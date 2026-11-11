# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01H operational output through the actual command and real SQLite service.

The standalone stored() diagnostic works before the CLI exists. Other cases
invoke its real __main__ in a fresh process; only storage failure/counting is
injected. Missing CLI is a structural failure, not logging/privacy evidence.
"""

import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import uuid

import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app import database
from app.exceptions import StorageBackendUnavailableError
from app.models.agent_session import AgentSessionContent
from app.models.base import Base
from app.services.storage import session_content as storage
from tests.rich_capture import declaration, upload
from tests.test_session_search import (
    capture as capture_fixture,
    paused_object_indexing as paused_object_indexing_fixture,
    store_contents,
)

capture = capture_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = pytest.mark.slow
BACKEND = Path(__file__).resolve().parents[2]
CLI = BACKEND / "scripts/backfill_session_search.py"
EXCEPTION_MARKER = "B01H_SYNTHETIC_PRIVATE_STORAGE_EXCEPTION"
BODY_MARKER = "B01H_SYNTHETIC_PRIVATE_RETAINED_BODY"
MIN_BYTES = 33_554_433
MAX_BYTES = 67_108_864

# runpy executes the same __main__ block as python -m. The bootstrap changes
# only the local store's I/O boundary and writes counters outside CLI streams.
CHILD = r"""
import json
import os
from pathlib import Path
import runpy
import sys
from app.services.storage.session_content import LocalContentStore

reads = []
original_read = LocalContentStore.read

def counted_read(store, key, offset=0, length=None):
    row = {"requested_bytes": length, "returned_bytes": 0}
    reads.append(row)
    if os.environ.get("B01H_REVIEW_FAILURE"):
        raise OSError(os.environ["B01H_REVIEW_FAILURE"])
    body = original_read(store, key, offset, length)
    row["returned_bytes"] = len(body)
    return body

LocalContentStore.read = counted_read
sys.argv[0] = "scripts.backfill_session_search"
try:
    runpy.run_module("scripts.backfill_session_search", run_name="__main__")
finally:
    Path(os.environ["B01H_REVIEW_IO_RECEIPT"]).write_text(json.dumps(reads))
"""


@pytest.fixture
async def db_engine(tmp_path, monkeypatch):
    # A file database lets each real CLI process observe committed state;
    # neither a default PostgreSQL URL nor a shared in-memory connection is used.
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'cli.sqlite3'}", poolclass=NullPool
    )

    @event.listens_for(engine.sync_engine, "connect")
    def foreign_keys(connection, _record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(
        database, "async_session", async_sessionmaker(engine, expire_on_commit=False)
    )
    try:
        yield engine
    finally:
        await engine.dispose()


class CommandProbe:
    def __init__(self, engine, directory, store_directory):
        self.engine = engine
        self.directory = directory
        self.store_directory = store_directory
        self.calls = []
        self.private_values = [EXCEPTION_MARKER, BODY_MARKER, str(directory)]

    def invoke(self, *arguments, enabled=True, store_directory=None, failure=None):
        assert CLI.is_file(), (
            "Structural prerequisite absent: scripts.backfill_session_search; "
            "the separate stored() diagnostic does not depend on this module"
        )
        io_path = self.directory / f"cli-io-{len(self.calls)}.json"
        environment = os.environ.copy()
        # Explicit settings win over .env and inherited operational credentials.
        for name in ("DATABASE_PASSWORD", "GCS_SA_EMAIL", "STORAGE_EMULATOR_HOST"):
            environment.pop(name, None)
        environment.update(
            DATABASE_URL=str(self.engine.url),
            GCS_BUCKET="",
            LOCAL_STORAGE_DIR=str(store_directory or self.store_directory),
            COMPANION_ENABLED=str(enabled).lower(),
            ENV="development",
            PYTHONPATH=str(BACKEND),
            PYTHONDONTWRITEBYTECODE="1",
            B01H_REVIEW_IO_RECEIPT=str(io_path),
        )
        environment.pop("B01H_REVIEW_FAILURE", None)
        if failure is not None:
            environment["B01H_REVIEW_FAILURE"] = failure
        result = subprocess.run(
            [sys.executable, "-c", CHILD, *arguments],
            cwd=BACKEND,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        observed = {
            "arguments": arguments,
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "reads": json.loads(io_path.read_text()) if io_path.exists() else None,
        }
        self.calls.append(observed)
        # Preserve the first actual subprocess result before an output assertion.
        (self.directory / "cli-observations.json").write_text(
            json.dumps(self.calls, indent=2) + "\n"
        )
        combined = result.stdout + result.stderr
        for private in self.private_values:
            assert private not in combined, "CLI emitted synthetic private source data"
        assert "Traceback (most recent call last)" not in result.stderr
        try:
            receipt = json.loads(result.stdout)
        except ValueError as error:
            pytest.fail(f"CLI must emit exactly one JSON receipt: {error}; exit={result.returncode}")
        assert isinstance(receipt, dict)
        assert receipt["schema"] == "session-search-backfill/1"
        assert receipt["command"] == arguments[0]
        assert receipt["exit_code"] == result.returncode
        assert {"result", "reason", "observed_at", "readiness"} <= receipt.keys()
        return receipt, observed

    def start(self):
        receipt, _ = self.invoke("start", "--scope", "all-workspaces")
        assert receipt["exit_code"] == 0
        assert receipt["result"] in {"created", "existing"}
        uuid.UUID(receipt["run"]["id"])
        return receipt

    async def persisted_state(self):
        names = ("session_search_backfill_runs", "session_search_backfill_claims")
        async with self.engine.connect() as connection:
            state = {}
            for name in names:
                table = Base.metadata.tables[name]
                rows = await connection.execute(select(table).order_by(*table.primary_key.columns))
                state[name] = [dict(row) for row in rows.mappings()]
            return state


@pytest.fixture
async def cli(db_engine, content_storage, tmp_path):
    yield CommandProbe(db_engine, tmp_path, content_storage)


async def test_stored_baseline_diagnostic_preserves_safe_error_without_cli(caplog, tmp_path):
    def failing_read():
        raise OSError(f"{EXCEPTION_MARKER} {BODY_MARKER} /synthetic-private/object")

    with caplog.at_level(logging.WARNING, logger=storage.__name__):
        with pytest.raises(StorageBackendUnavailableError) as raised:
            await storage.stored(failing_read)
    messages = [record.getMessage() for record in caplog.records]
    observed = {
        "storage_sha256": hashlib.sha256(Path(storage.__file__).read_bytes()).hexdigest(),
        "raw_exception_logged": any(EXCEPTION_MARKER in message for message in messages),
        "safe_error_detail": raised.value.detail,
        "error_type": type(raised.value).__name__,
        "cli_invoked": False,
    }
    (tmp_path / "stored-baseline-diagnostic.json").write_text(json.dumps(observed, indent=2) + "\n")
    assert raised.value.detail == "Content storage is unavailable; retry later"
    assert EXCEPTION_MARKER not in str(raised.value)
    # The diagnostic records the current unsafe lower-layer log; it does not
    # enshrine it or require an unrelated global logger behavior change.


@pytest.mark.usefixtures("paused_object_indexing")
async def test_cli_storage_failure_has_one_safe_receipt_and_no_private_diagnostic(
    cli, client, device_client, db_session, capture,
):
    body = (BODY_MARKER + " synthetic retained text " * 1024).encode()
    [ack] = await store_contents(device_client, capture, [declaration(body, delivery="upload")])
    assert ack["outcome"] == "upload_required"
    await db_session.commit()
    assert (await upload(device_client, capture, ack, body))["state"] == "available"
    source = await db_session.get(AgentSessionContent, uuid.UUID(ack["content_id"]))
    assert source.storage_backend == "local" and source.storage_key
    cli.private_values.extend((str(source.id), str(source.session_id), source.storage_key))
    failure = f"{EXCEPTION_MARKER} {BODY_MARKER} {source.id} {cli.store_directory / source.storage_key}"
    await db_session.commit()
    started = cli.start()
    identity = started["run"]["id"]
    # A new run may finish its bounded unavailable sweep before discovery.
    for _ in range(8):
        receipt, observed = cli.invoke("pass", "--run-id", identity, failure=failure)
        if observed["reads"]:
            assert len(observed["reads"]) == 1
            assert observed["reads"][0] == {"requested_bytes": len(body) + 1, "returned_bytes": 0}
            assert receipt["exit_code"] == 12
            assert receipt["coverage"] is None
            assert receipt["readiness"] is None
            assert receipt["progress"]["outcomes"]["retry_wait"] >= 1
            assert receipt["pass"]["requested_bytes"] == len(body) + 1
            assert receipt["pass"]["read_calls"] == 1
            break
        assert receipt["exit_code"] == 10
    else:
        pytest.fail("Eight bounded CLI passes never attempted the retained eligible object")


async def test_cli_start_is_idempotent_and_status_and_finished_pass_do_not_rewrite_run(cli):
    first = cli.start()
    second = cli.start()
    assert first["result"] == "created" and first["run"]["created"] is True
    assert second["result"] == "existing" and second["run"]["created"] is False
    assert first["run"]["id"] == second["run"]["id"]
    identity = first["run"]["id"]
    before = await cli.persisted_state()
    status, observed = cli.invoke("status", "--run-id", identity)
    assert status["readiness"] == "in_progress" and status["exit_code"] == 10
    assert observed["reads"] == []
    assert await cli.persisted_state() == before
    for _ in range(8):
        receipt, observed = cli.invoke("pass", "--run-id", identity)
        assert observed["reads"] == []
        if receipt["readiness"] == "ready_at_observation":
            assert receipt["exit_code"] == 0
            break
        assert receipt["exit_code"] == 10
    else:
        pytest.fail("Empty finite corpus did not finish after eight bounded passes")
    before = await cli.persisted_state()
    final, observed = cli.invoke("pass", "--run-id", identity)
    assert final["exit_code"] == 0 and final["readiness"] == "ready_at_observation"
    assert final["coverage"]["index_ready"] is True
    assert observed["reads"] == []
    assert await cli.persisted_state() == before


async def test_cli_feature_off_refuses_start_pass_but_status_remains_read_only(cli):
    identity = cli.start()["run"]["id"]
    before = await cli.persisted_state()
    for arguments in (("start", "--scope", "all-workspaces"), ("pass", "--run-id", identity)):
        receipt, observed = cli.invoke(*arguments, enabled=False)
        assert receipt["exit_code"] == 3 and receipt["readiness"] is None
        assert observed["reads"] == []
        assert await cli.persisted_state() == before
    status, observed = cli.invoke("status", "--run-id", identity, enabled=False)
    assert status["run"]["id"] == identity
    assert status["exit_code"] == 10
    assert observed["reads"] == []
    assert await cli.persisted_state() == before


async def test_cli_rejects_invalid_operational_limits_without_input_echo_or_writes(cli):
    identity = cli.start()["run"]["id"]
    before = await cli.persisted_state()
    invalid = (("--source-limit", "0"), ("--source-limit", "26"),
               ("--byte-budget", str(MIN_BYTES - 1)), ("--byte-budget", str(MAX_BYTES + 1)),
               ("--source-limit", EXCEPTION_MARKER))
    for option, value in invalid:
        receipt, observed = cli.invoke("pass", "--run-id", identity, option, value)
        assert receipt["exit_code"] == 2 and receipt["readiness"] is None
        assert observed["reads"] == []
        assert await cli.persisted_state() == before
    valid, observed = cli.invoke(
        "pass", "--run-id", identity, "--source-limit", "1", "--byte-budget", str(MIN_BYTES)
    )
    assert valid["exit_code"] in {0, 10}
    assert valid["pass"]["source_limit"] == 1
    assert valid["pass"]["byte_budget"] == MIN_BYTES
    assert observed["reads"] == []


async def test_cli_unknown_run_is_usage_failure_without_creating_a_run(cli):
    # Establish the real schema/service before exercising unknown identities.
    cli.start()
    before = await cli.persisted_state()
    unknown = str(uuid.uuid4())
    for command in ("pass", "status"):
        receipt, observed = cli.invoke(command, "--run-id", unknown)
        assert receipt["exit_code"] == 2 and receipt["readiness"] is None
        assert observed["reads"] == []
        assert await cli.persisted_state() == before


async def test_cli_effective_store_drift_refuses_pass_and_status_has_no_readiness(cli):
    identity = cli.start()["run"]["id"]
    before = await cli.persisted_state()
    other_store = cli.directory / "synthetic-private-other-store"
    for command in ("pass", "status"):
        receipt, observed = cli.invoke(command, "--run-id", identity, store_directory=other_store)
        assert receipt["exit_code"] == 3
        assert receipt["reason"] == "configuration_mismatch"
        assert receipt["readiness"] is None
        assert observed["reads"] == []
        assert await cli.persisted_state() == before
    restored, observed = cli.invoke("status", "--run-id", identity)
    assert restored["run"]["id"] == identity
    assert restored["readiness"] == "in_progress" and restored["exit_code"] == 10
    assert observed["reads"] == []
    assert await cli.persisted_state() == before
