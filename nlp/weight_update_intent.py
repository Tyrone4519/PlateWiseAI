import re


INTENT_TRIGGERS = [
    "update",
    "change",
    "now",
    "weigh",
    "weight is",
    "my weight",
    "down to",
    "up to",
    "dropped to",
    "currently",
    "new weight",
    "set",
]

NEGATIONS = ["not", "didn't", "don't"]
WEIGHT_PATTERN = r"\b(\d+(?:\.\d+)?)\s*(kg|kilo|kilograms|lbs|pounds|lb)\b"
QUESTION_PATTERNS = ["if i", "should i", "is it good", "calories for"]


def split_into_clauses(text: str) -> list[str]:
    """
    Splits text sequentially so we can process numeric updates
    in left-to-right reading order.
    """
    text = text.lower().strip()
    delimiters = r"[,.!?;]|\bbut\b|\bhowever\b|\binstead\b|\balthough\b|\band\b"
    clauses = re.split(delimiters, text)
    return [clause.strip() for clause in clauses if clause.strip()]


def parse_sequential_weight_update(text: str) -> dict:
    """
    Weight extractor that combines clause-by-clause sequential reading
    with regex-based unit parsing.
    """
    clauses = split_into_clauses(text)
    current_state_weight: float | None = None

    for clause in clauses:
        if any(neg in clause for neg in NEGATIONS):
            continue

        matches = re.findall(WEIGHT_PATTERN, clause)
        if not matches:
            continue

        raw_value, unit_str = matches[-1]
        value = float(raw_value)
        if unit_str in ["lbs", "pounds", "lb"]:
            current_state_weight = round(value * 0.453592, 2)
        else:
            current_state_weight = round(value, 2)

    is_update_intent = False
    lowered = text.lower()
    if current_state_weight is not None:
        if any(trigger in lowered for trigger in INTENT_TRIGGERS) or len(text.split()) <= 6:
            is_update_intent = True
        if any(pattern in lowered for pattern in QUESTION_PATTERNS):
            is_update_intent = False

    return {
        "intent": "weight_update",
        "is_update": is_update_intent,
        "extracted_weight_kg": current_state_weight,
    }
