#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Bounded real-PostgreSQL completion qualification; owns its disposable container.

Run with the backend virtualenv's Python. Does not use DATABASE_URL from the caller,
start application background loops, contact a forge, or touch existing containers.
The HTTP auth and forge responses are fixtures; SQL, migrations, services, request
transactions, queue worker, and local event subscribers are real.
"""

import argparse
import asyncio
from datetime import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
HEAD = "a" * 40
MERGED = "b" * 40
REPO_URL = "https://github.com/fixture/completion-qualification"
PR_URL = REPO_URL + "/pull/17"
REVIEW_ROLE = "operator-defined-independent-review-role-64".ljust(64, "x")
VALIDATION_ROLE = "operator-defined-exact-validation"
LEGACY_IDS = {
    key: uuid.uuid4()
    for key in ("user", "workspace", "board", "column", "card", "config")
}


def policy(**changes):
    return {
        "version": 1,
        "landing_actor": "platform",
        "landing_methods": ["merge_queue"],
        "source_review": "independent",
        "review_role": REVIEW_ROLE,
        "require_forge_checks": False,
        "postmerge_validation": {
            "role": VALIDATION_ROLE,
            "checks": [
                {"id": "fixture-ci", "argv": ["fixture-check"], "timeout_seconds": 30},
            ],
        },
        "evidence_only": {
            "enabled": True,
            "approval": "independent",
            "review_role": REVIEW_ROLE,
        },
        "dependency_release": "accepted",
        "auto_complete": False,
        **changes,
    }


def command(args, *, env=None, timeout=120):
    result = subprocess.run(
        args, cwd=BACKEND, env=env, capture_output=True, text=True, timeout=timeout
    )
    if result.returncode:
        raise RuntimeError(
            f"{args[0]} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}"
        )
    return result.stdout.strip()


async def seed_legacy(url):
    from sqlalchemy import MetaData
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(url)
    try:
        async with engine.begin() as conn:
            metadata = MetaData()
            await conn.run_sync(
                lambda sync: metadata.reflect(
                    sync,
                    only=[
                        "users",
                        "workspaces",
                        "boards",
                        "columns",
                        "cards",
                        "workspace_configs",
                    ],
                )
            )
            rows = [
                (
                    "users",
                    "user",
                    {"email": "legacy@qualification.invalid", "name": "Legacy fixture"},
                ),
                (
                    "workspaces",
                    "workspace",
                    {
                        "name": "Legacy fixture",
                        "slug": "legacy",
                        "created_by": LEGACY_IDS["user"],
                    },
                ),
                (
                    "boards",
                    "board",
                    {
                        "workspace_id": LEGACY_IDS["workspace"],
                        "name": "Legacy fixture",
                        "slug": "legacy",
                        "description": "Preserve old behavior",
                        "created_by": LEGACY_IDS["user"],
                        "enforce_done_merge_gate": False,
                        "loop_config": {"enabled": False, "loop_landing": "manual"},
                    },
                ),
                (
                    "columns",
                    "column",
                    {
                        "board_id": LEGACY_IDS["board"],
                        "name": "Done",
                        "position": 1024,
                        "column_type": "done",
                    },
                ),
                (
                    "cards",
                    "card",
                    {
                        "board_id": LEGACY_IDS["board"],
                        "column_id": LEGACY_IDS["column"],
                        "created_by": LEGACY_IDS["user"],
                        "title": "Already completed legacy card",
                        "description": "Keep this content",
                        "card_type": "task",
                        "priority": "none",
                        "position": 1024,
                    },
                ),
                (
                    "workspace_configs",
                    "config",
                    {
                        "workspace_id": LEGACY_IDS["workspace"],
                        "enforce_done_merge_gate": True,
                        "max_rework_attempts": 3,
                        "card_cooldown_hours": 1,
                        "commit_message_template": "legacy template",
                        "pr_description_template": "",
                        "version": 1,
                    },
                ),
            ]
            for table, key, values in rows:
                await conn.execute(
                    metadata.tables[table]
                    .insert()
                    .values(
                        id=LEGACY_IDS[key],
                        created_at=datetime.now(),
                        updated_at=datetime.now(),
                        **values,
                    )
                )
    finally:
        await engine.dispose()


async def qualify(url, report):
    from fastapi import Request
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import func, select, text
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.auth import current_agent_id, get_current_user
    from app.core.event_bus import EventBus
    from app.database import get_db
    from app.main import create_app
    from app.models.agents.agent import Agent, AgentType
    from app.models.agents.execution import AgentExecution, ExecutionStatus
    from app.models.agents.merge_queue import MergeQueueEntry
    from app.models.git.git_repo import GitProvider, GitRepo
    from app.models.kanban.board import Board
    from app.models.kanban.card import Card, CardDependency
    from app.models.kanban.column import Column, ColumnType
    from app.models.kanban.completion import CompletionAttempt, CompletionCandidate
    from app.models.notes.note import Note
    from app.models.user import User
    from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
    from app.models.workspace_config import WorkspaceConfig
    from app.services.completion_policy import CompletionPolicyService
    from app.services.kanban.reconciler import MergedPRReconciler
    from app.services.merge_queue import run_merge_queue_tick

    engine = create_async_engine(
        url,
        connect_args={
            "server_settings": {
                "lock_timeout": "2000",
                "statement_timeout": "5000",
                "application_name": "completion-qualification",
            }
        },
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    app = create_app()
    checks = report["checks"]

    async def request_db():
        async with sessions() as db, db.begin():
            yield db

    async def fixture_user(request: Request):
        token = current_agent_id.set(
            agent.id if request.headers.get("X-Fixture-Runner") else None
        )
        try:
            yield user
        finally:
            current_agent_id.reset(token)

    app.dependency_overrides[get_db] = request_db
    app.dependency_overrides[get_current_user] = fixture_user
    try:
        async with sessions() as db, db.begin():
            assert (
                await db.scalar(text("SELECT version_num FROM alembic_version"))
                == "107"
            )
            legacy = await db.get(Board, LEGACY_IDS["board"])
            legacy_config = await db.get(WorkspaceConfig, LEGACY_IDS["config"])
            legacy_card = await db.get(Card, LEGACY_IDS["card"])
            assert (
                legacy.completion_policy is None
                and legacy_config.completion_policy is None
            )
            assert (
                legacy.enforce_done_merge_gate is False
                and legacy_config.enforce_done_merge_gate is True
            )
            assert legacy.loop_config == {"enabled": False, "loop_landing": "manual"}
            assert (
                legacy_card.completion_mode == "source"
                and legacy_card.column_id == LEGACY_IDS["column"]
            )
            assert legacy_card.description == "Keep this content"
            assert await CompletionPolicyService(db).effective_policy(legacy) is None
            assert (
                await db.scalar(select(func.count()).select_from(CompletionCandidate))
                == 0
            )
            role_width = await db.scalar(
                text(
                    "SELECT character_maximum_length FROM information_schema.columns WHERE table_name='agent_executions' AND column_name='role'"
                )
            )
            assert role_width == 64
            checks.append(
                "migration104→105→106→107 preserves seeded legacy null policy, gates, loop, Done card; no candidates backfilled; role widened64"
            )
            legacy_config.completion_policy = policy()
            await db.flush()
            assert (
                await CompletionPolicyService(db).effective_policy(legacy)
            ).review_role == REVIEW_ROLE
            legacy_config.completion_policy = None
            await db.flush()
            assert (
                await db.scalar(
                    text(
                        "SELECT completion_policy IS NULL FROM workspace_configs WHERE id=:id"
                    ),
                    {"id": LEGACY_IDS["config"]},
                )
                is True
            )
            checks.append(
                "real PostgreSQL SQL NULL assignment and whole-object workspace inheritance"
            )

            user = User(email="operator@qualification.invalid", name="Fixture operator")
            db.add(user)
            await db.flush()
            workspace = Workspace(
                name="Qualification", slug="qualification", created_by=user.id
            )
            db.add(workspace)
            await db.flush()
            db.add(
                WorkspaceMember(
                    workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.owner
                )
            )
            board = Board(
                workspace_id=workspace.id,
                name="Qualification",
                slug="qualification",
                created_by=user.id,
            )
            agent = Agent(
                name="Fixture runner",
                agent_type=AgentType.coding,
                created_by_id=user.id,
            )
            config = WorkspaceConfig(
                workspace_id=workspace.id,
                pipeline_config={
                    "stages": [
                        {
                            "role": role,
                            "enabled": True,
                            "llm": {"provider": "codex-cli", "model": "fixture-model"},
                        }
                        for role in (REVIEW_ROLE, VALIDATION_ROLE)
                    ]
                },
            )
            db.add_all([board, agent, config])
            await db.flush()
            active = Column(
                board_id=board.id,
                name="Review",
                position=1024,
                column_type=ColumnType.review,
            )
            done = Column(
                board_id=board.id,
                name="Done",
                position=2048,
                column_type=ColumnType.done,
            )
            repo = GitRepo(
                board_id=board.id,
                workspace_id=workspace.id,
                name="Fixture",
                slug="fixture",
                url=REPO_URL,
                provider=GitProvider.github,
                default_branch="main",
                added_by=user.id,
            )
            db.add_all([active, done, repo])
            await db.flush()
            card = Card(
                board_id=board.id,
                column_id=active.id,
                title="Source",
                created_by=user.id,
                pr_url=PR_URL,
                branch_name="feature/qualified",
                git_repo_slug=repo.slug,
            )
            dependent = Card(
                board_id=board.id,
                column_id=active.id,
                title="Dependent",
                created_by=user.id,
            )
            db.add_all([card, dependent])
            await db.flush()
            execution = AgentExecution(
                agent_id=agent.id,
                workspace_id=workspace.id,
                board_id=board.id,
                action="loop_iteration",
                role="source",
                status=ExecutionStatus.completed,
                cards_affected=[str(card.id)],
                provider="codex-cli",
                model="fixture-source-model",
            )
            db.add_all(
                [
                    execution,
                    CardDependency(
                        card_id=dependent.id,
                        depends_on_card_id=card.id,
                        created_by=user.id,
                    ),
                ]
            )
            await db.flush()

        base = f"/api/workspaces/qualification/boards/{board.id}"
        endpoint = base + "/completion"
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://fixture"
        ) as client:

            async def api(method, path, body=None, *, runner=False, expected=200):
                response = await client.request(
                    method,
                    path,
                    json=body,
                    headers={"X-Fixture-Runner": "1"} if runner else {},
                )
                assert (
                    response.status_code == expected
                ), f"{method} {path}: {response.status_code} {response.text}"
                return response.json() if response.content else None

            async def claim():
                return (
                    await api(
                        "POST",
                        endpoint + "/work/claim",
                        {
                            "capabilities": {
                                "providers": ["codex-cli"],
                                "exact_checkout": True,
                                "argv_checks": True,
                            }
                        },
                        runner=True,
                    )
                )["work"]

            def result(work, outcome="passed"):
                return {
                    "lease_token": work["lease_token"],
                    "candidate_id": work["candidate_id"],
                    "policy_hash": work["policy_hash"],
                    "contract_hash": work["contract_hash"],
                    "source_sha": work["source_sha"],
                    "outcome": outcome,
                    "summary": "Isolated qualification fixture",
                    "checks": [
                        {
                            "id": "fixture-ci",
                            "exit_code": 0 if outcome == "passed" else 1,
                            "source_sha": work["source_sha"],
                            "output": "Fixture evidence",
                        }
                    ]
                    if work["kind"] == "validation"
                    else [],
                }

            async def ack(work, outcome="passed", expected=200):
                return await api(
                    "POST",
                    endpoint + f"/work/{work['attempt_id']}/result",
                    result(work, outcome),
                    runner=True,
                    expected=expected,
                )

            async def rejected_ack(work, code, *, retryable=False):
                response = await ack(work)
                receipt = response["result_receipt"]
                assert receipt["attempt_id"] == work["attempt_id"]
                assert receipt["status"] == "rejected"
                assert receipt["code"] == code
                assert receipt["retryable"] is retryable
                async with sessions() as db:
                    attempt = await db.get(
                        CompletionAttempt, uuid.UUID(work["attempt_id"])
                    )
                    assert attempt.status == "rejected"
                    assert attempt.result["receipt"] == receipt
                    execution_row = await db.get(AgentExecution, attempt.execution_id)
                    assert execution_row.status == ExecutionStatus.aborted
                return response

            async def ready():
                return (
                    await api(
                        "GET", base + f"/cards/{dependent.id}/dependencies/status"
                    )
                )["ready"]

            async def serialized_edit(method, path, body):
                async with sessions() as holder, holder.begin():
                    await CompletionPolicyService(holder).lock_board_for_completion(
                        board.id
                    )
                    update = asyncio.create_task(api(method, path, body))
                    try:
                        async with sessions() as observer:
                            for _ in range(40):
                                await observer.execute(
                                    text("SELECT pg_stat_clear_snapshot()")
                                )
                                blocked = await observer.scalar(
                                    text(
                                        "SELECT count(*) FROM pg_stat_activity WHERE application_name='completion-qualification' AND wait_event_type='Lock'"
                                    )
                                )
                                if blocked:
                                    break
                                await asyncio.sleep(0.025)
                            assert (
                                blocked and not update.done()
                            ), f"{path} failed to serialize behind completion lock"
                    except BaseException:
                        update.cancel()
                        await asyncio.gather(update, return_exceptions=True)
                        raise
                await asyncio.wait_for(update, timeout=4)

            async def new_review():
                forge.merged, forge.state, forge.merge_commit_sha = False, "open", None
                await api(
                    "POST",
                    endpoint + f"/cards/{card.id}/submit",
                    {"source_execution_id": str(execution.id)},
                    runner=True,
                )
                work = await claim()
                assert work and work["kind"] == "review"
                return work

            await api("PUT", endpoint + "/policy", {"policy": policy()})
            forge = SimpleNamespace(
                merged=False,
                state="open",
                mergeable=True,
                head_sha=HEAD,
                merge_commit_sha=None,
                head_branch="feature/qualified",
                base_branch="main",
                base_repo_url=REPO_URL,
                checks_passed=True,
            )
            with patch(
                "app.services.kanban.reconciler.board_scoped_pr_status",
                new=AsyncMock(side_effect=lambda *a, **k: forge),
            ):
                candidate = (
                    await api(
                        "POST",
                        endpoint + f"/cards/{card.id}/submit",
                        {"source_execution_id": str(execution.id)},
                        runner=True,
                    )
                )["candidate"]
                duplicate = (
                    await api(
                        "POST",
                        endpoint + f"/cards/{card.id}/submit",
                        {"source_execution_id": str(execution.id)},
                        runner=True,
                    )
                )["candidate"]
                assert candidate["id"] == duplicate["id"]
                concurrent = await asyncio.wait_for(
                    asyncio.gather(claim(), claim()), timeout=6
                )
                assert sum(work is not None for work in concurrent) == 1
                review = next(work for work in concurrent if work)
                assert (
                    review["execution_id"] != str(execution.id)
                    and review["role"] == REVIEW_ROLE
                )
                assert review["lease_token"] not in review["context"]
                async with sessions() as db:
                    assert (
                        await db.scalar(
                            select(func.count()).select_from(CompletionAttempt)
                        )
                        == 1
                    )
                    assert (
                        await db.scalar(
                            select(func.count())
                            .select_from(AgentExecution)
                            .where(AgentExecution.action == "completion_review")
                        )
                        == 1
                    )
                checks.append(
                    "two simultaneous fresh-connection claims yield one fresh 64-character-role execution and one secret lease"
                )

                async with sessions() as db, db.begin():
                    for model, row_id, unique_name in [
                        (
                            CompletionCandidate,
                            candidate["id"],
                            "uq_completion_current_card",
                        ),
                        (
                            CompletionAttempt,
                            review["attempt_id"],
                            "uq_completion_claimed_candidate",
                        ),
                    ]:
                        row = dict(
                            (
                                await db.execute(
                                    select(model.__table__).where(
                                        model.id == uuid.UUID(row_id)
                                    )
                                )
                            )
                            .mappings()
                            .one()
                        )
                        row["id"] = uuid.uuid4()
                        try:
                            async with db.begin_nested():
                                if model is CompletionAttempt:
                                    execution_row = dict(
                                        (
                                            await db.execute(
                                                select(AgentExecution.__table__).where(
                                                    AgentExecution.id
                                                    == uuid.UUID(review["execution_id"])
                                                )
                                            )
                                        )
                                        .mappings()
                                        .one()
                                    )
                                    execution_row["id"] = uuid.uuid4()
                                    await db.execute(
                                        AgentExecution.__table__.insert().values(
                                            **execution_row
                                        )
                                    )
                                    row["execution_id"] = execution_row["id"]
                                await db.execute(model.__table__.insert().values(**row))
                        except IntegrityError as exc:
                            assert unique_name in str(exc.orig), str(exc.orig)
                        else:
                            raise AssertionError(f"missing {unique_name}")
                        historical = await db.begin_nested()
                        if model is CompletionCandidate:
                            row["is_current"] = False
                        else:
                            row["status"] = "passed"
                            await db.execute(
                                AgentExecution.__table__.insert().values(
                                    **execution_row
                                )
                            )
                        await db.execute(model.__table__.insert().values(**row))
                        await historical.rollback()
                checks.append(
                    "actual PostgreSQL partial unique indexes reject second current candidate and concurrent claimed attempt, while permitting historical rows"
                )

                # A context-only edit must commit rejection and release the lease
                # immediately, while preserving the candidate and paid evidence.
                async with sessions() as db, db.begin():
                    db.add(
                        Note(
                            workspace_id=workspace.id,
                            title="Qualification context change",
                            content="Inspect the updated contract before accepting.",
                            pinned=True,
                            created_by=user.id,
                        )
                    )
                rejected = await rejected_ack(
                    review, "completion_context_changed", retryable=True
                )
                assert rejected["candidate"]["id"] == candidate["id"]
                assert rejected["candidate"]["status"] == "failed"
                old_review = review
                await api("POST", endpoint + f"/cards/{card.id}/retry", {}, runner=True)
                concurrent = await asyncio.wait_for(
                    asyncio.gather(claim(), claim()), timeout=6
                )
                assert sum(work is not None for work in concurrent) == 1
                review = next(work for work in concurrent if work)
                assert review["attempt_id"] != old_review["attempt_id"]
                assert review["candidate_id"] == old_review["candidate_id"]
                replay = await rejected_ack(
                    old_review, "completion_context_changed", retryable=True
                )
                assert replay["result_receipt"] == rejected["result_receipt"]
                async with sessions() as db:
                    successor = await db.get(
                        CompletionAttempt, uuid.UUID(review["attempt_id"])
                    )
                    assert successor.status == "claimed"
                assert await claim() is None
                checks.append(
                    "context rejection commits across requests, preserves candidate, allows immediate explicit retry with exactly one concurrent claimant; old receipt replay leaves successor lease intact"
                )
                await ack(review)
                assert await ready() is False
                bus = EventBus()
                reconciler = MergedPRReconciler(sessions)
                reconciler.start(bus)
                event_seen = []

                async def capture(event):
                    event_seen.append(event)

                bus.subscribe(capture, event_pattern="merge_queue.merged")

                async def fake_merge(entry):
                    assert entry.card_id == card.id
                    forge.merged, forge.state, forge.merge_commit_sha = (
                        True,
                        "closed",
                        MERGED,
                    )
                    return "merged", datetime.now()

                began = time.monotonic()
                processed = await asyncio.wait_for(
                    run_merge_queue_tick(
                        sessions, event_bus=bus, executor=fake_merge, max_per_tick=1
                    ),
                    timeout=6,
                )
                elapsed = time.monotonic() - began
                assert processed == 1 and len(event_seen) == 1
                assert (
                    elapsed < 1.5
                ), f"precommit subscriber blocked {elapsed:.2f}s (lock_timeout is 2s)"
                async with sessions() as db:
                    entry = await db.scalar(
                        select(MergeQueueEntry).where(
                            MergeQueueEntry.card_id == card.id
                        )
                    )
                    assert entry.state == "merged" and entry.attempt_count == 1
                    pending = await db.get(
                        CompletionCandidate, uuid.UUID(candidate["id"])
                    )
                    assert pending.status == "awaiting_merge", pending.status
                checks.append(
                    f"queue worker commits merged/attempt_count=1; synchronous precommit subscriber returns without workspace-lock deadlock ({elapsed:.3f}s)"
                )
                async with sessions() as db, db.begin():
                    await reconciler.scan_once(db)
                assert await ready() is False
                validation = await claim()
                assert (
                    validation["kind"] == "validation"
                    and validation["source_sha"] == MERGED
                )
                await ack(validation, "failed")
                assert await ready() is False
                await api("POST", endpoint + f"/cards/{card.id}/retry", {}, runner=True)
                retried = await claim()
                assert retried["attempt_id"] != validation["attempt_id"]
                await ack(retried)
                await ack(retried)
                assert await ready() is True
                async with sessions() as db:
                    assert (await db.get(Card, card.id)).column_id == active.id
                    accepted = await db.get(
                        CompletionCandidate, uuid.UUID(candidate["id"])
                    )
                    assert (
                        accepted.merge_sha == MERGED and accepted.status == "accepted"
                    )
                await reconciler._handle_event(event_seen[0])
                assert await ready() is True
                reconciler.stop()
                checks.append(
                    "missed/precommit event recovered by committed polling; exact merge validation fails/holds, retries/passes, duplicate ack idempotent; accepted dependency releases before manual Done"
                )

                # A real lock wait proves policy writes cannot cross an acceptance
                # transaction. Bound the wait and inspect PG rather than assuming timing.
                await serialized_edit(
                    "PUT", endpoint + "/policy", {"policy": policy(auto_complete=True)}
                )
                assert await ready() is False
                await api("PUT", endpoint + "/policy", {"policy": policy()})
                assert await ready() is False
                checks.append(
                    "policy edit waits on live completion transaction; invalidates accepted dependency; restoring prior policy does not resurrect receipt"
                )

                stale_review = await new_review()
                await serialized_edit(
                    "PATCH",
                    base + f"/cards/{card.id}",
                    {"title": "Changed source contract"},
                )
                rejected = await rejected_ack(
                    stale_review, "completion_candidate_stale"
                )
                await api("PATCH", base + f"/cards/{card.id}", {"title": "Source"})
                replay = await rejected_ack(stale_review, "completion_candidate_stale")
                assert replay["result_receipt"] == rejected["result_receipt"]
                assert await ready() is False
                checks.append(
                    "card metadata edit serializes; stale review acknowledgement rejected before and after restoring original metadata"
                )

                stale_review = await new_review()
                await serialized_edit(
                    "PUT",
                    base + f"/git-repos/{repo.id}",
                    {"default_branch": "changed-target"},
                )
                rejected = await rejected_ack(
                    stale_review, "completion_candidate_stale"
                )
                await api(
                    "PUT", base + f"/git-repos/{repo.id}", {"default_branch": "main"}
                )
                replay = await rejected_ack(stale_review, "completion_candidate_stale")
                assert replay["result_receipt"] == rejected["result_receipt"]
                assert await ready() is False
                checks.append(
                    "repository target edit serializes; stale review acknowledgement rejected before and after restoring original target"
                )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Private directory for qualification evidence",
    )
    args = parser.parse_args()
    output = args.output or Path(
        tempfile.mkdtemp(prefix="completion-postgres-evidence-")
    )
    output.mkdir(parents=True, exist_ok=True)
    source_sha = command(["git", "rev-parse", "HEAD"])
    container = "backplane-completion-qualification-" + secrets.token_hex(6)
    report = {
        "source_sha": source_sha,
        "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "working_tree_changes": command(["git", "status", "--short"]),
        "python": sys.version,
        "database_image": "pgvector/pgvector:pg16",
        "container": container,
        "fixture_boundaries": [
            "HTTP auth dependency fixture",
            "authoritative forge status fixture",
            "queue executor fixture: no actual git/forge merge",
            "local event bus with real subscribers; no cross-replica transport qualification",
        ],
        "checks": [],
        "result": "failed",
    }
    password = secrets.token_urlsafe(30)
    env = dict(
        os.environ,
        POSTGRES_USER="qualification",
        POSTGRES_PASSWORD=password,
        POSTGRES_DB="completion_qualification",
    )
    started = False
    try:
        command(
            [
                "docker",
                "run",
                "--detach",
                "--name",
                container,
                "--label",
                "backplane.qualification=completion-postgres",
                "--publish",
                "127.0.0.1::5432",
                "--env",
                "POSTGRES_USER",
                "--env",
                "POSTGRES_PASSWORD",
                "--env",
                "POSTGRES_DB",
                report["database_image"],
            ],
            env=env,
        )
        started = True
        for _ in range(50):
            ready = subprocess.run(
                [
                    "docker",
                    "exec",
                    container,
                    "pg_isready",
                    "-U",
                    "qualification",
                    "-d",
                    "completion_qualification",
                ],
                capture_output=True,
            )
            if ready.returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("own PostgreSQL fixture did not become ready")
        port = int(command(["docker", "port", container, "5432/tcp"]).rsplit(":", 1)[1])
        assert port not in (5432, 5433)
        url = f"postgresql+asyncpg://qualification:{password}@127.0.0.1:{port}/completion_qualification"
        os.environ.update(
            DATABASE_URL=url,
            EVENT_BUS_BACKEND="memory",
            APP_ENV="dev",
            VALARIS_EVENT_LOG="false",
        )
        sys.path.insert(0, str(BACKEND))
        report["database_port"] = port
        report["database_image_id"] = command(
            ["docker", "inspect", "--format", "{{.Image}}", container]
        )
        report["database_version"] = command(
            ["docker", "exec", container, "postgres", "--version"]
        )
        migration_log = []
        for revision in ("104", "105", "106", "107"):
            migration = subprocess.run(
                [sys.executable, "-m", "alembic", "upgrade", revision],
                cwd=BACKEND,
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=90,
            )
            migration_log.append(migration.stdout + migration.stderr)
            (output / "migrations.log").write_text("\n".join(migration_log))
            if migration.returncode:
                raise RuntimeError(
                    f"Alembic upgrade {revision} failed; see {output / 'migrations.log'}"
                )
            if revision == "104":
                asyncio.run(seed_legacy(url))
        asyncio.run(asyncio.wait_for(qualify(url, report), timeout=60))
        report["result"] = "passed"
    except Exception as exc:
        report["error"] = str(exc)
        raise
    finally:
        if started:
            subprocess.run(
                ["docker", "rm", "--force", "--volumes", container],
                capture_output=True,
                timeout=30,
                check=True,
            )
        report["own_container_removed"] = started
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "result": report["result"],
                    "source_sha": source_sha,
                    "checks": report["checks"],
                    "evidence": str(output),
                    "own_container_removed": report["own_container_removed"],
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    main()
