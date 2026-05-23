import json
import re
from pathlib import Path


ALLERGY_PATTERNS = [
    r"\bi am allergic to\b",
    r"\bi am allergic with\b",
    r"\bi'm allergic to\b",
    r"\bi'm allergic with\b",
    r"\bi actually am allergic to\b",
    r"\bi actually am allergic with\b",
    r"\bi have an allergy to\b",
    r"\bi have an allergy with\b",
    r"\bi cannot eat\b",
    r"\bi can't eat\b",
    r"\bi can not eat\b",
    r"\bi should avoid\b",
    r"\bi must avoid\b",
    r"\bi am unable to eat\b",
    r"\ballergic to\b",
    r"\ballergic with\b",
    r"\ballergy to\b",
    r"\ballergy with\b",
    r"过敏",
    r"不能吃",
    r"不可以吃",
    r"不敢吃",
]

ALLERGY_CAPTURE_PATTERNS = [
    r"\bi am allergic to (?P<foods>.+)",
    r"\bi am allergic with (?P<foods>.+)",
    r"\bi'm allergic to (?P<foods>.+)",
    r"\bi'm allergic with (?P<foods>.+)",
    r"\bi actually am allergic to (?P<foods>.+)",
    r"\bi actually am allergic with (?P<foods>.+)",
    r"\bi have an allergy to (?P<foods>.+)",
    r"\bi have an allergy with (?P<foods>.+)",
    r"\bi cannot eat (?P<foods>.+)",
    r"\bi can't eat (?P<foods>.+)",
    r"\bi can not eat (?P<foods>.+)",
    r"\bi should avoid (?P<foods>.+)",
    r"\bi must avoid (?P<foods>.+)",
    r"\bi am unable to eat (?P<foods>.+)",
    r"\ballergic to (?P<foods>.+)",
    r"\ballergic with (?P<foods>.+)",
    r"\ballergy to (?P<foods>.+)",
    r"\ballergy with (?P<foods>.+)",
    r"对(?P<foods>.+)过敏",
    r"(?P<foods>.+)过敏",
    r"不能吃(?P<foods>.+)",
    r"不可以吃(?P<foods>.+)",
]

STOP_PATTERNS = [
    r"\bbut\b",
    r"\bbecause\b",
    r"\bso\b",
    r"\bthat\b",
    r"\bwhich\b",
    r"[.!?;:]",
    r"[。！？；：]",
]

COMMON_FOOD_FALLBACKS = {
    "beef": "beef",
    "pork": "pork",
    "chicken": "chicken",
    "meat": "meat",
    "egg": "egg",
    "eggs": "egg",
    "shrimp": "shrimp",
    "prawn": "shrimp",
    "prawns": "shrimp",
    "peanut": "peanut",
    "peanuts": "peanut",
    "milk": "milk",
    "nuts": "nuts",
    "tree nuts": "nuts",
    "soy": "soy",
    "tomato": "tomatoes",
    "tomatoes": "tomatoes",
    "tomatos": "tomatoes",
    "tomotaes": "tomatoes",
    "虾": "shrimp",
    "花生": "peanut",
    "鸡蛋": "egg",
    "牛奶": "milk",
    "坚果": "nuts",
    "豆浆": "soy",
    "黄豆": "soy",
}

INTENT_PATTERNS = {
    "diet_preference": [
        "can i eat",
        "what can i eat",
        "what should i eat",
        "what can't i eat",
        "what cannot i eat",
        "diet preference",
        "vegetarian",
        "low sodium",
        "low salt",
        "low sugar",
        "high protein",
        "可以吃",
        "能吃什么",
        "不能吃什么",
        "素食",
        "低钠",
        "低盐",
        "低糖",
        "高蛋白",
    ],
    "condition": [
        "i have",
        "diagnosed with",
        "my condition",
        "my disease",
        "hypertension",
        "high blood pressure",
        "diabetes",
        "high cholesterol",
        "hyperlipidemia",
        "kidney disease",
        "chronic kidney disease",
        "gout",
        "fatty liver",
        "gastritis",
        "acid reflux",
        "reflux",
        "gerd",
        "anemia",
        "anaemia",
        "constipation",
        "高血压",
        "糖尿病",
        "高血脂",
        "肾病",
        "慢性肾病",
        "痛风",
        "脂肪肝",
        "胃炎",
        "反流",
        "胃食管反流",
        "贫血",
        "便秘",
    ],
    "goal_change": [
        "my goal",
        "change my goal",
        "i want to lose weight",
        "i want to gain weight",
        "i want to gain muscle",
        "weight loss",
        "gain weight",
        "gain muscle",
        "build muscle",
        "bulking",
        "cutting",
        "减重",
        "减肥",
        "增重",
        "增肌",
        "保持",
    ],
    "meal_query": [
        "current meal",
        "my meal",
        "meal summary",
        "ingredients",
        "what am i eating",
        "这个餐",
        "这顿饭",
        "我吃的什么",
        "配料",
        "食材",
    ],
    "meal_correction": [
        "remove ",
        "delete ",
        "exclude ",
        "take away ",
        "add ",
        "include ",
        "replace ",
        "swap ",
        "change ",
        "there is no ",
        "there is not ",
        "this is not ",
        "不是",
        "去掉",
        "删除",
        "加上",
        "加一个",
        "换成",
        "替换",
    ],
    "profile_query": [
        "what do you know about me",
        "my profile",
        "my target",
        "daily calories",
        "daily protein",
        "我的信息",
        "我的资料",
        "我的目标",
        "我的热量",
        "我的蛋白质",
    ],
    "who_guidance": [
        "who",
        "guideline",
        "guidelines",
        "evidence",
        "rule",
        "指南",
        "依据",
        "证据",
    ],
    "meal_analysis": [
        "advice",
        "healthy",
        "should i eat",
        "analyze",
        "analysis",
        "recommend",
        "safe",
        "是不是健康",
        "分析",
        "建议",
        "推荐",
        "安全吗",
    ],
    "greeting": [
        "hi",
        "hello",
        "hey",
        "hey there",
        "你好",
        "嗨",
        "哈喽",
    ],
    "thanks": [
        "thanks",
        "thank you",
        "thanks!",
        "谢谢",
        "感谢",
    ],
}


def load_food_library(json_path: str | Path) -> dict:
    path = Path(json_path)
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict) and "foods" in data and isinstance(data["foods"], dict):
        return data["foods"]

    if not isinstance(data, dict):
        raise ValueError("Food library JSON must contain a dictionary.")

    return data


def normalize_text(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[_/]", " ", text)
    text = re.sub(r"[^\w\s\u4e00-\u9fff'-]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def predict_intent(text: str) -> str:
    text = normalize_text(text)

    for pattern in ALLERGY_PATTERNS:
        if re.search(pattern, text):
            return "allergy"

    return "unknown"


def score_intents(text: str) -> dict[str, int]:
    normalized = normalize_text(text)
    scores: dict[str, int] = {}

    for intent, patterns in INTENT_PATTERNS.items():
        score = sum(1 for pattern in patterns if pattern in normalized)
        if score:
            scores[intent] = score

    return scores


def recognize_user_intent(text: str) -> dict:
    sentences = split_sentences(text)
    has_allergy = any(predict_intent(sentence) == "allergy" for sentence in sentences)
    scores = score_intents(text)

    if has_allergy:
        primary_intent = "allergy"
    elif scores:
        primary_intent = max(scores, key=scores.get)
    else:
        primary_intent = "unknown"

    result = {
        "intent": primary_intent,
        "matched_intents": sorted(scores, key=scores.get, reverse=True),
        "scores": scores,
    }

    if has_allergy:
        result["matched_intents"] = ["allergy", *[item for item in result["matched_intents"] if item != "allergy"]]

    return result


def split_sentences(text: str) -> list[str]:
    normalized = text.strip()
    parts = re.split(r"[.!?;:，,。！？；：]+", normalized)
    return [part.strip() for part in parts if part.strip()]


def build_food_lookup(food_library: dict) -> dict[str, str]:
    lookup = {}

    for canonical_name, meta in food_library.items():
        terms = [canonical_name, *meta.get("aliases", [])]
        for term in terms:
            normalized = normalize_text(term)
            if normalized:
                lookup[normalized] = canonical_name
                if normalized.endswith("es"):
                    lookup.setdefault(normalized[:-2], canonical_name)
                elif normalized.endswith("s") and len(normalized) > 3:
                    lookup.setdefault(normalized[:-1], canonical_name)

    return lookup


def split_candidate_foods(text: str) -> list[str]:
    normalized = normalize_text(text)
    parts = re.split(r",|/|&|\band\b|\bor\b|、|，|和|或", normalized)
    return [part.strip() for part in parts if part.strip()]


def trim_clause(text: str) -> str:
    trimmed = text
    for pattern in STOP_PATTERNS:
        match = re.search(pattern, trimmed, flags=re.IGNORECASE)
        if match:
            trimmed = trimmed[:match.start()]
    return trimmed.strip()


def clean_candidate_phrase(text: str) -> str:
    cleaned = normalize_text(text)
    cleaned = re.sub(r"^(the|a|an|my|any|some)\s+", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def match_food_phrase(phrase: str, food_library: dict) -> list[str]:
    phrase = clean_candidate_phrase(phrase)
    if not phrase:
        return []

    lookup = build_food_lookup(food_library)
    matched = []

    # Prefer longer phrases first so "tree nuts" wins before "nuts".
    for term in sorted(lookup, key=len, reverse=True):
        if re.search(r"\b" + re.escape(term) + r"\b", phrase):
            canonical = lookup[term]
            if canonical not in matched:
                matched.append(canonical)

    for term, canonical in COMMON_FOOD_FALLBACKS.items():
        if canonical in matched:
            continue

        # Use word boundaries for Latin tokens and substring matching only for CJK terms.
        if re.search(r"\b" + re.escape(term) + r"\b", phrase):
            matched.append(canonical)
            continue

        if re.search(r"[\u4e00-\u9fff]", term) and term in phrase:
            matched.append(canonical)

    return matched


def extract_food_entities(text: str, food_library: dict) -> list[str]:
    text = normalize_text(text)
    matched_foods = []

    for item in split_candidate_foods(text):
        for canonical in match_food_phrase(item, food_library):
            if canonical not in matched_foods:
                matched_foods.append(canonical)

    return matched_foods


def extract_allergy_entities(text: str, food_library: dict) -> list[str]:
    matched_foods = []
    for sentence in split_sentences(text):
        if predict_intent(sentence) != "allergy":
            continue

        lowered = normalize_text(sentence)
        sentence_matches = []

        for pattern in ALLERGY_CAPTURE_PATTERNS:
            match = re.search(pattern, lowered, flags=re.IGNORECASE)
            if not match:
                continue

            clause = trim_clause(match.group("foods"))
            for segment in split_candidate_foods(clause):
                for canonical in match_food_phrase(segment, food_library):
                    if canonical not in sentence_matches:
                        sentence_matches.append(canonical)

        if not sentence_matches:
            for canonical in extract_food_entities(sentence, food_library):
                if canonical not in sentence_matches:
                    sentence_matches.append(canonical)

        for canonical in sentence_matches:
            if canonical not in matched_foods:
                matched_foods.append(canonical)

    return matched_foods


def process_user_input(text: str, food_library: dict) -> dict:
    intent_result = recognize_user_intent(text)
    intent = intent_result["intent"]

    result = {
        "intent": intent,
        "allergies": [],
        "foods": [],
    }

    if intent == "allergy":
        allergies = extract_allergy_entities(text, food_library)
        result["allergies"] = allergies
        result["foods"] = allergies

    return result


if __name__ == "__main__":
    food_library = load_food_library("nutrition5k_food_entity_library.json")

    examples = [
        "I am allergic to shrimp",
        "I can't eat peanuts",
        "I cannot eat egg",
        "I should avoid milk",
        "I love chicken",
    ]

    for text in examples:
        output = process_user_input(text, food_library)
        print(text)
        print(output)
        print("-" * 40)
