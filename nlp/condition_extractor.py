import json
import re
from functools import lru_cache
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DISEASE_LIBRARY_PATH = BASE_DIR / "disease_library.json"

CONDITION_INTENT_PATTERNS = [
    "i have",
    "i was diagnosed with",
    "my doctor said",
    "i suffer from",
    "i am",
]

NEGATION_PATTERNS = [
    "not",
    "don't have",
    "do not have",
    "didn't have",
    "did not have",
    "no",
]


@lru_cache(maxsize=1)
def load_disease_library() -> dict:
    with DISEASE_LIBRARY_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict) and "conditions" in data and isinstance(data["conditions"], dict):
        return data["conditions"]

    if not isinstance(data, dict):
        raise ValueError("Disease library JSON must contain a dictionary.")

    return data


def normalize_text(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s'-]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"[.!?;:,\n]+", text.strip())
    return [part.strip() for part in parts if part.strip()]


def detect_condition_intent(text: str) -> bool:
    lowered = normalize_text(text)
    return any(pattern in lowered for pattern in CONDITION_INTENT_PATTERNS)


def extract_condition_entities(text: str) -> list[str]:
    matched: list[str] = []
    condition_library = load_disease_library()

    for sentence in split_sentences(text):
        lowered = normalize_text(sentence)
        for canonical_name, meta in condition_library.items():
            aliases = meta.get("aliases", [])
            for alias in aliases:
                alias_pattern = r"\b" + re.escape(alias) + r"\b"
                if not re.search(alias_pattern, lowered):
                    continue

                negated = any(
                    re.search(r"\b" + re.escape(neg) + r"\s+(?:have\s+)?(?:a\s+)?(?:an\s+)?"+ re.escape(alias) + r"\b", lowered)
                    for neg in NEGATION_PATTERNS
                ) or re.search(r"\bnot\s+" + re.escape(alias) + r"\b", lowered)

                if negated:
                    continue

                if canonical_name not in matched:
                    matched.append(canonical_name)
                    break

    return matched


def process_condition_entities(text: str) -> dict:
    conditions = extract_condition_entities(text)
    return {
        "intent": "condition",
        "is_update": bool(conditions) and detect_condition_intent(text),
        "conditions": conditions,
    }
