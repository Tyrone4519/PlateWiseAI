import re

from embedding_utils import confidence_from_score, encode_templates, predict_intent_by_similarity
from food_extractor import extract_foods


INTENT_TEMPLATES = {
    "add": [
        "add tofu",
        "add egg",
        "include tofu",
        "include another ingredient",
        "there is another ingredient",
        "you missed an ingredient",
        "please add tofu",
        "also add spinach",
        "This is ingredient"
    ],
    "remove": [
        "remove egg",
        "delete egg",
        "exclude the ingredient",
        "take egg away",
        "there is no egg",
        "egg should not be there",
        "please remove pork",
        "you should remove broth",
    ],
    "replace": [
        "replace pork with tofu",
        "swap pork with tofu",
        "change pork to tofu",
        "substitute pork with tofu",
        "correct the ingredient",
        "pork is tofu",
        "egg is chicken",
        "it is tofu not pork",
        "this is tofu instead of pork",
        "replace shrimp with chicken",
    ],
    "confirm": [
        "this is correct",
        "looks good",
        "yes correct",
        "that is right",
        "the ingredients are correct",
        "this looks right",
    ],
}


def init_user_correction_model(model):
    _, intent_labels, intent_embeddings = encode_templates(model, INTENT_TEMPLATES)
    return intent_labels, intent_embeddings


def predict_correction_intent(user_text: str, model, intent_labels, intent_embeddings) -> dict:
    intent, score = predict_intent_by_similarity(user_text, model, intent_labels, intent_embeddings)
    return {
        "intent": intent,
        "score": score,
        "confidence": confidence_from_score(score),
    }


def build_command(intent: str, foods: list[str]) -> dict | None:
    if intent == "replace" and len(foods) >= 2:
        return {
            "action": "replace",
            "from": foods[0],
            "to": foods[1],
        }

    if intent == "remove" and len(foods) >= 1:
        return {
            "action": "remove",
            "food": foods[0],
        }

    if intent == "add" and len(foods) >= 1:
        return {
            "action": "add",
            "food": foods[0],
        }

    if intent == "confirm":
        return {
            "action": "confirm",
        }

    return None


def clean_food_phrase(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"\b(actually|really|just|the|a|an)\b", " ", text)
    text = re.split(r"\b(?:instead of|not|but|with)\b", text, maxsplit=1)[0]
    text = re.sub(r"[^\w\s'-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def infer_is_replace_command(user_text: str, food_library: dict) -> dict | None:
    normalized = user_text.lower().strip()
    normalized = re.sub(r"\s+", " ", normalized)

    match = re.search(r"\b(?P<old>.+?)\s+is\s+(?P<new>.+)\b", normalized)
    if not match:
        return None

    old_foods = extract_foods(match.group("old"), food_library)
    new_foods = extract_foods(match.group("new"), food_library)
    old_food = old_foods[0] if old_foods else clean_food_phrase(match.group("old"))
    new_food = new_foods[0] if new_foods else clean_food_phrase(match.group("new"))

    if old_food in {"this", "it", "that"}:
        return None

    if old_food and new_food and old_food != new_food:
        return {
            "action": "replace",
            "from": old_food,
            "to": new_food,
        }

    return None


def process_user_correction(
    user_text: str,
    model,
    intent_labels,
    intent_embeddings,
    food_library: dict,
) -> dict:
    prediction = predict_correction_intent(user_text, model, intent_labels, intent_embeddings)
    foods = extract_foods(user_text, food_library)
    command = infer_is_replace_command(user_text, food_library) or build_command(prediction["intent"], foods)
    intent = "replace" if command and command.get("action") == "replace" else prediction["intent"]

    return {
        "intent": intent,
        "score": prediction["score"],
        "confidence": prediction["confidence"],
        "foods": foods,
        "command": command,
    }


def update_dish(dish: dict, command: dict | None) -> dict:
    if not command:
        return dish

    if command["action"] == "replace":
        for ingredient in dish.get("ingredients", []):
            if ingredient.get("name") == command["from"]:
                ingredient["name"] = command["to"]

    elif command["action"] == "remove":
        dish["ingredients"] = [
            ingredient
            for ingredient in dish.get("ingredients", [])
            if ingredient.get("name") != command["food"]
        ]

    elif command["action"] == "add":
        dish.setdefault("ingredients", []).append({"name": command["food"]})

    return dish
