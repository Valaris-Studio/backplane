# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: the internal guarded selection a completion consumer
can reuse — one request-local body per note across aliases, exact admitted
bytes and revisions, and no legacy or wire change."""

import uuid

import pytest

from app.config import settings
from app.repositories.kanban.board import BoardRepository
from app.repositories.kanban.card import CardRepository
from app.services.agents.context_assembly import assemble_context_with_manifest
from app.services.agents.context_budget import resolve_context_budget
from app.services.agents.context_manifest import note_revision, sha256_text, utf8_bytes
from app.services.agents.guarded_context_assembly import assemble_guarded_context
from tests.routers.agents.context_budgets_support import (
    DEFAULT_POLICY,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    expected_block,
    note_for_source,
    observe_notes,
    source,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]


async def _bound_card_and_board(case, session):
    card = await CardRepository(session).get_by_id(uuid.UUID(case.receipt.card_id))
    board = await BoardRepository(session).get_by_id(uuid.UUID(case.receipt.board_id))
    return card, board


async def test_selection_reuses_one_fetched_body_per_note_across_aliases(budget_case):
    case = budget_case
    note, = await case.seed([{"content": "shared-é🧭"}])
    pinned, = await case.seed([note_for_source("pinned_notes", content="workspace-pinned-é")])
    sources = [source(alias="First"), source(alias="Again"), source("pinned_notes", alias="Pinned")]
    async with case.receipt.factory() as session:
        card, board = await _bound_card_and_board(case, session)
        with observe_notes(case) as observed:
            assembled = await assemble_guarded_context(
                session, policy=resolve_context_budget(DEFAULT_POLICY, settings.CONTEXT_BUDGET_CEILINGS),
                ceilings=settings.CONTEXT_BUDGET_CEILINGS,
                workspace_id=uuid.UUID(case.receipt.workspace["id"]), card=card, board=board,
                sources=sources,
            )
    assert observed.body_reads == {note["id"]: 1, pinned["id"]: 1}
    selection = assembled.selection
    assert [s.alias for s in selection.sources] == ["First", "Again", "Pinned"]
    first, again, pinned_source = selection.sources
    assert first.notes[0].body is again.notes[0].body
    assert selection.budget == assembled.manifest.budget
    for selected, expected in ((first, note), (pinned_source, pinned)):
        admitted, = selected.notes
        kind = "card_notes" if selected is first else "pinned_notes"
        assert admitted.rendered == expected_block(expected, kind) == selected.text
        assert admitted.rendered_sha256 == sha256_text(admitted.rendered)
        assert admitted.rendered_bytes == utf8_bytes(admitted.rendered)
        assert admitted.revision_sha256 == note_revision(admitted.body)
        assert str(admitted.body.id) == expected["id"]
        assert selected.admission == assembled.manifest.sources[selected.source_index].admission
    # Wire provenance is unchanged: only card_notes are record-traced.
    assert [len(s.records) for s in assembled.manifest.sources] == [1, 1, 0]


async def test_legacy_assembly_and_refresh_wire_carry_no_selection(budget_case):
    case = budget_case
    await case.seed([{"content": "legacy-é"}])
    async with case.receipt.factory() as session:
        card, board = await _bound_card_and_board(case, session)
        legacy = await assemble_context_with_manifest(
            session, workspace_id=uuid.UUID(case.receipt.workspace["id"]), card=card, board=board,
            sources=[source()],
        )
    assert legacy.selection is None
    await case.configure([source()])
    response = await case.refresh()
    assert response.status_code == 200
    assert set(response.json()) == {"execution_id", "context", "context_manifest", "context_revision"}
