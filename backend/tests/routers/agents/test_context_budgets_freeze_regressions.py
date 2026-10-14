# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored contracts from root's binding review decisions: the
required-admission failure reason, an explicit null version, and pre-decode
structure admission observed through HTTP at lowered configured ceilings."""

import pytest

from app.services.agents import context_assembly, context_manifest, guarded_context_assembly
from tests.routers.agents.context_budgets_support import (
    DEFAULT_POLICY,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    compact_json,
    expected_block,
    source,
    utf8,
)
from tests.routers.agents.context_receipts_support import document
from tests.routers.agents.context_structure_support import VISIBLE, depth_document
from tests.routers.agents.test_context_budgets_implementer import _store_budget
from tests.routers.agents.test_context_structure_ceilings import install_instance_limits

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]


async def test_required_admission_failure_names_its_reason(budget_case):
    case = budget_case
    await case.seed([{"content": "oversize-" + "x" * 80}])
    await case.configure([source(alias="R" * 70000, required=True)], max_note_body_bytes=64)
    response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    payload = response.json()
    assert payload["error_code"] == "context_budget_exceeded"
    assert payload["context"]["reason"] == "required_source"
    # Adversarial alias: the envelope stays bounded and carries no body.
    assert len(response.content) <= 3 * 65536
    assert "oversize-" not in response.text


async def test_present_null_version_is_refused(budget_case):
    case = budget_case
    await case.seed([{"content": "never-read"}])
    await _store_budget(case, [source()], {**DEFAULT_POLICY, "version": None})
    response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_budget_invalid"


async def test_lowered_ceilings_ignore_delimiters_inside_json_strings(budget_case, monkeypatch):
    # Quoted brackets and commas are text: a quote-unaware scan would see depth
    # 15+ and dozens of values here and wrongly exclude the note.
    install_instance_limits(monkeypatch, max_json_depth=8, max_json_nodes=40)
    case = budget_case
    value = document(VISIBLE)
    value["attrs"] = {"quoted": "[[[[[[[[[[{{{{" + ",1" * 40 + '\\"]'}
    note, = await case.seed([{"content": compact_json(value)}])
    await case.configure([source()])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": expected_block({**note, "content": VISIBLE})}
    assert response.json()["context_manifest"]["diagnostics"]["excluded_count"] == 0


async def test_lowered_ceiling_scan_precedes_render_and_revision_hash(budget_case, monkeypatch):
    install_instance_limits(monkeypatch, max_json_depth=8)
    case = budget_case
    rejected_body = compact_json(depth_document(9))
    rejected, later = await case.seed([{"content": rejected_body}, {"content": "later small é"}])
    events = []

    def spy(name, real):
        def recorded(content, *args, **kwargs):
            events.append((name, content))
            return real(content, *args, **kwargs)
        return recorded

    monkeypatch.setattr(guarded_context_assembly, "structure_excess",
                        spy("scan", guarded_context_assembly.structure_excess))
    monkeypatch.setattr(context_assembly, "prosemirror_to_markdown",
                        spy("render", context_assembly.prosemirror_to_markdown))
    monkeypatch.setattr(context_manifest, "_revision_content",
                        spy("hash", context_manifest._revision_content))
    await case.configure([source()])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": expected_block(later)}
    entry, = response.json()["context_manifest"]["diagnostics"]["entries"]
    assert (entry["note_id"], entry["reason"]) == (rejected["id"], "structure_depth_limit")
    assert [name for name, content in events if content == rejected_body] == ["scan"]
    assert [name for name, content in events if content == later["content"]] == ["scan", "render", "hash"]
    assert utf8(rejected_body) < DEFAULT_POLICY["max_note_body_bytes"]
