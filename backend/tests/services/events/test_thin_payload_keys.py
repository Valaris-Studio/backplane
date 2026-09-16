# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fix 8: the thin fallback must preserve every field a consumer filters on.

When a full envelope blows the ~8KB NOTIFY cap it degrades to a THIN form
carrying only the entity ids. If that form drops the field a consumer keys on,
the receiver silently no-ops:
  - a frontend per-card filter needs card_id / entity_id
  - the Go runner's self-suppression needs actor_id / agent_id / target_agent_id
  - activity consumers filter on entity_type / action
  - per-recipient notifications need recipient_user_id
  - api_key.first_used is filtered per-user on user_id
"""

from app.core.event_bus import _THIN_ID_KEYS, _thin_payload


# Fields real payload-reading consumers filter on. A thin form MUST retain any
# of these that were present in the full payload.
_CONSUMER_FILTER_KEYS = (
    "entity_id",
    "agent_id",
    "actor_id",
    "target_agent_id",
    "recipient_user_id",
    "board_id",
    "approval_id",
    "card_id",
    "entity_type",
    "action",
    # ConnectionManager._should_deliver drops an api_key.first_used whose
    # payload has no user_id, so losing it in the thin form silently eats
    # the event instead of degrading it.
    "user_id",
)


def test_thin_keys_cover_activity_and_agent_filters():
    for key in _CONSUMER_FILTER_KEYS:
        assert key in _THIN_ID_KEYS, f"{key} missing from _THIN_ID_KEYS"


def test_thin_form_of_oversized_activity_payload_keeps_filter_fields():
    # A representative oversized activity payload (big after_state blows the cap).
    full = {
        "entity_type": "card",
        "entity_id": "card-uuid",
        "action": "updated",
        "actor_id": "actor-uuid",
        "agent_id": "agent-uuid",
        "target_agent_id": "target-uuid",
        "recipient_user_id": "user-uuid",
        "user_id": "owner-uuid",
        "board_id": "board-uuid",
        "approval_id": "approval-uuid",
        "card_id": "card-uuid",
        "after_state": {"description": "x" * 9000},
        "summary": "a very long human sentence " * 100,
    }
    thin = _thin_payload(full)

    for key in _CONSUMER_FILTER_KEYS:
        assert thin.get(key) == full[key], f"{key} lost in thin form"
    # The huge snapshot / prose that blew the cap is dropped.
    assert "after_state" not in thin
    assert "summary" not in thin
    assert thin["_thin"] is True
