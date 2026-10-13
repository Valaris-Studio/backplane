# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A2 HTTP fixtures reuse A1's real keys, request transactions and note corpus."""

import copy
import uuid
from dataclasses import dataclass

import pytest_asyncio
from sqlalchemy import select, update

from app.models.agents.prompt_config import AgentPromptConfig
from app.models.notes.note import Note
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.models.workspace_config import WorkspaceConfig
from tests.routers.agents.context_receipts_support import (
    ALIAS,
    ROLE,
    _receipt_case_fixture,  # noqa: F401
)

HEADER = "X-Backplane-Context-Dispatch-Version"
PROVIDER = "operator-provider-47"
MODEL = "operator-model-47"
INVOCATION = {"kind": "stage", "step_name": None, "prompt_slot": "main"}


@dataclass
class DispatchCase:
    case: object
    template_id: uuid.UUID

    @property
    def config_path(self):
        return f"/api/workspaces/{self.case.workspace['slug']}/config"

    def agent_path(self, agent_id=None):
        return f"/api/workspaces/{self.case.workspace['slug']}/agents/{agent_id or self.case.agent_id}"

    def headers(self, actor="agent", version="1"):
        headers = dict(self.case.headers[actor])
        if version is not None:
            headers[HEADER] = version
        return headers

    async def config(self):
        response = await self.case.http.get(self.config_path, headers=self.headers("recipient"))
        assert response.status_code == 200, response.text
        return response.json()

    async def write(self, pipeline, actor="recipient", **changes):
        current = await self.config()
        return await self.case.http.patch(self.config_path, headers=self.headers(actor), json={
            "pipeline_config": pipeline, "expected_version": current["version"], **changes,
        })

    async def store(self, transform):
        """Model old permissive writers without calling future production symbols."""
        async with self.case.factory() as db:
            config = await db.scalar(select(WorkspaceConfig).where(
                WorkspaceConfig.workspace_id == uuid.UUID(self.case.workspace["id"]),
            ))
            pipeline = copy.deepcopy(config.pipeline_config)
            transform(pipeline)
            config.pipeline_config = pipeline
            await db.commit()

    async def enroll(self):
        await self.store(lambda p: p.update(context_dispatch={
            "version": 1, "required_agent_ids": [self.case.agent_id],
        }))

    async def contract(self, agent_id=None, actor="agent", version="1"):
        return await self.case.http.get(self.agent_path(agent_id) + "/context-dispatch-contract",
                                        headers=self.headers(actor, version))

    async def assignment(self, *, version="1"):
        body = {"board_id": self.case.board_id}
        if version is not None:
            body["context_dispatch_version"] = int(version)
            negotiation = await self.contract(version=version)
            body["context_dispatch_policy_revision"] = (
                negotiation.json().get("policy_revision", "0" * 64)
                if negotiation.status_code == 200 else "0" * 64
            )
        return await self.case.http.post(self.agent_path() + "/next-assignment",
                                        headers=self.headers(version=version), json=body)

    async def bound(self, *, required=True):
        if required:
            await self.enroll()
        response = await self.assignment()
        assert response.status_code == 200, response.text
        assignment = response.json()
        # A1 ignores these additive fields. A2 must persist and enforce them.
        policy = assignment.get("context_dispatch", {}).get("policy_revision", "0" * 64)
        payload = self.case.start_payload(assignment, context_dispatch_version=1,
                                          context_dispatch_policy_revision=policy)
        response = await self.case.http.post(f"/api/agents/{self.case.agent_id}/executions",
                                            json=payload, headers=self.headers())
        assert response.status_code == 201, response.text
        return assignment, response.json(), payload

    async def snapshot(self, execution, invocation=None):
        invocation = invocation or INVOCATION
        params = {"invocation_kind": invocation["kind"], "prompt_slot": invocation["prompt_slot"]}
        if invocation.get("step_name") is not None:
            params["step_name"] = invocation["step_name"]
        return await self.case.http.get(self.case.execution_path(execution["id"]) + "/dispatch-context",
                                       params=params, headers=self.headers())

    async def current(self, execution, invocation=None):
        response = await self.snapshot(execution, invocation)
        assert response.status_code == 200, response.text
        assert response.headers.get(HEADER) == "1"
        return response.json()

    def payload(self, snapshot, **changes):
        return {
            "protocol_version": 1, "client_request_id": str(uuid.uuid4()),
            "context_revision": snapshot["context_revision"],
            "dispatch_revision": snapshot["dispatch_revision"],
            "invocation": snapshot["invocation"],
            "input_prompt": "Prelude 🧪\n" + snapshot["context"].get(ALIAS, ""),
            "system_prompt": "", "provider": PROVIDER, "adapter": "custom-adapter-47",
            "model": MODEL, "resolution_kind": "pinned", "resume_session_id": None,
            "channel_contract": {"version": 1, "input": "verbatim", "system": "empty", "resume": False},
            **changes,
        }

    async def prepare(self, execution, payload, actor="agent"):
        return await self.case.http.post(self.case.execution_path(execution["id"]) + "/dispatch-preparations",
                                        json=payload, headers=self.headers(actor))


@pytest_asyncio.fixture(name="dispatch_case")
async def _dispatch_case_fixture(receipt_case):
    case = receipt_case
    template_id = uuid.uuid4()
    async with case.factory() as db:
        await db.execute(update(WorkspaceMember).where(
            WorkspaceMember.workspace_id == uuid.UUID(case.workspace["id"]),
            WorkspaceMember.user_id == uuid.UUID(case.recipient_id),
        ).values(role=WorkspaceRole.admin))
        config = await db.scalar(select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == uuid.UUID(case.workspace["id"]),
        ))
        pipeline = copy.deepcopy(config.pipeline_config)
        pipeline["stages"][0]["llm"].update(provider=PROVIDER, model=MODEL)
        # A1 seeds arbitrary historical kinds directly. Config-write tests must
        # pass today's unrelated kind vocabulary guard to reach A2 policy.
        for source in pipeline["stages"][0]["llm"]["context_sources"]:
            if "kind" in source["filter"]:
                source["filter"]["kind"] = "user_note"
        await db.execute(update(Note).where(Note.id.in_([
            uuid.UUID(case.notes[0]["id"]), uuid.UUID(case.notes[1]["id"]),
        ])).values(kind="user_note"))
        config.pipeline_config = pipeline
        db.add(AgentPromptConfig(id=template_id, name="Authored arbitrary-role prompt",
                                slug="operator-template-47", team_role=ROLE, stage="continue_project",
                                content='Current template 🧪\n{{ index .ContextSources "ReviewedHandoff_47" }}',
                                workspace_id=uuid.UUID(case.workspace["id"]),
                                created_by_id=uuid.UUID(case.recipient_id)))
        await db.commit()
    yield DispatchCase(case, template_id)


def finding_codes(response):
    """Accept the established validation-list and API-error envelopes."""
    body = response.json()
    detail = body.get("detail")
    if isinstance(detail, list):
        return {entry.get("code", entry.get("error_code")) for entry in detail}
    return {body.get("error_code")} | ({detail.get("error_code")} if isinstance(detail, dict) else set())


def two_steps(pipeline):
    pipeline["stages"][0]["lifecycle"] = [
        {"name": "first_call", "kind": "llm", "params": {"stage": "continue_project"}, "next": "second_call"},
        {"name": "second_call", "kind": "llm", "params": {
            "stage": "continue_project", "provider": PROVIDER, "model": MODEL,
            "context_sources": [{"kind": "card_notes", "as": "SecondContext47", "required": True,
                                 "filter": {"kind": "user_note", "limit": 3}}],
            "tool_policy": {"deny": ["Bash(never-second:*)"]},
        }, "next": "finished"},
        {"name": "finished", "kind": "end", "params": {}},
    ]
