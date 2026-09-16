# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase-0 mention producer — `extract_mention_ids` pure unit tests (contract §2).

The resolver is the ONE place text becomes a recipient set: it walks PM-JSON,
collects every `type=="mention"` node carrying a parseable `attrs.id` UUID,
ignores `label` (MEN-1: id is identity), dedupes, and tolerates malformed input
by returning an empty set (MEN-4: a parse failure must NEVER raise — it must not
roll back the triggering card/note write).

Collection-time RED: until extract.py exists this import errors.
"""

from __future__ import annotations

import json
import uuid

from app.services.mentions.extract import extract_mention_ids


def _doc(*nodes: dict) -> dict:
    return {"type": "doc", "content": list(nodes)}


def _mention(user_id: str, label: str = "Someone") -> dict:
    return {"type": "mention", "attrs": {"id": user_id, "label": label}}


def _para(*children: dict) -> dict:
    return {"type": "paragraph", "content": list(children)}


def test_extract_empty_inputs_return_empty_set():
    assert extract_mention_ids(None) == set()
    assert extract_mention_ids("") == set()
    assert extract_mention_ids(_doc()) == set()
    assert extract_mention_ids(json.dumps(_doc())) == set()


def test_extract_malformed_json_string_returns_empty_set():
    # A non-JSON string (plain text description) must degrade to no mentions,
    # never raise.
    assert extract_mention_ids("just some plain @text not a node") == set()
    assert extract_mention_ids("{not valid json") == set()


def test_extract_malformed_shapes_never_raise():
    # Hostile shapes the producer might be handed; each is a silent no-op set().
    for bad in (123, [1, 2, 3], {"type": "mention"}, {"content": "notalist"}):
        assert extract_mention_ids(bad) == set()


def test_extract_single_mention_from_dict_and_json_string():
    uid = uuid.uuid4()
    doc = _doc(_para({"type": "text", "text": "hey "}, _mention(str(uid))))
    assert extract_mention_ids(doc) == {uid}
    assert extract_mention_ids(json.dumps(doc)) == {uid}


def test_extract_deeply_nested_mentions_are_found():
    a, b = uuid.uuid4(), uuid.uuid4()
    doc = _doc(
        {
            "type": "bulletList",
            "content": [
                {
                    "type": "listItem",
                    "content": [_para({"type": "text", "text": "x"}, _mention(str(a)))],
                },
                {
                    "type": "listItem",
                    "content": [
                        {
                            "type": "blockquote",
                            "content": [_para(_mention(str(b)))],
                        }
                    ],
                },
            ],
        }
    )
    assert extract_mention_ids(doc) == {a, b}


def test_extract_dedupes_repeated_ids():
    uid = uuid.uuid4()
    doc = _doc(
        _para(_mention(str(uid))),
        _para(_mention(str(uid), label="Same Person Twice")),
    )
    assert extract_mention_ids(doc) == {uid}


def test_extract_ignores_label_uses_only_id():
    # MEN-1: identity is attrs.id, never the display label.
    uid = uuid.uuid4()
    doc = _doc(_para(_mention(str(uid), label="Wrong Name")))
    assert extract_mention_ids(doc) == {uid}


def test_extract_non_uuid_id_is_ignored():
    good = uuid.uuid4()
    doc = _doc(
        _para(
            _mention("not-a-uuid"),
            _mention(str(good)),
            {"type": "mention", "attrs": {"label": "no id at all"}},
            {"type": "mention"},  # no attrs key
        )
    )
    assert extract_mention_ids(doc) == {good}
