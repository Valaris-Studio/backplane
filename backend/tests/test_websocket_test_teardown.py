# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Negative WebSocket assertions must not strand receiver threads at shutdown."""

import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.slow
@pytest.mark.timeout(45)
def test_websocket_negative_assertions_exit_cleanly():
    # An in-process pytest assertion cannot catch non-daemon threads that only
    # block interpreter shutdown after pytest has printed its green summary.
    program = """
import faulthandler
import os
import sys
import threading

import pytest

print(f"WebSocket teardown probe pid={os.getpid()}", flush=True)
result = pytest.main([
    "tests/routers/test_events_ws.py::test_ws_subscribe_filters_non_matching",
    "tests/routers/test_events_ws.py::test_ws_unsubscribe_stops_events",
    "tests/routers/test_notifications_ws.py::test_ws_notification_not_delivered_to_non_recipient_socket",
    "-q", "--tb=short", "-p", "no:cacheprovider",
])
remaining = [
    thread for thread in threading.enumerate()
    if not thread.daemon and thread is not threading.current_thread()
]
if remaining:
    print("Non-daemon threads after pytest:", [thread.name for thread in remaining], flush=True)
    faulthandler.dump_traceback(file=sys.stdout, all_threads=True)
sys.exit(result)
"""
    try:
        completed = subprocess.run(
            [sys.executable, "-c", program],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout or b""
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        pytest.fail(f"WebSocket tests did not exit after their summary:\n{output}")
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "Non-daemon threads after pytest:" not in completed.stdout, completed.stdout
