# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`install_tracking` installs once per tool manager and tracks per session.

Under streamable-http the lowlevel Server enters `app_lifespan` once PER
SESSION against the one shared `_tool_manager`. Wrapping on every entry stacks
a tracker closure per session that is never removed, so every call is recorded
by every session's tracker that ever existed. The wrapper must install once
(same sentinel technique as `install_hand`) and resolve the CURRENT request's
tracker from the lowlevel request context, falling back to the install-time
tracker when no request is active (stdio startup, direct calls).
"""
from __future__ import annotations

import contextlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from mcp.shared.context import RequestContext

from valaris_mcp.allowlist import ALLOWLIST_ENV, install_hand
from valaris_mcp.hand import HandState
from valaris_mcp.server import app_lifespan, install_tracking, mcp
from valaris_mcp.toolsets import TOOLSETS_ENV

pytestmark = pytest.mark.anyio

TRACKING_SENTINEL = "_valaris_tracking_installed"
HAND_SENTINEL = "_valaris_hand_installed"
MANAGER_PATCHED_NAMES = ("call_tool", "list_tools", TRACKING_SENTINEL, HAND_SENTINEL)


class _FakeToolManager:
    def __init__(self, call_tool):
        self.call_tool = call_tool


class _FakeServer:
    def __init__(self, call_tool):
        self._tool_manager = _FakeToolManager(call_tool)


def _deny_all_hand() -> HandState:
    return HandState(["cards"], frozenset({"get_card"}), frozenset({"__none__"}))


@contextlib.contextmanager
def _request_carrying(**lifespan_fields):
    from mcp.server.lowlevel.server import request_ctx

    token = request_ctx.set(
        RequestContext(
            request_id=1,
            meta=None,
            session=AsyncMock(),
            lifespan_context=SimpleNamespace(**lifespan_fields),
        )
    )
    try:
        yield
    finally:
        request_ctx.reset(token)


# ---------- install once ----------


async def test_install_tracking_installs_its_wrapper_at_most_once_per_manager():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_tracking(server, AsyncMock())
    call_after_first = server._tool_manager.call_tool
    assert call_after_first is not original

    install_tracking(server, AsyncMock())
    assert server._tool_manager.call_tool is call_after_first


async def test_install_tracking_marks_the_manager_with_its_sentinel():
    server = _FakeServer(AsyncMock(return_value="ok"))
    install_tracking(server, AsyncMock())
    assert getattr(server._tool_manager, TRACKING_SENTINEL, False) is True


async def test_second_install_leaves_the_inner_original_awaited_once_per_call():
    """A restacked wrapper would still reach the original once, so the
    observable symptom of stacking is the tracker side: the SECOND session's
    tracker must not be layered on top of the first."""
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    tracker_a, tracker_b = AsyncMock(), AsyncMock()
    install_tracking(server, tracker_a)
    install_tracking(server, tracker_b)

    assert await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"}) == "ok"
    original.assert_awaited_once_with("get_board", {"workspace_slug": "x"})
    assert tracker_a.before_tool_call.await_count + tracker_b.before_tool_call.await_count == 1
    assert tracker_a.after_tool_call.await_count + tracker_b.after_tool_call.await_count == 1


# ---------- per-request tracker resolution ----------


async def test_install_tracking_resolves_the_current_requests_tracker():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    installed_tracker, session_tracker = AsyncMock(), AsyncMock()
    install_tracking(server, installed_tracker)

    with _request_carrying(tracker=session_tracker):
        assert await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"}) == "ok"

    session_tracker.before_tool_call.assert_awaited_once_with("get_board", {"workspace_slug": "x"})
    session_tracker.after_tool_call.assert_awaited_once_with("get_board", "ok")
    installed_tracker.before_tool_call.assert_not_awaited()
    installed_tracker.after_tool_call.assert_not_awaited()


async def test_install_tracking_falls_back_to_the_install_time_tracker_without_a_request():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    installed_tracker = AsyncMock()
    install_tracking(server, installed_tracker)

    assert await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"}) == "ok"

    installed_tracker.before_tool_call.assert_awaited_once_with("get_board", {"workspace_slug": "x"})
    installed_tracker.after_tool_call.assert_awaited_once_with("get_board", "ok")


async def test_install_tracking_falls_back_when_the_lifespan_context_has_no_tracker():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    installed_tracker = AsyncMock()
    install_tracking(server, installed_tracker)

    with _request_carrying(hand=HandState(None, None, None)):
        assert await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"}) == "ok"

    installed_tracker.before_tool_call.assert_awaited_once()
    installed_tracker.after_tool_call.assert_awaited_once()


async def test_install_tracking_records_a_raised_call_on_the_current_requests_tracker():
    original = AsyncMock(side_effect=RuntimeError("boom"))
    server = _FakeServer(original)
    installed_tracker, session_tracker = AsyncMock(), AsyncMock()
    install_tracking(server, installed_tracker)

    with _request_carrying(tracker=session_tracker):
        with pytest.raises(RuntimeError) as excinfo:
            await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"})

    session_tracker.after_tool_call.assert_awaited_once()
    assert session_tracker.after_tool_call.await_args.args[0] == "get_board"
    assert session_tracker.after_tool_call.await_args.kwargs["error"] is excinfo.value
    installed_tracker.after_tool_call.assert_not_awaited()


async def test_raised_call_hands_the_tracker_the_exception_and_its_text():
    the_exc = RuntimeError("boom")
    server = _FakeServer(AsyncMock(side_effect=the_exc))
    tracker = AsyncMock()
    install_tracking(server, tracker)

    with pytest.raises(RuntimeError):
        await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"})

    tracker.after_tool_call.assert_awaited_once_with("get_board", "boom", error=the_exc)


# ---------- two sessions on the singleton ----------


@pytest.fixture
def restore_singleton_manager():
    # `install_hand`/`install_tracking` patch the shared singleton's manager in
    # place and stamp their sentinels on it; leave the rest of the suite the
    # unpatched class methods and a manager that installs afresh.
    manager = mcp._tool_manager
    patched_before = {
        name: vars(manager)[name] for name in MANAGER_PATCHED_NAMES if name in vars(manager)
    }
    for name in MANAGER_PATCHED_NAMES:
        vars(manager).pop(name, None)
    yield manager
    for name in MANAGER_PATCHED_NAMES:
        vars(manager).pop(name, None)
    vars(manager).update(patched_before)


@pytest.fixture
def two_trackers(monkeypatch):
    import valaris_mcp.server as server_module

    trackers = [AsyncMock(name="tracker_1"), AsyncMock(name="tracker_2")]
    handed_out = iter(trackers)
    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    monkeypatch.setattr(server_module, "ValarisClient", lambda: AsyncMock())
    monkeypatch.setattr(server_module, "ExecutionTracker", lambda client: next(handed_out))
    return trackers


async def test_two_sequential_lifespans_on_the_singleton_leave_one_tracker_layer(
    restore_singleton_manager, two_trackers
):
    manager = restore_singleton_manager
    original = AsyncMock(return_value="ok")
    manager.call_tool = original
    tracker_1, tracker_2 = two_trackers

    async with app_lifespan(mcp) as first:
        call_after_first = manager.call_tool
        assert first.tracker is tracker_1
    async with app_lifespan(mcp) as second:
        assert second.tracker is tracker_2
        assert manager.call_tool is call_after_first

        # get_server_info rides on every hand, so only the tracker layer is under test.
        with _request_carrying(tracker=second.tracker, hand=second.hand):
            assert await manager.call_tool("get_server_info", {}) == "ok"

    original.assert_awaited_once_with("get_server_info", {})
    tracker_2.before_tool_call.assert_awaited_once_with("get_server_info", {})
    tracker_2.after_tool_call.assert_awaited_once_with("get_server_info", "ok")
    tracker_1.before_tool_call.assert_not_awaited()
    tracker_1.after_tool_call.assert_not_awaited()


async def test_first_sessions_tracker_still_records_its_own_requests_after_a_second_lifespan(
    restore_singleton_manager, two_trackers
):
    manager = restore_singleton_manager
    manager.call_tool = AsyncMock(return_value="ok")
    tracker_1, tracker_2 = two_trackers

    async with app_lifespan(mcp) as first:
        pass
    async with app_lifespan(mcp) as second:
        with _request_carrying(tracker=first.tracker, hand=first.hand):
            await manager.call_tool("get_server_info", {})
        with _request_carrying(tracker=second.tracker, hand=second.hand):
            await manager.call_tool("get_server_info", {})

    tracker_1.before_tool_call.assert_awaited_once()
    tracker_1.after_tool_call.assert_awaited_once()
    tracker_2.before_tool_call.assert_awaited_once()
    tracker_2.after_tool_call.assert_awaited_once()


# ---------- hand inner, tracker outer ----------
#
# `app_lifespan` installs the hand first and the tracker second so a DENIED
# call is still recorded (docs/pipeline-design/05-mcp-allowlist-enforcement.md
# §3.3). Nothing else in the suite pins that order.


async def test_denied_call_is_still_recorded_by_the_tracker():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    tracker = AsyncMock()
    install_hand(server, _deny_all_hand())
    install_tracking(server, tracker)

    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("get_card", {"workspace_slug": "x"})

    original.assert_not_awaited()
    tracker.before_tool_call.assert_awaited_once_with("get_card", {"workspace_slug": "x"})
    tracker.after_tool_call.assert_awaited_once()
    assert tracker.after_tool_call.await_args.args[0] == "get_card"


async def test_denied_call_hands_the_tracker_the_denial_payload():
    """Forensics need the WHY, not just that the call happened: the tracker
    receives the denial JSON the hand raised as its text, so the row can be
    classified and summarised."""
    server = _FakeServer(AsyncMock(return_value="ok"))
    tracker = AsyncMock()
    install_hand(server, _deny_all_hand())
    install_tracking(server, tracker)

    with pytest.raises(PermissionError) as excinfo:
        await server._tool_manager.call_tool("get_card", {"workspace_slug": "x"})

    recorded = tracker.after_tool_call.await_args.args[1]
    assert isinstance(recorded, str)
    assert json.loads(recorded) == json.loads(str(excinfo.value))
    assert tracker.after_tool_call.await_args.kwargs["error"] is excinfo.value


async def test_lifespan_installs_hand_inside_tracking(restore_singleton_manager, two_trackers, monkeypatch):
    manager = restore_singleton_manager
    manager.call_tool = AsyncMock(return_value="ok")
    monkeypatch.setenv(ALLOWLIST_ENV, "get_card")
    tracker_1, _ = two_trackers

    async with app_lifespan(mcp) as session:
        with _request_carrying(tracker=session.tracker, hand=session.hand):
            with pytest.raises(PermissionError):
                await manager.call_tool("create_note", {"workspace_slug": "x"})

    tracker_1.before_tool_call.assert_awaited_once_with("create_note", {"workspace_slug": "x"})
    tracker_1.after_tool_call.assert_awaited_once()
