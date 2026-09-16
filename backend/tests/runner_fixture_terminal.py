# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A fixture-owned PTY; the external terminal is only an authenticated relay."""

import asyncio
import contextlib
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import secrets
import selectors
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import tty


class OwnedTerminal:
    def __init__(self, command, *, env, cwd, directory):
        self.command, self.env, self.cwd = command, env, str(cwd)
        self.directory = Path(directory)
        self.nonce = secrets.token_hex(24)
        self.process = None
        self.server = None
        self.master = None
        self.handlers = set()
        self.pumps = []
        self._stop_lock = asyncio.Lock()
        self._socket_dir = tempfile.TemporaryDirectory(prefix="bp-tty-", dir="/tmp")
        self.socket_path = str(Path(self._socket_dir.name) / "tty.sock")

    async def start(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.spec = self.directory / "owned-child.json"
        fd = os.open(self.spec, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump({"command": self.command, "env": self.env, "cwd": self.cwd}, file)
        self.server = await asyncio.start_unix_server(
            self._handle, path=self.socket_path
        )

    async def _handle(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        pumps = []
        owns_child = False
        try:
            header = json.loads(await asyncio.wait_for(reader.readline(), 5))
            if not secrets.compare_digest(str(header.get("nonce", "")), self.nonce):
                return
            if self.process is not None:
                return
            master, slave = pty.openpty()
            self.master = master
            size = struct.pack(
                "HHHH",
                max(10, min(100, int(header["rows"]))),
                max(40, min(300, int(header["cols"]))),
                0,
                0,
            )
            fcntl.ioctl(master, termios.TIOCSWINSZ, size)
            try:
                # No Python preexec_fn in the multithreaded pytest process.
                # The single-threaded child wrapper acquires its controlling
                # terminal, then execs the artifact with the same PID/session.
                self.process = subprocess.Popen(
                    [
                        sys.executable,
                        str(Path(__file__).resolve()),
                        "--exec",
                        str(self.spec),
                    ],
                    stdin=slave,
                    stdout=slave,
                    stderr=slave,
                    start_new_session=True,
                )
                owns_child = True
            finally:
                os.close(slave)
            identity = self.directory / "owned-child-identity.json"
            fd = os.open(identity, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as file:
                json.dump(
                    {
                        "pid": self.process.pid,
                        "process_group": self.process.pid,
                        "identity": self.nonce,
                    },
                    file,
                )

            async def input_pump():
                while data := await reader.read(65536):
                    os.write(master, data)

            async def output_pump():
                loop = asyncio.get_running_loop()
                while True:
                    ready = loop.create_future()

                    def readable():
                        loop.remove_reader(master)
                        try:
                            data = os.read(master, 65536)
                        except OSError:
                            data = b""
                        if not ready.done():
                            ready.set_result(data)

                    loop.add_reader(master, readable)
                    try:
                        data = await ready
                    finally:
                        loop.remove_reader(master)
                    if not data:
                        return
                    writer.write(data)
                    await writer.drain()

            pumps = [
                asyncio.create_task(input_pump()),
                asyncio.create_task(output_pump()),
            ]
            self.pumps = pumps
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        finally:
            try:
                if owns_child:
                    await self._stop_process()
            finally:
                # close() may cancel a handler already waiting for the stop
                # lock in this finally block. Its pumps and socket still need
                # cleanup before the server can finish waiting for clients.
                for pump in pumps:
                    pump.cancel()
                try:
                    await asyncio.gather(*pumps, return_exceptions=True)
                finally:
                    writer.close()
                    try:
                        with contextlib.suppress(ConnectionError):
                            await writer.wait_closed()
                    finally:
                        self.handlers.discard(task)

    async def _stop_process(self):
        async with self._stop_lock:
            child = self.process
            if child is not None and child.returncode is None:
                # Do not poll/wait before signalling: even if the leader has
                # exited, this parent's unreaped child reserves its PID. A
                # recycled PID can never receive these process-group signals.
                self._signal_owned_group(child, signal.SIGTERM)
                await asyncio.sleep(0.1)
                if child.returncode is None:
                    self._signal_owned_group(child, signal.SIGKILL)
                # Finish selectors before releasing the descriptor: otherwise
                # a delayed pump callback could touch an unrelated reused FD.
                for pump in self.pumps:
                    pump.cancel()
                await asyncio.gather(*self.pumps, return_exceptions=True)
                # Release the owned terminal before reaping. On macOS a
                # killed writer can remain stuck until its PTY is closed.
                self._close_master()
                # Keep the leader unreaped while checking its original group:
                # the identity cannot be recycled during this bounded audit.
                for attempt in range(6):
                    live = await asyncio.to_thread(
                        self._live_group_descendants, child.pid
                    )
                    if not live:
                        break
                    await asyncio.sleep(0.05)
                else:
                    raise RuntimeError(
                        "fixture cleanup could not stop live descendants in its owned process group"
                    )
                await asyncio.to_thread(child.wait, timeout=5)

    @staticmethod
    def _signal_owned_group(child, sig):
        try:
            os.killpg(child.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        # A PTY leader may no longer receive its original group's signal.
        # This Popen is still unreaped, so only this exact owned PID is safe.
        with contextlib.suppress(ProcessLookupError):
            os.kill(child.pid, sig)

    @staticmethod
    def _live_group_descendants(group_id):
        result = subprocess.run(
            ["/bin/ps", "-axo", "pid=,pgid=,stat="],
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        )
        live = []
        for row in result.stdout.splitlines():
            pid, group, state = row.split()
            if (
                int(group) == group_id
                and int(pid) != group_id
                and not state.startswith("Z")
            ):
                live.append(int(pid))
        return live

    def _close_master(self):
        if self.master is not None:
            asyncio.get_running_loop().remove_reader(self.master)
            os.close(self.master)
            self.master = None

    async def close(self):
        if self.server is not None:
            self.server.close()
        try:
            await self._stop_process()
        finally:
            for task in list(self.handlers):
                task.cancel()
            await asyncio.gather(*self.handlers, return_exceptions=True)
            if self.server is not None:
                await self.server.wait_closed()
            self._close_master()
            self._socket_dir.cleanup()


class TerminalDriver:
    """Keyboard automation over the same owned PTY used by human qualification."""

    def __init__(self, terminal):
        self.terminal = terminal
        self.writer = None
        self.reader_task = None
        self.transcript = ""
        self.offset = 0
        self.changed = asyncio.Event()

    async def connect(self):
        reader, self.writer = await asyncio.open_unix_connection(
            self.terminal.socket_path
        )
        self.writer.write(
            json.dumps({"nonce": self.terminal.nonce, "rows": 40, "cols": 120}).encode()
            + b"\n"
        )
        await self.writer.drain()

        async def receive():
            while data := await reader.read(65536):
                self.transcript += data.decode(errors="replace")
                assert (
                    len(self.transcript) < 2_000_000
                ), "fixture terminal output exceeded its bound"
                self.changed.set()
            self.changed.set()

        self.reader_task = asyncio.create_task(receive())

    async def send(self, keys):
        self.offset = len(self.transcript)
        self.writer.write(keys.encode())
        await self.writer.drain()

    async def expect(self, text, timeout=15):
        async with asyncio.timeout(timeout):
            while True:
                self.changed.clear()
                plain = re.sub(
                    r"\x1b\[[0-?]*[ -/]*[@-~]", "", self.transcript[self.offset :]
                )
                if text in plain:
                    return plain
                if self.reader_task.done():
                    await self.reader_task
                    raise AssertionError(
                        f"terminal exited before expected screen: {text}"
                    )
                await self.changed.wait()

    async def close(self):
        if self.writer is not None:
            self.writer.close()
            with contextlib.suppress(ConnectionError):
                await self.writer.wait_closed()
        if self.reader_task is not None:
            self.reader_task.cancel()
            await asyncio.gather(self.reader_task, return_exceptions=True)


def relay(metadata_path):
    metadata = json.loads(Path(metadata_path).read_text())
    size = os.get_terminal_size(sys.stdin.fileno())
    previous = termios.tcgetattr(sys.stdin.fileno())
    with socket.socket(socket.AF_UNIX) as channel:
        channel.connect(metadata["terminal_socket"])
        channel.sendall(
            json.dumps(
                {
                    "nonce": metadata["terminal_identity"],
                    "rows": size.lines,
                    "cols": size.columns,
                }
            ).encode()
            + b"\n"
        )
        selector = selectors.DefaultSelector()
        selector.register(channel, selectors.EVENT_READ)
        selector.register(sys.stdin, selectors.EVENT_READ)
        try:
            tty.setraw(sys.stdin.fileno())
            while True:
                for key, _ in selector.select():
                    if key.fileobj is channel:
                        data = channel.recv(65536)
                        if not data:
                            return
                        os.write(sys.stdout.fileno(), data)
                    else:
                        data = os.read(sys.stdin.fileno(), 65536)
                        if not data:
                            return
                        channel.sendall(data)
        finally:
            selector.close()
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, previous)


if __name__ == "__main__":
    if sys.argv[1] == "--exec":
        spec = json.loads(Path(sys.argv[2]).read_text())
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        os.chdir(spec["cwd"])
        os.execve(spec["command"][0], spec["command"], spec["env"])
    elif sys.argv[1] == "--relay":
        relay(sys.argv[2])
