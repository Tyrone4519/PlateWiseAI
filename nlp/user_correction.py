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


def process_user_correction(
    user_text: str,
    model,
    intent_labels,
    intent_embeddings,
    food_library: dict,
) -> dict:
    prediction = predict_correction_intent(user_text, model, intent_labels, intent_embeddings)
    foods = extract_foods(user_text, food_library)
    command = build_command(prediction["intent"], foods)

    return {
        "intent": prediction["intent"],
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
