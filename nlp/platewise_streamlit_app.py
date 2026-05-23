import json
import math
import os
import re
import uuid
from functools import lru_cache
from pathlib import Path

import streamlit as st
from PIL import Image
import pandas as pd

from condition_extractor import extract_condition_entities
from goal_update_intent import parse_sequential_goal_update
from intent_recognition_defs import extract_allergy_entities, extract_food_entities, load_food_library, recognize_user_intent
from weight_update_intent import parse_sequential_weight_update

try:
    from google import genai
except ImportError:  # pragma: no cover - handled in UI
    genai = None


BASE_DIR = Path(__file__).resolve().parent
WHO_KB_PATH = BASE_DIR / "who_knowledge.json"
FOOD_LIBRARY_PATH = BASE_DIR / "nutrition5k_food_entity_library.json"
# USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search"

FOOD_CLASS_DEFAULTS = {
    "protein": {"estimated_grams": 90, "estimated_sodium_mg": 90, "estimated_calories": 180, "estimated_carbs_g": 0, "estimated_sugar_g": 0, "estimated_fat_g": 9},
    "seafood": {"estimated_grams": 90, "estimated_sodium_mg": 120, "estimated_calories": 120, "estimated_carbs_g": 1, "estimated_sugar_g": 0, "estimated_fat_g": 3},
    "vegetable": {"estimated_grams": 70, "estimated_sodium_mg": 20, "estimated_calories": 25, "estimated_carbs_g": 4, "estimated_sugar_g": 2, "estimated_fat_g": 0},
    "fruit": {"estimated_grams": 80, "estimated_sodium_mg": 2, "estimated_calories": 45, "estimated_carbs_g": 12, "estimated_sugar_g": 8, "estimated_fat_g": 0},
    "grain_staple": {"estimated_grams": 120, "estimated_sodium_mg": 60, "estimated_calories": 180, "estimated_carbs_g": 36, "estimated_sugar_g": 1, "estimated_fat_g": 2},
    "prepared_dish": {"estimated_grams": 120, "estimated_sodium_mg": 220, "estimated_calories": 220, "estimated_carbs_g": 18, "estimated_sugar_g": 3, "estimated_fat_g": 10},
    "sauce_condiment": {"estimated_grams": 25, "estimated_sodium_mg": 420, "estimated_calories": 60, "estimated_carbs_g": 5, "estimated_sugar_g": 3, "estimated_fat_g": 4},
    "dessert": {"estimated_grams": 70, "estimated_sodium_mg": 90, "estimated_calories": 220, "estimated_carbs_g": 30, "estimated_sugar_g": 18, "estimated_fat_g": 9},
    "beverage": {"estimated_grams": 250, "estimated_sodium_mg": 40, "estimated_calories": 80, "estimated_carbs_g": 16, "estimated_sugar_g": 14, "estimated_fat_g": 1},
    "default": {"estimated_grams": 60, "estimated_sodium_mg": 50, "estimated_calories": 80, "estimated_carbs_g": 8, "estimated_sugar_g": 2, "estimated_fat_g": 3},
}

MEAL_DETECTION_PROMPT = """
You are a professional nutrition analysis assistant specializing in multimodal food recognition.

Task:
Analyze the provided food image and return a structured JSON object. 
Your primary goal is to identify food items and map them to names that exist in the **Local USDA Database** provided below.

Recognition Guidelines:
For each food item, distinguish between what is clearly visible and what is inferred.
- **Visible Ingredients**: Items you are >90% certain of based on visual features (e.g., "white rice", "green broccoli").
- **Uncertain/Inferred**: Items that are partially obscured, mixed, or logically expected but visually ambiguous (e.g., hidden oils, seasoning, or the specific type of a liquid).

Local USDA Mapping Logic (Priority):
1. **Direct Match**: Identify the food (e.g., "boiled egg") and map it to the most specific category name in the provided list (e.g., "egg").
2. **Semantic Fallback**: If a specific brand or preparation method is not in the list, map it to the most similar generic ingredient (e.g., "Grilled Chicken Breast" -> "chicken").
3. **USDA Table Priority**: Ensure the `name` field in your JSON output uses terms that are likely to appear in the local USDA database to ensure high retrieval success.

### Fallback Strategy (If ingredient is missing from provided list):
- **Category Analogy**: Use a generic category average (e.g., if "Yellow Dragon Fruit" is missing, use "fruit").
- **Knowledge-Based Estimation**: If the item is completely absent, provide the entry based on your internal training data. The system will automatically tag these as AI-estimated.

Return JSON only:
{
  "dish_name": "dish name",
  "dish_estimated_grams": 400,
  "ingredients": [
    {"name": "ingredient", "estimated_grams": 100}
  ]
}

Rules:
1. First recognize the actual food (e.g., "grilled corn").
2. Then map it to the closest label from the provided list (e.g., "corn").
3. Do NOT map to unrelated foods.
4. If no good match exists, choose the closest semantic match, not random.
5. If the item is a liquid in a cup or glass, prioritize mapping it to drinks categories. Do not label drinking liquids as 'sauce' unless they are in small dipping containers.
6. Use simple names (e.g., "corn", not "grilled corn with butter").
7. Use singular form.
9. Do NOT estimate nutrition values.
10. Return JSON only.
"""

MEAL_RECALCULATION_PROMPT = """
You are updating a corrected meal JSON after the user fixed ingredients.

You will receive a JSON object describing the current meal and its corrected ingredient list.
Return JSON only in this format:
{
  "dish_name": "dish name",
  "dish_estimated_grams": 400,
  "ingredients": [
    {
      "name": "ingredient",
      "estimated_grams": 100
    }
  ]
}

Rules:
1. Update the dish_name so it matches the corrected ingredients.
2. Keep the corrected ingredient names in the JSON.
3. Keep or lightly adjust ingredient grams only if needed for consistency.
4. Do not estimate calories, sodium, sugar, fat, or carbs in the JSON.
5. Return JSON only with no markdown or explanation.
"""


def load_who_knowledge() -> list[dict]:
    with WHO_KB_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def nutrition_kb_items(kb: list[dict]) -> list[dict]:
    return [item for item in kb if item.get("category", "nutrition_topic") == "nutrition_topic"]


def condition_guidance_items(kb: list[dict]) -> list[dict]:
    return [item for item in kb if item.get("category") == "condition_guidance"]


def get_condition_guidance_entries(conditions: list[str], kb: list[dict]) -> list[dict]:
    condition_set = set(conditions)
    return [item for item in condition_guidance_items(kb) if item.get("condition") in condition_set]


def contains_cjk(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", text))


def normalize_token(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", text.lower())).strip()


FOOD_CANONICAL_ALIASES = {
    "prawn": "shrimp",
    "prawns": "shrimp",
    "shrimps": "shrimp",
    "peanuts": "peanut",
    "eggs": "egg",
    "tree nut": "nuts",
    "tree nuts": "nuts",
    "tomatoes": "tomato",
    "tomatos": "tomato",
    "tomatoe": "tomato",
    "tomatoe s": "tomato",
    "tomotaes": "tomato",
    "cherry tomato": "tomato",
    "cherry tomatoes": "tomato",
    "courgette": "zucchini",
    "courgettes": "zucchini",
    "noodles": "noodle",
    "rice": "rice",
    "potatoes": "potato",
    "fries": "french fry",
    "chips": "french fry",
    "carrots": "carrot",
    "cucumbers": "cucumber",
    "lettuces": "lettuce",
    "beans": "bean",
    "bean sprouts": "bean sprout",
    "lychees": "lychee",
    "lyche": "lychee",
}


def singularize_food_token(text: str) -> str:
    normalized = normalize_token(text)
    if normalized in FOOD_CANONICAL_ALIASES:
        return FOOD_CANONICAL_ALIASES[normalized]
    if normalized.endswith("ies") and len(normalized) > 4:
        return normalized[:-3] + "y"
    if normalized.endswith("oes") and len(normalized) > 4:
        return normalized[:-2]
    if normalized.endswith("es") and len(normalized) > 4:
        return normalized[:-2]
    if normalized.endswith("s") and len(normalized) > 3:
        return normalized[:-1]
    return normalized


def canonical_food_name(name: str) -> str:
    normalized = normalize_token(name)
    if not normalized:
        return normalized
    if normalized in FOOD_CANONICAL_ALIASES:
        return FOOD_CANONICAL_ALIASES[normalized]

    usda_match = find_usda_label(normalized)
    if usda_match:
        return usda_match

    return singularize_food_token(normalized)


USDA_QUERY_ALIASES = {
    "carrot": "carrots",
    "carrots": "carrots",
    "rice": "cooked rice",
    "white rice": "cooked white rice",
    "brown rice": "cooked brown rice",
    "noodle": "cooked noodles",
    "noodles": "cooked noodles",
    "potato": "potato",
    "potatoes": "potato",
    "egg": "boiled egg",
    "eggs": "boiled egg",
}


def usda_food_labels() -> list[str]:
    return load_local_usda()["food_name"].dropna().astype(str).str.lower().str.strip().unique().tolist()


def find_usda_label(text: str) -> str | None:
    normalized = singularize_food_token(text)
    alias = USDA_QUERY_ALIASES.get(normalized)
    if alias:
        return alias

    labels = usda_food_labels()
    if normalized in labels:
        return normalized

    plural = normalized + "s"
    if plural in labels:
        return plural

    for label in sorted(labels, key=len, reverse=True):
        label_normalized = normalize_token(label)
        if normalized == singularize_food_token(label_normalized):
            return label

    return None


COMMON_ALLERGEN_TOKENS = {
    "egg",
    "milk",
    "peanut",
    "nut",
    "almond",
    "cashew",
    "walnut",
    "shrimp",
    "prawn",
    "crab",
    "lobster",
    "fish",
    "soy",
    "tofu",
    "wheat",
    "sesame",
}


def classify_food(name: str) -> str:
    normalized = normalize_token(canonical_food_name(name))
    if any(token in normalized for token in ["coffee", "tea", "juice", "milk", "soda", "water", "drink"]):
        return "beverage"
    if any(token in normalized for token in ["cake", "cookie", "ice cream", "candy", "pie", "pudding", "dessert"]):
        return "dessert"
    if any(token in normalized for token in ["sauce", "dressing", "condiment", "gravy"]):
        return "sauce_condiment"
    if any(token in normalized for token in ["rice", "noodle", "pasta", "bread", "potato", "oat", "cereal"]):
        return "grain_staple"
    if any(token in normalized for token in ["shrimp", "prawn", "fish", "crab", "salmon", "tuna", "tilapia", "seafood"]):
        return "seafood"
    if any(token in normalized for token in ["egg", "chicken", "beef", "pork", "lamb", "turkey", "tofu", "bean"]):
        return "protein"
    if any(token in normalized for token in ["apple", "banana", "orange", "berry", "fruit", "melon", "grape"]):
        return "fruit"
    if any(token in normalized for token in ["pepper", "onion", "carrot", "broccoli", "lettuce", "tomato", "vegetable"]):
        return "vegetable"
    return "default"


def is_common_allergen(name: str) -> bool:
    tokens = set(normalize_token(name).split())
    return bool(tokens & COMMON_ALLERGEN_TOKENS)


def estimate_ingredient_entry(name: str) -> dict:
    canonical_name = canonical_food_name(name)
    food_class = classify_food(canonical_name)
    defaults = FOOD_CLASS_DEFAULTS.get(food_class, FOOD_CLASS_DEFAULTS["default"])
    return {
        "name": canonical_name,
        "estimated_grams": defaults["estimated_grams"],
        "estimated_sodium_mg": defaults["estimated_sodium_mg"],
        "estimated_calories": defaults["estimated_calories"],
        "estimated_carbs_g": defaults["estimated_carbs_g"],
        "estimated_sugar_g": defaults["estimated_sugar_g"],
        "estimated_fat_g": defaults["estimated_fat_g"],
        "food_class": food_class,
        "possible_allergen": is_common_allergen(canonical_name),
    }


def recalculate_meal_totals(meal: dict) -> dict:
    ingredients = meal.get("ingredients", [])
    total_grams = sum(float(item.get("estimated_grams", 0)) for item in ingredients)
    total_sodium = sum(float(item.get("estimated_sodium_mg", 0)) for item in ingredients)
    total_calories = sum(float(item.get("estimated_calories", 0)) for item in ingredients)
    total_carbs = sum(float(item.get("estimated_carbs_g", 0)) for item in ingredients)
    total_sugar = sum(float(item.get("estimated_sugar_g", 0)) for item in ingredients)
    total_fat = sum(float(item.get("estimated_fat_g", 0)) for item in ingredients)
    total_protein = sum(float(item.get("estimated_protein_g", 0)) for item in ingredients)
    total_fiber = sum(float(item.get("estimated_fiber_g", 0)) for item in ingredients)

    meal["dish_estimated_grams"] = round(total_grams)
    meal["dish_estimated_sodium_mg"] = round(total_sodium)
    meal["dish_estimated_calories"] = round(total_calories)
    meal["dish_estimated_carbs_g"] = round(total_carbs)
    meal["dish_estimated_sugar_g"] = round(total_sugar)
    meal["dish_estimated_fat_g"] = round(total_fat)
    meal["dish_estimated_protein_g"] = round(total_protein)
    meal["dish_estimated_fiber_g"] = round(total_fiber)

    return meal

def fix_ingredient_grams(meal):
    ingredients = meal.get("ingredients", [])
    total = float(meal.get("dish_estimated_grams", 0) or 0)

    if not ingredients or total <= 0:
        return meal

    sum_ing = sum(float(i.get("estimated_grams", 0) or 0) for i in ingredients)
    if sum_ing <= 0:
        return meal

    scale = total / sum_ing
    for i in ingredients:
        i["estimated_grams"] = round(float(i.get("estimated_grams", 0)) * scale)

    return meal


def normalize_meal_structure(meal: dict) -> dict:
    normalized_ingredients = []
    unmatched_ingredients = []
    for item in meal.get("ingredients", []):
        raw_name = str(item.get("name", "ingredient"))
        usda_label = find_usda_label(raw_name)
        if not usda_label:
            unmatched_ingredients.append({
                "name": raw_name,
                "estimated_grams": item.get("estimated_grams"),
                "reason": "not_found_in_local_usda_csv",
            })
            continue

        entry = estimate_ingredient_entry(usda_label)
        entry["estimated_grams"] = round(float(item.get("estimated_grams", entry["estimated_grams"])))
        entry["estimated_sodium_mg"] = round(float(item.get("estimated_sodium_mg", entry["estimated_sodium_mg"])))
        entry["estimated_calories"] = round(float(item.get("estimated_calories", entry["estimated_calories"])))
        entry["estimated_protein_g"] = round(float(item.get("estimated_protein_g", entry.get("estimated_protein_g", 0))))
        entry["estimated_carbs_g"] = round(float(item.get("estimated_carbs_g", entry["estimated_carbs_g"])))
        entry["estimated_sugar_g"] = round(float(item.get("estimated_sugar_g", entry["estimated_sugar_g"])))
        entry["estimated_fat_g"] = round(float(item.get("estimated_fat_g", entry["estimated_fat_g"])))
        entry = enrich_ingredient_entry_with_usda(entry)
        normalized_ingredients.append(entry)

    meal["ingredients"] = normalized_ingredients
    if unmatched_ingredients:
        meal["unmatched_ingredients"] = unmatched_ingredients
        meal["dish_name"] = infer_dish_name_from_ingredients(meal) if normalized_ingredients else "unmatched meal"
    else:
        meal.pop("unmatched_ingredients", None)
    return recalculate_meal_totals(meal)


def get_gemini_api_key() -> str:
    state_key = st.session_state.get("gemini_api_key", "").strip()
    return state_key or os.getenv("GEMINI_API_KEY", "").strip()

@lru_cache(maxsize=1)
def load_local_usda():
    path = BASE_DIR / "usda_LLMprompt.csv"  
    df = pd.read_csv(path)
    df.columns = df.columns.str.lower().str.strip()
    df["food_name"] = df["food_name"].str.lower().str.strip()
    return df


@lru_cache(maxsize=256)
def search_usda_nutrients(food_name: str) -> dict | None:
    df = load_local_usda()

    food_name = canonical_food_name(food_name)
    match = df[df["food_name"] == food_name]
    if match.empty:
        food_name_pattern = re.escape(food_name)
        match = df[df["food_name"].str.contains(food_name_pattern, na=False)]

    if match.empty:
        return None

    row = match.iloc[0]

    return {
        "calories_per_100g": row.get("energy (kcal)"),
        "carbs_per_100g": row.get("carbohydrate, by difference (g)"),
        "sugar_per_100g": row.get("total sugars (g)"),
        "fat_per_100g": row.get("total lipid (fat) (g)"),
        "sodium_mg_per_100g": row.get("sodium, na (mg)"),
        "protein_per_100g": row.get("protein (g)"),
    }


def enrich_ingredient_entry_with_usda(entry: dict) -> dict:
    nutrient_values = search_usda_nutrients(str(entry.get("name", "")))
    if not nutrient_values:
        entry["nutrition_source"] = "fallback_default"
        return entry

    grams = float(entry.get("estimated_grams", 0))

    if nutrient_values.get("calories_per_100g") is not None:
        entry["estimated_calories"] = round(grams / 100 * nutrient_values["calories_per_100g"])
    if nutrient_values.get("carbs_per_100g") is not None:
        entry["estimated_carbs_g"] = round(grams / 100 * nutrient_values["carbs_per_100g"])
    if nutrient_values.get("sugar_per_100g") is not None:
        entry["estimated_sugar_g"] = round(grams / 100 * nutrient_values["sugar_per_100g"])
    if nutrient_values.get("fat_per_100g") is not None:
        entry["estimated_fat_g"] = round(grams / 100 * nutrient_values["fat_per_100g"])
    if nutrient_values.get("sodium_mg_per_100g") is not None:
        entry["estimated_sodium_mg"] = round(grams / 100 * nutrient_values["sodium_mg_per_100g"])
    if nutrient_values.get("protein_per_100g") is not None:
        entry["estimated_protein_g"] = round(grams / 100 * nutrient_values["protein_per_100g"])

    entry["nutrition_source"] = "local_usda_csv"
    return entry


def invalid_usda_ingredient_names(meal: dict) -> list[str]:
    invalid = []
    for item in meal.get("ingredients", []):
        name = str(item.get("name", "")).strip()
        if name and not find_usda_label(name):
            invalid.append(name)
    return invalid


def remap_meal_to_usda_labels_with_gemini(meal: dict, client) -> dict:
    invalid_names = invalid_usda_ingredient_names(meal)
    if not invalid_names:
        return meal

    labels = usda_food_labels()
    label_str = "\n".join(f"- {label}" for label in labels)
    remap_prompt = f"""
You are a strict local USDA label mapper.

Some ingredient names are not in the allowed local USDA table:
{json.dumps(invalid_names, ensure_ascii=True)}

Rewrite the meal JSON so EVERY ingredient name is exactly one label from ALLOWED_USDA_LABELS.
Keep each ingredient's estimated_grams from the input unless there is an obvious JSON formatting issue.
Do not add nutrients. Do not explain. Return JSON only.

ALLOWED_USDA_LABELS:
{label_str}

INPUT_MEAL_JSON:
{json.dumps(meal, ensure_ascii=True)}

Required output format:
{{
  "dish_name": "dish name",
  "ingredients": [
    {{"name": "EXACT_LABEL_FROM_ALLOWED_USDA_LABELS", "estimated_grams": 100}}
  ]
}}
"""
    response = client.models.generate_content(
        model="gemini-3.1-flash-lite-preview",
        contents=[remap_prompt],
    )
    text = response.text or ""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return meal

    try:
        remapped = json.loads(match.group())
    except json.JSONDecodeError:
        return meal

    if not isinstance(remapped, dict) or not isinstance(remapped.get("ingredients"), list):
        return meal
    return remapped


def detect_food_from_image(image: Image.Image, api_key: str) -> dict:
    if genai is None:
        raise RuntimeError("google-genai is not installed. Run: pip install -r requirements.txt")
    if not api_key:
        raise RuntimeError("Missing Gemini API key. Set GEMINI_API_KEY to enable uploaded meal analysis.")

    client = genai.Client(api_key=api_key)

    df_usda = load_local_usda()
    all_labels = df_usda['food_name'].unique().tolist()
    
    label_str = "\n".join([f"- {l}" for l in all_labels])

    DETECTION_PROMPT = f"""
    You are a nutrition database matcher. Analyze the image and map ingredients ONLY to the provided list.
    
    ALLOWED INGREDIENTS LIST:
    {label_str}
    
    STRICT RULES:
    1. If an item is a beverage (like coffee), you MUST pick a name starting with "Coffee" from the list.
    2. NEVER use the label "sauce" for a drink.
    3. If no exact match exists, pick the MOST semantically similar label from the list.
    4. Return JSON only: {{"dish_name": "...", "ingredients": [{{"name": "EXACT_LABEL_FROM_LIST", "estimated_grams": 100}}]}}
    """

    response = client.models.generate_content(
        model="gemini-3.1-flash-lite-preview",
        contents=[DETECTION_PROMPT, image],
    )

    result = json.loads(re.search(r"\{.*\}", response.text, re.DOTALL).group())

    result = fix_ingredient_grams(result)
    result = remap_meal_to_usda_labels_with_gemini(result, client)
    return normalize_meal_structure(result)


def refresh_corrected_meal_with_api(meal: dict, api_key: str) -> dict:
    if genai is None:
        raise RuntimeError("google-genai is not installed. Run: pip install -r requirements.txt")
    if not api_key:
        raise RuntimeError("Missing Gemini API key. Set GEMINI_API_KEY to enable corrected meal recalculation.")

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model="gemini-3.1-flash-lite-preview",
        contents=[
            MEAL_RECALCULATION_PROMPT,
            json.dumps(meal, ensure_ascii=True),
        ],
    )
    text = response.text or ""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("JSON not found in model response.")
    result = json.loads(match.group())
    result = remap_meal_to_usda_labels_with_gemini(result, client)
    return normalize_meal_structure(result)


def init_state() -> None:
    if "profile" not in st.session_state:
        st.session_state.profile = {
            "user_id": str(uuid.uuid4()),
            "age": 22,
            "gender": "female",
            "height_cm": 165.0,
            "weight_kg": 58.0,
            "goal": "maintain",
            "conditions": [],
            "dietary_restrictions": [],
            "daily_calories": 0,
            "daily_protein": 0.0,
        }
    else:
        profile = st.session_state.profile
        restrictions = profile.get("dietary_restrictions", [])
        for legacy_key in ("allergies", "diet_preferences"):
            for item in profile.get(legacy_key, []):
                if item not in restrictions:
                    restrictions.append(item)
        profile["dietary_restrictions"] = restrictions
        profile.pop("allergies", None)
        profile.pop("diet_preferences", None)
    if "meal" not in st.session_state:
        st.session_state.meal = None
    if "daily_intake" not in st.session_state:
        st.session_state.daily_intake = {
            "calories": 0,
            "carbs_g": 0,
            "sugar_g": 0,
            "sodium_mg": 0,
            "fat_g": 0,
        }
    if "confirmed_meal_keys" not in st.session_state:
        st.session_state.confirmed_meal_keys = []
    if "confirmed_meals" not in st.session_state:
        st.session_state.confirmed_meals = []
    if "chat_history" not in st.session_state:
        st.session_state.chat_history = []
    if "capability_tip" not in st.session_state:
        st.session_state.capability_tip = None


def calculate_targets(profile: dict) -> tuple[int, float]:
    gender = profile["gender"]
    weight = float(profile["weight_kg"])
    height = float(profile["height_cm"])
    age = int(profile["age"])

    if gender == "male":
        bmr = 10 * weight + 6.25 * height - 5 * age + 5
    else:
        bmr = 10 * weight + 6.25 * height - 5 * age - 161

    tdee = bmr * 1.55
    goal = profile["goal"]

    if goal == "lose_weight":
        tdee -= 500
        protein_factor = 1.6
    elif goal == "gain_weight":
        tdee += 350
        protein_factor = 1.4
    elif goal == "gain_muscle":
        tdee += 300
        protein_factor = 2.0
    else:
        protein_factor = 1.2

    return round(tdee), round(weight * protein_factor, 1)


def update_targets() -> None:
    calories, protein = calculate_targets(st.session_state.profile)
    st.session_state.profile["daily_calories"] = calories
    st.session_state.profile["daily_protein"] = protein


def render_capability_guide() -> None:
    capabilities = {
        "My profile": {
            "summary": "I can remember changes to your body details, goals, and health conditions.",
            "examples": [
                "My weight is 70 kg.",
                "Change my goal to lose weight.",
                "I want to gain muscle.",
                "I have hypertension.",
                "I have diabetes.",
            ],
        },
        "Food limits": {
            "summary": "I can keep track of foods you avoid, including allergies, and remove them later.",
            "examples": [
                "I am allergic to shrimp.",
                "I cannot eat tomatoes.",
                "I should avoid peanuts.",
                "I am not allergic to tomatoes.",
                "I can eat shrimp now.",
            ],
        },
        "Meal questions": {
            "summary": "I can explain the meal estimate and whether it fits your profile.",
            "examples": [
                "Analyze this meal.",
                "Is this meal healthy for me?",
                "Can I eat this with diabetes?",
                "What are the ingredients?",
                "How many calories are in this meal?",
            ],
        },
        "Fix ingredients": {
            "summary": "I can update the ingredient list when recognition gets something wrong.",
            "examples": [
                "Remove rice.",
                "Add broccoli.",
                "Replace prawn with tofu.",
                "This is not beef, it is chicken.",
            ],
        },
    }

    st.caption("Tell me about a meal, your goals, or foods you avoid. Tap a topic for example wording.")
    cols = st.columns(len(capabilities))
    for idx, label in enumerate(capabilities):
        if cols[idx].button(label, key=f"capability_tip_{label}", use_container_width=True):
            st.session_state.capability_tip = None if st.session_state.capability_tip == label else label

    active_tip = st.session_state.capability_tip
    if active_tip:
        capability = capabilities[active_tip]
        examples = "  \n".join(f"`{example}`" for example in capability["examples"][:3])
        st.markdown(
            f"{capability['summary']}  \n"
            f"Try: {examples}"
        )


def meal_tracking_key(meal: dict | None) -> str | None:
    if not meal:
        return None
    return json.dumps(meal, sort_keys=True, ensure_ascii=True)


def confirm_current_meal(meal: dict) -> bool:
    meal_key = meal_tracking_key(meal)
    if not meal_key or meal_key in st.session_state.confirmed_meal_keys:
        return False

    st.session_state.daily_intake["calories"] += round(float(meal.get("dish_estimated_calories", 0)))
    st.session_state.daily_intake["carbs_g"] += round(float(meal.get("dish_estimated_carbs_g", 0)))
    st.session_state.daily_intake["sugar_g"] += round(float(meal.get("dish_estimated_sugar_g", 0)))
    st.session_state.daily_intake["sodium_mg"] += round(float(meal.get("dish_estimated_sodium_mg", 0)))
    st.session_state.daily_intake["fat_g"] += round(float(meal.get("dish_estimated_fat_g", 0)))

    st.session_state.confirmed_meal_keys.append(meal_key)
    st.session_state.confirmed_meals.append(
        {
            "dish_name": meal.get("dish_name", "meal"),
            "calories": round(float(meal.get("dish_estimated_calories", 0))),
            "carbs_g": round(float(meal.get("dish_estimated_carbs_g", 0))),
            "sugar_g": round(float(meal.get("dish_estimated_sugar_g", 0))),
            "sodium_mg": round(float(meal.get("dish_estimated_sodium_mg", 0))),
            "fat_g": round(float(meal.get("dish_estimated_fat_g", 0))),
        }
    )
    return True


def infer_dish_name_from_ingredients(meal: dict) -> str:
    ingredient_names = [str(item.get("name", "")).strip().lower() for item in meal.get("ingredients", []) if item.get("name")]
    if not ingredient_names:
        return meal.get("dish_name", "meal")

    primary = []
    for item in ingredient_names:
        if item not in {"soy sauce", "salad dressing", "broth", "coconut broth"}:
            primary.append(item)
    primary = primary[:2] if primary else ingredient_names[:2]

    current_name = str(meal.get("dish_name", "meal")).lower()
    if "rice" in current_name:
        suffix = "rice bowl"
    elif "noodle" in current_name or "ramen" in current_name or "laksa" in current_name:
        suffix = "noodle bowl"
    elif "salad" in current_name:
        suffix = "salad"
    else:
        suffix = "dish"

    label_parts = []
    for word in primary:
        if suffix == "rice bowl" and "rice" in word:
            continue
        if suffix == "noodle bowl" and ("noodle" in word or "ramen" in word):
            continue
        if suffix == "salad" and "salad" in word:
            continue
        label_parts.append(word.title())

    label = " and ".join(label_parts) if label_parts else primary[0].title()
    return f"{label} {suffix}".strip()


def reset_daily_intake() -> None:
    st.session_state.daily_intake = {
        "calories": 0,
        "carbs_g": 0,
        "sugar_g": 0,
        "sodium_mg": 0,
        "fat_g": 0,
    }
    st.session_state.confirmed_meal_keys = []
    st.session_state.confirmed_meals = []


def sample_meals() -> dict:
    return {
        "Laksa": {
            "dish_name": "laksa",
            "dish_estimated_grams": 720,
            "dish_estimated_calories": 760,
            "dish_estimated_sodium_mg": 2100,
            "dish_estimated_carbs_g": 68,
            "dish_estimated_sugar_g": 8,
            "dish_estimated_fat_g": 34,
            "ingredients": [
                {"name": "noodle", "estimated_grams": 220, "estimated_sodium_mg": 180, "estimated_calories": 230, "estimated_carbs_g": 44, "estimated_sugar_g": 1, "estimated_fat_g": 2},
                {"name": "prawn", "estimated_grams": 90, "estimated_sodium_mg": 140, "estimated_calories": 100, "estimated_carbs_g": 1, "estimated_sugar_g": 0, "estimated_fat_g": 2},
                {"name": "egg", "estimated_grams": 50, "estimated_sodium_mg": 70, "estimated_calories": 80, "estimated_carbs_g": 1, "estimated_sugar_g": 0, "estimated_fat_g": 5},
                {"name": "coconut broth", "estimated_grams": 320, "estimated_sodium_mg": 1600, "estimated_calories": 330, "estimated_carbs_g": 18, "estimated_sugar_g": 6, "estimated_fat_g": 25},
                {"name": "bean sprout", "estimated_grams": 40, "estimated_sodium_mg": 30, "estimated_calories": 20, "estimated_carbs_g": 4, "estimated_sugar_g": 1, "estimated_fat_g": 0},
            ],
        },
        "Chicken Salad": {
            "dish_name": "chicken salad",
            "dish_estimated_grams": 420,
            "dish_estimated_calories": 390,
            "dish_estimated_sodium_mg": 460,
            "dish_estimated_carbs_g": 17,
            "dish_estimated_sugar_g": 8,
            "dish_estimated_fat_g": 19,
            "ingredients": [
                {"name": "chicken", "estimated_grams": 140, "estimated_sodium_mg": 120, "estimated_calories": 220, "estimated_carbs_g": 0, "estimated_sugar_g": 0, "estimated_fat_g": 10},
                {"name": "lettuce", "estimated_grams": 90, "estimated_sodium_mg": 20, "estimated_calories": 15, "estimated_carbs_g": 3, "estimated_sugar_g": 1, "estimated_fat_g": 0},
                {"name": "tomato", "estimated_grams": 60, "estimated_sodium_mg": 10, "estimated_calories": 10, "estimated_carbs_g": 2, "estimated_sugar_g": 2, "estimated_fat_g": 0},
                {"name": "cucumber", "estimated_grams": 50, "estimated_sodium_mg": 5, "estimated_calories": 8, "estimated_carbs_g": 2, "estimated_sugar_g": 1, "estimated_fat_g": 0},
                {"name": "salad dressing", "estimated_grams": 40, "estimated_sodium_mg": 280, "estimated_calories": 137, "estimated_carbs_g": 10, "estimated_sugar_g": 4, "estimated_fat_g": 9},
            ],
        },
        "Fried Rice": {
            "dish_name": "fried rice",
            "dish_estimated_grams": 600,
            "dish_estimated_calories": 820,
            "dish_estimated_sodium_mg": 1450,
            "dish_estimated_carbs_g": 86,
            "dish_estimated_sugar_g": 6,
            "dish_estimated_fat_g": 24,
            "ingredients": [
                {"name": "rice", "estimated_grams": 300, "estimated_sodium_mg": 80, "estimated_calories": 390, "estimated_carbs_g": 78, "estimated_sugar_g": 1, "estimated_fat_g": 3},
                {"name": "egg", "estimated_grams": 60, "estimated_sodium_mg": 90, "estimated_calories": 90, "estimated_carbs_g": 1, "estimated_sugar_g": 0, "estimated_fat_g": 6},
                {"name": "chicken", "estimated_grams": 100, "estimated_sodium_mg": 130, "estimated_calories": 180, "estimated_carbs_g": 0, "estimated_sugar_g": 0, "estimated_fat_g": 9},
                {"name": "carrot", "estimated_grams": 30, "estimated_sodium_mg": 15, "estimated_calories": 12, "estimated_carbs_g": 3, "estimated_sugar_g": 2, "estimated_fat_g": 0},
                {"name": "soy sauce", "estimated_grams": 25, "estimated_sodium_mg": 1100, "estimated_calories": 25, "estimated_carbs_g": 4, "estimated_sugar_g": 3, "estimated_fat_g": 0},
            ],
        },
    }


def parse_list_field(text: str) -> list[str]:
    if not text.strip():
        return []
    return unique_profile_items(item.strip().lower() for item in text.split(",") if item.strip())


PROFILE_ITEM_ALIASES = {
    "prawn": "shrimp",
    "prawns": "shrimp",
    "peanuts": "peanut",
    "eggs": "egg",
    "tree nuts": "nuts",
    "tomatoes": "tomato",
    "tomatos": "tomato",
    "tomotaes": "tomato",
    "cherry tomatoes": "tomato",
    "lychees": "lychee",
    "lyche": "lychee",
    "cherry tomato": "tomato",
    "low salt": "low_sodium",
    "low sodium": "low_sodium",
    "high protein": "high_protein",
    "low sugar": "low_sugar",
}


def normalize_profile_item(value: str) -> str:
    normalized = normalize_token(str(value))
    if normalized in PROFILE_ITEM_ALIASES:
        return PROFILE_ITEM_ALIASES[normalized]
    if normalized in {"low sodium", "high protein", "low sugar"}:
        return normalized.replace(" ", "_")
    return singularize_food_token(normalized)


def unique_profile_items(items) -> list[str]:
    unique = []
    for item in items:
        normalized = normalize_profile_item(str(item))
        if normalized and normalized not in unique:
            unique.append(normalized)
    return unique


def add_unique_profile_item(profile: dict, key: str, value: str, label: str, updates: list[str]) -> None:
    value = normalize_profile_item(value)
    if value not in profile[key]:
        profile[key].append(value)
        updates.append(f"{label} added: {value}")


def remove_profile_item(profile: dict, key: str, value: str, label: str, updates: list[str]) -> None:
    value = normalize_profile_item(value)
    original = profile.get(key, [])
    filtered = [item for item in original if normalize_profile_item(item) != value]
    if len(filtered) != len(original):
        profile[key] = filtered
        updates.append(f"{label} removed: {value}")


def sync_profile_restrictions(profile: dict) -> None:
    allergies = unique_profile_items(profile.get("allergies", []))
    diet_preferences = unique_profile_items(profile.get("diet_preferences", []))
    dietary_restrictions = unique_profile_items([
        *allergies,
        *diet_preferences,
        *profile.get("dietary_restrictions", []),
    ])

    profile["allergies"] = allergies
    profile["diet_preferences"] = diet_preferences
    profile["dietary_restrictions"] = dietary_restrictions


def add_profile_allergy(profile: dict, value: str, updates: list[str]) -> None:
    add_unique_profile_item(profile, "allergies", value, "allergy", updates)
    sync_profile_restrictions(profile)


def remove_profile_allergy(profile: dict, value: str, updates: list[str]) -> None:
    value = normalize_profile_item(value)
    before = set(unique_profile_items(profile.get("allergies", [])))
    profile["allergies"] = [
        item
        for item in unique_profile_items(profile.get("allergies", []))
        if normalize_profile_item(item) != value
    ]
    profile["dietary_restrictions"] = [
        item
        for item in unique_profile_items(profile.get("dietary_restrictions", []))
        if normalize_profile_item(item) != value
    ]
    if value in before:
        updates.append(f"allergy removed: {value}")
    sync_profile_restrictions(profile)


def add_profile_diet_preference(profile: dict, value: str, updates: list[str]) -> None:
    add_unique_profile_item(profile, "diet_preferences", value, "diet preference", updates)
    sync_profile_restrictions(profile)


def get_restrictions(profile: dict) -> set[str]:
    sync_profile_restrictions(profile)
    normalized = profile["dietary_restrictions"]
    return set(normalized)


def food_restrictions(profile: dict) -> set[str]:
    preference_labels = {"vegetarian", "vegan", "low_sodium", "low_sugar", "high_protein"}
    if "allergies" in profile:
        return set(unique_profile_items(profile.get("allergies", [])))
    return {item for item in get_restrictions(profile) if item not in preference_labels}


FOOD_MATCH_STOPWORDS = {
    "cooked",
    "raw",
    "fresh",
    "dried",
    "dry",
    "whole",
    "reduced",
    "low",
    "boiled",
    "fried",
    "roasted",
    "grilled",
    "baked",
    "with",
    "and",
    "in",
    "as",
    "ingredient",
    "nfs",
}


def meaningful_food_tokens(name: str) -> set[str]:
    return {
        singularize_food_token(token)
        for token in canonical_food_name(name).split()
        if len(token) > 1 and token not in FOOD_MATCH_STOPWORDS
    }


def restriction_matches_ingredient(restriction: str, ingredient: str) -> bool:
    restriction_name = canonical_food_name(restriction)
    ingredient_name = canonical_food_name(ingredient)
    if not restriction_name or not ingredient_name:
        return False
    if restriction_name == ingredient_name:
        return True

    restriction_tokens = set(restriction_name.split())
    ingredient_tokens = set(ingredient_name.split())
    if restriction_tokens and ingredient_tokens and restriction_tokens <= ingredient_tokens:
        return True

    restriction_core = meaningful_food_tokens(restriction_name)
    ingredient_core = meaningful_food_tokens(ingredient_name)
    return bool(restriction_core and ingredient_core and restriction_core <= ingredient_core)


def restricted_items_in_meal(profile: dict, meal: dict | None) -> list[str]:
    if not meal:
        return []
    restricted = food_restrictions(profile)
    matches = []
    for item in meal.get("ingredients", []):
        ingredient = canonical_food_name(str(item.get("name", "")))
        for restriction in restricted:
            if restriction_matches_ingredient(restriction, ingredient) and ingredient not in matches:
                matches.append(ingredient)
    return matches


def allergy_exclusion_note(meal: dict) -> str:
    excluded = meal.get("excluded_allergy_ingredients") or []
    if not excluded:
        return ""

    names = ", ".join(excluded)
    return (
        f"Allergy note: your profile says you are allergic to {names}. "
        f"I detected {names} in the image, so I did not include it in the nutrition calculation."
    )


def apply_allergy_exclusions(profile: dict, meal: dict | None) -> tuple[dict | None, list[str]]:
    if not meal:
        return meal, []

    restricted = food_restrictions(profile)
    if not restricted:
        return meal, []

    kept_ingredients = []
    excluded = list(meal.get("excluded_allergy_ingredients") or [])

    for item in meal.get("ingredients", []):
        ingredient_name = str(item.get("name", ""))
        matched_restriction = next(
            (
                restriction
                for restriction in restricted
                if restriction_matches_ingredient(restriction, ingredient_name)
            ),
            None,
        )

        if matched_restriction:
            excluded_name = canonical_food_name(ingredient_name) or canonical_food_name(matched_restriction)
            if excluded_name and excluded_name not in excluded:
                excluded.append(excluded_name)
        else:
            kept_ingredients.append(item)

    if len(kept_ingredients) == len(meal.get("ingredients", [])):
        return meal, []

    meal["ingredients"] = kept_ingredients
    meal["excluded_allergy_ingredients"] = excluded
    meal["allergy_exclusion_note"] = allergy_exclusion_note(meal)
    meal["dish_name"] = infer_dish_name_from_ingredients(meal)
    return recalculate_meal_totals(meal), excluded


def extract_profile_food_mentions(text: str, fallback_map: dict[str, str]) -> list[str]:
    foods = []
    foods.extend(extract_food_mentions(text))
    lowered = text.lower()
    for phrase, value in fallback_map.items():
        if phrase in lowered:
            foods.append(value)
    return unique_profile_items(foods)


def extract_cannot_eat_food_mentions(text: str) -> list[str]:
    lowered = text.lower()
    matches = re.findall(
        r"\b(?:i\s+)?(?:cannot|can't|can\s+not|could\s+not|should\s+not|must\s+not)\s+eat\s+([^,.!?;]+)",
        lowered,
    )
    foods = []
    for match in matches:
        cleaned = re.sub(r"\b(any|the|a|an|food|foods|ingredient|ingredients)\b", " ", match)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if cleaned:
            foods.append(canonical_food_name(cleaned) or cleaned)
    return unique_profile_items(foods)


def extract_can_eat_food_mentions(text: str) -> list[str]:
    lowered = text.lower()
    matches = re.findall(
        r"\b(?:i\s+)?(?:can|could)\s+(?:now\s+|actually\s+)?eat\s+([^,.!?;]+)",
        lowered,
    )
    foods = []
    for match in matches:
        cleaned = re.sub(r"\b(any|the|a|an|food|foods|ingredient|ingredients|now|again)\b", " ", match)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if cleaned:
            foods.append(normalize_profile_item(cleaned) or cleaned)
    return unique_profile_items(foods)


def is_restriction_removal_intent(text: str) -> bool:
    lowered = text.lower()
    patterns = [
        r"\bnot allergic to\b",
        r"\bnot allergy to\b",
        r"\bno longer allergic to\b",
        r"\bno allergy to\b",
        r"\bremove\b.+\b(allergy|allergies|restriction|restrictions)\b",
        r"\bdelete\b.+\b(allergy|allergies|restriction|restrictions)\b",
        r"\bclear\b.+\b(allergy|allergies|restriction|restrictions)\b",
        r"\bi can eat\b",
        r"\bi can now eat\b",
        r"\bi actually eat\b",
        r"\bi eat\b",
        r"\bi'm ok with\b",
        r"\bi am ok with\b",
        r"不过敏",
        r"可以吃",
        r"能吃",
        r"删除.*过敏",
        r"移除.*过敏",
    ]
    return any(re.search(pattern, lowered) for pattern in patterns)


def detect_profile_updates(text: str, profile: dict) -> list[str]:
    lowered = text.lower()
    updates = []
    sync_profile_restrictions(profile)
    profile["dietary_restrictions"] = unique_profile_items(profile.get("dietary_restrictions", []))
    allergies_map = {
        "shrimp": "shrimp",
        "prawn": "shrimp",
        "prawns": "shrimp",
        "peanut": "peanut",
        "peanuts": "peanut",
        "nuts": "nuts",
        "egg": "egg",
        "eggs": "egg",
        "tomato": "tomato",
        "tomatoes": "tomato",
        "tomatos": "tomato",
        "tomotaes": "tomato",
        "zucchini": "zucchini",
        "courgette": "zucchini",
        "虾": "shrimp",
        "花生": "peanut",
        "坚果": "nuts",
        "鸡蛋": "egg",
    }
    preferences_map = {
        "low sodium": "low_sodium",
        "low salt": "low_sodium",
        "vegetarian": "vegetarian",
        "high protein": "high_protein",
        "low sugar": "low_sugar",
        "低钠": "low_sodium",
        "低盐": "low_sodium",
        "素食": "vegetarian",
        "高蛋白": "high_protein",
        "低糖": "low_sugar",
    }
    for condition in extract_condition_entities(text):
        if condition not in profile["conditions"]:
            profile["conditions"].append(condition)
            updates.append(f"condition added: {condition}")

    allergy_trigger = any(
        token in lowered
        for token in [
            "allergic",
            "allergy",
            "cannot eat",
            "can't eat",
            "can not eat",
            "should avoid",
            "must avoid",
            "过敏",
            "不能吃",
            "不可以吃",
        ]
    )
    food_library = load_food_library(FOOD_LIBRARY_PATH)
    allergy_items = extract_allergy_entities(text, food_library)
    cannot_eat_items = extract_cannot_eat_food_mentions(text) if allergy_trigger else []
    if cannot_eat_items:
        allergy_items = cannot_eat_items
    elif allergy_trigger and not allergy_items:
        allergy_items = extract_food_mentions(text)
    removal_items = extract_food_entities(text, food_library)
    can_eat_items = extract_can_eat_food_mentions(text) if is_restriction_removal_intent(text) else []
    if can_eat_items:
        removal_items = can_eat_items
    elif is_restriction_removal_intent(text) and not removal_items:
        removal_items = extract_food_mentions(text)

    if is_restriction_removal_intent(text):
        for item in removal_items:
            remove_profile_allergy(profile, item, updates)
    else:
        if allergy_trigger:
            for item in allergy_items:
                add_profile_allergy(profile, item, updates)

    for phrase, value in preferences_map.items():
        if phrase in lowered:
            add_profile_diet_preference(profile, value, updates)

    goal_result = parse_sequential_goal_update(text)
    if goal_result["is_update"] and goal_result["final_goal"]:
        if profile["goal"] != goal_result["final_goal"]:
            profile["goal"] = goal_result["final_goal"]
            updates.append(f"goal updated: {goal_result['final_goal']}")

    weight_result = parse_sequential_weight_update(text)
    if weight_result["is_update"] and weight_result["extracted_weight_kg"] is not None:
        extracted_weight = float(weight_result["extracted_weight_kg"])
        if float(profile["weight_kg"]) != extracted_weight:
            profile["weight_kg"] = extracted_weight
            updates.append(f"weight updated: {profile['weight_kg']} kg")

    height_match = re.search(r"\b(?:height is|my height is|height|i am|i'm)\s+(\d{2,3}(?:\.\d+)?)\s*cm\b", lowered)
    if height_match and not weight_result["is_update"]:
        profile["height_cm"] = float(height_match.group(1))
        updates.append(f"height updated: {profile['height_cm']} cm")

    if any(token in lowered for token in [" male", "man", "boy"]):
        if profile["gender"] != "male":
            profile["gender"] = "male"
            updates.append("gender updated: male")
    if any(token in lowered for token in ["female", "woman", "girl"]):
        if profile["gender"] != "female":
            profile["gender"] = "female"
            updates.append("gender updated: female")

    return updates


def biggest_sodium_source(meal: dict) -> dict | None:
    ingredients = meal.get("ingredients", [])
    if not ingredients:
        return None
    return max(ingredients, key=lambda item: item.get("estimated_sodium_mg", 0))


def ingredient_names(meal: dict) -> list[str]:
    return [str(item.get("name", "")).lower() for item in meal.get("ingredients", [])]


def score_meal(profile: dict, meal: dict, kb: list[dict]) -> tuple[list[dict], list[str]]:
    matched_rules = []
    risk_notes = []
    sodium = meal.get("dish_estimated_sodium_mg", 0)
    calories = meal.get("dish_estimated_calories", 0)
    daily_calories = profile.get("daily_calories", 0)
    conditions = set(profile.get("conditions", []))
    names = ingredient_names(meal)

    low_sodium_user = (
        "hypertension" in conditions
        or "kidney_disease" in conditions
        or "low_sodium" in get_restrictions(profile)
        or profile["goal"] == "reduce_sodium"
    )

    for rule in nutrition_kb_items(kb):
        tags = set(rule.get("tags", []))
        if rule["topic"] == "sodium" and low_sodium_user:
            matched_rules.append(rule)
            if sodium >= 1000:
                risk_notes.append("This meal is high in sodium for a low-sodium user.")
        elif rule["topic"] == "sugar" and "diabetes" in conditions:
            matched_rules.append(rule)
        elif rule["topic"] == "healthy_diet":
            matched_rules.append(rule)
        elif rule["topic"] == "fat" and ("hyperlipidemia" in conditions or calories >= 700):
            matched_rules.append(rule)

    if profile["goal"] == "lose_weight" and daily_calories:
        if calories >= math.floor(daily_calories * 0.45):
            risk_notes.append("This meal uses a large share of the user's daily calorie target.")

    if "diabetes" in conditions:
        if any(token in names for token in ["rice", "noodle", "fried rice", "dessert", "sweet drink", "soda"]):
            risk_notes.append("For diabetes, this meal may need portion control because it contains concentrated carbohydrate sources.")

    if "hyperlipidemia" in conditions:
        if calories >= 700 or any(token in names for token in ["fried chicken", "coconut broth", "salad dressing"]):
            risk_notes.append("For high cholesterol or hyperlipidemia, this meal may be heavier in fat or energy than ideal.")

    if "kidney_disease" in conditions and sodium >= 900:
        risk_notes.append("For kidney disease, sodium reduction is especially important, and this meal looks relatively salty.")

    if "gout" in conditions and any(token in names for token in ["prawn", "shrimp", "anchovy", "sardine", "broth"]):
        risk_notes.append("For gout, some ingredients here may be higher in purines, so moderation may be helpful.")

    main_source = biggest_sodium_source(meal)
    if main_source and main_source.get("estimated_sodium_mg", 0) >= 500:
        risk_notes.append(
            f"The main sodium source appears to be {main_source['name']} "
            f"({main_source['estimated_sodium_mg']} mg)."
        )

    return matched_rules, risk_notes


def generate_advice(profile: dict, meal: dict, kb: list[dict]) -> str:
    matched_rules, risk_notes = score_meal(profile, meal, kb)
    dish = meal["dish_name"]
    sodium = meal.get("dish_estimated_sodium_mg", 0)
    calories = meal.get("dish_estimated_calories", 0)
    main_source = biggest_sodium_source(meal)

    advice = [f"This looks like {dish}, estimated at about {calories} kcal and {sodium} mg sodium."]
    exclusion_note = allergy_exclusion_note(meal)
    if exclusion_note:
        advice.append(exclusion_note)

    restrictions = get_restrictions(profile)
    risky_restricted_items = restricted_items_in_meal(profile, meal)

    if risky_restricted_items:
        advice.append(
            "Your profile says you restrict "
            + ", ".join(risky_restricted_items)
            + ", and this meal may contain it."
        )

    if risk_notes:
        advice.extend(risk_notes)

    if main_source and main_source.get("name") in {"coconut broth", "broth", "soy sauce", "salad dressing"}:
        advice.append(f"A practical first step is to reduce the {main_source['name']}, since it drives much of the sodium.")

    if profile["goal"] == "lose_weight":
        advice.append("For weight-loss support, consider a smaller portion or add more vegetables before choosing seconds.")
    elif profile["goal"] == "gain_weight":
        advice.append("For healthy weight gain, add energy-dense but balanced foods such as rice, dairy, nuts if safe, or an extra protein serving.")
    elif profile["goal"] == "gain_muscle":
        advice.append("For muscle gain, keep a solid protein portion and pair it with a less salty side if possible.")
    else:
        advice.append("For a balanced choice, focus on portion control and try to add vegetables or fruit elsewhere in the day.")

    if matched_rules:
        rule_titles = "; ".join(rule["short_label"] for rule in matched_rules[:3])
        advice.append(f"WHO evidence used: {rule_titles}.")

    advice.append("This is general nutrition support, not a medical diagnosis.")
    return " ".join(advice)


def build_meal_insight(profile: dict, meal: dict, kb: list[dict]) -> dict:
    matched_rules, risk_notes = score_meal(profile, meal, kb)
    main_source = biggest_sodium_source(meal)
    ingredients = meal.get("ingredients", [])

    headline = f"{meal['dish_name'].title()} is estimated at {meal.get('dish_estimated_calories', 0)} kcal and {meal.get('dish_estimated_sodium_mg', 0)} mg sodium."
    top_ingredients = ", ".join(item["name"] for item in ingredients[:4]) if ingredients else "No ingredients available"

    actions = []
    if main_source and main_source.get("name") in {"coconut broth", "broth", "soy sauce", "salad dressing"}:
        actions.append(f"Reduce the {main_source['name']} first, because it is the main sodium driver.")
    if profile["goal"] == "lose_weight":
        actions.append("Keep the portion moderate and add vegetables or fruit later in the day.")
    elif profile["goal"] == "gain_weight":
        actions.append("Add a calorie-dense but balanced side such as rice, yogurt, milk, or another safe protein serving.")
    elif profile["goal"] == "gain_muscle":
        actions.append("Keep the protein-rich parts and pair them with a simpler, lower-sodium side.")
    else:
        actions.append("Balance this meal by watching portion size and adding more vegetables across the day.")

    if not risk_notes:
        risk_notes.append("No major rule-based risk was triggered for the current profile, but the meal values are still estimates.")

    return {
        "headline": headline,
        "top_ingredients": top_ingredients,
        "main_risk": risk_notes[0],
        "risk_notes": risk_notes,
        "actions": actions,
        "who_rules": matched_rules,
        "full_advice": generate_advice(profile, meal, kb),
    }


def split_correction_sentences(text: str) -> list[str]:
    parts = re.split(r"[.!?;:,\n]+", text)
    return [part.strip() for part in parts if part.strip()]


def extract_food_mentions(text: str) -> list[str]:
    normalized_text = normalize_token(text)
    normalized_text = normalized_text.replace("soap", "soup")
    matched = []

    for label in sorted(usda_food_labels(), key=len, reverse=True):
        label_normalized = normalize_token(label)
        if not label_normalized:
            continue
        label_variants = {label_normalized, singularize_food_token(label_normalized)}
        if any(re.search(r"\b" + re.escape(variant) + r"\b", normalized_text) for variant in label_variants):
            usda_label = find_usda_label(label) or label
            if usda_label not in matched:
                matched.append(usda_label)

    fallback_map = {
        "beef": "beef",
        "beef broth": "beef broth",
        "beef soup": "beef broth",
        "pork": "pork",
        "chicken": "chicken",
        "egg": "egg",
        "eggs": "egg",
        "shrimp": "shrimp",
        "prawn": "shrimp",
        "rice": "rice",
        "noodle": "noodle",
        "potato": "potato",
        "radish": "radish",
        "tofu": "tofu",
        "zucchini": "zucchini",
        "courgette": "zucchini",
        "sauce": "sauce",
        "broth": "broth",
        "soup": "broth",
        "soap": "broth",
    }
    for token, canonical in sorted(fallback_map.items(), key=lambda item: len(item[0]), reverse=True):
        canonical = find_usda_label(canonical) or canonical_food_name(canonical)
        if re.search(r"\b" + re.escape(token) + r"\b", normalized_text) and canonical not in matched:
            matched.append(canonical)

    return matched


def find_matching_ingredient_name(meal: dict, food_name: str) -> str | None:
    normalized_target = canonical_food_name(food_name)
    synonym_pairs = {
        "soup": "broth",
        "broth": "soup",
        "soap": "soup",
    }
    for item in meal.get("ingredients", []):
        current = canonical_food_name(str(item.get("name", "")))
        if not current:
            continue
        if current == normalized_target or normalized_target in current or current in normalized_target:
            return item["name"]
        target_tokens = normalized_target.split()
        current_tokens = current.split()
        if target_tokens and current_tokens:
            overlap = set(target_tokens) & set(current_tokens)
            if overlap:
                swapped_target = " ".join(synonym_pairs.get(token, token) for token in target_tokens)
                if swapped_target and (swapped_target in current or current in swapped_target):
                    return item["name"]
    return None


def find_protein_like_ingredient(meal: dict, exclude: set[str] | None = None) -> str | None:
    exclude = exclude or set()
    preferred_classes = {"protein", "seafood"}
    for item in meal.get("ingredients", []):
        item_name = str(item.get("name", ""))
        if normalize_token(item_name) in exclude:
            continue
        if item.get("food_class") in preferred_classes:
            return item_name

    for item in meal.get("ingredients", []):
        item_name = str(item.get("name", ""))
        normalized = normalize_token(item_name)
        if normalized in exclude:
            continue
        if any(token in normalized for token in ["pork", "beef", "chicken", "shrimp", "prawn", "meat", "fish"]):
            return item_name
    return None


def infer_correction_command(text: str, meal: dict) -> dict | None:
    lowered = text.lower().strip()
    lowered = re.sub(r"\bdidnot\b", "did not", lowered)
    lowered = re.sub(r"\bdont\b", "don't", lowered)
    lowered = re.sub(r"\bsoap\b", "soup", lowered)
    foods = extract_food_mentions(text)

    replace_patterns = [
        r"\bsome of the (?P<old>.+?) is (?P<new>.+)\b",
        r"\bpart of the (?P<old>.+?) is (?P<new>.+)\b",
        r"\bthis is not (?P<old>.+?)\s+(?:this is|it is|it's|its)\s+(?P<new>.+)\b",
        r"\bnot (?P<old>.+?)\s+(?:but|it is|it's|this is)\s+(?P<new>.+)\b",
        r"\breplace (?P<old>.+?) with (?P<new>.+)\b",
        r"\bswap (?P<old>.+?) with (?P<new>.+)\b",
        r"\bchange (?P<old>.+?) to (?P<new>.+)\b",
        r"\b(?P<old>.+?)\s+is\s+(?P<new>.+)\b",
        r"\bthe (?:meat|protein|ingredient|food)\s+is (?P<new>.+)\b",
        r"\bit\s+is (?P<new>.+)\b",
    ]
    for pattern in replace_patterns:
        match = re.search(pattern, lowered)
        if not match:
            continue
        new_foods = extract_food_mentions(match.group("new"))
        if not new_foods:
            continue

        old_group = match.groupdict().get("old")
        old_foods = extract_food_mentions(old_group) if old_group else []
        if old_foods:
            return {"action": "replace", "from": old_foods[0], "to": new_foods[0]}
        if old_group:
            matched_old_name = find_matching_ingredient_name(meal, old_group)
            if matched_old_name:
                return {"action": "replace", "from": matched_old_name, "to": new_foods[0]}

        contextual_old = [food for food in foods if food != new_foods[0]]
        if contextual_old:
            return {"action": "replace", "from": contextual_old[0], "to": new_foods[0]}

        protein_candidate = find_protein_like_ingredient(meal, exclude={normalize_token(new_foods[0])})
        if protein_candidate:
            return {"action": "replace", "from": protein_candidate, "to": new_foods[0]}

    non_consumption_patterns = [
        r"\bi did not eat (?P<food>.+)\b",
        r"\bi didn't eat (?P<food>.+)\b",
        r"\bi didnot eat (?P<food>.+)\b",
        r"\bi did not have (?P<food>.+)\b",
        r"\bi didn't have (?P<food>.+)\b",
        r"\bi do not drink (?P<food>.+)\b",
        r"\bi don't drink (?P<food>.+)\b",
        r"\bi did not drink (?P<food>.+)\b",
        r"\bi didn't drink (?P<food>.+)\b",
        r"\bi do not drink the (?P<food>.+)\b",
        r"\bi don't drink the (?P<food>.+)\b",
        r"\bi skipped (?P<food>.+)\b",
        r"\bi left (?P<food>.+)\b",
        r"\bi did not eat the (?P<food>.+)\b",
        r"\bi didn't eat the (?P<food>.+)\b",
        r"\bi didnot eat the (?P<food>.+)\b",
    ]
    for pattern in non_consumption_patterns:
        match = re.search(pattern, lowered)
        if not match:
            continue
        target_foods = extract_food_mentions(match.group("food"))
        if target_foods:
            return {"action": "remove", "food": target_foods[0]}

    if any(phrase in lowered for phrase in ["there is no ", "there is not ", "remove ", "delete ", "exclude ", "take away "]):
        if foods:
            return {"action": "remove", "food": foods[0]}

    if any(phrase in lowered for phrase in ["add ", "include ", "you missed ", "there is another ingredient", "there is "]):
        if foods:
            if "there is no " not in lowered and "there is not " not in lowered:
                return {"action": "add", "food": foods[-1]}

    if any(phrase in lowered for phrase in ["this is correct", "looks good", "yes correct", "that is right"]):
        return {"action": "confirm"}

    if len(foods) >= 2 and (re.search(r"\bnot\b", lowered) or "wrong" in lowered):
        return {"action": "replace", "from": foods[0], "to": foods[-1]}

    return None


def apply_meal_correction(text: str, meal: dict, api_key: str | None = None) -> tuple[dict, str | None]:
    lowered = text.lower().strip()
    ingredients = meal.get("ingredients", [])

    def finalize_corrected_meal(updated_meal: dict, action_message: str) -> tuple[dict, str]:
        api_used = False
        if api_key:
            try:
                updated_meal = refresh_corrected_meal_with_api(updated_meal, api_key)
                api_used = True
            except Exception:
                pass

        if not api_used:
            updated_meal["dish_name"] = infer_dish_name_from_ingredients(updated_meal)
            updated_meal = normalize_meal_structure(updated_meal)

        suffix = (
            " I also refreshed the dish name and nutrition estimate."
            if api_used
            else " I refreshed the dish name and re-ran the nutrition calculation from the updated JSON."
        )
        return updated_meal, action_message + suffix

    for sentence in split_correction_sentences(text):
        inferred_command = infer_correction_command(sentence, meal)
        if not inferred_command:
            continue

        if inferred_command["action"] == "confirm":
            return meal, "Thanks for confirming the meal analysis."

        if inferred_command["action"] == "replace":
            old_name = find_matching_ingredient_name(meal, inferred_command["from"]) or inferred_command["from"]
            new_name = inferred_command["to"]
            replaced = False
            for item in meal["ingredients"]:
                if normalize_token(item["name"]) == normalize_token(old_name):
                    original_grams = item.get("estimated_grams")
                    replacement = estimate_ingredient_entry(new_name)
                    if original_grams is not None:
                        replacement["estimated_grams"] = original_grams
                    item.update(replacement)
                    replaced = True
                    break
            if replaced:
                return finalize_corrected_meal(meal, f"Updated the meal: replaced {old_name} with {new_name}.")

        if inferred_command["action"] == "remove":
            food = inferred_command["food"]
            matched_name = find_matching_ingredient_name(meal, food)
            if matched_name:
                meal["ingredients"] = [item for item in ingredients if normalize_token(item["name"]) != normalize_token(matched_name)]
                return finalize_corrected_meal(meal, f"Updated the meal: removed {matched_name}.")

        if inferred_command["action"] == "add":
            food = inferred_command["food"]
            if not find_matching_ingredient_name(meal, food):
                meal["ingredients"].append(estimate_ingredient_entry(food))
                return finalize_corrected_meal(meal, f"Updated the meal: added {food}.")

    inferred_command = infer_correction_command(text, meal)
    if inferred_command:
        if inferred_command["action"] == "confirm":
            return meal, "Thanks for confirming the meal analysis."

        if inferred_command["action"] == "replace":
            old_name = find_matching_ingredient_name(meal, inferred_command["from"]) or inferred_command["from"]
            new_name = inferred_command["to"]
            replaced = False
            for item in meal["ingredients"]:
                if normalize_token(item["name"]) == normalize_token(old_name):
                    original_grams = item.get("estimated_grams")
                    replacement = estimate_ingredient_entry(new_name)
                    if original_grams is not None:
                        replacement["estimated_grams"] = original_grams
                    item.update(replacement)
                    replaced = True
                    break
            if replaced:
                return finalize_corrected_meal(meal, f"Updated the meal: replaced {old_name} with {new_name}.")

        if inferred_command["action"] == "remove":
            food = inferred_command["food"]
            matched_name = find_matching_ingredient_name(meal, food)
            if matched_name:
                meal["ingredients"] = [item for item in ingredients if normalize_token(item["name"]) != normalize_token(matched_name)]
                return finalize_corrected_meal(meal, f"Updated the meal: removed {matched_name}.")

        if inferred_command["action"] == "add":
            food = inferred_command["food"]
            if not find_matching_ingredient_name(meal, food):
                meal["ingredients"].append(estimate_ingredient_entry(food))
                return finalize_corrected_meal(meal, f"Updated the meal: added {food}.")

    if lowered.startswith("remove "):
        food = lowered.replace("remove ", "", 1).strip()
        meal["ingredients"] = [item for item in ingredients if item["name"].lower() != food]
        return finalize_corrected_meal(meal, f"Removed {food} from the meal.")

    if lowered.startswith("add "):
        food = lowered.replace("add ", "", 1).strip()
        meal["ingredients"].append(estimate_ingredient_entry(food))
        return finalize_corrected_meal(meal, f"Added {food} to the meal.")

    if lowered.startswith("replace ") and " with " in lowered:
        old_name, new_name = lowered.replace("replace ", "", 1).split(" with ", 1)
        for item in meal["ingredients"]:
            if item["name"].lower() == old_name.strip():
                original_grams = item.get("estimated_grams")
                replacement = estimate_ingredient_entry(new_name.strip())
                if original_grams is not None:
                    replacement["estimated_grams"] = original_grams
                item.update(replacement)
                return finalize_corrected_meal(meal, f"Replaced {old_name.strip()} with {new_name.strip()}.")

    return meal, None


def format_profile_summary(profile: dict) -> str:
    sync_profile_restrictions(profile)
    return (
        f"Age {profile['age']}, gender {profile['gender']}, height {profile['height_cm']} cm, "
        f"weight {profile['weight_kg']} kg, goal {profile['goal']}, daily target about "
        f"{profile['daily_calories']} kcal and {profile['daily_protein']} g protein. "
        f"Conditions: {', '.join(profile['conditions']) if profile['conditions'] else 'none'}. "
        f"Allergies: {', '.join(profile['allergies']) if profile['allergies'] else 'none'}. "
        f"Diet preferences: {', '.join(profile['diet_preferences']) if profile['diet_preferences'] else 'none'}."
    )


def format_meal_summary(meal: dict) -> str:
    ingredients = meal.get("ingredients", [])
    ingredient_names = ", ".join(item["name"] for item in ingredients[:6]) if ingredients else "no ingredients listed"
    return (
        f"Current meal is {meal['dish_name']} with about {meal.get('dish_estimated_calories', 0)} kcal, "
        f"{meal.get('dish_estimated_carbs_g', 0)} g carbs, {meal.get('dish_estimated_sugar_g', 0)} g sugar, "
        f"{meal.get('dish_estimated_fat_g', 0)} g fat, {meal.get('dish_estimated_sodium_mg', 0)} mg sodium, "
        f"and ingredients including {ingredient_names}."
    )


def format_ingredient_calorie_breakdown(meal: dict, limit: int = 6) -> str:
    ingredients = meal.get("ingredients", [])[:limit]
    if not ingredients:
        return "No ingredient calorie breakdown is available."

    parts = []
    for item in ingredients:
        name = str(item.get("name", "ingredient"))
        grams = round(float(item.get("estimated_grams", 0)))
        calories = round(float(item.get("estimated_calories", 0)))
        parts.append(f"{name}: {calories} kcal ({grams} g)")

    return "Ingredient calories: " + "; ".join(parts) + "."


def build_chat_image_analysis_reply(meal: dict, profile: dict, kb: list[dict]) -> str:
    insight = build_meal_insight(profile, meal, kb)
    exclusion_note = allergy_exclusion_note(meal)
    exclusion_prefix = f"{exclusion_note} " if exclusion_note else ""
    return (
        f"I analyzed your uploaded meal image. {exclusion_prefix}{insight['headline']} "
        f"{format_ingredient_calorie_breakdown(meal)} "
        f"Main note: {insight['main_risk']} "
        f"Suggested next step: {insight['actions'][0]} "
        f"You can now confirm this meal to add it to today's intake."
    )


def build_meal_correction_reply(action_message: str, meal: dict, profile: dict, kb: list[dict]) -> str:
    insight = build_meal_insight(profile, meal, kb)
    exclusion_note = allergy_exclusion_note(meal)
    exclusion_text = f"{exclusion_note} " if exclusion_note else ""
    return (
        f"{action_message} {exclusion_text}"
        f"The updated dish is {meal.get('dish_name', 'meal').title()} with about "
        f"{meal.get('dish_estimated_calories', 0)} kcal, {meal.get('dish_estimated_carbs_g', 0)} g carbs, "
        f"{meal.get('dish_estimated_sugar_g', 0)} g sugar, {meal.get('dish_estimated_fat_g', 0)} g fat, "
        f"and {meal.get('dish_estimated_sodium_mg', 0)} mg sodium. "
        f"{format_ingredient_calorie_breakdown(meal)} "
        f"Main risk: {insight['main_risk']} "
        f"You can confirm this meal to add it to today's intake."
    )


def build_confirm_meal_reply(meal: dict, profile: dict, kb: list[dict]) -> str:
    insight = build_meal_insight(profile, meal, kb)
    daily_intake = st.session_state.daily_intake
    return (
        f"Meal confirmed. {meal.get('dish_name', 'Meal').title()} was added to today's intake. "
        f"This meal contributes about {meal.get('dish_estimated_calories', 0)} kcal, "
        f"{meal.get('dish_estimated_carbs_g', 0)} g carbs, {meal.get('dish_estimated_sugar_g', 0)} g sugar, "
        f"{meal.get('dish_estimated_fat_g', 0)} g fat, and {meal.get('dish_estimated_sodium_mg', 0)} mg sodium. "
        f"{format_ingredient_calorie_breakdown(meal)} "
        f"Today's running total is now {daily_intake['calories']} kcal, {daily_intake['carbs_g']} g carbs, "
        f"{daily_intake['sugar_g']} g sugar, {daily_intake['fat_g']} g fat, and {daily_intake['sodium_mg']} mg sodium. "
        f"Main insight: {insight['main_risk']}"
    )


def infer_user_intent(user_text: str) -> str | None:
    intent = recognize_user_intent(user_text).get("intent")
    if intent == "unknown":
        return None
    return intent


def build_condition_guidance(profile: dict, meal: dict | None, kb: list[dict]) -> str:
    conditions = profile.get("conditions", [])
    if not conditions:
        return "I have not stored a disease or condition for you yet. You can say things like 'I have hypertension' or 'I have diabetes'."

    advice_parts = [entry["summary"] for entry in get_condition_guidance_entries(conditions, kb)]

    if meal:
        insight = build_meal_insight(profile, meal, kb)
        advice_parts.append(f"For your current meal, the main issue is: {insight['main_risk']}")

    return " ".join(advice_parts)


def build_diet_preference_guidance(profile: dict, meal: dict | None) -> str:
    restrictions = get_restrictions(profile)
    conditions = set(profile.get("conditions", []))

    allowed = []
    avoid = []

    if "vegetarian" in restrictions:
        allowed.append("vegetables, tofu, beans, eggs, and dairy if you include them")
        avoid.append("meat and seafood")
    if "high_protein" in restrictions or profile.get("goal") == "gain_muscle":
        allowed.append("lean chicken, fish, tofu, eggs, Greek yogurt, and beans")
    if "low_sodium" in restrictions or "hypertension" in conditions:
        allowed.append("fresh foods, clear ingredient meals, and sauces on the side")
        avoid.append("soy sauce, broth-heavy dishes, processed meat, and salty dressings")
    if "low_sugar" in restrictions or "diabetes" in conditions:
        allowed.append("high-fibre carbs, vegetables, and lower-sugar snacks")
        avoid.append("sweet drinks, desserts, and heavily sweetened sauces")
    if "hyperlipidemia" in conditions:
        allowed.append("oats, beans, vegetables, fish, and lean protein with lighter cooking methods")
        avoid.append("deep-fried foods, creamy sauces, and heavily processed snacks")
    if "kidney_disease" in conditions:
        allowed.append("simple home-style meals with clear ingredients and lighter seasoning")
        avoid.append("very salty soups, instant foods, and highly processed meals")
    if "gout" in conditions:
        allowed.append("vegetables, low-fat dairy, eggs, tofu, and moderate portions of lean protein")
        avoid.append("organ meats, anchovies, sardines, rich broths, and some shellfish")
    if "fatty_liver" in conditions:
        allowed.append("vegetables, beans, whole grains, and lean protein in moderate portions")
        avoid.append("sugary drinks, frequent fried foods, and energy-dense processed snacks")
    if "gastritis" in conditions:
        allowed.append("soft, simple, less irritating meals with gentle cooking")
        avoid.append("very spicy food, greasy food, alcohol, and strongly acidic items if they worsen symptoms")
    if "reflux" in conditions:
        allowed.append("smaller lighter meals and simpler protein plus vegetables")
        avoid.append("very greasy meals, late heavy meals, and common trigger foods if they bother you")
    if "anemia" in conditions:
        allowed.append("iron-rich foods such as lean meat, beans, tofu, leafy greens, and vitamin C-rich fruit")
        avoid.append("tea or coffee right around iron-rich meals if iron intake is a concern")
    if "constipation" in conditions:
        allowed.append("fruit, vegetables, legumes, oats, and other higher-fibre foods with enough water")
        avoid.append("very low-fibre patterns and long periods without fluids")
    allergen_restrictions = sorted(food_restrictions(profile))
    if allergen_restrictions:
        avoid.append("foods containing " + ", ".join(allergen_restrictions))

    if meal:
        risky = restricted_items_in_meal(profile, meal)
        if risky:
            avoid.append("the current meal because it may contain " + ", ".join(risky))

    if not allowed and not avoid:
        return "Tell me your dietary restrictions first, for example vegetarian, low sodium, low sugar, or allergic to shrimp, and I can say what to eat or avoid."

    allowed_text = "Good options: " + "; ".join(allowed[:4]) + "." if allowed else ""
    avoid_text = " Avoid or limit: " + "; ".join(avoid[:4]) + "." if avoid else ""
    return (allowed_text + avoid_text).strip()


def build_goal_change_reply(profile: dict) -> str:
    goal_labels = {
        "lose_weight": "weight loss",
        "gain_weight": "weight gain",
        "gain_muscle": "muscle gain",
        "maintain": "maintenance",
    }
    goal = goal_labels.get(profile["goal"], profile["goal"])
    return (
        f"Your goal is now set to {goal}. Your daily target is about "
        f"{profile['daily_calories']} kcal and {profile['daily_protein']} g protein."
    )


def build_condition_update_reply(profile: dict, kb: list[dict], meal: dict | None = None) -> str:
    conditions = profile.get("conditions", [])
    if not conditions:
        return "I have not stored any condition yet."

    readable = ", ".join(conditions)
    parts = [f"I noted these conditions in your profile: {readable}."]

    topic_queries = []
    if "diabetes" in conditions:
        topic_queries.append("diabetes sugar healthy diet")
    if "hypertension" in conditions:
        topic_queries.append("hypertension sodium potassium")
    if "hyperlipidemia" in conditions:
        topic_queries.append("high cholesterol fat healthy diet")
    if "kidney_disease" in conditions:
        topic_queries.append("kidney disease sodium potassium")
    if "gout" in conditions:
        topic_queries.append("healthy diet sugar")
    if "fatty_liver" in conditions:
        topic_queries.append("weight management sugar fat healthy diet")
    if "gastritis" in conditions:
        topic_queries.append("healthy diet")
    if "reflux" in conditions:
        topic_queries.append("healthy diet")
    if "anemia" in conditions:
        topic_queries.append("healthy diet fruit vegetables")
    if "constipation" in conditions:
        topic_queries.append("healthy diet fibre fruit vegetables")

    condition_entries = get_condition_guidance_entries(conditions, kb)
    if condition_entries:
        top_condition_entries = condition_entries[:2]
        parts.append(
            "WHO condition guidance: "
            + " ".join(f"{item['short_label']}: {item['summary']}" for item in top_condition_entries)
        )

    who_summaries = []
    for query in topic_queries:
        for item in find_kb_matches(query, kb):
            if item["short_label"] not in {entry["short_label"] for entry in who_summaries}:
                who_summaries.append(item)

    if who_summaries:
        top_items = who_summaries[:2]
        parts.append(
            "Relevant WHO guidance: "
            + " ".join(f"{item['short_label']}: {item['summary']}" for item in top_items)
        )

    parts.append(build_condition_guidance(profile, meal, kb))
    return " ".join(parts)


def find_kb_matches(user_text: str, kb: list[dict]) -> list[dict]:
    lowered = user_text.lower()
    keyword_map = {
        "sodium": ["sodium", "salt", "hypertension", "blood pressure", "salty"],
        "sugar": ["sugar", "sweet", "diabetes", "dessert", "glucose"],
        "fat": ["fat", "oily", "fried", "cholesterol", "hyperlipidemia", "high cholesterol", "高血脂"],
        "healthy_diet": ["healthy diet", "vegetable", "fruit", "fibre", "fiber", "balanced"],
        "potassium": ["potassium", "banana", "blood pressure", "kidney disease", "肾病"],
    }
    matched_topics = {
        topic
        for topic, keywords in keyword_map.items()
        if any(keyword in lowered for keyword in keywords)
    }
    if not matched_topics:
        return []
    return [item for item in nutrition_kb_items(kb) if item["topic"] in matched_topics]


def answer_who_question(user_text: str, kb: list[dict]) -> str | None:
    matches = find_kb_matches(user_text, kb)
    lowered = user_text.lower()
    matched_conditions = [
        item for item in condition_guidance_items(kb)
        if item.get("condition", "").replace("_", " ") in lowered
        or item.get("condition", "") in lowered
    ]
    for item in matched_conditions:
        if item["id"] not in {entry["id"] for entry in matches}:
            matches.append(item)
    if not matches:
        return None

    parts = []
    for item in matches[:3]:
        parts.append(f"{item['short_label']}: {item['summary']} Source: {item['source_title']} ({item['source_url']})")
    return " ".join(parts)


def suggest_next_prompts(meal: dict | None) -> str:
    prompts = [
        "Try one of these: profile: 'My weight is 70 kg'; restriction: 'I am allergic to shrimp'; remove restriction: 'I am not allergic to tomatoes'; goal: 'I want to gain muscle'."
    ]
    if meal:
        prompts.append("Meal: 'Analyze this meal'; fix: 'Replace prawn with tofu'.")
    return " ".join(prompts)


def unknown_intent_reply(meal: dict | None) -> str:
    if meal:
        meal_hint = " For the current meal, you can also say `Analyze this meal` or `Replace prawn with tofu`."
    else:
        meal_hint = " If you want meal advice, upload a meal image first, then say `Analyze this meal`."

    return (
        "I can help if you phrase that as one clear update or question. "
        "For example: `My weight is 70 kg`, `I have diabetes`, "
        "`I am allergic to shrimp`, or `I am not allergic to tomatoes`."
        + meal_hint
    )


def chatbot_reply(user_text: str) -> str:
    profile = st.session_state.profile
    meal = st.session_state.meal
    kb = load_who_knowledge()
    lowered = user_text.lower().strip()
    intent_result = recognize_user_intent(user_text)
    intent = intent_result["intent"]

    updates = detect_profile_updates(user_text, profile)
    correction_message = None
    is_meal_correction = bool(
        meal
        and (
            intent == "meal_correction"
            or infer_correction_command(user_text, meal)
        )
    )

    if is_meal_correction:
        updated_meal, correction_message = apply_meal_correction(user_text, meal, None)
        updated_meal, excluded_allergens = apply_allergy_exclusions(profile, updated_meal)
        if excluded_allergens:
            correction_message = correction_message or "Updated the meal based on your allergy profile."
        st.session_state.meal = updated_meal
        meal = updated_meal
    elif meal:
        updated_meal, excluded_allergens = apply_allergy_exclusions(profile, meal)
        if excluded_allergens:
            correction_message = "Updated the meal based on your allergy profile."
        st.session_state.meal = updated_meal
        meal = updated_meal

    if updates:
        update_targets()
        update_text = "I updated your profile: " + ", ".join(updates) + "."
        if correction_message and meal:
            correction_text = build_meal_correction_reply(correction_message, meal, profile, kb)
            return f"{update_text} {correction_text}"
        if intent == "goal_change":
            return update_text + f" {build_goal_change_reply(profile)}"
        if intent == "condition":
            return update_text + f" {build_condition_update_reply(profile, kb, meal)}"
        if intent in {"diet_preference", "allergy"}:
            return update_text + f" {build_diet_preference_guidance(profile, meal)}"
        return update_text + f" {format_profile_summary(profile)}"

    if correction_message and meal:
        return build_meal_correction_reply(correction_message, meal, profile, kb)

    if meal and intent == "meal_analysis":
        return generate_advice(profile, meal, kb)

    if intent in {"diet_preference", "allergy"}:
        return build_diet_preference_guidance(profile, meal)

    if intent == "condition":
        return build_condition_guidance(profile, meal, kb)

    if intent == "goal_change":
        update_targets()
        return build_goal_change_reply(profile)

    if intent == "profile_query":
        return format_profile_summary(profile)

    if meal and intent == "meal_query":
        return format_meal_summary(meal)

    if intent == "who_guidance":
        who_reply = answer_who_question(user_text, kb)
        if who_reply:
            return who_reply
        return "I can explain WHO guidance on sodium, sugar, fats, vegetables, fibre, and potassium. Ask me a specific topic."

    if meal and intent == "allergy":
        risky_items = restricted_items_in_meal(profile, meal)
        if not risky_items:
            risky_items = [item["name"] for item in meal.get("ingredients", []) if item.get("possible_allergen")]
        if risky_items:
            return f"Please be careful. This meal may contain allergen-relevant items such as {', '.join(risky_items[:4])}. Cross-check the real ingredients before eating."
        return "I do not see a direct allergy match from the current meal estimate, but image-based meal detection can miss hidden ingredients."

    if intent == "greeting":
        return "Hello. You can chat with me normally, or tell me your meal, goal, dietary restrictions, or a condition you have."

    if intent == "thanks":
        return "You're welcome."

    if contains_cjk(user_text):
        if meal:
            insight = build_meal_insight(profile, meal, kb)
            return (
                f"I can continue based on your current profile and meal. "
                f"This meal is estimated at about {meal.get('dish_estimated_calories', 0)} kcal "
                f"and {meal.get('dish_estimated_sodium_mg', 0)} mg sodium. "
                f"Main note: {insight['main_risk']} You can also say 'analyze this meal', "
                f"'remove egg', or 'I have hypertension'."
            )
        return unknown_intent_reply(meal)

    return unknown_intent_reply(meal)


def render_sidebar() -> None:
    st.sidebar.header("Profile")
    profile = st.session_state.profile

    st.sidebar.text_input("Gemini API Key", value=st.session_state.get("gemini_api_key", ""), key="gemini_api_key", type="password")

    profile["age"] = st.sidebar.number_input("Age", min_value=1, max_value=120, value=int(profile["age"]))
    profile["gender"] = st.sidebar.selectbox("Gender", ["female", "male"], index=0 if profile["gender"] == "female" else 1)
    profile["height_cm"] = st.sidebar.number_input("Height (cm)", min_value=50.0, max_value=250.0, value=float(profile["height_cm"]))
    profile["weight_kg"] = st.sidebar.number_input("Weight (kg)", min_value=20.0, max_value=300.0, value=float(profile["weight_kg"]))

    goal_options = ["maintain", "lose_weight", "gain_weight", "gain_muscle"]
    profile["goal"] = st.sidebar.selectbox("Goal", goal_options, index=goal_options.index(profile["goal"]))
    profile["conditions"] = parse_list_field(st.sidebar.text_input("Conditions (comma-separated)", ",".join(profile["conditions"])))
    profile["dietary_restrictions"] = parse_list_field(
        st.sidebar.text_input(
            "Dietary Restrictions (comma-separated)",
            ",".join(profile.get("dietary_restrictions", [])),
        )
    )

    if st.sidebar.button("Save Profile"):
        update_targets()
        st.sidebar.success("Profile saved.")

    update_targets()
    daily_intake = st.session_state.daily_intake
    st.sidebar.metric("Daily Calories Target", profile["daily_calories"], delta=f"Eaten {daily_intake['calories']} kcal")
    st.sidebar.metric("Daily Protein Target", profile["daily_protein"])

    st.sidebar.markdown("**Today's Intake**")
    st.sidebar.metric("Carbs (g)", daily_intake["carbs_g"])
    st.sidebar.metric("Sugar (g)", daily_intake["sugar_g"])
    st.sidebar.metric("Sodium (mg)", daily_intake["sodium_mg"])
    st.sidebar.metric("Fat (g)", daily_intake["fat_g"])

    if st.sidebar.button("Reset Today's Intake"):
        reset_daily_intake()
        st.rerun()

def render_meal_panel() -> None:
    st.subheader("Meal Input")
    meal_library = sample_meals()
    selected = st.selectbox("Quick Demo Meals", ["Select one"] + list(meal_library.keys()))
    if selected != "Select one" and st.button("Load Demo Meal"):
        st.session_state.meal = normalize_meal_structure(json.loads(json.dumps(meal_library[selected])))
        st.success(f"Loaded {selected}.")

    if not get_gemini_api_key():
        st.caption("Meal image analysis needs `GEMINI_API_KEY` in the environment.")

    if st.session_state.meal:
        st.markdown("**Current Meal**")
        st.write(format_meal_summary(st.session_state.meal))

        meal_key = meal_tracking_key(st.session_state.meal)
        already_confirmed = meal_key in st.session_state.confirmed_meal_keys if meal_key else False
        if st.button("Confirm This Meal", disabled=already_confirmed):
            if confirm_current_meal(st.session_state.meal):
                st.success("This meal was added to today's intake.")
                st.rerun()
        elif already_confirmed:
            st.caption("This version of the meal has already been counted in today's intake.")


def render_insight_panel() -> None:
    st.subheader("Meal Insights")
    meal = st.session_state.meal
    if not meal:
        st.info("Load a demo meal or run meal analysis to see automatic insights here.")
        return

    kb = load_who_knowledge()
    insight = build_meal_insight(st.session_state.profile, meal, kb)

    st.markdown(f"**Summary:** {insight['headline']}")
    st.markdown(f"**Detected ingredients:** {insight['top_ingredients']}")
    st.warning(insight["main_risk"])

    col1, col2, col3, col4, col5 = st.columns(5)
    with col1:
        st.metric("Calories", meal.get("dish_estimated_calories", 0))
    with col2:
        st.metric("Sodium (mg)", meal.get("dish_estimated_sodium_mg", 0))
    with col3:
        st.metric("Carbs (g)", meal.get("dish_estimated_carbs_g", 0))
    with col4:
        st.metric("Sugar (g)", meal.get("dish_estimated_sugar_g", 0))
    with col5:
        st.metric("Fat (g)", meal.get("dish_estimated_fat_g", 0))

    st.markdown("**Recommended actions**")
    for action in insight["actions"]:
        st.write(f"- {action}")

    st.markdown("**WHO evidence used**")
    if insight["who_rules"]:
        for rule in insight["who_rules"][:3]:
            st.write(f"- {rule['short_label']}: {rule['summary']}")
    else:
        st.write("- No WHO rule was matched for this meal-profile combination yet.")

    with st.expander("Full narrative insight"):
        st.write(insight["full_advice"])

    confirmed_meals = st.session_state.confirmed_meals
    if confirmed_meals:
        st.markdown("**Today's Confirmed Meals**")
        for entry in confirmed_meals[-5:]:
            st.write(
                f"- {entry['dish_name'].title()}: {entry['calories']} kcal, "
                f"{entry['carbs_g']} g carbs, {entry['sugar_g']} g sugar, "
                f"{entry['fat_g']} g fat, {entry['sodium_mg']} mg sodium"
            )


def render_chat() -> None:
    st.subheader("Chatbot")
    render_capability_guide()

    for msg in st.session_state.chat_history:
        with st.chat_message(msg["role"]):
            st.write(msg["content"])

    if st.session_state.meal:
        meal_key = meal_tracking_key(st.session_state.meal)
        already_confirmed = meal_key in st.session_state.confirmed_meal_keys if meal_key else False
        if st.button("Confirm Current Meal in Chat", key="chat_confirm_meal", disabled=already_confirmed):
            if confirm_current_meal(st.session_state.meal):
                kb = load_who_knowledge()
                reply = build_confirm_meal_reply(st.session_state.meal, st.session_state.profile, kb)
                st.session_state.chat_history.append({"role": "user", "content": "Confirm this meal"})
                st.session_state.chat_history.append({"role": "assistant", "content": reply})
                st.rerun()
        elif already_confirmed:
            st.caption("The current meal has already been added to today's intake.")

    uploaded_chat_image = st.file_uploader(
        "Upload a meal image to chat about it",
        type=["png", "jpg", "jpeg"],
        key="chat_meal_uploader",
    )
    if uploaded_chat_image:
        image = Image.open(uploaded_chat_image).convert("RGB")
        st.image(image, caption="Meal image for chatbot", use_container_width=True)
        if st.button("Analyze Image In Chat", key="chat_image_analyze"):
            try:
                with st.spinner("Analyzing uploaded meal image..."):
                    result = detect_food_from_image(image, get_gemini_api_key())
                    result, _ = apply_allergy_exclusions(st.session_state.profile, result)
                st.session_state.meal = result
                kb = load_who_knowledge()
                reply = build_chat_image_analysis_reply(result, st.session_state.profile, kb)
                st.session_state.chat_history.append({"role": "user", "content": "[Uploaded a meal image]"})
                st.session_state.chat_history.append({"role": "assistant", "content": reply})
                st.rerun()
            except Exception as exc:
                st.error(f"Meal analysis failed: {exc}")
    elif not get_gemini_api_key():
        st.caption("Image analysis in chat needs `GEMINI_API_KEY` in the environment.")

    prompt = st.chat_input("Ask about meal nutrition, ingredients, calories, or conditions...")
    if prompt:
        st.session_state.chat_history.append({"role": "user", "content": prompt})
        reply = chatbot_reply(prompt)
        st.session_state.chat_history.append({"role": "assistant", "content": reply})
        st.rerun()


def render_who_panel() -> None:
    st.subheader("WHO Knowledge")
    kb = load_who_knowledge()
    for item in kb:
        with st.expander(item["short_label"]):
            st.write(item["summary"])
            st.markdown(f"Source: [{item['source_title']}]({item['source_url']})")


def main() -> None:
    st.set_page_config(page_title="PlateWise MVP", page_icon="🥗", layout="wide")
    init_state()
    st.title("PlateWise MVP")
    st.caption("A multimodal nutrition assistant for food nutrition recognition, meal analysis, and lightweight disease recognition in chat.")

    render_sidebar()

    col1, col2 = st.columns([1.2, 1])
    with col1:
        render_chat()
    with col2:
        render_who_panel()


if __name__ == "__main__":
    main()
