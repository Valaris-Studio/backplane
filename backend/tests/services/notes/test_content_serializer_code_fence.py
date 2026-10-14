# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.services.notes.content_serializer import prosemirror_to_markdown


def _code_doc(code: str) -> dict:
    return {
        "type": "doc",
        "content": [{"type": "codeBlock", "content": [{"type": "text", "text": code}]}],
    }


def test_serialize_code_block_many_backtick_runs_keeps_minimum_fence() -> None:
    # Parity guard for the frontend twin, whose Math.max spread overflowed here.
    code = "` " * 200_000
    assert prosemirror_to_markdown(_code_doc(code)) == f"```\n{code}\n```"
