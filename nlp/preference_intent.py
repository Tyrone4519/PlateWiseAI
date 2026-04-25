from embedding_utils import confidence_from_score, encode_templates, predict_intent_by_similarity, unique_preserve_order
from food_extractor import extract_foods


INTENT_TEMPLATES = {
    "allergy": [
        "i am allergic to shrimp",
        "i am allergic to peanuts",
        "i have an allergy to milk",
        "i cannot eat egg",
        "i can't eat shrimp",
        "i should avoid peanuts",
        "i must avoid milk",
        "i am unable to eat nuts",
    ],
    "diet_preference": [
        "i am vegetarian",
        "i am vegan",
        "i prefer low sodium food",
        "i want low salt meals",
        "i follow a low sugar diet",
        "i prefer high protein meals",
        "i only eat vegetarian food",
        "i need low sodium food",
    ],
}

PREFERENCE_LABEL_RULES = {
    "vegetarian": ["vegetarian"],
    "vegan": ["vegan"],
    "low_sodium": ["low sodium"],
    "low_salt": ["low salt"],
    "low_sugar": ["low sugar"],
    "high_protein": ["high protein"],
}


def init_preference_model(model):
    _, intent_labels, intent_embeddings = encode_templates(model, INTENT_TEMPLATES)
    return intent_labels, intent_embeddings


def predict_preference_intent(user_text: str, model, intent_labels, intent_embeddings) -> dict:
    intent, score = predict_intent_by_similarity(user_text, model, intent_labels, intent_embeddings)
    return {
        "intent": intent,
        "score": score,
        "confidence": confidence_from_score(score),
    }


def extract_diet_preferences(text: str) -> list[str]:
    lowered = text.lower()
    preferences: list[str] = []

    for label, patterns in PREFERENCE_LABEL_RULES.items():
        if any(pattern in lowered for pattern in patterns):
            preferences.append(label)

    return unique_preserve_order(preferences)


def process_preference_input(
    user_text: str,
    model,
    intent_labels,
    intent_embeddings,
    food_library: dict,
) -> dict:
    prediction = predict_preference_intent(user_text, model, intent_labels, intent_embeddings)
    foods = extract_foods(user_text, food_library)

    result = {
        "intent": prediction["intent"],
        "score": prediction["score"],
        "confidence": prediction["confidence"],
        "allergies": [],
        "diet_preferences": [],
        "foods": foods,
    }

    if prediction["intent"] == "allergy":
        result["allergies"] = foods

    if prediction["intent"] == "diet_preference":
        result["diet_preferences"] = extract_diet_preferences(user_text)

    return result
