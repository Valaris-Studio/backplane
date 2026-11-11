# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Private-safe receipts at the real CLI's bootstrap and cleanup boundaries.

Each process executes runpy's actual __main__. Only engine construction and
disposal are fault-injected; parsing, orchestration, service/schema reads and
receipt emission remain production code. No server or operational DB is used.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

pytestmark = pytest.mark.slow
BACKEND = Path(__file__).resolve().parents[2]
CLI = BACKEND / "scripts/backfill_session_search.py"
RUN_ID = "8f890fc0-480b-4a21-a1ee-f3b98f6a8b7f"
EXCEPTION_MARKER = "B01H_SYNTHETIC_PRIVATE_BOUNDARY_EXCEPTION"
BODY_MARKER = "B01H_SYNTHETIC_PRIVATE_BOUNDARY_BODY"
URL_MARKER = "B01H_SYNTHETIC_PRIVATE_DATABASE_PORT"

CHILD = r"""
import json
import os
from pathlib import Path
import runpy
import sys

mode = os.environ["B01H_BOUNDARY_MODE"]
observed = {
    "mode": mode, "bootstrap_ready": False, "runpy_entered": False,
    "build_calls": 0, "dispose_calls": 0, "disposed_before_failure": False,
    "sql_statements": 0, "fault_reached": False,
}
try:
    if mode != "malformed_url":
        from sqlalchemy import event
        from sqlalchemy.ext.asyncio import AsyncEngine
        from app import database

        original_build = database.build_engine
        original_dispose = AsyncEngine.dispose

        def build(url):
            observed["build_calls"] += 1
            if mode == "build_failure":
                observed["fault_reached"] = True
                raise RuntimeError(os.environ["B01H_BOUNDARY_PRIVATE_FAILURE"])
            engine = original_build(url)

            @event.listens_for(engine.sync_engine, "after_cursor_execute")
            def after_execute(*_args):
                observed["sql_statements"] += 1

            return engine

        async def dispose(engine, *args, **kwargs):
            observed["dispose_calls"] += 1
            await original_dispose(engine, *args, **kwargs)
            if mode == "dispose_failure":
                observed["disposed_before_failure"] = True
                observed["fault_reached"] = True
                raise RuntimeError(os.environ["B01H_BOUNDARY_PRIVATE_FAILURE"])

        database.build_engine = build
        AsyncEngine.dispose = dispose
    # The malformed-URL case deliberately imports no app code here: failure
    # must occur inside the real CLI bootstrap, not inside this fixture.
    observed["bootstrap_ready"] = True
    sys.argv[0] = "scripts.backfill_session_search"
    observed["runpy_entered"] = True
    runpy.run_module("scripts.backfill_session_search", run_name="__main__")
finally:
    Path(os.environ["B01H_BOUNDARY_PROBE"]).write_text(
        json.dumps(observed, sort_keys=True) + "\n"
    )
"""


def invoke(tmp_path, mode, *arguments):
    assert CLI.is_file(), "Structural prerequisite missing: actual backfill CLI"
    probe_path = tmp_path / "boundary-probe.json"
    private_store = tmp_path / "synthetic-private-store"
    database_path = tmp_path / "synthetic-private-cli.sqlite3"
    database_url = f"sqlite+aiosqlite:///{database_path}"
    if mode == "malformed_url":
        # make_url parses the invalid port before any driver connection. The
        # synthetic address cannot result in a real network/database request.
        database_url = (
            "postgresql+asyncpg://synthetic:synthetic-password@invalid.example:"
            f"{URL_MARKER}/synthetic"
        )
    # Fresh cwd prevents loading the checkout's .env. Inherit only runtime
    # location/locale variables, never operational app/cloud credentials.
    environment = {
        key: os.environ[key]
        for key in ("PATH", "SYSTEMROOT", "WINDIR", "TMPDIR", "LANG", "LC_ALL")
        if key in os.environ
    }
    environment.update(
        DATABASE_URL=database_url,
        GCS_BUCKET="",
        LOCAL_STORAGE_DIR=str(private_store),
        COMPANION_ENABLED="true",
        ENV="development",
        PYTHONPATH=str(BACKEND),
        PYTHONDONTWRITEBYTECODE="1",
        B01H_BOUNDARY_MODE=mode,
        B01H_BOUNDARY_PROBE=str(probe_path),
        B01H_BOUNDARY_PRIVATE_FAILURE=(
            f"{EXCEPTION_MARKER} {BODY_MARKER} {private_store}/retained-object"
        ),
    )
    result = subprocess.run(
        [sys.executable, "-c", CHILD, *arguments],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    probe = json.loads(probe_path.read_text()) if probe_path.exists() else None
    observation = {
        "mode": mode,
        "arguments": list(arguments),
        "cli_sha256": hashlib.sha256(CLI.read_bytes()).hexdigest(),
        "child_sha256": hashlib.sha256(CHILD.encode()).hexdigest(),
        "exit_code": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "probe": probe,
        "private_database_created": database_path.exists(),
    }
    # Preserve the first outcome before any assertion. All private values here
    # are synthetic; the report never contains an inherited environment dump.
    (tmp_path / "cli-boundary-observation.json").write_text(
        json.dumps(observation, indent=2) + "\n"
    )
    assert probe is not None, "Fixture setup failed before the sidecar was written"
    assert (
        probe["bootstrap_ready"] and probe["runpy_entered"]
    ), "Fixture setup failed before entering the actual CLI; not a product red"
    return result, probe, (EXCEPTION_MARKER, BODY_MARKER, URL_MARKER, str(tmp_path))


def private_safe_streams(result, forbidden):
    combined = result.stdout + result.stderr
    return [
        "private synthetic value escaped" for value in forbidden if value in combined
    ] + (
        ["raw traceback escaped"]
        if "Traceback (most recent call last)" in combined
        else []
    )


def one_receipt(result, forbidden, *, expected_result, expected_reason, expected_exit):
    failures = private_safe_streams(result, forbidden)
    if result.returncode != expected_exit:
        failures.append(f"exit {result.returncode} instead of {expected_exit}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        failures.append(f"expected one JSON line, received {len(lines)}")
    document = None
    try:
        document = json.loads(result.stdout)
    except (ValueError, TypeError):
        failures.append("stdout is not exactly one JSON document")
    if not isinstance(document, dict):
        failures.append("receipt is not a JSON object")
    else:
        for key, expected in {
            "schema": "session-search-backfill/1",
            "command": "status",
            "result": expected_result,
            "reason": expected_reason,
            "exit_code": expected_exit,
            "readiness": None,
        }.items():
            if key not in document or document[key] != expected:
                failures.append(f"receipt {key} differs from the boundary contract")
        if not document.get("observed_at"):
            failures.append("receipt lacks observation time")
    # Collect safe diagnostics so zero JSON and leaked traceback/marker remain
    # visible together, without putting raw streams into assertion output.
    assert not failures, "; ".join(failures)
    return document


def test_cli_real_missing_schema_still_returns_one_safe_refusal(tmp_path):
    result, probe, forbidden = invoke(tmp_path, "observe", "status", "--run-id", RUN_ID)
    assert probe["build_calls"] == 1
    assert probe["dispose_calls"] == 1
    assert probe["sql_statements"] > 0
    assert probe["fault_reached"] is False
    assert (tmp_path / "synthetic-private-cli.sqlite3").is_file()
    one_receipt(
        result,
        forbidden,
        expected_result="refused",
        expected_reason="schema_missing",
        expected_exit=3,
    )


def test_cli_build_engine_failure_returns_one_safe_failed_receipt(tmp_path):
    result, probe, forbidden = invoke(
        tmp_path, "build_failure", "status", "--run-id", RUN_ID
    )
    assert probe["fault_reached"] is True
    assert probe["build_calls"] == 1
    assert probe["dispose_calls"] == 0
    assert probe["sql_statements"] == 0
    assert not (tmp_path / "synthetic-private-cli.sqlite3").exists()
    one_receipt(
        result,
        forbidden,
        expected_result="failed",
        expected_reason="unexpected_failure",
        expected_exit=1,
    )


def test_cli_dispose_failure_replaces_unemitted_refusal_with_one_safe_failure(tmp_path):
    result, probe, forbidden = invoke(
        tmp_path, "dispose_failure", "status", "--run-id", RUN_ID
    )
    assert probe["build_calls"] == 1
    assert probe["dispose_calls"] == 1
    assert probe["sql_statements"] > 0
    assert probe["disposed_before_failure"] is True
    assert probe["fault_reached"] is True
    one_receipt(
        result,
        forbidden,
        expected_result="failed",
        expected_reason="unexpected_failure",
        expected_exit=1,
    )


def test_cli_import_time_malformed_database_url_returns_one_safe_failure(tmp_path):
    result, probe, forbidden = invoke(
        tmp_path, "malformed_url", "status", "--run-id", RUN_ID
    )
    assert (
        probe["build_calls"] == probe["dispose_calls"] == probe["sql_statements"] == 0
    )
    assert probe["fault_reached"] is False
    assert not (tmp_path / "synthetic-private-cli.sqlite3").exists()
    one_receipt(
        result,
        forbidden,
        expected_result="failed",
        expected_reason="unexpected_failure",
        expected_exit=1,
    )


def test_cli_explicit_help_is_human_usage_without_an_operational_receipt(tmp_path):
    result, probe, forbidden = invoke(tmp_path, "observe", "--help")
    assert result.returncode == 0
    assert not private_safe_streams(result, forbidden)
    assert "usage:" in result.stdout.lower()
    assert "--help" in result.stdout
    with pytest.raises(ValueError):
        json.loads(result.stdout)
    assert (
        probe["build_calls"] == probe["dispose_calls"] == probe["sql_statements"] == 0
    )
    assert not (tmp_path / "synthetic-private-cli.sqlite3").exists()
