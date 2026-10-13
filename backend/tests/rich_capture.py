# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Shared setup for the rich-capture tests: a rich mapping on a device that
negotiated rich capture, records built from the frozen wire corpus
(contracts/rich-capture/wire/), and declarations whose size and digest are
their own body's.

Wire timestamps are fixed on 2026-10-08. Tests that delete a session rely on
its cutoff (the real deletion time plus the device's clock lead) reaching
past them, which holds for any run after that day."""

import copy
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.agent_session import AgentSession
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.services.session_retention import SessionRetentionService
from app.schemas.session_content import (
    CAPABILITIES_HEADER,
    CHUNK_DIGEST_HEADER,
    RICH_CAPTURE_CAPABILITY,
)

WIRE = Path(__file__).resolve().parents[2] / "contracts" / "rich-capture" / "wire"
ME = "/api/me/companion/installations"
INGEST = "/api/companion/ingest"
POLICY = "/api/companion/policy"
CONTENTS = "/api/companion/contents"
ROOT = "/synthetic/project"
# The offer example's grant: wire records are observed after it.
RICH_SINCE = datetime(2026, 10, 8, 13, 58, 41, tzinfo=timezone.utc)
GENERATION = {
    "id": "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b",
    "profile": "rich",
    "admitted_from": "2026-10-08T14:00:00Z",
    "policy_revision": "5ba464a63a45a12848bee0be8bd50bdb82ddc503c9ffaddfd11f03c73d1b73d3",
}
REDACTION = {"filter_version": "asymptoteobserve-redact/1", "replacements": 0}
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def wire(name: str) -> dict:
    return copy.deepcopy(json.loads((WIRE / f"{name}.json").read_text())["body"])


def content_key(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode()).hexdigest()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def enroll_rich(
    client,
    device_client,
    db_session,
    workspace,
    board,
    *,
    root: str = ROOT,
    rich_since: datetime = RICH_SINCE,
    capabilities: str | None = RICH_CAPTURE_CAPABILITY,
) -> dict:
    """An installation with one rich mapping, granted since `rich_since`,
    that fetched its policy announcing `capabilities`."""
    installation = (
        await client.post(
            ME,
            json={
                "installation_id": str(uuid.uuid4()),
                "name": "Synthetic laptop",
                "platform": "linux-amd64",
            },
        )
    ).json()
    created = await client.post(
        f"{ME}/{installation['installation_id']}/mappings",
        json={
            "workspace_id": str(workspace.id),
            "board_id": str(board.id),
            "root_path": root,
            "content_level": "rich",
        },
    )
    assert created.status_code == 201, created.text
    mapping = created.json()
    await db_session.execute(
        update(CompanionProjectMapping)
        .where(CompanionProjectMapping.id == uuid.UUID(mapping["id"]))
        .values(rich_since=rich_since)
    )
    await db_session.flush()
    headers = {"Authorization": "Bearer " + installation["device_token"]}
    policy = await device_client.get(
        POLICY,
        headers={**headers, CAPABILITIES_HEADER: capabilities}
        if capabilities
        else headers,
    )
    assert policy.status_code == 200, policy.text
    return {
        "installation": installation,
        "installation_id": installation["installation_id"],
        "mapping": mapping,
        "mapping_id": mapping["id"],
        "headers": headers,
    }


def declaration(
    body: bytes | None,
    *,
    key: str | None = None,
    channel: str = "tool_output",
    role: str = "tool",
    media_type: str = "text/plain",
    delivery: str | None = None,
    occurred_at: str = "2026-10-08T14:04:20Z",
    order: int = 47,
    **fields,
) -> dict:
    """A declaration of `body`, inline when small text, uploaded otherwise;
    with no body, `coverage`/`coverage_reason` must be given."""
    declared = {
        "content_key": key or content_key("claude_code", "sess-1", uuid.uuid4().hex),
        "role": role,
        "channel": channel,
        "source": {
            "kind": "claude_transcript",
            "parser": "companion-claude-transcript/1",
            "schema_version": "claude-code-jsonl/2",
            "native_ref": str(uuid.uuid4()),
            "order": order,
        },
        "occurred_at": occurred_at,
        "observed_at": occurred_at,
        "media_type": media_type,
        "redaction": REDACTION,
        "coverage": "captured",
    }
    if body is None:
        declared["delivery"] = delivery or "none"
    else:
        declared["byte_count"] = len(body)
        declared["sha256"] = sha256(body)
        inline = channel != "attachment" and len(body) <= 16 << 10
        declared["delivery"] = delivery or ("inline" if inline else "upload")
        if declared["delivery"] == "inline":
            declared["inline_text"] = body.decode()
    return {**declared, **fields}


def rich_record(mapping_id, contents: list[dict], *, events=None, **overrides) -> dict:
    """The wire corpus' rich record carrying `contents` instead of its own."""
    record = wire("ingest-request-rich-record")
    record.update(
        capture_id=uuid.uuid4().hex,
        mapping_id=str(mapping_id),
        contents=contents,
        capture_generation=dict(GENERATION),
    )
    if events is not None:
        record["events"] = events
    return {**record, **overrides}


async def ingest(device_client, enrolled, records):
    response = await device_client.post(
        INGEST, json={"records": records}, headers=enrolled["headers"]
    )
    assert response.status_code == 200, response.text
    return response.json()


def acks_by_key(result: dict) -> dict[str, dict]:
    return {ack["content_key"]: ack for ack in result["contents"]}


async def put_chunk(device_client, enrolled, content_id, index, chunk, *, digest=None):
    return await device_client.put(
        f"{CONTENTS}/{content_id}/chunks/{index}",
        content=chunk,
        headers={
            **enrolled["headers"],
            "Content-Type": "application/octet-stream",
            CHUNK_DIGEST_HEADER: digest or sha256(chunk),
        },
    )


async def finalize(device_client, enrolled, content_id, body: bytes, **overrides):
    return await device_client.post(
        f"{CONTENTS}/{content_id}/finalize",
        json={"byte_count": len(body), "sha256": sha256(body), **overrides},
        headers=enrolled["headers"],
    )


async def upload(device_client, enrolled, ack: dict, body: bytes) -> dict:
    """Every chunk of an upload_required ack, then finalize; returns the
    final upload state."""
    chunk_bytes = ack["upload"]["chunk_bytes"]
    for index in range(ack["upload"]["chunk_count"]):
        chunk = body[index * chunk_bytes : (index + 1) * chunk_bytes]
        response = await put_chunk(
            device_client, enrolled, ack["content_id"], index, chunk
        )
        assert response.status_code == 200, response.text
    response = await finalize(device_client, enrolled, ack["content_id"], body)
    assert response.status_code == 200, response.text
    return response.json()


async def declare_and_upload(device_client, enrolled, body: bytes, **fields) -> dict:
    declared = declaration(body, delivery="upload", **fields)
    result = await ingest(
        device_client, enrolled, [rich_record(enrolled["mapping_id"], [declared])]
    )
    [ack] = result["contents"]
    assert ack["outcome"] == "upload_required", ack
    return {"ack": ack, "state": await upload(device_client, enrolled, ack, body)}


async def only_session(db_session) -> AgentSession:
    return await db_session.scalar(
        select(AgentSession).execution_options(populate_existing=True)
    )


def sessions_path(workspace, session_id) -> str:
    return f"/api/workspaces/{workspace.slug}/sessions/{session_id}"


async def installation_bytes(db_session, enrolled) -> int:
    installation = await db_session.scalar(
        select(CompanionInstallation)
        .where(CompanionInstallation.id == uuid.UUID(enrolled["installation_id"]))
        .execution_options(populate_existing=True)
    )
    return installation.content_bytes


def purge(db_engine) -> SessionRetentionService:
    """The retention job on its own sessions, as the background loop runs it;
    callers commit their setup first."""
    return SessionRetentionService(
        async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    )


def integration_leg_unavailable(reason: str) -> None:
    """Skip an integration leg whose service is not configured, except in the
    handoff gate (RICH_CAPTURE_REQUIRE_LEGS=1), where a missing leg fails."""
    if os.environ.get("RICH_CAPTURE_REQUIRE_LEGS") == "1":
        pytest.fail(f"required integration leg unavailable: {reason}")
    pytest.skip(reason)
