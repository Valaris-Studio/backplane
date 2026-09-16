# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One PM→markdown truth: backend serializer vs the shared parity corpus.

`fixtures/pm_markdown_corpus.json` is the single canonical corpus read by BOTH
serializer suites (the frontend twin is
`frontend/src/features/notes/utils/__tests__/noteToMarkdown.corpus.test.ts`).
Each entry pins the CONTRACT emission for one node of the closed vocabulary —
frontend emission for mention/image/fileAttachment, backend P0-1 emission for
tables — so whichever engine lags the contract goes red on exactly those
entries while the already-agreeing entries act as regression guards.

RED today (editor P0-4): the backend's unknown-node fallback serializes
mention, image and fileAttachment to nothing, so those entries (plus
kitchen-sink) fail until the serializer gains the matching rules.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.notes.content_serializer import prosemirror_to_markdown

_CORPUS_PATH = Path(__file__).parent / "fixtures" / "pm_markdown_corpus.json"
_CORPUS = json.loads(_CORPUS_PATH.read_text())


@pytest.mark.parametrize("entry", _CORPUS, ids=[e["name"] for e in _CORPUS])
def test_serialize_corpus_entry_matches_contract(entry: dict) -> None:
    assert prosemirror_to_markdown(entry["doc"]) == entry["expected_markdown"]
