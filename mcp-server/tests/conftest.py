# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock

import pytest

from valaris_mcp.server import AppContext

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
    tracker_mock = AsyncMock()
    # Unrestricted by default: no toolset layer, no allowlist.
    if HandState is None:
        app = AppContext(client=client_mock, tracker=tracker_mock)
    else:
        app = AppContext(
            client=client_mock,
            tracker=tracker_mock,
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
