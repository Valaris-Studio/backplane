# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from dataclasses import dataclass
import contextlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from valaris_mcp.server import AppContext
from valaris_mcp.tracking import InvocationRecorder

try:
    from valaris_mcp.hand import HandState
except ImportError:  # RED phase of tests/test_enable_toolsets.py: hand.py not written yet
    HandState = None


@dataclass
class MockContext:
    request_context: MagicMock

    @property
    def session(self):
        # Mirrors the real `Context.session`, so tools reaching the server
        # session (e.g. to send notifications) work against this stand-in.
        return self.request_context.session


def make_ctx(client_mock: AsyncMock, hand: HandState | None = None) -> MockContext:
    recorder_mock = MagicMock(spec=InvocationRecorder)
    recorder_mock.health.return_value = {
        "recorded": 0,
        "unconfirmed": 0,
        "queued": 0,
        "last_error": None,
        "circuit_open": False,
        "durable_retry": False,
    }
    recorder_mock.begin.return_value = SimpleNamespace(id="test-invocation")
    recorder_mock.running.side_effect = lambda *args, **kwargs: contextlib.nullcontext()
    # Unrestricted by default: no toolset layer, no allowlist.
    if HandState is None:
        app = AppContext(client=client_mock, recorder=recorder_mock)
    else:
        app = AppContext(
            client=client_mock,
            recorder=recorder_mock,
            hand=hand if hand is not None else HandState(None, None, None),
        )
    ctx = MockContext(request_context=MagicMock())
    ctx.request_context.lifespan_context = app
    ctx.request_context.session = AsyncMock()
    return ctx


@pytest.fixture
def mock_client():
    client = AsyncMock()
    client.ws = lambda slug: f"/workspaces/{slug}"
    client.board = lambda slug, bid: f"/workspaces/{slug}/boards/{bid}"
    return client


@pytest.fixture
def ctx(mock_client):
    return make_ctx(mock_client)
