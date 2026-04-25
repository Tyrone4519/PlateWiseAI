import copy
import json
import os
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
import io

import platewise_streamlit_app as platewise

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
USDA_API_KEY = os.getenv("USDA_API_KEY", "").strip()

# Version lock for the wrapper layer.
# The actual vision / nutrition / advice pipeline is still called from platewise_streamlit_app.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite-preview").strip()

platewise.get_gemini_api_key = lambda: GEMINI_API_KEY
platewise.get_usda_api_key = lambda: USDA_API_KEY

for attr in ["GEMINI_MODEL", "VISION_MODEL", "TEXT_MODEL", "MODEL_NAME"]:
    if hasattr(platewise, attr):
        setattr(platewise, attr, GEMINI_MODEL)

app = FastAPI(title="PlateWise NLP API", version="original-pipeline-api-3.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    user_text: str
    meal: Optional[dict] = None
    profile: dict


class ReportRequest(BaseModel):
    meal: dict
    profile: dict
    last_analysis: Optional[dict] = None


def normalize_goal(goal: str | None) -> str:
    value = str(goal or "").strip().lower().replace(" ", "_").replace("-", "_")
    mapping = {
        "lose_weight": "lose_weight",
        "loss_weight": "lose_weight",
        "weight_loss": "lose_weight",
        "lose": "lose_weight",
        "gain_weight": "gain_weight",
        "gain": "gain_weight",
        "gain_muscle": "gain_muscle",
        "muscle_gain": "gain_muscle",
        "maintain": "maintain",
        "maintenance": "maintain",
        "reduce_sodium": "reduce_sodium",
        "low_sodium": "reduce_sodium",
    }
    return mapping.get(value, value or "maintain")


def parse_text_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip().lower() for item in value if str(item).strip()]
    return [item.strip().lower() for item in str(value).split(",") if item.strip()]


def require_profile(profile: dict) -> dict:
    if not isinstance(profile, dict) or not profile:
        raise ValueError("Real Supabase profile is required.")

    required_keys = ["age", "gender", "height_cm", "weight_kg", "goal"]
    missing = [key for key in required_keys if profile.get(key) in [None, ""]]
    if missing:
        raise ValueError(f"Profile missing required fields: {missing}")

    working = copy.deepcopy(profile)
    working["age"] = int(float(working["age"]))
    working["height_cm"] = float(working["height_cm"])
    working["weight_kg"] = float(working["weight_kg"])
    working["gender"] = str(working["gender"]).strip().lower()
    working["goal"] = normalize_goal(working.get("goal"))

    working["dietary_restrictions"] = parse_text_list(
        working.get("dietary_restrictions", working.get("restrictions"))
    )

    condition_text = working.get("health_notes") or ""
    conditions = parse_text_list(working.get("conditions"))

    extracted_conditions = platewise.extract_condition_entities(str(condition_text))
    for item in extracted_conditions:
        if item not in conditions:
            conditions.append(item)

    working["conditions"] = conditions

    calories, protein = platewise.calculate_targets(working)
    working["daily_calories"] = calories
    working["daily_protein"] = protein

    return working


def profile_updates_for_supabase(profile: dict) -> dict:
    updates = {}

    if profile.get("age") is not None:
        updates["age"] = int(float(profile["age"]))
    if profile.get("gender") is not None:
        updates["gender"] = str(profile["gender"]).lower()
    if profile.get("height_cm") is not None:
        updates["height_cm"] = float(profile["height_cm"])
    if profile.get("weight_kg") is not None:
        updates["weight_kg"] = float(profile["weight_kg"])
    if profile.get("goal") is not None:
        updates["goal"] = normalize_goal(profile["goal"])

    if "dietary_restrictions" in profile:
        updates["restrictions"] = ", ".join(profile.get("dietary_restrictions") or [])

    if "conditions" in profile:
        updates["health_notes"] = ", ".join(profile.get("conditions") or [])

    return updates


def changed_profile_updates(before: dict, after: dict) -> dict:
    before_updates = profile_updates_for_supabase(before)
    after_updates = profile_updates_for_supabase(after)

    return {
        key: value
        for key, value in after_updates.items()
        if before_updates.get(key) != value
    }


def meal_items_for_db(meal: dict | None) -> list[dict]:
    if not meal:
        return []

    rows = []
    for item in meal.get("ingredients", []):
        rows.append({
            "food_name": item.get("name") or "Unknown food",
            "estimated_portion": item.get("estimated_grams"),
            "portion_unit": "g",
            "calories": item.get("estimated_calories"),
            "protein_g": item.get("estimated_protein_g"),
            "fat_g": item.get("estimated_fat_g"),
            "carbs_g": item.get("estimated_carbs_g"),
            "sodium_mg": item.get("estimated_sodium_mg"),
            "sugar_g": item.get("estimated_sugar_g"),
            "fiber_g": item.get("estimated_fiber_g"),
            "confidence_score": item.get("confidence_score"),
            "notes": item.get("food_class"),
        })

    return rows


def report_totals(meal: dict | None) -> dict:
    meal = meal or {}
    return {
        "total_calories": meal.get("dish_estimated_calories"),
        "total_protein_g": meal.get("dish_estimated_protein_g"),
        "total_fat_g": meal.get("dish_estimated_fat_g"),
        "total_carbs_g": meal.get("dish_estimated_carbs_g"),
        "total_sodium_mg": meal.get("dish_estimated_sodium_mg"),
        "total_sugar_g": meal.get("dish_estimated_sugar_g"),
        "total_fiber_g": meal.get("dish_estimated_fiber_g"),
    }


def api_insight(profile: dict, meal: dict | None) -> dict | None:
    if not meal:
        return None

    kb = platewise.load_who_knowledge()
    insight = platewise.build_meal_insight(profile, meal, kb)

    sodium = meal.get("dish_estimated_sodium_mg") or 0
    calories = meal.get("dish_estimated_calories") or 0
    risk_notes = insight.get("risk_notes") or []

    if any("high" in str(note).lower() for note in risk_notes) or sodium >= 1000:
        risk_level = "high"
    elif sodium >= 500 or calories >= 500:
        risk_level = "medium"
    else:
        risk_level = "low"

    return {
        "risk_level": risk_level,
        "headline": insight.get("headline"),
        "main_risk": insight.get("main_risk"),
        "risk_notes": insight.get("risk_notes") or [],
        "actions": insight.get("actions") or [],
        "who_rules": insight.get("who_rules") or [],
        "final_summary": insight.get("full_advice") or insight.get("headline"),
        "recommendation": " ".join(insight.get("actions") or []),
    }


def is_meal_related_question(text: str) -> bool:
    lowered = text.lower()
    keywords = [
        "health", "healthy", "unhealthy", "good", "bad", "advice",
        "recommend", "suggest", "what do you think", "how do you think",
        "this food", "this meal", "calorie", "calories", "sodium",
        "sugar", "fat", "protein", "diet", "eat", "portion",
    ]
    return any(key in lowered for key in keywords)


@app.get("/")
def root():
    return {
        "status": "NLP API running",
        "gemini_configured": bool(GEMINI_API_KEY),
        "usda_configured": bool(USDA_API_KEY),
        "gemini_model_lock": GEMINI_MODEL,
        "pipeline": "original_platewise_streamlit_functions",
    }


@app.post("/analyze-image")
async def analyze_image(
    image: UploadFile = File(...),
    profile: str = Form(...),
):
    try:
        profile_dict = require_profile(json.loads(profile))

        image_bytes = await image.read()
        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        meal = platewise.detect_food_from_image(pil_image, GEMINI_API_KEY)

        kb = platewise.load_who_knowledge()
        reply = platewise.build_chat_image_analysis_reply(meal, profile_dict, kb)
        insight = api_insight(profile_dict, meal)

        return {
            "ok": True,
            "reply": reply,
            "meal": meal,
            "insight": insight,
            "items_for_db": meal_items_for_db(meal),
            "report_totals": report_totals(meal),
            "profile": profile_dict,
            "profile_updates": {},
        }

    except Exception as e:
        print("analyze-image error:", e)
        return {
            "ok": False,
            "reply": f"Image analysis failed: {str(e)}",
            "meal": None,
            "insight": None,
            "items_for_db": [],
            "report_totals": {},
            "profile_updates": {},
        }


@app.post("/chat-turn")
def chat_turn(req: ChatRequest):
    try:
        profile = require_profile(req.profile)
        before_profile = copy.deepcopy(profile)
        meal = copy.deepcopy(req.meal) if req.meal else None
        kb = platewise.load_who_knowledge()

        updates_text = platewise.detect_profile_updates(req.user_text, profile)

        try:
            calories, protein = platewise.calculate_targets(profile)
            profile["daily_calories"] = calories
            profile["daily_protein"] = protein
        except Exception:
            pass

        correction_message = None
        if meal:
            meal, correction_message = platewise.apply_meal_correction(
                req.user_text,
                meal,
                GEMINI_API_KEY,
            )

        intent = platewise.recognize_user_intent(req.user_text).get("intent")

        if updates_text:
            update_prefix = "I updated your profile: " + ", ".join(updates_text) + "."
            if correction_message and meal:
                reply = update_prefix + " " + platewise.build_meal_correction_reply(
                    correction_message,
                    meal,
                    profile,
                    kb,
                )
            elif intent == "goal_change":
                reply = update_prefix + " " + platewise.build_goal_change_reply(profile)
            elif intent == "condition":
                reply = update_prefix + " " + platewise.build_condition_update_reply(profile, kb, meal)
            elif intent in {"diet_preference", "allergy"}:
                reply = update_prefix + " " + platewise.build_diet_preference_guidance(profile, meal)
            else:
                reply = update_prefix + " " + platewise.format_profile_summary(profile)

        elif correction_message and meal:
            reply = platewise.build_meal_correction_reply(correction_message, meal, profile, kb)

        elif meal and (intent == "meal_analysis" or is_meal_related_question(req.user_text)):
            reply = platewise.generate_advice(profile, meal, kb)

        elif intent in {"diet_preference", "allergy"}:
            reply = platewise.build_diet_preference_guidance(profile, meal)

        elif intent == "condition":
            reply = platewise.build_condition_guidance(profile, meal, kb)

        elif intent == "goal_change":
            reply = platewise.build_goal_change_reply(profile)

        elif intent == "profile_query":
            reply = platewise.format_profile_summary(profile)

        elif meal and intent == "meal_query":
            reply = platewise.format_meal_summary(meal)

        elif intent == "who_guidance":
            who_reply = platewise.answer_who_question(req.user_text, kb)
            reply = who_reply or "I can explain sodium, sugar, fats, vegetables, fibre, and potassium guidance."

        elif intent == "thanks":
            reply = "You're welcome."

        elif meal:
            reply = platewise.generate_advice(profile, meal, kb)

        elif intent == "greeting":
            reply = "Hello. You can chat with me normally, upload a meal image, or tell me your goal, restriction, or health condition."

        else:
            reply = (
                "Please upload a meal image first, or tell me a meal to discuss. "
                "I can also update your profile if you tell me your goal, weight, condition, or dietary restriction."
            )

        return {
            "ok": True,
            "reply": reply,
            "meal": meal,
            "insight": api_insight(profile, meal),
            "items_for_db": meal_items_for_db(meal),
            "report_totals": report_totals(meal),
            "profile": profile,
            "profile_updates": changed_profile_updates(before_profile, profile),
        }

    except Exception as e:
        print("chat-turn error:", e)
        return {
            "ok": False,
            "reply": f"Chat failed: {str(e)}",
            "meal": req.meal,
            "insight": None,
            "items_for_db": [],
            "report_totals": {},
            "profile_updates": {},
        }


@app.post("/build-report")
def build_report(req: ReportRequest):
    try:
        profile = require_profile(req.profile)
        before_profile = copy.deepcopy(profile)
        meal = copy.deepcopy(req.meal)

        kb = platewise.load_who_knowledge()
        insight = platewise.build_meal_insight(profile, meal, kb)
        reply = insight.get("full_advice") or platewise.generate_advice(profile, meal, kb)

        return {
            "ok": True,
            "title": meal.get("dish_name", "Meal Analysis").title(),
            "reply": reply,
            "meal": meal,
            "insight": api_insight(profile, meal),
            "items_for_db": meal_items_for_db(meal),
            "report_totals": report_totals(meal),
            "profile": profile,
            "profile_updates": changed_profile_updates(before_profile, profile),
        }

    except Exception as e:
        print("build-report error:", e)
        return {
            "ok": False,
            "reply": f"Report failed: {str(e)}",
            "meal": req.meal,
            "insight": None,
            "items_for_db": [],
            "report_totals": {},
            "profile_updates": {},
        }