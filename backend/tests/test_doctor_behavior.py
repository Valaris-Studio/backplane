# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Behavior tests for scripts/doctor.sh's exit-code contract (BP-ONB-RERUN-001).

The onboarding audit proved `make doctor` could print a failure readout and
still exit 0: an unreachable Docker daemon or a fully-absent stack hit an
early `exit 0`, missing port listeners were only printed, HTTP probes accepted
any 1xx-4xx (and a connection failure produced the string "000000", matching
neither the "000" test nor `-ge 500`), and the migration check only required
`alembic current` to exit 0 — never the `(head)` marker.

These tests run the real script with stub `docker`/`curl`/`lsof` executables
prepended to PATH, so each fault mode is simulated deterministically without a
Docker daemon. The stubs are driven by STUB_* environment variables.
"""

import os
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCTOR = REPO_ROOT / "scripts" / "doctor.sh"

DOCKER_STUB = """#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "Docker version 0.0.0-stub"; exit 0; fi
if [[ "$1" == "inspect" ]]; then echo "${STUB_HEALTH:-healthy}"; exit 0; fi
if [[ "$1" == "compose" ]]; then
  shift
  if [[ "${STUB_DAEMON_DOWN:-0}" == "1" ]]; then
    echo "Cannot connect to the Docker daemon (stub)" >&2
    exit 1
  fi
  case "$1" in
    version) echo "Docker Compose version v0.0.0-stub"; exit 0 ;;
    ps)
      shift
      if [[ "$*" == *"--status running"* ]]; then
        for s in ${STUB_RUNNING:-}; do echo "$s"; done
      elif [[ "$*" == *"-a"* ]]; then
        for s in ${STUB_RUNNING:-}; do echo "$s running"; done
      elif [[ "$1" == "-q" ]]; then
        for s in ${STUB_RUNNING:-}; do [[ "$s" == "$2" ]] && echo "cid-$2"; done
      else
        echo "NAME STATUS"
        for s in ${STUB_RUNNING:-}; do echo "$s Up"; done
      fi
      exit 0 ;;
    exec)
      echo "${STUB_ALEMBIC_OUTPUT:-080_stub (head)}"
      exit "${STUB_ALEMBIC_EXIT:-0}" ;;
  esac
fi
exit 0
"""

# Real curl with `-w '%{http_code}'` prints "000" on a connection failure AND
# exits non-zero — the stub reproduces both so the historical "000000"
# double-append bug stays covered.
CURL_STUB = """#!/usr/bin/env bash
if [[ "${STUB_CURL_FAIL:-0}" == "1" ]]; then printf '000'; exit 7; fi
printf '%s' "${STUB_HTTP_CODE:-200}"
exit 0
"""

LSOF_STUB = """#!/usr/bin/env bash
if [[ "${STUB_PORTS_LISTENING:-1}" == "1" ]]; then
  echo "COMMAND PID USER"
  echo "stub 1 user TCP *:0 (LISTEN)"
  exit 0
fi
exit 1
"""


@pytest.fixture
def run_doctor(tmp_path):
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    for name, body in (("docker", DOCKER_STUB), ("curl", CURL_STUB), ("lsof", LSOF_STUB)):
        stub = stub_bin / name
        stub.write_text(body)
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    def _run(**stub_env: str) -> subprocess.CompletedProcess:
        env = {
            **os.environ,
            "PATH": f"{stub_bin}:{os.environ['PATH']}",
            **stub_env,
        }
        return subprocess.run(
            [str(DOCTOR)], capture_output=True, text=True, env=env, timeout=30
        )

    return _run


ALL_RUNNING = "postgres backend frontend"


def test_doctor_healthy_stack_exits_zero(run_doctor):
    result = run_doctor(STUB_RUNNING=ALL_RUNNING)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "DOCTOR: OK" in result.stdout


def test_doctor_docker_daemon_unreachable_exits_nonzero(run_doctor):
    result = run_doctor(STUB_DAEMON_DOWN="1")
    assert result.returncode != 0, (
        "doctor exited 0 with an unreachable Docker daemon:\n" + result.stdout
    )


def test_doctor_stack_absent_exits_nonzero(run_doctor):
    result = run_doctor(STUB_RUNNING="")
    assert "STACK NOT RUNNING" in result.stdout
    assert result.returncode != 0, (
        "doctor exited 0 with no essential service running:\n" + result.stdout
    )


def test_doctor_migrations_behind_head_exits_nonzero(run_doctor):
    result = run_doctor(
        STUB_RUNNING=ALL_RUNNING, STUB_ALEMBIC_OUTPUT="079_older_revision"
    )
    assert result.returncode != 0, (
        "doctor exited 0 with migrations behind head:\n" + result.stdout
    )


def test_doctor_http_probe_non_2xx_exits_nonzero(run_doctor):
    result = run_doctor(STUB_RUNNING=ALL_RUNNING, STUB_HTTP_CODE="404")
    assert result.returncode != 0, (
        "doctor exited 0 with endpoints returning 404:\n" + result.stdout
    )


def test_doctor_http_probe_connection_failure_exits_nonzero(run_doctor):
    result = run_doctor(STUB_RUNNING=ALL_RUNNING, STUB_CURL_FAIL="1")
    assert "000000" not in result.stdout, (
        "curl failure produced the double-appended '000000' code:\n" + result.stdout
    )
    assert result.returncode != 0, (
        "doctor exited 0 with unreachable endpoints:\n" + result.stdout
    )


def test_doctor_missing_port_listener_exits_nonzero(run_doctor):
    result = run_doctor(STUB_RUNNING=ALL_RUNNING, STUB_PORTS_LISTENING="0")
    assert result.returncode != 0, (
        "doctor exited 0 with no listener on the dev ports:\n" + result.stdout
    )
