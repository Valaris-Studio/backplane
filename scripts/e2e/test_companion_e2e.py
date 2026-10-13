# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run with the MCP server's interpreter, like the harness itself:

    mcp-server/.venv/bin/python -m unittest discover -s scripts/e2e
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "companion" / "scripts" / "tests")]

import companion_e2e  # noqa: E402
from test_text_encoding import default_encoding_calls  # noqa: E402

REQUIRED = ["--pg-root", "pg", "--beacon-artifact", "dist/artifact.json", "--otelcol-artifact", "dist/otelcol.json"]


class ParseArgumentsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = os.getcwd()
        os.chdir(self.directory.name)
        self.cwd = Path.cwd()

    def tearDown(self):
        os.chdir(self.previous)
        self.directory.cleanup()

    def test_relative_paths_become_absolute_against_the_invocation_directory(self):
        # Alembic, uvicorn and the MCP server run with another cwd, where a relative interpreter no longer resolves.
        args = companion_e2e.parse_args(REQUIRED + ["--backend-python", "backend/.venv/bin/python", "--mcp-python", "mcp/.venv/bin/python",
                                                    "--work-root", "work"])
        self.assertEqual(args.backend_python, str(self.cwd / "backend/.venv/bin/python"))
        self.assertEqual(args.mcp_python, str(self.cwd / "mcp/.venv/bin/python"))
        self.assertEqual(args.work_root, str(self.cwd / "work"))
        self.assertEqual(args.pg_root, str(self.cwd / "pg"))
        self.assertEqual(args.beacon_artifact, str(self.cwd / "dist/artifact.json"))
        self.assertEqual(args.otelcol_artifact, str(self.cwd / "dist/otelcol.json"))

    def test_a_venv_interpreter_symlink_is_not_followed(self):
        # Resolving bin/python to the base interpreter would silently drop the venv's packages.
        target = self.cwd / "base-python"
        target.touch()
        venv = self.cwd / "venv" / "bin"
        venv.mkdir(parents=True)
        (venv / "python").symlink_to(target)
        args = companion_e2e.parse_args(REQUIRED + ["--backend-python", "venv/bin/python"])
        self.assertEqual(args.backend_python, str(self.cwd / "venv/bin/python"))

    def test_a_bare_command_name_is_left_for_path_lookup(self):
        args = companion_e2e.parse_args(REQUIRED + ["--backend-python", "python3", "--mcp-python", "python3.12"])
        self.assertEqual((args.backend_python, args.mcp_python), ("python3", "python3.12"))


class CompanionRunTest(unittest.TestCase):
    def test_undecodable_output_is_replaced_not_raised(self):
        with tempfile.TemporaryDirectory() as directory:
            companion = companion_e2e.Companion(Path(sys.executable), Path(directory), "beacon.json", "otelcol.json")
            result = companion.run("-c", "import sys; sys.stdout.buffer.write(b'ok \\xff')")
        self.assertEqual(result.stdout, "ok \ufffd")


class TextEncodingTest(unittest.TestCase):
    def test_the_harness_never_uses_the_locale_encoding(self):
        self.assertEqual(default_encoding_calls(HERE / "companion_e2e.py"), [])


if __name__ == "__main__":
    unittest.main()


class ClaudeTranscriptTest(unittest.TestCase):
    def test_expected_tokens_count_each_request_once_at_its_final_usage(self):
        requests = {}
        for line in companion_e2e.claude_transcript("claude-e2e-1").splitlines():
            entry = json.loads(line)
            usage = entry.get("message", {}).get("usage")
            if usage:
                key = (entry["message"]["id"], entry["requestId"])
                if key not in requests or usage["output_tokens"] > requests[key]["output_tokens"]:
                    requests[key] = usage
        totals = tuple(sum(usage[name] for usage in requests.values())
                       for name in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        self.assertEqual(totals, companion_e2e.CLAUDE_TRANSCRIPT_TOKENS)
        self.assertEqual(len(requests), 2)

    def test_every_content_block_carries_the_sentinel_the_database_scan_looks_for(self):
        lines = [json.loads(line) for line in companion_e2e.claude_transcript("s").splitlines()]
        blocks = [line["message"]["content"] for line in lines if isinstance(line["message"]["content"], list)]
        self.assertTrue(blocks)
        for block in blocks:
            self.assertIn(companion_e2e.CLAUDE_TRANSCRIPT_SENTINEL, json.dumps(block))

    def test_lines_are_newline_terminated_json_for_the_given_session(self):
        text = companion_e2e.claude_transcript("claude-e2e-1")
        self.assertTrue(text.endswith("\n"))
        self.assertTrue(all(json.loads(line)["sessionId"] == "claude-e2e-1" for line in text.splitlines()))


class CaptureWindowTest(unittest.TestCase):
    def runner(self, windows):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        data = Path(directory.name)
        if windows is not None:
            (data / "capture-windows.json").write_text(json.dumps({"windows": windows}), encoding="utf-8")
        runner = object.__new__(companion_e2e.Run)
        runner.companion = type("Companion", (), {"data": data})()
        return runner

    def test_only_an_open_window_for_the_mapping_counts(self):
        open_span = [{"from": "2026-09-25T00:00:00Z", "last_seen": "2026-09-25T00:00:01Z", "open": True}]
        closed_span = [{"from": "2026-09-25T00:00:00Z", "last_seen": "2026-09-25T00:00:01Z"}]
        self.assertTrue(self.runner({"claude_code\x00m1": open_span}).capture_window_open("m1"))
        self.assertFalse(self.runner({"claude_code\x00m1": closed_span}).capture_window_open("m1"))
        self.assertFalse(self.runner({"claude_code\x00m2": open_span}).capture_window_open("m1"))
        self.assertFalse(self.runner(None).capture_window_open("m1"))

    def test_transcript_stamps_keep_milliseconds(self):
        stamp = json.loads(companion_e2e.claude_transcript("s").splitlines()[0])["timestamp"]
        self.assertRegex(stamp, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
