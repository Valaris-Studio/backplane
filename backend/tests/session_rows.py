# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Session rows written straight to the database, for read-side tests that
need exact timestamps, costs and states rather than what ingest derives."""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.core.harness import KNOWN_HARNESSES
from app.models.agent_session import AgentSession, SessionWorkLink
from app.models.companion import CompanionInstallation, CompanionProjectMapping


async def add_installation(db, owner, **values) -> CompanionInstallation:
    installation = CompanionInstallation(
        owner_id=owner.id,
        name=values.pop("name", "Synthetic laptop"),
        platform="linux",
        token_hash=hashlib.sha256(secrets.token_bytes(16)).hexdigest(),
        token_prefix="bpc_test",
        enabled_agents=values.pop("enabled_agents", list(KNOWN_HARNESSES)),
        last_seen_at=values.pop("last_seen_at", datetime.now(timezone.utc)),
        **values,
    )
    db.add(installation)
    await db.flush()
    return installation


async def add_mapping(db, installation, workspace, **values) -> CompanionProjectMapping:
    mapping = CompanionProjectMapping(
        installation_id=installation.id,
        workspace_id=workspace.id,
        root_path="/synthetic/" + uuid.uuid4().hex,
        origin="explicit",
        **values,
    )
    db.add(mapping)
    await db.flush()
    return mapping


async def add_session(
    db,
    installation,
    workspace,
    *,
    started: timedelta,
    last: timedelta | None = None,
    **values,
) -> AgentSession:
    """`started` and `last` are how long ago, measured from now."""
    now = datetime.now(timezone.utc)
    last_event_at = now - (last if last is not None else timedelta(0))
    if "cost_usd" in values and values["cost_usd"] is not None:
        values["cost_usd"] = Decimal(str(values["cost_usd"]))
    session = AgentSession(
        workspace_id=workspace.id,
        owner_id=installation.owner_id,
        installation_id=installation.id,
        harness=values.pop("harness", "claude_code"),
        native_session_id=values.pop("native", uuid.uuid4().hex),
        started_at=now - started,
        last_event_at=last_event_at,
        activity_event_count=values.pop("activity_event_count", 1),
        **values,
    )
    db.add(session)
    await db.flush()
    return session


async def add_link(
    db,
    session,
    entity,
    *,
    relation="changed",
    entity_type="card",
    last_seen: timedelta = timedelta(0),
    correlated=False,
) -> SessionWorkLink:
    seen_at = datetime.now(timezone.utc) - last_seen
    link = SessionWorkLink(
        session_id=session.id,
        workspace_id=session.workspace_id,
        entity_type=entity_type,
        entity_id=entity.id,
        board_id=getattr(entity, "board_id", None),
        relation=relation,
        first_seen_at=seen_at - timedelta(minutes=1),
        last_seen_at=seen_at,
        invocation_count=1,
        correlated_count=1 if correlated else 0,
    )
    db.add(link)
    await db.flush()
    return link
