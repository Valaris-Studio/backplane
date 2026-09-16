# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from tests.runner_fixture_terminal import OwnedTerminal


def _linux_group_states(group_id):
    states = {}
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            # comm is parenthesized and may itself contain spaces or ')'.
            fields = stat.read_text().rsplit(")", 1)[1].split()
        except FileNotFoundError:
            continue  # A process may exit while /proc is being enumerated.
        if int(fields[2]) == group_id:
            states[int(stat.parent.name)] = fields[0]
    return states


@pytest.mark.parametrize("reason", ["early-finish", "timeout"])
async def test_fixture_reaps_owned_terminal_group_on_early_exit(tmp_path, reason):
    terminal = OwnedTerminal(
        ["/bin/sh", "-c", "printf ready; sleep 30"],
        env={"PATH": "/usr/bin:/bin"},
        cwd=tmp_path,
        directory=tmp_path,
    )
    await terminal.start()
    reader, writer = await asyncio.open_unix_connection(terminal.socket_path)
    writer.write(
        json.dumps({"nonce": terminal.nonce, "rows": 24, "cols": 80}).encode() + b"\n"
    )
    await writer.drain()
    assert await asyncio.wait_for(reader.readexactly(5), 5) == b"ready"
    pid = terminal.process.pid
    assert os.getpgid(pid) == pid
    if sys.platform == "linux":
        assert _linux_group_states(pid)[pid] != "Z"
    try:
        if reason == "timeout":
            with pytest.raises(TimeoutError):
                async with asyncio.timeout(0.01):
                    await asyncio.Event().wait()
    finally:
        await terminal.close()
        writer.close()
        await writer.wait_closed()
    assert terminal.process.returncode is not None
    if sys.platform == "linux":
        # Container PID 1 may leave orphaned zombies unreaped. Those cannot
        # execute; every live descendant must still be gone after cleanup.
        states = _linux_group_states(pid)
        assert all(state == "Z" for state in states.values()), states
    else:
        with pytest.raises((ProcessLookupError, PermissionError)):
            os.killpg(pid, 0)


async def test_fixture_never_signals_recycled_pid_after_reaping(tmp_path):
    terminal = OwnedTerminal(
        ["/usr/bin/true"],
        env={"PATH": "/usr/bin:/bin"},
        cwd=tmp_path,
        directory=tmp_path,
    )
    unrelated = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    await terminal.start()
    reader, writer = await asyncio.open_unix_connection(terminal.socket_path)
    writer.write(
        json.dumps({"nonce": terminal.nonce, "rows": 24, "cols": 80}).encode() + b"\n"
    )
    await writer.drain()
    try:
        await asyncio.wait_for(reader.read(), 5)
        assert terminal.process.wait(timeout=5) == 0
        # Simulate a PID value now belonging to another process. Returncode
        # proves this Popen child was reaped, so teardown must never signal it.
        terminal.process.pid = unrelated.pid
        await terminal.close()
        assert unrelated.poll() is None
    finally:
        writer.close()
        await writer.wait_closed()
        unrelated.terminate()
        unrelated.wait(timeout=5)


async def test_close_cleans_handler_when_cancelled_during_process_stop(tmp_path):
    terminal = OwnedTerminal(
        ["/bin/sh", "-c", "printf ready; sleep 30"],
        env={"PATH": "/usr/bin:/bin"},
        cwd=tmp_path,
        directory=tmp_path,
    )
    disconnect = asyncio.Event()
    stopping = asyncio.Event()
    ready = asyncio.Event()

    class Reader:
        async def readline(self):
            return (
                json.dumps({"nonce": terminal.nonce, "rows": 24, "cols": 80}).encode()
                + b"\n"
            )

        async def read(self, _):
            await disconnect.wait()
            return b""

    class Writer:
        closed = False

        def write(self, data):
            if b"ready" in data:
                ready.set()

        async def drain(self):
            pass

        def close(self):
            self.closed = True

        async def wait_closed(self):
            assert self.closed

    writer = Writer()
    original_stop = terminal._stop_process

    async def blocked_handler_stop():
        if asyncio.current_task() in terminal.handlers:
            stopping.set()
            await asyncio.Event().wait()
        await original_stop()

    terminal._stop_process = blocked_handler_stop
    await terminal.start()
    handler = asyncio.create_task(terminal._handle(Reader(), writer))
    try:
        await asyncio.wait_for(ready.wait(), 5)
        disconnect.set()
        await asyncio.wait_for(stopping.wait(), 5)
        # close stops the owned process, then cancels this handler while it is
        # already inside its finally block, waiting to acquire the stop lock.
        await asyncio.wait_for(terminal.close(), 5)
        assert writer.closed
        assert not terminal.handlers
        assert handler.done()
    finally:
        terminal._stop_process = original_stop
        handler.cancel()
        await asyncio.gather(handler, return_exceptions=True)
        await terminal.close()


async def test_automated_terminal_driver_interacts_with_owned_child(tmp_path):
    from tests.runner_fixture_terminal import TerminalDriver
    import sys

    terminal = OwnedTerminal(
        [
            sys.executable,
            "-c",
            "print('Fixture name?', flush=True); name=input(); print('Hello '+name, flush=True); input()",
        ],
        env={"PATH": "/usr/bin:/bin"},
        cwd=tmp_path,
        directory=tmp_path,
    )
    await terminal.start()
    driver = TerminalDriver(terminal)
    try:
        await driver.connect()
        await driver.expect("Fixture name?")
        await driver.send("operator\r")
        await driver.expect("Hello operator")
    finally:
        await driver.close()
        await terminal.close()
    assert terminal.process.returncode is not None


async def test_group_permission_error_does_not_block_async_owned_child_cleanup(
    tmp_path, monkeypatch
):
    terminal = OwnedTerminal([], env={}, cwd=tmp_path, directory=tmp_path)
    child = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    unrelated = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    terminal.process = child

    def denied_group(pid, sig):
        assert pid == child.pid
        raise PermissionError("fixture group unavailable")

    monkeypatch.setattr(os, "killpg", denied_group)

    async def complete_graceful_exit():
        await asyncio.sleep(0.2)
        child.terminate()

    finished = asyncio.create_task(complete_graceful_exit())
    try:
        await terminal.close()
        assert child.returncode is not None
        assert unrelated.poll() is None
    finally:
        finished.cancel()
        await asyncio.gather(finished, return_exceptions=True)
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        unrelated.terminate()
        unrelated.wait(timeout=5)


async def test_group_denial_signals_only_the_owned_unreaped_pid(tmp_path, monkeypatch):
    terminal = OwnedTerminal([], env={}, cwd=tmp_path, directory=tmp_path)
    child = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    unrelated = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    terminal.process = child

    def denied_group(pid, sig):
        assert pid == child.pid
        raise PermissionError("fixture group unavailable")

    monkeypatch.setattr(os, "killpg", denied_group)
    try:
        await terminal.close()
        assert child.returncode is not None
        assert unrelated.poll() is None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        unrelated.terminate()
        unrelated.wait(timeout=5)


async def test_group_signal_also_reaches_owned_leader(tmp_path, monkeypatch):
    terminal = OwnedTerminal([], env={}, cwd=tmp_path, directory=tmp_path)
    child = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    unrelated = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    terminal.process = child

    def group_signal_without_leader(pid, sig):
        assert pid == child.pid

    monkeypatch.setattr(os, "killpg", group_signal_without_leader)
    try:
        await terminal.close()
        assert child.returncode is not None
        assert unrelated.poll() is None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        unrelated.terminate()
        unrelated.wait(timeout=5)


async def test_denied_group_with_live_descendant_reports_cleanup_failure(
    tmp_path, monkeypatch
):
    import signal

    terminal = OwnedTerminal([], env={}, cwd=tmp_path, directory=tmp_path)
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import subprocess,time; c=subprocess.Popen(['/bin/sleep','30']); print(c.pid,flush=True); time.sleep(30)",
        ],
        start_new_session=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert int(child.stdout.readline()) > 0
    terminal.process = child
    real_killpg = os.killpg

    def denied_group(pid, sig):
        assert pid == child.pid
        raise PermissionError("fixture group unavailable")

    monkeypatch.setattr(os, "killpg", denied_group)
    try:
        with pytest.raises(RuntimeError, match="live descendants"):
            await terminal.close()
    finally:
        # The fixture still owns the unreaped parent identity if group cleanup
        # cannot be proven; restore signaling and finish the owned group only.
        real_killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=5)
        child.stdout.close()
        terminal.process = None
        await terminal.close()


async def test_owned_terminal_is_released_before_waiting_for_exit(
    tmp_path, monkeypatch
):
    terminal = OwnedTerminal([], env={}, cwd=tmp_path, directory=tmp_path)
    terminal.master, slave = os.openpty()
    child = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    terminal.process = child
    real_wait = child.wait

    def wait_after_terminal_release(*args, **kwargs):
        assert (
            terminal.master is None
        ), "open PTY can leave killed child stuck in terminal I/O"
        return real_wait(*args, **kwargs)

    monkeypatch.setattr(child, "wait", wait_after_terminal_release)
    try:
        await terminal.close()
        assert child.returncode is not None
    finally:
        os.close(slave)
        if child.poll() is None:
            child.kill()
        real_wait(timeout=5)


async def test_terminal_pumps_finish_before_master_descriptor_closes(tmp_path):
    terminal = OwnedTerminal([], env={}, cwd=tmp_path, directory=tmp_path)
    terminal.master, slave = os.openpty()
    child = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    terminal.process = child
    started = asyncio.Event()
    pump_saw_open_master = []

    async def pump():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            pump_saw_open_master.append(terminal.master is not None)

    task = asyncio.create_task(pump())
    terminal.pumps = [task]
    await started.wait()
    try:
        await terminal.close()
        assert task.done(), "terminal pump could touch a reused descriptor after close"
        assert pump_saw_open_master == [True]
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        os.close(slave)
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
