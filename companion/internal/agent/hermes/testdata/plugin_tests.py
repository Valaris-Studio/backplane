"""Hermes v0.22.4 contract tests for the rendered backplane-companion observer plugin.

Driven by plugin_python_test.go (python3 -I, configured by HERMES_PLUGIN_TEST_*).
The fake PluginContext mirrors hermes_cli/plugins.py (register_hook, session_cwd,
session_surface) and PluginManager.invoke_hook; hook kwargs mirror the fire sites
cited on each builder. Each case runs in its own interpreter, because the plugin
keeps process-wide state (one forwarder per process). Stdlib only.
"""

import contextlib
import contextvars
import importlib.util
import inspect
import json
import os
import pwd
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from datetime import datetime, timezone

PLUGIN_DIR = os.environ["HERMES_PLUGIN_TEST_PLUGIN_DIR"]
EXECUTABLE = os.environ["HERMES_PLUGIN_TEST_EXECUTABLE"]
LATE_PLUGIN_DIR = os.environ["HERMES_PLUGIN_TEST_LATE_PLUGIN_DIR"]
LATE_EXECUTABLE = os.environ["HERMES_PLUGIN_TEST_LATE_EXECUTABLE"]
RECORDS = os.environ["HERMES_PLUGIN_TEST_RECORDS"]
# The rendering baked into a worker image (RenderSocketOnlyPlugin): no command, socket only.
SOCKET_ONLY_PLUGIN_DIR = os.environ["HERMES_PLUGIN_TEST_SOCKET_ONLY_PLUGIN_DIR"]
SOCKET_DIR = os.environ["HERMES_PLUGIN_TEST_SOCKET_DIR"]
HOOK_SOCKET_ENV = "BACKPLANE_COMPANION_HOOK_SOCKET"

PLUGIN_SCHEMA = "backplane.hermes.v1"
OBSERVER_SCHEMA_VERSION = "hermes.observer.v1"
OBSERVED_HOOKS = ["on_session_finalize", "on_session_start", "post_approval_response", "post_tool_call"]
NEVER_REGISTERED = ["pre_tool_call", "pre_llm_call", "post_llm_call", "on_session_end", "pre_verify"]
LOCAL_SURFACES = ["cli", "tui", "desktop", "acp"]
NON_LOCAL_SURFACES = ["telegram", "discord", "slack", "gateway", ""]
CHILD_ENV = {"PATH", "HOME", "BACKPLANE_COMPANION_HOME"}
# Set by the fake companion's own runtime (shell or PEP 538 locale coercion), not by the plugin.
RUNTIME_ADDED_ENV = {"PWD", "SHLVL", "_", "OLDPWD", "LC_CTYPE", "__CF_USER_TEXT_ENCODING", "__PYVENV_LAUNCHER__"}
PROVIDER_SECRETS = [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY",
    "NOUS_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "BACKPLANE_API_KEY",
]
CONTENT_MEMBERS = {
    "args", "result", "error_message", "user_message", "assistant_response", "conversation_history",
    "middleware_trace", "command", "description", "pattern_key", "pattern_keys", "session_key",
}

SESSION = "20261023_101500_a1b2c3"
BARRIER_SESSION = "20261023_235959_ffffff"
TURN = SESSION + ":3f9c2b1e-7d4a-4c2b-9e1f-0a1b2c3d4e5f:8a1b2c3d"
CALL = "toolu_01AbCdEf"
CWD = "/home/dev/src/project"
MODEL = "anthropic/claude-sonnet-4.5"
OBSERVED_AT = "<observed_at>"

RECORD_WAIT_SECONDS = 20.0
CALLBACK_BUDGET_SECONDS = 1.0
OVERFLOW_EVENTS = 5000
OVERFLOW_BUDGET_SECONDS = 5.0

RFC3339_UTC = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|\+00:00)$")

THREAD_FAILURES = []
threading.excepthook = lambda failure: THREAD_FAILURES.append(
    "%s in thread %s: %s" % (failure.exc_type.__name__, getattr(failure.thread, "name", "?"), failure.exc_value))

_RealPopen = subprocess.Popen
_POPEN_SIGNATURE = inspect.signature(_RealPopen.__init__)
POPEN_CALLS = []


class RecordingPopen(_RealPopen):
    def __init__(self, *args, **kwargs):
        try:
            super().__init__(*args, **kwargs)
        finally:
            try:
                bound = _POPEN_SIGNATURE.bind(self, *args, **kwargs).arguments
            except TypeError:
                bound = {"args": args[0] if args else kwargs.get("args")}
            POPEN_CALLS.append({
                "args": bound.get("args"), "shell": bound.get("shell", False), "executable": bound.get("executable"),
            })


subprocess.Popen = RecordingPopen


def spawn_attempts(executable):
    def mentions(args):
        if isinstance(args, (list, tuple)):
            return any(mentions(arg) for arg in args)
        return isinstance(args, (str, bytes, os.PathLike)) and executable in os.fsdecode(args)

    return [call for call in list(POPEN_CALLS) if mentions(call["args"])]


_loaded_plugins = 0
# plugins_loader._directory_module_name for this plugin's manifest key.
HERMES_MODULE_NAME = "hermes_plugins.backplane_companion"


def load_plugin(plugin_dir, name=None):
    """Imports the plugin as plugins_loader._load_directory_module does: under a fresh
    name per call, or under `name` after evicting it and its submodules (a force reload)."""
    global _loaded_plugins
    _loaded_plugins += 1
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []
        namespace.__package__ = "hermes_plugins"
        sys.modules["hermes_plugins"] = namespace
    name = name or "hermes_plugins.backplane_companion__case%d" % _loaded_plugins
    for loaded in list(sys.modules):
        if loaded == name or loaded.startswith(name + "."):
            sys.modules.pop(loaded, None)
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(plugin_dir, "__init__.py"), submodule_search_locations=[plugin_dir])
    module = importlib.util.module_from_spec(spec)
    module.__package__ = name
    module.__path__ = [plugin_dir]
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def accepted_kwargs(callback, payload):
    """PluginManager._hook_callback_kwargs: **kwargs callbacks get everything, narrow ones only what they name."""
    try:
        parameters = inspect.signature(callback).parameters
    except (TypeError, ValueError):
        return dict(payload)
    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()):
        return dict(payload)
    keyword_kinds = {inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY}
    return {name: value for name, value in payload.items()
            if name in parameters and parameters[name].kind in keyword_kinds}


# hermes_cli.plugin_session reads the session of the running hook from a ContextVar,
# so session_cwd()/session_surface() return "" on any thread the plugin starts itself.
_calling_session = contextvars.ContextVar("hermes_calling_session", default=None)


class FakePluginContext:
    def __init__(self, cwd=CWD, surface="cli"):
        self.cwd = cwd
        self.surface = surface
        self.hooks = []
        self.privileged_calls = []
        self.plugin_id = "backplane-companion"
        self.manifest = types.SimpleNamespace(name="backplane-companion", key="backplane-companion", version="")

    def register_hook(self, hook_name, callback):
        self.hooks.append((hook_name, callback))
        return types.SimpleNamespace(unregister=lambda: None)

    def session_cwd(self):
        calling = _calling_session.get()
        return calling[0] if calling else ""

    def session_surface(self):
        calling = _calling_session.get()
        return calling[1] if calling else ""

    def __getattr__(self, name):
        if name.startswith("register_") or name in ("inject_message", "dispatch_tool", "post_message", "call_mcp"):
            return lambda *args, **kwargs: self.privileged_calls.append(name)
        raise AttributeError(name)

    def fire(self, hook_name, **kwargs):
        kwargs.setdefault("telemetry_schema_version", OBSERVER_SCHEMA_VERSION)
        token = _calling_session.set((self.cwd, self.surface))
        try:
            return [callback(**accepted_kwargs(callback, kwargs))
                    for name, callback in list(self.hooks) if name == hook_name]
        finally:
            _calling_session.reset(token)

    def fire_outside_session(self, hook_name, **kwargs):
        """How the gateway fires on_session_finalize when the last viewer detaches or it
        shuts down (gateway/session_viewer_close.py:250 -> run_shutdown_session_end.py:56-73):
        on a housekeeping executor thread, in a context with no session bound, so
        session_cwd() and session_surface() return ""."""
        kwargs.setdefault("telemetry_schema_version", OBSERVER_SCHEMA_VERSION)
        results = []

        def invoke():
            results.extend(callback(**accepted_kwargs(callback, kwargs))
                           for name, callback in list(self.hooks) if name == hook_name)

        housekeeping = threading.Thread(target=contextvars.Context().run, args=(invoke,),
                                        name="hermes-housekeeping")
        housekeeping.start()
        housekeeping.join()
        return results


class BrokenSessionContext(FakePluginContext):
    def session_cwd(self):
        raise RuntimeError("no session bound to this call")

    def session_surface(self):
        raise RuntimeError("no session bound to this call")


def session_start_kwargs(session_id=SESSION, platform="cli", **more):
    # agent/conversation_loop.py:867-870
    kwargs = dict(session_id=session_id, model=MODEL, platform=platform)
    kwargs.update(more)
    return kwargs


def post_tool_call_kwargs(session_id=SESSION, tool_call_id=CALL, **more):
    # model_tools.py:689-694; _CallIds.hook_kwargs turns a None id into ""
    kwargs = dict(
        tool_name="mcp__backplane__get_card", args={"card_id": "c-1"}, result='{"ok": true}',
        task_id="task-7", session_id=session_id, tool_call_id=tool_call_id, turn_id=TURN,
        api_request_id=TURN + ":api:1", duration_ms=42, status="ok", error_type=None, error_message=None,
        middleware_trace=[])
    kwargs.update(more)
    return kwargs


def approval_kwargs(session_id=SESSION, choice="deny", surface="cli", **more):
    # tools/approval.py:910-916 through tools/approval_context.py:54-70
    kwargs = dict(
        command="rm -rf build", description="recursive delete", pattern_key="recursive_delete",
        pattern_keys=["recursive_delete"], session_key="agent:main:cli:dm:local", surface=surface,
        choice=choice, turn_id=TURN, tool_call_id=CALL, session_id=session_id)
    kwargs.update(more)
    return kwargs


def finalize_kwargs(session_id=SESSION, platform="cli", reason="shutdown", **more):
    # hermes_cli/cli_shutdown.py:185 -> hermes_cli/lifecycle.py:81
    kwargs = dict(session_id=session_id, platform=platform, reason=reason)
    kwargs.update(more)
    return kwargs


def every_event(session_id, surface="cli"):
    approval_surface = "cli" if surface == "cli" else "gateway"
    return [
        ("on_session_start", session_start_kwargs(session_id, platform=surface)),
        ("post_tool_call", post_tool_call_kwargs(session_id)),
        ("post_approval_response", approval_kwargs(session_id, surface=approval_surface)),
        ("on_session_finalize", finalize_kwargs(session_id, platform=surface)),
    ]


def expected_projection(event, extra, **top):
    projection = {"hook_event_name": event, "session_id": SESSION, "cwd": CWD}
    projection.update(top)
    projection["extra"] = {"platform": "cli", "observed_at": OBSERVED_AT, "plugin_schema": PLUGIN_SCHEMA}
    projection["extra"].update(extra)
    return projection


def clear_records():
    for name in os.listdir(RECORDS):
        with contextlib.suppress(FileNotFoundError):
            os.remove(os.path.join(RECORDS, name))


def read_records():
    records = []
    for name in sorted(os.listdir(RECORDS)):
        if not (name.startswith("call-") and name.endswith(".json")):
            continue
        with open(os.path.join(RECORDS, name), encoding="utf-8") as handle:
            record = json.load(handle)
        try:
            record["payload"] = json.loads(record["stdin"])
        except ValueError:
            record["payload"] = None
        records.append(record)
    return records


def session_of(record):
    payload = record["payload"]
    return payload.get("session_id") if isinstance(payload, dict) else None


def wait_until(condition, timeout):
    deadline = time.monotonic() + timeout
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.02)
    return condition()


def wait_for_records(count, timeout=RECORD_WAIT_SECONDS):
    wait_until(lambda: len(read_records()) >= count, timeout)
    return read_records()


def member_names(value):
    if isinstance(value, dict):
        for key, nested in value.items():
            yield key
            yield from member_names(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from member_names(nested)


def still_running(pid):
    try:
        reaped, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return False
    return reaped == 0


@contextlib.contextmanager
def patched_environ(changes):
    saved = {name: os.environ.get(name) for name in changes}
    try:
        for name, value in changes.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@contextlib.contextmanager
def without_module(name):
    """`import name` raises ImportError inside the block, as on a platform without it."""
    saved = sys.modules.get(name)
    sys.modules[name] = None
    try:
        yield
    finally:
        if saved is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = saved


# Hermes' gateway session ids: local-<sha256 hex> (hermes_state_keys.py:71-74).
GATEWAY_SESSION = "local-" + "5e" * 32
UNSEEN_SESSION = "local-" + "0f" * 32
CHAT_SESSION = "20261023_101500_c4a7c4"


class FakeHookSocket:
    """The headless Companion's hook socket, as plugin_tests sees it: one frame per connection, read
    to the half-close, answered "{}". Keyed like the fake companion by the session id in the frame:
    slow_ never answers, fail_ closes without answering."""

    def __init__(self):
        self.path = os.path.join(SOCKET_DIR, "h%d.sock" % os.getpid())
        self.frames = []
        self.lock = threading.Lock()
        self.listener = None

    def start(self):
        with contextlib.suppress(FileNotFoundError):
            os.remove(self.path)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(16)
        threading.Thread(target=self._serve, name="fake-hook-socket", daemon=True).start()
        return self

    def _serve(self):
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(connection,), daemon=True).start()

    def _handle(self, connection):
        with connection:
            connection.settimeout(5.0)
            frame = b""
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                frame += chunk
            with self.lock:
                self.frames.append(frame)
            session = frame_session(frame) or ""
            if session.startswith("slow_"):
                time.sleep(30)
            elif not session.startswith("fail_"):
                connection.sendall(b"{}\n")

    def recorded(self):
        with self.lock:
            return list(self.frames)

    def close(self):
        if self.listener is not None:
            self.listener.close()
        with contextlib.suppress(FileNotFoundError):
            os.remove(self.path)


def frame_payload(frame):
    agent_line, separator, payload = frame.partition(b"\n")
    if separator != b"\n" or agent_line != b"hermes":
        return None
    try:
        return json.loads(payload.decode("utf-8"))
    except ValueError:
        return None


def frame_session(frame):
    payload = frame_payload(frame)
    return payload.get("session_id") if isinstance(payload, dict) else None


def hook_and_session(record):
    payload = record["payload"] if isinstance(record["payload"], dict) else {}
    return payload.get("hook_event_name"), payload.get("session_id")


class HermesObserverPluginTest(unittest.TestCase):
    def setUp(self):
        clear_records()
        del THREAD_FAILURES[:]

    def tearDown(self):
        self.assertEqual(THREAD_FAILURES, [], "a plugin thread raised instead of swallowing the failure")

    def register(self, surface="cli", plugin_dir=PLUGIN_DIR, context=FakePluginContext):
        ctx = context(surface=surface)
        load_plugin(plugin_dir).register(ctx)
        return ctx

    def fire_observed(self, ctx, hook_name, **kwargs):
        started = time.monotonic()
        results = ctx.fire(hook_name, **kwargs)
        elapsed = time.monotonic() - started
        self.assertEqual(results, [None], "%s must run exactly one callback that returns None" % hook_name)
        self.assertLess(elapsed, CALLBACK_BUDGET_SECONDS, "%s held the Hermes turn for %.2fs" % (hook_name, elapsed))

    def fire_outside_session_observed(self, ctx, hook_name, **kwargs):
        started = time.monotonic()
        results = ctx.fire_outside_session(hook_name, **kwargs)
        elapsed = time.monotonic() - started
        self.assertEqual(results, [None], "%s must run exactly one callback that returns None" % hook_name)
        self.assertLess(elapsed, CALLBACK_BUDGET_SECONDS, "%s held the Hermes worker for %.2fs" % (hook_name, elapsed))

    def records_exactly(self, count):
        records = wait_for_records(count)
        self.assertEqual(len(records), count, "companion calls: %s" % [record["stdin"] for record in records])
        return records

    def records_through(self, session_id):
        recorded = wait_until(lambda: any(session_of(record) == session_id for record in read_records()),
                              RECORD_WAIT_SECONDS)
        self.assertTrue(recorded, "the companion never received the %s event" % session_id)
        return read_records()

    def assert_observed_at(self, value, fired_from, fired_until):
        match = RFC3339_UTC.match(value) if isinstance(value, str) else None
        self.assertIsNotNone(match, "observed_at %r is not an RFC3339 UTC timestamp" % (value,))
        whole = datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        observed = whole + (float("0" + match.group(2)) if match.group(2) else 0.0)
        self.assertGreaterEqual(observed, fired_from - 1.0, "observed_at is not the time the hook fired")
        self.assertLessEqual(observed, fired_until + 1.0, "observed_at is not the time the hook fired")

    def assert_golden(self, record, expected, fired_from, fired_until):
        payload = record["payload"]
        self.assertIsInstance(payload, dict, "stdin must be exactly one JSON object: %r" % record["stdin"])
        actual = json.loads(json.dumps(payload))
        self.assertIsInstance(actual.get("extra"), dict, "projection has no extra object: %r" % payload)
        self.assert_observed_at(actual["extra"].get("observed_at"), fired_from, fired_until)
        actual["extra"]["observed_at"] = OBSERVED_AT
        # Same latitude as hermes_test.go withoutNullToolMembers: these nulls may ride along off tool calls.
        if actual.get("hook_event_name") != "post_tool_call":
            for member in ("tool_name", "tool_input"):
                if member in actual and actual[member] is None:
                    del actual[member]
        self.assertEqual(actual, expected)

    def fire_golden(self, hook_name, kwargs, expected):
        ctx = self.register()
        fired_from = time.time()
        self.fire_observed(ctx, hook_name, future_member="additive", **kwargs)
        fired_until = time.time()
        record = self.records_exactly(1)[0]
        self.assert_golden(record, expected, fired_from, fired_until)
        return record

    def test_register_subscribes_only_the_four_observer_hooks(self):
        ctx = self.register()
        names = [name for name, _ in ctx.hooks]
        for forbidden in NEVER_REGISTERED:
            self.assertNotIn(forbidden, names, "%s is a directive/turn hook; the plugin is observer-only" % forbidden)
        self.assertEqual([name for name in names if name.startswith("transform_")], [])
        self.assertEqual(sorted(names), OBSERVED_HOOKS)
        self.assertTrue(all(callable(callback) for _, callback in ctx.hooks))
        self.assertEqual(ctx.privileged_calls, [], "register(ctx) must only register hooks")

    def test_on_session_start_projection_golden(self):
        self.fire_golden("on_session_start", session_start_kwargs(),
                         expected_projection("on_session_start", {"model": MODEL}))

    def test_post_tool_call_projection_golden(self):
        record = self.fire_golden(
            "post_tool_call", post_tool_call_kwargs(),
            expected_projection("post_tool_call", {"turn_id": TURN, "status": "ok", "duration_ms": 42},
                                tool_name="mcp__backplane__get_card", tool_input=None, tool_call_id=CALL))
        duration = record["payload"]["extra"]["duration_ms"]
        self.assertTrue(isinstance(duration, int) and not isinstance(duration, bool),
                        "duration_ms must stay an integer, got %r" % (duration,))

    def test_post_approval_response_projection_golden(self):
        self.fire_golden("post_approval_response", approval_kwargs(),
                         expected_projection("post_approval_response", {"turn_id": TURN, "choice": "deny"},
                                             tool_call_id=CALL))

    def test_on_session_finalize_projection_golden(self):
        self.fire_golden("on_session_finalize", finalize_kwargs(),
                         expected_projection("on_session_finalize", {"reason": "shutdown"}))

    def test_on_session_finalize_forwards_only_hermes_end_reason_tokens(self):
        # gateway/session_controls.py _END_REASON: a lower-case token Hermes itself names the end with.
        tokens = ["cli_close", "new_session", "session_boundary", "shutdown", "a" + "b" * 31]
        not_tokens = ["sk-live-" + secrets.token_hex(12), "The user typed quit", "a" + "b" * 32, "reason2"]
        ctx = self.register()
        fired_from = time.time()
        for reason in tokens + not_tokens:
            self.fire_observed(ctx, "on_session_finalize", **finalize_kwargs(reason=reason))
        fired_until = time.time()
        records = self.records_exactly(len(tokens) + len(not_tokens))
        for record, reason in zip(records, tokens):
            self.assert_golden(record, expected_projection("on_session_finalize", {"reason": reason}),
                               fired_from, fired_until)
        for record in records[len(tokens):]:
            self.assert_golden(record, expected_projection("on_session_finalize", {}), fired_from, fired_until)

    def test_local_surfaces_are_forwarded_with_their_platform(self):
        ctx = self.register()
        for index, surface in enumerate(LOCAL_SURFACES):
            ctx.surface = surface
            self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs(tool_call_id="toolu_surface_%d" % index))
        records = self.records_exactly(len(LOCAL_SURFACES))
        platforms = [((record["payload"] or {}).get("extra") or {}).get("platform") for record in records]
        self.assertEqual(platforms, LOCAL_SURFACES)

    def test_non_local_surfaces_are_skipped(self):
        ctx = self.register()
        for index, surface in enumerate(NON_LOCAL_SURFACES):
            ctx.surface = surface
            for hook_name, kwargs in every_event("20261023_1015%02d_abcdef" % index, surface):
                self.fire_observed(ctx, hook_name, **kwargs)
        ctx.surface = "cli"
        self.fire_observed(ctx, "on_session_finalize", **finalize_kwargs(session_id=BARRIER_SESSION))
        records = self.records_through(BARRIER_SESSION)
        self.assertEqual([session_of(record) for record in records], [BARRIER_SESSION],
                         "events of non-local surfaces reached the companion")

    def test_content_kwargs_never_reach_stdin(self):
        token = secrets.token_hex(16)

        def secret(label):
            return "sk-live-%s-%s" % (label, token)

        turn_content = dict(
            user_message=secret("user_message"), assistant_response=secret("assistant_response"),
            conversation_history=[
                {"role": "user", "content": secret("history")},
                {"role": "assistant", "content": [{"type": "text", "text": secret("history.nested")}]},
            ])
        ctx = self.register()
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs(**turn_content))
        self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs(
            args={"command": "curl -H 'Authorization: Bearer %s' https://api.example.com" % secret("args"),
                  "env": {"OPENAI_API_KEY": secret("args.env")},
                  "files": [{"path": "/etc/hosts", "content": secret("args.files")}]},
            result=json.dumps({"stdout": secret("result"), "error": secret("result.error")}),
            status="error", error_type="tool_error", error_message=secret("error_message"),
            middleware_trace=[{"middleware": "redact", "args": {"api_key": secret("middleware_trace")}}],
            **turn_content))
        self.fire_observed(ctx, "post_approval_response", **approval_kwargs(
            command="echo %s | sh" % secret("command"), description=secret("description"),
            pattern_key=secret("pattern_key"), pattern_keys=[secret("pattern_keys")],
            session_key=secret("session_key"), **turn_content))
        self.fire_observed(ctx, "on_session_finalize", **finalize_kwargs(**turn_content))
        records = self.records_exactly(4)
        for record in records:
            self.assertNotIn(token, record["stdin"], "content reached the companion: %s" % record["stdin"])
            self.assertEqual(set(member_names(record["payload"])) & CONTENT_MEMBERS, set(), record["stdin"])
        tool_calls = [record for record in records if (record["payload"] or {}).get("hook_event_name") == "post_tool_call"]
        self.assertEqual(len(tool_calls), 1)
        self.assertEqual(tool_calls[0]["payload"]["extra"].get("status"), "error")

    def test_child_env_is_minimal_without_parent_secrets(self):
        token = secrets.token_hex(16)
        real_home = tempfile.mkdtemp(prefix="real home ")
        companion_home = tempfile.mkdtemp(prefix="companion home ")
        profile_home = tempfile.mkdtemp(prefix="profile home ")
        for directory in (real_home, companion_home, profile_home):
            self.addCleanup(shutil.rmtree, directory, True)
        parent = {name: "sk-live-%s-%s" % (name.lower(), token) for name in PROVIDER_SECRETS}
        parent.update(HOME=profile_home, HERMES_REAL_HOME=real_home, BACKPLANE_COMPANION_HOME=companion_home,
                      HERMES_HOME=os.path.join(profile_home, ".hermes"), TERMINAL_HOME_MODE="profile")
        with patched_environ(parent):
            ctx = self.register()
            self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
            env = self.records_exactly(1)[0]["env"]
        self.assertNotIn(token, json.dumps(env), "a parent secret reached the companion's environment")
        self.assertEqual(env.get("HOME"), real_home, "HOME must come from HERMES_REAL_HOME")
        self.assertEqual(env.get("BACKPLANE_COMPANION_HOME"), companion_home)
        self.assertTrue(env.get("PATH"), "the companion needs PATH")
        self.assertEqual(sorted(set(env) - CHILD_ENV - RUNTIME_ADDED_ENV), [], "child env is not minimal")

    def test_child_home_falls_back_to_passwd_home(self):
        profile_home = tempfile.mkdtemp(prefix="profile home ")
        self.addCleanup(shutil.rmtree, profile_home, True)
        with patched_environ({"HERMES_REAL_HOME": None, "BACKPLANE_COMPANION_HOME": None, "HOME": profile_home}):
            ctx = self.register()
            self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
            env = self.records_exactly(1)[0]["env"]
        self.assertEqual(env.get("HOME"), pwd.getpwuid(os.getuid()).pw_dir)
        self.assertNotIn("BACKPLANE_COMPANION_HOME", env)
        self.assertEqual(sorted(set(env) - CHILD_ENV - RUNTIME_ADDED_ENV), [], "child env is not minimal")

    def test_child_argv_is_executable_hook_hermes_without_shell(self):
        ctx = self.register()
        self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs())
        record = self.records_exactly(1)[0]
        self.assertEqual(record["argv"], [EXECUTABLE, "hook", "hermes"])
        for call in spawn_attempts(EXECUTABLE):
            self.assertFalse(call["shell"], "the companion must be spawned without a shell")
            self.assertIn(call["executable"], (None, EXECUTABLE))
            self.assertIsInstance(call["args"], (list, tuple))
            self.assertEqual(list(call["args"]), [EXECUTABLE, "hook", "hermes"])

    def test_events_reach_companion_in_fire_order(self):
        ctx = self.register()
        fired = [("on_session_start", session_start_kwargs())]
        fired += [("post_tool_call", post_tool_call_kwargs(tool_call_id="toolu_order_%d" % index)) for index in range(3)]
        fired += [("post_approval_response", approval_kwargs()), ("on_session_finalize", finalize_kwargs())]
        for hook_name, kwargs in fired:
            self.fire_observed(ctx, hook_name, **kwargs)
        records = self.records_exactly(len(fired))
        received = [((record["payload"] or {}).get("hook_event_name"), (record["payload"] or {}).get("tool_call_id"))
                    for record in records]
        self.assertEqual([name for name, _ in received], [name for name, _ in fired])
        self.assertEqual([call_id for _, call_id in received[1:4]], ["toolu_order_0", "toolu_order_1", "toolu_order_2"])

    def test_one_daemon_worker_thread_drains_events(self):
        existing = set(threading.enumerate())
        ctx = self.register()
        for index in range(3):
            self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs(tool_call_id="toolu_worker_%d" % index))
        self.records_exactly(3)
        started = [thread for thread in threading.enumerate() if thread not in existing]
        self.assertEqual(len(started), 1, "want one worker thread, found %s" % [thread.name for thread in started])
        self.assertTrue(started[0].daemon, "a non-daemon worker would hold the Hermes gateway open at exit")

    def test_missing_executable_returns_none_and_is_never_retried(self):
        self.assertFalse(os.path.exists(LATE_EXECUTABLE))
        self.addCleanup(shutil.rmtree, os.path.dirname(LATE_EXECUTABLE), True)
        ctx = self.register(plugin_dir=LATE_PLUGIN_DIR)
        for hook_name, kwargs in every_event("20261023_101500_dead01"):
            self.fire_observed(ctx, hook_name, **kwargs)
        wait_until(lambda: len(spawn_attempts(LATE_EXECUTABLE)) >= 4, timeout=2.0)
        os.makedirs(os.path.dirname(LATE_EXECUTABLE))
        shutil.copy2(EXECUTABLE, LATE_EXECUTABLE)
        os.chmod(LATE_EXECUTABLE, 0o700)
        for hook_name, kwargs in every_event(SESSION):
            self.fire_observed(ctx, hook_name, **kwargs)
        self.records_exactly(4)
        self.fire_observed(ctx, "on_session_finalize", **finalize_kwargs(session_id=BARRIER_SESSION))
        records = self.records_through(BARRIER_SESSION)
        self.assertEqual([session_of(record) for record in records], [SESSION] * 4 + [BARRIER_SESSION],
                         "an event sent while the companion was missing was retried")

    def test_failing_executable_returns_none_and_is_never_retried(self):
        failing = "fail_" + SESSION
        ctx = self.register()
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs(session_id=failing))
        self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs(session_id=failing))
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
        self.records_exactly(3)
        self.fire_observed(ctx, "on_session_finalize", **finalize_kwargs(session_id=BARRIER_SESSION))
        records = self.records_through(BARRIER_SESSION)
        self.assertEqual([session_of(record) for record in records], [failing, failing, SESSION, BARRIER_SESSION])

    def test_slow_executable_never_blocks_and_is_timed_out(self):
        slow = "slow_" + SESSION
        ctx = self.register()
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs(session_id=slow))
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
        self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs())
        records = wait_for_records(3, timeout=RECORD_WAIT_SECONDS + 2.0)
        self.assertEqual([session_of(record) for record in records], [slow, SESSION, SESSION],
                         "a hung companion stalled the worker past its timeout")
        self.assertFalse(still_running(records[0]["pid"]), "the timed-out companion was left running")

    def test_queue_full_drops_without_blocking(self):
        ctx = self.register()
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs(session_id="slow_" + SESSION))
        self.records_exactly(1)
        started = time.monotonic()
        results = [ctx.fire("post_tool_call", **post_tool_call_kwargs(session_id="drop_" + SESSION,
                                                                      tool_call_id="toolu_%05d" % index))
                   for index in range(OVERFLOW_EVENTS)]
        elapsed = time.monotonic() - started
        self.assertEqual([result for result in results if result != [None]], [])
        self.assertLess(elapsed, OVERFLOW_BUDGET_SECONDS,
                        "%d events against a busy worker took %.2fs; a full queue must drop" % (OVERFLOW_EVENTS, elapsed))

    def test_callbacks_never_raise_on_broken_context_or_odd_kwargs(self):
        broken = self.register(context=BrokenSessionContext)
        for hook_name, kwargs in every_event(SESSION):
            self.fire_observed(broken, hook_name, **kwargs)
        cyclic = {}
        cyclic["self"] = cyclic
        odd_events = [
            ("on_session_start", {}),
            ("on_session_start", {"session_id": None, "model": None, "platform": None}),
            ("post_tool_call", {}),
            ("post_tool_call", {"session_id": 7, "tool_name": b"\xff", "tool_call_id": None, "turn_id": object(),
                                "duration_ms": "fast", "status": object(), "args": cyclic, "result": object(),
                                "middleware_trace": None}),
            ("post_approval_response", {"choice": None, "session_id": None, "tool_call_id": None}),
            ("on_session_finalize", {"session_id": None, "reason": ["not", "a", "string"], "platform": 3}),
        ]
        ctx = self.register()
        for hook_name, kwargs in odd_events:
            self.fire_observed(ctx, hook_name, **kwargs)
        self.fire_observed(ctx, "on_session_finalize", **finalize_kwargs(session_id=BARRIER_SESSION))
        self.records_through(BARRIER_SESSION)

    # --- observers Hermes fires outside a bound session context --------------------------

    def test_finalize_outside_a_session_is_forwarded_with_the_surface_and_cwd_the_session_showed(self):
        ctx = self.register(surface="tui")
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs(GATEWAY_SESSION, platform="tui"))
        fired_from = time.time()
        # The last viewer detached: the row's source is the platform and the viewer's
        # end reason is Hermes' own token.
        self.fire_outside_session_observed(
            ctx, "on_session_finalize", **finalize_kwargs(GATEWAY_SESSION, platform="tui", reason="tui_close"))
        fired_until = time.time()
        records = self.records_exactly(2)
        expected = expected_projection("on_session_finalize", {"reason": "tui_close"})
        expected["session_id"] = GATEWAY_SESSION
        expected["extra"]["platform"] = "tui"
        self.assert_golden(records[1], expected, fired_from, fired_until)

    def test_every_observer_outside_a_session_uses_what_the_session_showed(self):
        # The plugin may first meet a session mid-way (loaded after its start).
        ctx = self.register(surface="desktop")
        self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs(tool_call_id="toolu_bound"))
        fired_from = time.time()
        self.fire_outside_session_observed(ctx, "post_tool_call", **post_tool_call_kwargs(tool_call_id="toolu_unbound"))
        self.fire_outside_session_observed(ctx, "post_approval_response", **approval_kwargs(surface="gateway"))
        self.fire_outside_session_observed(ctx, "on_session_finalize", **finalize_kwargs(platform="desktop"))
        fired_until = time.time()
        records = self.records_exactly(4)
        for record, expected in zip(records[1:], [
            expected_projection("post_tool_call", {"turn_id": TURN, "status": "ok", "duration_ms": 42},
                                tool_name="mcp__backplane__get_card", tool_input=None, tool_call_id="toolu_unbound"),
            expected_projection("post_approval_response", {"turn_id": TURN, "choice": "deny"}, tool_call_id=CALL),
            expected_projection("on_session_finalize", {"reason": "shutdown"}),
        ]):
            expected["extra"]["platform"] = "desktop"
            self.assert_golden(record, expected, fired_from, fired_until)

    def test_observers_outside_a_session_of_a_session_never_forwarded_are_dropped(self):
        ctx = self.register()
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
        ctx.surface = "telegram"
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs(CHAT_SESSION, platform="telegram"))
        for hook_name, kwargs in [
            ("on_session_finalize", finalize_kwargs(UNSEEN_SESSION, platform="cli")),
            ("post_tool_call", post_tool_call_kwargs(UNSEEN_SESSION)),
            ("post_approval_response", approval_kwargs(UNSEEN_SESSION)),
            ("on_session_finalize", finalize_kwargs(CHAT_SESSION, platform="telegram")),
        ]:
            self.fire_outside_session_observed(ctx, hook_name, **kwargs)
        # Barrier: the FIFO worker delivers it after anything enqueued before it.
        self.fire_outside_session_observed(ctx, "on_session_finalize", **finalize_kwargs())
        barrier = ("on_session_finalize", SESSION)
        arrived = wait_until(lambda: barrier in [hook_and_session(record) for record in read_records()],
                             RECORD_WAIT_SECONDS)
        self.assertTrue(arrived, "the finalize of a forwarded session fired outside its context never arrived")
        self.assertEqual([hook_and_session(record) for record in read_records()],
                         [("on_session_start", SESSION), barrier],
                         "an event of a session the plugin never forwarded reached the companion")

    def test_reload_reuses_the_one_forwarder_thread(self):
        before = set(threading.enumerate())
        ctx = FakePluginContext()
        load_plugin(PLUGIN_DIR, HERMES_MODULE_NAME).register(ctx)
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
        self.records_exactly(1)
        # discover_and_load(force=True): evict the module, run it again, register(ctx) anew.
        for _ in range(3):
            ctx = FakePluginContext()
            load_plugin(PLUGIN_DIR, HERMES_MODULE_NAME).register(ctx)
        self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs())
        self.records_exactly(2)
        started = [thread for thread in threading.enumerate() if thread not in before]
        self.assertEqual(len(started), 1, "want the one forwarder after 3 reloads, found %s"
                         % [thread.name for thread in started])
        self.assertTrue(started[0].daemon, "a non-daemon worker would hold the Hermes gateway open at exit")

    def test_plugin_loads_and_forwards_without_pwd(self):
        home = tempfile.mkdtemp(prefix="home without pwd ")
        self.addCleanup(shutil.rmtree, home, True)
        with patched_environ({"HERMES_REAL_HOME": None, "BACKPLANE_COMPANION_HOME": None, "HOME": home}), \
                without_module("pwd"):
            ctx = self.register()
            self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
            env = self.records_exactly(1)[0]["env"]
            expected_home = os.path.expanduser("~")
        self.assertEqual(expected_home, home, "setup: expanduser reads HOME")
        self.assertEqual(env.get("HOME"), home, "without pwd the child HOME is os.path.expanduser('~')")
        self.assertEqual(sorted(set(env) - CHILD_ENV - RUNTIME_ADDED_ENV), [], "child env is not minimal")

    # --- the hook socket route (the worker image's rendering) -------------------------------

    def hook_socket(self, start=True):
        fake = FakeHookSocket()
        self.addCleanup(fake.close)
        return fake.start() if start else fake

    def register_over_socket(self, path, plugin_dir=SOCKET_ONLY_PLUGIN_DIR):
        with patched_environ({HOOK_SOCKET_ENV: path}):
            return self.register(plugin_dir=plugin_dir)

    def frames_exactly(self, fake, count):
        wait_until(lambda: len(fake.recorded()) >= count, RECORD_WAIT_SECONDS)
        frames = fake.recorded()
        self.assertEqual(len(frames), count, "hook socket frames: %r" % frames)
        return frames

    def test_socket_only_rendering_registers_nothing_without_the_socket_variable(self):
        existing = set(threading.enumerate())
        with patched_environ({HOOK_SOCKET_ENV: None}):
            ctx = self.register(plugin_dir=SOCKET_ONLY_PLUGIN_DIR)
        self.assertEqual(ctx.hooks, [], "without a socket the worker image's plugin must observe nothing")
        self.assertEqual(ctx.privileged_calls, [])
        self.assertEqual([thread for thread in threading.enumerate() if thread not in existing], [],
                         "an inert plugin started a forwarder thread")

    def test_socket_only_rendering_ignores_a_relative_socket_path(self):
        ctx = self.register_over_socket("run/hook.sock")
        self.assertEqual(ctx.hooks, [], "a relative socket path is not a socket the gateway named")

    def test_socket_variable_routes_every_event_over_the_socket_without_spawning(self):
        fake = self.hook_socket()
        ctx = self.register_over_socket(fake.path)
        self.assertEqual(sorted(name for name, _ in ctx.hooks), OBSERVED_HOOKS)
        fired_from = time.time()
        for hook_name, kwargs in every_event(SESSION):
            self.fire_observed(ctx, hook_name, **kwargs)
        fired_until = time.time()
        frames = self.frames_exactly(fake, 4)
        for frame in frames:
            self.assertTrue(frame.startswith(b"hermes\n"), "frame does not start with the agent line: %r" % frame[:40])
        payloads = [frame_payload(frame) for frame in frames]
        self.assertEqual([payload["hook_event_name"] for payload in payloads],
                         ["on_session_start", "post_tool_call", "post_approval_response", "on_session_finalize"])
        self.assert_golden({"payload": payloads[0], "stdin": frames[0][7:].decode("utf-8")},
                           expected_projection("on_session_start", {"model": MODEL}), fired_from, fired_until)
        for payload in payloads:
            self.assertFalse(CONTENT_MEMBERS & set(member_names(payload)), "content reached the socket: %r" % payload)
        self.assertEqual(spawn_attempts(EXECUTABLE), [], "the socket route spawned the companion")
        self.assertEqual(read_records(), [], "the socket route also ran the subprocess route")

    def test_socket_variable_wins_over_a_rendered_command(self):
        fake = self.hook_socket()
        ctx = self.register_over_socket(fake.path, plugin_dir=PLUGIN_DIR)
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
        self.frames_exactly(fake, 1)
        time.sleep(0.2)
        self.assertEqual(spawn_attempts(EXECUTABLE), [], "with a socket named, the command was still spawned")
        self.assertEqual(read_records(), [])

    def test_missing_socket_returns_none_and_is_never_retried(self):
        fake = self.hook_socket(start=False)
        ctx = self.register_over_socket(fake.path)
        module = sys.modules[ctx.hooks[0][1].__module__] if ctx.hooks else None
        for hook_name, kwargs in every_event("20261023_101500_dead02"):
            self.fire_observed(ctx, hook_name, **kwargs)
        wait_until(lambda: module is not None and module.counters["companion_failures"] >= 4, 5.0)
        self.assertEqual(module.counters["companion_failures"], 4, "each lost record counts once")
        fake.start()
        self.fire_observed(ctx, "on_session_finalize", **finalize_kwargs(session_id=BARRIER_SESSION))
        frames = self.frames_exactly(fake, 1)
        self.assertEqual([frame_session(frame) for frame in frames], [BARRIER_SESSION],
                         "an event sent while the socket was absent was retried")

    def test_socket_closed_without_a_reply_is_counted_not_raised(self):
        fake = self.hook_socket()
        ctx = self.register_over_socket(fake.path)
        module = sys.modules[ctx.hooks[0][1].__module__]
        failing = "fail_" + SESSION
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs(session_id=failing))
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
        frames = self.frames_exactly(fake, 2)
        self.assertEqual([frame_session(frame) for frame in frames], [failing, SESSION])
        wait_until(lambda: module.counters["companion_failures"] >= 1, 5.0)
        self.assertEqual(module.counters["companion_failures"], 1, "a refused record counts exactly once")
        self.assertEqual(module.counters["callback_failures"], 0)

    def test_silent_socket_never_blocks_and_is_timed_out(self):
        fake = self.hook_socket()
        ctx = self.register_over_socket(fake.path)
        slow = "slow_" + SESSION
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs(session_id=slow))
        self.fire_observed(ctx, "on_session_start", **session_start_kwargs())
        self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs())
        wait_until(lambda: len(fake.recorded()) >= 3, RECORD_WAIT_SECONDS + 2.0)
        self.assertEqual([frame_session(frame) for frame in fake.recorded()], [slow, SESSION, SESSION],
                         "a silent companion stalled the worker past its timeout")

    def test_socket_route_runs_one_daemon_worker_thread(self):
        fake = self.hook_socket()
        existing = set(threading.enumerate())
        ctx = self.register_over_socket(fake.path)
        for index in range(3):
            self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs(tool_call_id="toolu_sock_%d" % index))
        self.frames_exactly(fake, 3)
        # The fake's per-connection handler threads are its own, not the plugin's.
        started = [thread for thread in threading.enumerate()
                   if thread not in existing and not thread.name.startswith("Thread-")]
        self.assertEqual(len(started), 1, "want one worker thread, found %s" % [thread.name for thread in started])
        self.assertTrue(started[0].daemon)

    # --- only an empty surface falls back to what the session showed ------------------------

    def test_a_remembered_session_fired_from_a_messaging_surface_is_dropped(self):
        # A Desktop session the process saw, later driven from a chat (an admin's cross-origin
        # /resume, gateway/slash_commands_session.py): session_surface() names the chat's
        # platform (hermes_cli/plugin_session.py), so the context is bound, just not locally.
        ctx = self.register(surface="desktop")
        self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs(tool_call_id="toolu_bound"))
        for surface in ("telegram", "discord", "slack", "gateway"):
            ctx.surface = surface
            for hook_name, kwargs in every_event(SESSION, surface):
                if hook_name == "post_tool_call":
                    kwargs = post_tool_call_kwargs(tool_call_id="toolu_from_%s" % surface)
                self.fire_observed(ctx, hook_name, **kwargs)
        ctx.surface = "cli"
        self.fire_observed(ctx, "on_session_finalize", **finalize_kwargs(session_id=BARRIER_SESSION))
        records = self.records_through(BARRIER_SESSION)
        self.assertEqual([hook_and_session(record) for record in records],
                         [("post_tool_call", SESSION), ("on_session_finalize", BARRIER_SESSION)],
                         "a hook fired from a messaging surface was forwarded as the remembered local session")

    # --- one forwarder and one session memory under concurrency -----------------------------

    def register_concurrently(self, modules_and_contexts):
        """register(ctx) for each pair, each from its own thread, all released at once. Every
        thread start a registration makes is held open, so an unguarded check-then-start of
        the forwarder interleaves there. Returns what register raised."""
        gate = threading.Barrier(len(modules_and_contexts))
        registering = threading.local()
        failures = []
        real_start = threading.Thread.start

        def widened_start(thread):
            if getattr(registering, "active", False):
                time.sleep(WIDENED_START_SECONDS)
            return real_start(thread)

        def register_one(module, ctx):
            registering.active = True
            try:
                gate.wait(timeout=10)
                module.register(ctx)
            except Exception as failure:
                failures.append("%s: %s" % (type(failure).__name__, failure))
            finally:
                registering.active = False

        workers = [threading.Thread(target=register_one, args=pair, name="hermes-plugin-manager-%d" % index)
                   for index, pair in enumerate(modules_and_contexts)]
        threading.Thread.start = widened_start
        try:
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(30)
        finally:
            threading.Thread.start = real_start
        self.assertEqual([worker.name for worker in workers if worker.is_alive()], [], "a register(ctx) never returned")
        return failures

    def assert_every_registration_forwards(self, contexts):
        for index, ctx in enumerate(contexts):
            self.fire_observed(ctx, "post_tool_call", **post_tool_call_kwargs(tool_call_id="toolu_manager_%d" % index))
        received = sorted(record["payload"]["tool_call_id"] for record in self.records_exactly(len(contexts)))
        self.assertEqual(received, sorted("toolu_manager_%d" % index for index in range(len(contexts))))

    def fire_storm(self, module, contexts):
        """Every context fires for more sessions than the plugin remembers, each in its own
        order, so a remembered entry is evicted while another thread reads or refreshes it.
        Returns the callback failures the plugin counted. The drop_ sessions record nothing."""
        remembered = getattr(module, "SESSIONS_REMEMBERED", 1024)
        sessions = ["drop_20261023_%06d" % index for index in range(remembered + 256)]
        unexpected = []

        def fire_all(offset, ctx):
            for step in range(len(sessions)):
                session_id = sessions[(offset * 211 + step) % len(sessions)]
                results = ctx.fire("on_session_start", **session_start_kwargs(session_id))
                if results != [None]:
                    unexpected.append(results)

        firing = [threading.Thread(target=fire_all, args=(offset, ctx), name="hermes-turn-%d" % offset)
                  for offset, ctx in enumerate(contexts)]
        interval = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)
        try:
            for thread in firing:
                thread.start()
            for thread in firing:
                thread.join(60)
        finally:
            sys.setswitchinterval(interval)
        self.assertEqual(unexpected, [], "an observer returned something other than None")
        return getattr(module, "counters", {}).get("callback_failures", 0)

    def test_concurrent_registers_and_fires_of_one_load_share_one_forwarder(self):
        before = set(threading.enumerate())
        module = load_plugin(PLUGIN_DIR)
        contexts = [FakePluginContext() for _ in range(CONCURRENT_REGISTRATIONS)]
        failures = self.register_concurrently([(module, ctx) for ctx in contexts])
        self.assert_every_registration_forwards(contexts)
        callback_failures = self.fire_storm(module, contexts)
        started = [thread.name for thread in threading.enumerate() if thread not in before]
        self.assertEqual(
            {"register raised": failures, "threads started": len(started), "callback failures": callback_failures},
            {"register raised": [], "threads started": 1, "callback failures": 0},
            "%d concurrent registers of one load: threads %s" % (CONCURRENT_REGISTRATIONS, started))

    def test_concurrent_registers_of_separate_loads_share_one_forwarder(self):
        # Two plugin managers loading the plugin at once (multiplexed profiles), or a reload
        # racing a load: each runs the module anew, under its own name.
        before = set(threading.enumerate())
        loads = [(load_plugin(PLUGIN_DIR), FakePluginContext()) for _ in range(CONCURRENT_REGISTRATIONS)]
        failures = self.register_concurrently(loads)
        started = [thread.name for thread in threading.enumerate() if thread not in before]
        self.assertEqual(
            {"register raised": failures, "threads started": len(started)},
            {"register raised": [], "threads started": 1},
            "%d concurrent registers of separate loads: threads %s" % (CONCURRENT_REGISTRATIONS, started))
        self.assert_every_registration_forwards([ctx for _, ctx in loads])


CONCURRENT_REGISTRATIONS = 6
WIDENED_START_SECONDS = 0.3

CASE_TIMEOUT_SECONDS = 120


def run_each_case_in_its_own_interpreter():
    """Prints every case's report, then OK only if each case ended exactly OK: a
    skipped case ("OK (skipped=1)") fails the run, as plugin_python_test.go requires."""
    names = unittest.TestLoader().getTestCaseNames(HermesObserverPluginTest)
    failed = []
    for name in names:
        env = dict(os.environ, HERMES_PLUGIN_TEST_CASE=name)
        try:
            case = subprocess.run([sys.executable, "-I", os.path.abspath(__file__)], env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  timeout=CASE_TIMEOUT_SECONDS, check=False)
            report = case.stdout.decode("utf-8", "replace")
            clean = case.returncode == 0 and re.search(r"(?m)^OK$", report) is not None
        except subprocess.TimeoutExpired as timeout:
            report = (timeout.output or b"").decode("utf-8", "replace") + "\nTIMED OUT\n"
            clean = False
        # Only the run's own verdict may read as a bare OK line.
        sys.stdout.write(re.sub(r"(?m)^OK", "case OK", report))
        if not clean:
            failed.append(name)
    print("Ran %d cases, each in its own interpreter" % len(names))
    if failed:
        print("FAILED (%d): %s" % (len(failed), ", ".join(failed)))
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    if os.environ.get("HERMES_PLUGIN_TEST_CASE"):
        unittest.main(argv=[sys.argv[0], "HermesObserverPluginTest." + os.environ["HERMES_PLUGIN_TEST_CASE"]],
                      verbosity=2)
    else:
        run_each_case_in_its_own_interpreter()
