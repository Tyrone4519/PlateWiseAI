import math


def flatten_templates(intent_templates: dict[str, list[str]]) -> tuple[list[str], list[str]]:
    intent_texts: list[str] = []
    intent_labels: list[str] = []

    for intent, texts in intent_templates.items():
        for text in texts:
            intent_texts.append(text)
            intent_labels.append(intent)

    return intent_texts, intent_labels


def encode_templates(model, intent_templates: dict[str, list[str]]) -> tuple[list[str], list[str], list]:
    intent_texts, intent_labels = flatten_templates(intent_templates)
    intent_embeddings = model.encode(intent_texts, normalize_embeddings=True)
    return intent_texts, intent_labels, intent_embeddings


def cosine_scores(query_embedding, intent_embeddings) -> list[float]:
    scores: list[float] = []
    for embedding in intent_embeddings:
        score = sum(a * b for a, b in zip(query_embedding, embedding))
        scores.append(float(score))
    return scores


def predict_intent_by_similarity(
    user_text: str,
    model,
    intent_labels: list[str],
    intent_embeddings,
) -> tuple[str, float]:
    query_embedding = model.encode([user_text], normalize_embeddings=True)[0]
    scores = cosine_scores(query_embedding, intent_embeddings)
    best_idx = max(range(len(scores)), key=scores.__getitem__)
    return intent_labels[best_idx], scores[best_idx]


def top_k_intents_by_similarity(
    user_text: str,
    model,
    intent_labels: list[str],
    intent_embeddings,
    k: int = 3,
) -> list[dict]:
    query_embedding = model.encode([user_text], normalize_embeddings=True)[0]
    scores = cosine_scores(query_embedding, intent_embeddings)
    ranked_indexes = sorted(range(len(scores)), key=scores.__getitem__, reverse=True)[:k]
    return [
        {
            "intent": intent_labels[idx],
            "score": scores[idx],
        }
        for idx in ranked_indexes
    ]


def unique_preserve_order(items: list[str]) -> list[str]:
    seen = set()
    result = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def confidence_from_score(score: float) -> str:
    if score >= 0.80:
        return "high"
    if score >= 0.60:
        return "medium"
    if score >= 0.40:
        return "low"
    return "very_low"
