import re


GOAL_MAPPING = {
    "lose_weight": ["lose weight", "lose fat", "cut", "burn fat", "shed pounds", "weight loss"],
    "gain_weight": ["gain weight", "bulk", "put on weight"],
    "gain_muscle": ["gain muscle", "build muscle", "get stronger", "muscle mass"],
    "maintain": ["maintain", "keep my weight", "stay the same"],
}

INTENT_TRIGGERS = [
    "change",
    "switch",
    "want to",
    "goal is",
    "plan is",
    "now",
    "decided to",
    "update",
    "wanted to",
]

NEGATIONS = ["don't want", "not trying to", "stop", "no longer"]


def split_into_clauses(text: str) -> list[str]:
    """
    Splits text sequentially so we can process the user's goal changes
    in left-to-right reading order.
    """
    text = text.lower().strip()
    delimiters = r"[,.!?;]|\bbut\b|\bhowever\b|\binstead\b|\balthough\b|\band\b"
    clauses = re.split(delimiters, text)
    return [clause.strip() for clause in clauses if clause.strip()]


def parse_sequential_goal_update(text: str) -> dict:
    """
    Reads user input as a simple state machine and tracks how the goal
    changes through the sentence.
    """
    clauses = split_into_clauses(text)

    transition_history: list[str] = []
    current_state_goal: str | None = None

    for clause in clauses:
        if any(neg in clause for neg in NEGATIONS):
            continue

        clause_goal = None
        for standard_goal, keywords in GOAL_MAPPING.items():
            if any(keyword in clause for keyword in keywords):
                clause_goal = standard_goal
                break

        if clause_goal and clause_goal != current_state_goal:
            current_state_goal = clause_goal
            transition_history.append(current_state_goal)

    is_update_intent = False
    lowered = text.lower()
    if current_state_goal:
        if any(trigger in lowered for trigger in INTENT_TRIGGERS) or len(text.split()) <= 8:
            is_update_intent = True

    return {
        "intent": "goal_update",
        "is_update": is_update_intent,
        "final_goal": current_state_goal,
        "transition_history": transition_history,
    }
