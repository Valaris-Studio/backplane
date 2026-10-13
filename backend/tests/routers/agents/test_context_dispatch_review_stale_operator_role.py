# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regression: operator guards must read the CURRENT
role, not a membership object the request session already holds.

The route dependency loads WorkspaceMember into the request session
(expire_on_commit=False). A role change committed by another transaction
while the request waits must win over that identity-map copy."""

import copy
import uuid

import pytest
from sqlalchemy import update

from app.exceptions import ForbiddenError
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.repositories.workspace import WorkspaceMemberRepository
from app.services.agents.context_dispatch import ContextDispatchPolicyService
from app.services.completion_policy import CompletionPolicyService
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def _demote_elsewhere(d, role):
    async with d.case.factory() as other:
        await other.execute(update(WorkspaceMember).where(
            WorkspaceMember.workspace_id == uuid.UUID(d.case.workspace["id"]),
            WorkspaceMember.user_id == uuid.UUID(d.case.recipient_id),
        ).values(role=role))
        await other.commit()


async def _held_membership(db, d):
    # Callers keep the returned object alive like WorkspaceContext does: the
    # identity map holds instances weakly, so a dropped one would be re-read.
    held = await WorkspaceMemberRepository(db).get_membership(
        uuid.UUID(d.case.workspace["id"]), uuid.UUID(d.case.recipient_id))
    assert held.role == WorkspaceRole.admin
    return held


@pytest.mark.parametrize("demoted_to", [WorkspaceRole.member, WorkspaceRole.viewer])
async def test_context_policy_guard_reads_the_current_role(dispatch_case, demoted_to):
    d = dispatch_case
    pipeline = (await d.config())["pipeline_config"]
    proposed = copy.deepcopy(pipeline)
    proposed["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id]}
    async with d.case.factory() as db:
        held = await _held_membership(db, d)
        await _demote_elsewhere(d, demoted_to)
        with pytest.raises(ForbiddenError):
            await ContextDispatchPolicyService(db).check_pipeline_write(
                uuid.UUID(d.case.workspace["id"]), pipeline, proposed, uuid.UUID(d.case.recipient_id))
        assert held.role == WorkspaceRole.admin  # the request copy stays stale; the guard must not use it


async def test_completion_operator_guard_reads_the_current_role(dispatch_case):
    d = dispatch_case
    async with d.case.factory() as db:
        held = await _held_membership(db, d)
        await _demote_elsewhere(d, WorkspaceRole.member)
        with pytest.raises(ForbiddenError):
            await CompletionPolicyService(db).authorize(
                uuid.UUID(d.case.workspace["id"]), uuid.UUID(d.case.recipient_id), operator=True)
        assert held.role == WorkspaceRole.admin


async def test_current_admin_still_passes_both_guards(dispatch_case):
    d = dispatch_case
    pipeline = (await d.config())["pipeline_config"]
    proposed = copy.deepcopy(pipeline)
    proposed["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id]}
    async with d.case.factory() as db:
        held = await _held_membership(db, d)
        await ContextDispatchPolicyService(db).check_pipeline_write(
            uuid.UUID(d.case.workspace["id"]), pipeline, proposed, uuid.UUID(d.case.recipient_id))
        await CompletionPolicyService(db).authorize(
            uuid.UUID(d.case.workspace["id"]), uuid.UUID(d.case.recipient_id), operator=True)
        assert held.role == WorkspaceRole.admin
