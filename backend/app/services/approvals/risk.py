# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.models.approvals.approval import ApprovalCategory

# Base risk scores per category
BASE_SCORES = {
    ApprovalCategory.deletion: 60,
    ApprovalCategory.bulk_change: 40,
    ApprovalCategory.deployment: 70,
    ApprovalCategory.schema_change: 80,
    ApprovalCategory.permission_change: 50,
    ApprovalCategory.external_action: 30,
    # Skill content steers future agent behavior — a proposal must NEVER
    # auto-approve, so the base score sits well above AUTO_APPROVE_THRESHOLD.
    ApprovalCategory.skill_publication: 60,
}

AUTO_APPROVE_THRESHOLD = 30


def compute_risk_score(category: ApprovalCategory, action_payload: dict) -> int:
    score = BASE_SCORES.get(category, 50)

    if category == ApprovalCategory.deletion:
        item_count = action_payload.get("item_count", 0)
        card_ids = action_payload.get("card_ids", [])
        if item_count > 1 or len(card_ids) > 1:
            score += 20
        if action_payload.get("board_level"):
            score += 10

    elif category == ApprovalCategory.bulk_change:
        item_count = action_payload.get("item_count", len(action_payload.get("cards", [])))
        score += min(40, (item_count // 10) * 10)

    elif category == ApprovalCategory.deployment:
        if action_payload.get("environment") == "production":
            score += 20
        elif action_payload.get("environment") == "staging":
            score -= 20

    elif category == ApprovalCategory.schema_change:
        if action_payload.get("destructive"):
            score += 10

    elif category == ApprovalCategory.permission_change:
        if action_payload.get("role") in ("admin", "owner"):
            score += 30

    elif category == ApprovalCategory.external_action:
        branch = action_payload.get("branch", "")
        if branch in ("main", "master", "production"):
            score += 20

    return min(100, max(0, score))
