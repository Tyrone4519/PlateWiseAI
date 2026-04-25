import json
import re
from pathlib import Path


def normalize_text(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[_/]", " ", text)
    text = re.sub(r"[^\w\s'-]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def load_food_library(json_path: str | Path) -> dict:
    path = Path(json_path)
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict) and "foods" in data and isinstance(data["foods"], dict):
        return data["foods"]

    if not isinstance(data, dict):
        raise ValueError("Food library JSON must contain a dictionary.")

    return data


def build_food_lookup(food_library: dict) -> dict[str, str]:
    lookup: dict[str, str] = {}

    for canonical_name, meta in food_library.items():
        terms = [canonical_name, *meta.get("aliases", [])]
        for term in terms:
            normalized = normalize_text(term)
            if normalized:
                lookup[normalized] = canonical_name

    return lookup


def extract_foods(text: str, food_library: dict) -> list[str]:
    normalized = normalize_text(text)
    lookup = build_food_lookup(food_library)
    matched: list[str] = []

    for term in sorted(lookup, key=len, reverse=True):
        if re.search(r"\b" + re.escape(term) + r"\b", normalized):
            canonical = lookup[term]
            if canonical not in matched:
                matched.append(canonical)

    return matched
