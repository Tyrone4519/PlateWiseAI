import copy
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Optional

import io
import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

import platewise_streamlit_app as platewise


# ===============================
# ENV / PATH
# ===============================

BASE_DIR = Path(__file__).resolve().parent
FOOD_DATABASE_PATH = BASE_DIR / "food_database.csv"

load_dotenv(BASE_DIR / ".env")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()

# Version lock for the wrapper layer.
# The actual vision / nutrition / advice pipeline is still called from platewise_streamlit_app.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite").strip()

platewise.get_gemini_api_key = lambda: GEMINI_API_KEY

for attr in ["GEMINI_MODEL", "VISION_MODEL", "TEXT_MODEL", "MODEL_NAME"]:
    if hasattr(platewise, attr):
        setattr(platewise, attr, GEMINI_MODEL)


# ===============================
# FASTAPI APP
# ===============================

app = FastAPI(title="PlateWise NLP API", version="original-pipeline-api-3.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===============================
# REQUEST MODELS
# ===============================

class ChatRequest(BaseModel):
    user_text: str
    meal: Optional[dict] = None
    profile: dict


class ReportRequest(BaseModel):
    meal: dict
    profile: dict
    last_analysis: Optional[dict] = None


class EditMealRequest(BaseModel):
    meal: dict
    profile: dict
    ingredients: list[dict]


class MealAdviceRequest(BaseModel):
    meal: dict
    profile: dict
    ingredients: Optional[list[dict]] = None


# ===============================
# PROFILE HELPERS
# ===============================

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
        return [
            str(item).strip().lower()
            for item in value
            if str(item).strip()
        ]

    return [
        item.strip().lower()
        for item in str(value).split(",")
        if item.strip()
    ]


PREFERENCE_LABELS = {"vegetarian", "vegan", "low_sodium", "low_sugar", "high_protein"}


def split_profile_restrictions(values: list[str]) -> tuple[list[str], list[str]]:
    allergies = []
    diet_preferences = []

    for item in values:
        if item in PREFERENCE_LABELS:
            if item not in diet_preferences:
                diet_preferences.append(item)
        elif item not in allergies:
            allergies.append(item)

    return allergies, diet_preferences


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

    restrictions = parse_text_list(
        working.get("dietary_restrictions", working.get("restrictions"))
    )
    allergies, diet_preferences = split_profile_restrictions(restrictions)
    explicit_allergies = parse_text_list(working.get("allergies"))
    explicit_diet_preferences = parse_text_list(working.get("diet_preferences"))

    for item in explicit_allergies:
        if item not in allergies:
            allergies.append(item)

    for item in explicit_diet_preferences:
        if item not in diet_preferences:
            diet_preferences.append(item)

    working["allergies"] = platewise.unique_profile_items(allergies)
    working["diet_preferences"] = platewise.unique_profile_items(diet_preferences)
    working["dietary_restrictions"] = platewise.unique_profile_items([
        *working["allergies"],
        *working["diet_preferences"],
    ])

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
    has_structured_restrictions = bool(
        after.get("allergies") or after.get("diet_preferences")
    )

    return {
        key: value
        for key, value in after_updates.items()
        if before_updates.get(key) != value or (key == "restrictions" and has_structured_restrictions)
    }


def allergy_update_reply(updates_text: list[str]) -> str | None:
    added = [
        item.split(": ", 1)[1]
        for item in updates_text
        if item.startswith("allergy added: ") and ": " in item
    ]
    removed = [
        item.split(": ", 1)[1]
        for item in updates_text
        if item.startswith("allergy removed: ") and ": " in item
    ]

    if added and len(added) == len(updates_text):
        foods = ", ".join(added)
        return (
            f"I updated your allergy profile: {foods}. "
            f"I will avoid foods containing {foods} in future meal analysis. "
            "You can also change your allergy information from the Profile page."
        )

    if removed and len(removed) == len(updates_text):
        foods = ", ".join(removed)
        return (
            f"I updated your allergy profile: removed {foods}. "
            "You can also change your allergy information from the Profile page."
        )

    return None


def existing_allergy_reply(user_text: str, profile: dict) -> str | None:
    try:
        food_library = platewise.load_food_library(platewise.FOOD_LIBRARY_PATH)
        items = platewise.extract_allergy_entities(user_text, food_library)
    except Exception:
        items = []

    existing = {platewise.normalize_profile_item(item) for item in profile.get("allergies") or []}
    matched = []

    for item in items:
        normalized = platewise.normalize_profile_item(item)
        if normalized in existing and normalized not in matched:
            matched.append(normalized)

    if not matched:
        return None

    foods = ", ".join(matched)
    return (
        f"Your allergy profile already includes {foods}. "
        f"I will avoid foods containing {foods} in future meal analysis. "
        "You can also change your allergy information from the Profile page."
    )


# ===============================
# MEAL / REPORT HELPERS
# ===============================

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
        "health",
        "healthy",
        "unhealthy",
        "good",
        "bad",
        "advice",
        "recommend",
        "suggest",
        "what do you think",
        "how do you think",
        "this food",
        "this meal",
        "calorie",
        "calories",
        "sodium",
        "sugar",
        "fat",
        "protein",
        "diet",
        "eat",
        "portion",
    ]

    return any(key in lowered for key in keywords)


# ===============================
# FOOD SEARCH HELPERS
# ===============================

def normalize_search_text(text: str) -> str:
    text = str(text or "").lower().strip()
    text = re.sub(r"[_/,-]+", " ", text)
    text = re.sub(r"[^\w\s\u4e00-\u9fff'-]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def find_first_existing_column(df: pd.DataFrame, candidates: list[str]) -> str | None:
    columns = set(df.columns)

    for col in candidates:
        if col in columns:
            return col

    return None


NUTRIENT_COLUMN_MAP = {
    "calories": "energy (kcal)",
    "protein_g": "protein (g)",
    "fat_g": "total lipid (fat) (g)",
    "carbs_g": "carbohydrate, by difference (g)",
    "sodium_mg": "sodium, na (mg)",
    "sugar_g": "total sugars (g)",
    "fiber_g": "fiber, total dietary (g)",
}


def safe_float(value, default: float | None = None) -> float | None:
    try:
        if value in [None, ""] or pd.isna(value):
            return default
        return float(value)
    except Exception:
        return default


def nutrients_from_row(row) -> dict:
    nutrients = {}
    for key, col in NUTRIENT_COLUMN_MAP.items():
        value = safe_float(row.get(col))
        if value is not None:
            nutrients[key] = value
    return nutrients


def scale_nutrients_per_100g(nutrients_per_100g: dict, grams: float) -> dict:
    scale = grams / 100.0
    return {
        "estimated_calories": round(float(nutrients_per_100g.get("calories", 0)) * scale),
        "estimated_protein_g": round(float(nutrients_per_100g.get("protein_g", 0)) * scale),
        "estimated_fat_g": round(float(nutrients_per_100g.get("fat_g", 0)) * scale),
        "estimated_carbs_g": round(float(nutrients_per_100g.get("carbs_g", 0)) * scale),
        "estimated_sodium_mg": round(float(nutrients_per_100g.get("sodium_mg", 0)) * scale),
        "estimated_sugar_g": round(float(nutrients_per_100g.get("sugar_g", 0)) * scale),
        "estimated_fiber_g": round(float(nutrients_per_100g.get("fiber_g", 0)) * scale),
    }


def food_search_record_by_name(name: str) -> dict | None:
    normalized = normalize_search_text(name)
    if not normalized:
        return None

    for item in load_food_search_table():
        if normalize_search_text(item.get("name", "")) == normalized:
            return item

    return None


def edited_ingredient_from_request(item: dict, old_item: dict | None = None) -> dict | None:
    old_item = old_item or {}
    name = str(item.get("name", "")).strip()

    if not name:
        return None

    grams = safe_float(item.get("estimated_grams"), safe_float(old_item.get("estimated_grams"), 100.0))
    if not grams or grams <= 0:
        grams = 100.0

    edited = {
        "name": name,
        "estimated_grams": grams,
    }

    nutrients_per_100g = item.get("nutrients_per_100g") or old_item.get("nutrients_per_100g")
    nutrition_source = item.get("nutrition_source") or old_item.get("nutrition_source")

    if not nutrients_per_100g:
        matched_food = food_search_record_by_name(name)
        if matched_food:
            nutrients_per_100g = matched_food.get("nutrients_per_100g")
            nutrition_source = matched_food.get("nutrition_source")

    if isinstance(nutrients_per_100g, dict) and nutrients_per_100g:
        edited["nutrients_per_100g"] = nutrients_per_100g
        edited.update(scale_nutrients_per_100g(nutrients_per_100g, grams))
        edited["nutrition_source"] = nutrition_source or "food_database.csv"
    else:
        for field in [
            "estimated_calories",
            "estimated_protein_g",
            "estimated_fat_g",
            "estimated_carbs_g",
            "estimated_sodium_mg",
            "estimated_sugar_g",
            "estimated_fiber_g",
        ]:
            value = safe_float(item.get(field), safe_float(old_item.get(field)))
            if value is not None:
                edited[field] = round(value)
        if item.get("nutrition_source") or old_item.get("nutrition_source"):
            edited["nutrition_source"] = item.get("nutrition_source") or old_item.get("nutrition_source")

    return edited


def build_user_edited_meal(old_meal: dict, ingredients: list[dict]) -> dict:
    old_ingredients = old_meal.get("ingredients", [])
    edited_ingredients = []

    for index, item in enumerate(ingredients):
        old_item = old_ingredients[index] if index < len(old_ingredients) else {}
        edited = edited_ingredient_from_request(item, old_item)
        if edited:
            edited_ingredients.append(edited)

    if not edited_ingredients:
        raise ValueError("At least one ingredient is required.")

    meal = {
        "dish_name": old_meal.get("dish_name", "corrected meal"),
        "ingredients": edited_ingredients,
    }

    meal["dish_name"] = platewise.infer_dish_name_from_ingredients(meal)

    if all("estimated_calories" in item for item in edited_ingredients):
        return platewise.recalculate_meal_totals(meal)

    return platewise.normalize_meal_structure(meal)


@lru_cache(maxsize=1)
def load_food_search_table() -> list[dict]:
    """
    Load the local summarized food database for frontend search.

    Priority:
    1. nlp/food_database.csv
    2. fallback to platewise.load_local_usda(), which reads usda_LLMprompt.csv
    """

    records: list[dict] = []

    if FOOD_DATABASE_PATH.exists():
        df = pd.read_csv(FOOD_DATABASE_PATH)
        df.columns = df.columns.str.lower().str.strip()

        name_col = find_first_existing_column(
            df,
            [
                "main_food_description",
                "food_name",
                "description",
                "name",
                "ingredient",
            ],
        )

        zh_col = find_first_existing_column(
            df,
            [
                "main_food_description_zh",
                "food_name_zh",
                "description_zh",
                "name_zh",
                "chinese_name",
                "zh_name",
            ],
        )

        category_col = find_first_existing_column(
            df,
            [
                "wweia_food_category_description",
                "category",
                "food_category",
                "food_category_description",
                "main_category",
            ],
        )

        if not name_col:
            raise ValueError(
                "food_database.csv must contain one of these columns: "
                "main_food_description, food_name, description, name, ingredient."
            )

        for _, row in df.iterrows():
            name = str(row.get(name_col, "")).strip()

            if not name or name.lower() == "nan":
                continue

            zh_name = ""
            if zh_col:
                zh_name = str(row.get(zh_col, "")).strip()
                if zh_name.lower() == "nan":
                    zh_name = ""

            category = ""
            if category_col:
                category = str(row.get(category_col, "")).strip()
                if category.lower() == "nan":
                    category = ""

            records.append({
                "name": name,
                "name_zh": zh_name,
                "category": category,
                "nutrients_per_100g": nutrients_from_row(row),
                "nutrition_source": "food_database.csv",
                "search_text": normalize_search_text(f"{name} {zh_name} {category}"),
            })

        # Deduplicate by English name
        seen = set()
        unique_records = []

        for item in records:
            key = item["name"].lower().strip()

            if key in seen:
                continue

            seen.add(key)
            unique_records.append(item)

        return unique_records

    # fallback: use existing local USDA table from platewise_streamlit_app.py
    df = platewise.load_local_usda()

    for _, row in df.iterrows():
        name = str(row.get("food_name", "")).strip()
        if not name or name.lower() == "nan":
            continue
        records.append({
            "name": name,
            "name_zh": "",
            "category": "",
            "nutrients_per_100g": nutrients_from_row(row),
            "nutrition_source": "usda_LLMprompt.csv",
            "search_text": normalize_search_text(name),
        })

    return records


# ===============================
# ROUTES
# ===============================

@app.get("/")
def root():
    return {
        "status": "NLP API running",
        "gemini_configured": bool(GEMINI_API_KEY),
        "local_usda_table": "usda_LLMprompt.csv",
        "food_database_table": "food_database.csv" if FOOD_DATABASE_PATH.exists() else "not_found_using_usda_fallback",
        "gemini_model_lock": GEMINI_MODEL,
        "pipeline": "original_platewise_streamlit_functions",
    }


@app.get("/food-search")
def food_search(q: str = "", limit: int = 12):
    try:
        query = normalize_search_text(q)
        limit = max(1, min(int(limit or 12), 30))

        records = load_food_search_table()

        if not query:
            items = [
                {
                    "name": item["name"],
                    "name_zh": item.get("name_zh", ""),
                    "category": item.get("category", ""),
                    "nutrients_per_100g": item.get("nutrients_per_100g", {}),
                    "nutrition_source": item.get("nutrition_source", ""),
                }
                for item in records[:limit]
            ]

            return {
                "ok": True,
                "items": items,
                "results": items,
            }

        starts_with = []
        contains = []

        for item in records:
            name_norm = normalize_search_text(item.get("name", ""))
            zh_norm = normalize_search_text(item.get("name_zh", ""))
            search_text = item.get("search_text", "")

            if name_norm.startswith(query) or zh_norm.startswith(query):
                starts_with.append(item)
            elif query in search_text:
                contains.append(item)

        results = starts_with + contains

        seen = set()
        unique_results = []

        for item in results:
            key = item["name"].lower().strip()

            if key in seen:
                continue

            seen.add(key)

            unique_results.append({
                "name": item["name"],
                "name_zh": item.get("name_zh", ""),
                "category": item.get("category", ""),
                "nutrients_per_100g": item.get("nutrients_per_100g", {}),
                "nutrition_source": item.get("nutrition_source", ""),
            })

        items = unique_results[:limit]

        return {
            "ok": True,
            "items": items,
            "results": items,
        }

    except Exception as e:
        print("food-search error:", e)

        return {
            "ok": False,
            "items": [],
            "results": [],
            "error": str(e),
        }


@app.post("/analyze-image")
async def analyze_image(
    image: UploadFile = File(...),
    profile: str = Form(...),
    goal: str = Form("healthy eating"),
):
    try:
        profile_dict = require_profile(json.loads(profile))

        image_bytes = await image.read()
        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        meal = platewise.detect_food_from_image(pil_image, GEMINI_API_KEY)
        meal, excluded_allergens = platewise.apply_allergy_exclusions(profile_dict, meal)

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
            "excluded_allergy_ingredients": excluded_allergens,
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


@app.post("/edit-meal")
def edit_meal(req: EditMealRequest):
    try:
        profile = require_profile(req.profile)
        before_profile = copy.deepcopy(profile)

        old_meal = copy.deepcopy(req.meal or {})
        updated_meal = build_user_edited_meal(old_meal, req.ingredients)

        updated_meal, excluded_allergens = platewise.apply_allergy_exclusions(
            profile,
            updated_meal,
        )

        kb = platewise.load_who_knowledge()

        reply = platewise.build_meal_correction_reply(
            "Updated the ingredients based on your edits.",
            updated_meal,
            profile,
            kb,
        )

        return {
            "ok": True,
            "reply": reply,
            "meal": updated_meal,
            "insight": api_insight(profile, updated_meal),
            "items_for_db": meal_items_for_db(updated_meal),
            "report_totals": report_totals(updated_meal),
            "profile": profile,
            "profile_updates": changed_profile_updates(before_profile, profile),
            "excluded_allergy_ingredients": excluded_allergens,
        }

    except Exception as e:
        print("edit-meal error:", e)

        return {
            "ok": False,
            "reply": f"Meal edit failed: {str(e)}",
            "meal": req.meal,
            "insight": None,
            "items_for_db": [],
            "report_totals": {},
            "profile_updates": {},
        }


@app.post("/meal-advice")
def meal_advice(req: MealAdviceRequest):
    try:
        profile = require_profile(req.profile)
        before_profile = copy.deepcopy(profile)

        if req.ingredients is not None:
            old_meal = copy.deepcopy(req.meal or {})
            meal = build_user_edited_meal(old_meal, req.ingredients)
        else:
            meal = copy.deepcopy(req.meal)

        meal, excluded_allergens = platewise.apply_allergy_exclusions(profile, meal)

        kb = platewise.load_who_knowledge()
        reply = platewise.build_chat_image_analysis_reply(meal, profile, kb)

        return {
            "ok": True,
            "reply": reply,
            "meal": meal,
            "insight": api_insight(profile, meal),
            "items_for_db": meal_items_for_db(meal),
            "report_totals": report_totals(meal),
            "profile": profile,
            "profile_updates": changed_profile_updates(before_profile, profile),
            "excluded_allergy_ingredients": excluded_allergens,
        }

    except Exception as e:
        print("meal-advice error:", e)

        return {
            "ok": False,
            "reply": f"Meal advice failed: {str(e)}",
            "meal": req.meal,
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

        intent = platewise.recognize_user_intent(req.user_text).get("intent")
        updates_text = platewise.detect_profile_updates(req.user_text, profile)

        try:
            calories, protein = platewise.calculate_targets(profile)
            profile["daily_calories"] = calories
            profile["daily_protein"] = protein
        except Exception:
            pass

        correction_message = None

        is_meal_correction = bool(
            meal
            and (
                intent == "meal_correction"
                or platewise.infer_correction_command(req.user_text, meal)
            )
        )

        if is_meal_correction:
            meal, correction_message = platewise.apply_meal_correction(
                req.user_text,
                meal,
                None,
            )

        excluded_allergens = []

        if meal and not updates_text:
            meal, excluded_allergens = platewise.apply_allergy_exclusions(profile, meal)

            if excluded_allergens:
                correction_message = correction_message or "Updated the meal based on your allergy profile."

        if updates_text:
            allergy_reply = allergy_update_reply(updates_text)
            update_prefix = allergy_reply or "I updated your profile: " + ", ".join(updates_text) + "."

            if correction_message and meal:
                reply = update_prefix + " " + platewise.build_meal_correction_reply(
                    correction_message,
                    meal,
                    profile,
                    kb,
                )

            elif allergy_reply:
                reply = allergy_reply

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

        elif intent == "allergy":
            reply = existing_allergy_reply(req.user_text, profile) or platewise.build_diet_preference_guidance(profile, meal)

        elif intent == "diet_preference":
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
            reply = (
                "Hello. You can chat with me normally, upload a meal image, "
                "or tell me your goal, restriction, or health condition."
            )

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
            "excluded_allergy_ingredients": excluded_allergens,
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

        meal, excluded_allergens = platewise.apply_allergy_exclusions(profile, meal)

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
            "excluded_allergy_ingredients": excluded_allergens,
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
