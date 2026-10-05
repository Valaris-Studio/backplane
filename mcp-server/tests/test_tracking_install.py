# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`install_tracking` installs once per tool manager and records per session.

Under streamable-http the lowlevel Server enters `app_lifespan` once PER
SESSION against the one shared `_tool_manager`. Wrapping on every entry stacks
a recorder closure per session that is never removed, so every call is recorded
by every session's recorder that ever existed. The wrapper must install once
(same sentinel technique as `install_hand`) and resolve the CURRENT request's
recorder from the lowlevel request context, falling back to the install-time
recorder when no request is active (stdio startup, direct calls).
"""
from __future__ import annotations

import contextlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

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


def _recorder(name: str = "recorder") -> MagicMock:
    recorder = MagicMock(name=name)
    recorder.begin.return_value = SimpleNamespace(id=f"{name}-invocation")
    recorder.running.side_effect = lambda *args, **kwargs: contextlib.nullcontext()
    return recorder


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
    install_tracking(server, _recorder())
    call_after_first = server._tool_manager.call_tool
    assert call_after_first is not original

    install_tracking(server, _recorder())
    assert server._tool_manager.call_tool is call_after_first


async def test_install_tracking_marks_the_manager_with_its_sentinel():
    server = _FakeServer(AsyncMock(return_value="ok"))
    install_tracking(server, _recorder())
    assert getattr(server._tool_manager, TRACKING_SENTINEL, False) is True


async def test_second_install_leaves_the_inner_original_awaited_once_per_call():
    """A restacked wrapper would still reach the original once, so the
    observable symptom of stacking is the recorder side: the SECOND session's
    recorder must not be layered on top of the first."""
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    recorder_a, recorder_b = _recorder(), _recorder()
    install_tracking(server, recorder_a)
    install_tracking(server, recorder_b)

    assert await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"}) == "ok"
    original.assert_awaited_once_with("get_board", {"workspace_slug": "x"})
    assert recorder_a.begin.call_count + recorder_b.begin.call_count == 1
    assert recorder_a.finish.call_count + recorder_b.finish.call_count == 1


# ---------- per-request recorder resolution ----------


async def test_install_tracking_resolves_the_current_requests_recorder():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    installed_recorder, session_recorder = _recorder(), _recorder()
    install_tracking(server, installed_recorder)

    with _request_carrying(recorder=session_recorder):
        assert await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"}) == "ok"

    session_recorder.begin.assert_called_once_with("get_board", {"workspace_slug": "x"})
    session_recorder.finish.assert_called_once_with(session_recorder.begin.return_value, "ok")
    installed_recorder.begin.assert_not_called()
    installed_recorder.finish.assert_not_called()


async def test_install_tracking_falls_back_to_the_install_time_recorder_without_a_request():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    installed_recorder = _recorder()
    install_tracking(server, installed_recorder)

    assert await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"}) == "ok"

    installed_recorder.begin.assert_called_once_with("get_board", {"workspace_slug": "x"})
    installed_recorder.finish.assert_called_once_with(installed_recorder.begin.return_value, "ok")


async def test_install_tracking_falls_back_when_the_lifespan_context_has_no_recorder():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    installed_recorder = _recorder()
    install_tracking(server, installed_recorder)

    with _request_carrying(hand=HandState(None, None, None)):
        assert await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"}) == "ok"

    installed_recorder.begin.assert_called_once()
    installed_recorder.finish.assert_called_once()


async def test_install_tracking_records_a_raised_call_on_the_current_requests_recorder():
    original = AsyncMock(side_effect=RuntimeError("boom"))
    server = _FakeServer(original)
    installed_recorder, session_recorder = _recorder(), _recorder()
    install_tracking(server, installed_recorder)

    with _request_carrying(recorder=session_recorder):
        with pytest.raises(RuntimeError) as excinfo:
            await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"})

    session_recorder.finish.assert_called_once()
    assert session_recorder.finish.call_args.args[0] is session_recorder.begin.return_value
    assert session_recorder.finish.call_args.kwargs["error"] is excinfo.value
    installed_recorder.finish.assert_not_called()


async def test_raised_call_hands_the_recorder_the_exception_and_its_text():
    the_exc = RuntimeError("boom")
    server = _FakeServer(AsyncMock(side_effect=the_exc))
    recorder = _recorder()
    install_tracking(server, recorder)

    with pytest.raises(RuntimeError):
        await server._tool_manager.call_tool("get_board", {"workspace_slug": "x"})

    recorder.finish.assert_called_once_with(recorder.begin.return_value, "boom", error=the_exc)


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
def two_recorders(monkeypatch):
    import valaris_mcp.server as server_module

    recorders = [_recorder(name="recorder_1"), _recorder(name="recorder_2")]
    handed_out = iter(recorders)
    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    monkeypatch.setattr(server_module, "ValarisClient", lambda: AsyncMock())
    monkeypatch.setattr(
        server_module, "InvocationRecorder", lambda client, **_: next(handed_out)
    )
    return recorders


async def test_two_sequential_lifespans_on_the_singleton_leave_one_recorder_layer(
    restore_singleton_manager, two_recorders
):
    manager = restore_singleton_manager
    original = AsyncMock(return_value="ok")
    manager.call_tool = original
    recorder_1, recorder_2 = two_recorders

    async with app_lifespan(mcp) as first:
        call_after_first = manager.call_tool
        assert first.recorder is recorder_1
    async with app_lifespan(mcp) as second:
        assert second.recorder is recorder_2
        assert manager.call_tool is call_after_first

        # get_server_info rides on every hand, so only the recorder layer is under test.
        with _request_carrying(recorder=second.recorder, hand=second.hand):
            assert await manager.call_tool("get_server_info", {}) == "ok"

    original.assert_awaited_once_with("get_server_info", {})
    recorder_2.begin.assert_called_once_with("get_server_info", {})
    recorder_2.finish.assert_called_once_with(recorder_2.begin.return_value, "ok")
    recorder_1.begin.assert_not_called()
    recorder_1.finish.assert_not_called()


async def test_first_sessions_recorder_still_records_its_own_requests_after_a_second_lifespan(
    restore_singleton_manager, two_recorders
):
    manager = restore_singleton_manager
    manager.call_tool = AsyncMock(return_value="ok")
    recorder_1, recorder_2 = two_recorders

    async with app_lifespan(mcp) as first:
        pass
    async with app_lifespan(mcp) as second:
        with _request_carrying(recorder=first.recorder, hand=first.hand):
            await manager.call_tool("get_server_info", {})
        with _request_carrying(recorder=second.recorder, hand=second.hand):
            await manager.call_tool("get_server_info", {})

    recorder_1.begin.assert_called_once()
    recorder_1.finish.assert_called_once()
    recorder_2.begin.assert_called_once()
    recorder_2.finish.assert_called_once()


# ---------- hand inner, recorder outer ----------
#
# `app_lifespan` installs the hand first and the recorder second so a DENIED
# call is still recorded (docs/pipeline-design/05-mcp-allowlist-enforcement.md
# §3.3). Nothing else in the suite pins that order.


async def test_denied_call_is_still_recorded_by_the_recorder():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    recorder = _recorder()
    install_hand(server, _deny_all_hand())
    install_tracking(server, recorder)

    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("get_card", {"workspace_slug": "x"})

    original.assert_not_awaited()
    recorder.begin.assert_called_once_with("get_card", {"workspace_slug": "x"})
    recorder.finish.assert_called_once()
    assert recorder.finish.call_args.args[0] is recorder.begin.return_value


async def test_denied_call_hands_the_recorder_the_denial_payload():
    """Forensics need the WHY, not just that the call happened: the recorder
    receives the denial JSON the hand raised as its text, so the row can be
    classified and summarised."""
    server = _FakeServer(AsyncMock(return_value="ok"))
    recorder = _recorder()
    install_hand(server, _deny_all_hand())
    install_tracking(server, recorder)

    with pytest.raises(PermissionError) as excinfo:
        await server._tool_manager.call_tool("get_card", {"workspace_slug": "x"})

    recorded = recorder.finish.call_args.args[1]
    assert isinstance(recorded, str)
    assert json.loads(recorded) == json.loads(str(excinfo.value))
    assert recorder.finish.call_args.kwargs["error"] is excinfo.value


async def test_lifespan_installs_hand_inside_tracking(restore_singleton_manager, two_recorders, monkeypatch):
    manager = restore_singleton_manager
    manager.call_tool = AsyncMock(return_value="ok")
    monkeypatch.setenv(ALLOWLIST_ENV, "get_card")
    recorder_1, _ = two_recorders

    async with app_lifespan(mcp) as session:
        with _request_carrying(recorder=session.recorder, hand=session.hand):
            with pytest.raises(PermissionError):
                await manager.call_tool("create_note", {"workspace_slug": "x"})

    recorder_1.begin.assert_called_once_with("create_note", {"workspace_slug": "x"})
    recorder_1.finish.assert_called_once()
