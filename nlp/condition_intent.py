from condition_extractor import extract_condition_entities, split_sentences
from embedding_utils import confidence_from_score, encode_templates, predict_intent_by_similarity, unique_preserve_order


INTENT_TEMPLATES = {
    "hypertension": [
        "i have hypertension",
        "i have high blood pressure",
        "my doctor said i have hypertension",
        "i was diagnosed with high blood pressure",
    ],
    "diabetes": [
        "i have diabetes",
        "i am diabetic",
        "my doctor said i have diabetes",
        "my blood sugar is high",
    ],
    "hyperlipidemia": [
        "i have high cholesterol",
        "i have hyperlipidemia",
        "my cholesterol is high",
        "my doctor said i have hyperlipidemia",
    ],
    "kidney_disease": [
        "i have kidney disease",
        "i have chronic kidney disease",
        "i have ckd",
        "my doctor said i have kidney disease",
    ],
    "gout": [
        "i have gout",
        "my doctor diagnosed gout",
        "i suffer from gout",
    ],
    "fatty_liver": [
        "i have fatty liver",
        "my doctor said i have fatty liver",
        "i was diagnosed with fatty liver",
    ],
    "gastritis": [
        "i have gastritis",
        "my doctor said i have gastritis",
        "i was diagnosed with gastritis",
    ],
    "reflux": [
        "i have acid reflux",
        "i have reflux",
        "i have gerd",
        "my doctor said i have acid reflux",
    ],
    "anemia": [
        "i have anemia",
        "i have anaemia",
        "my doctor said i have anemia",
    ],
    "constipation": [
        "i have constipation",
        "i suffer from constipation",
        "my doctor said i have constipation",
    ],
}


def init_condition_model(model):
    _, intent_labels, intent_embeddings = encode_templates(model, INTENT_TEMPLATES)
    return intent_labels, intent_embeddings


def process_condition_input(user_text: str, model, intent_labels, intent_embeddings) -> dict:
    extracted_conditions = extract_condition_entities(user_text)
    matched_conditions = list(extracted_conditions)
    top_score = 0.0

    for sentence in split_sentences(user_text):
        condition, score = predict_intent_by_similarity(sentence, model, intent_labels, intent_embeddings)
        top_score = max(top_score, score)
        if condition not in matched_conditions and score >= 0.55:
            matched_conditions.append(condition)

    if not matched_conditions:
        condition, top_score = predict_intent_by_similarity(user_text, model, intent_labels, intent_embeddings)
        matched_conditions = [condition]

    return {
        "intent": "condition",
        "score": top_score,
        "confidence": confidence_from_score(top_score),
        "conditions": unique_preserve_order(matched_conditions),
    }
