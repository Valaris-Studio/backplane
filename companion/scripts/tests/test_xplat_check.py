# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "xplat_check.sh"
REPO = Path(__file__).resolve().parents[3]

# Stand-ins for go and cargo: they log what they were asked and fail only on
# request, so every leg's reporting is checked without a real build.
FAKE_GO = """#!/bin/sh
printf 'go %s GOOS=%s GOARCH=%s CGO_ENABLED=%s\\n' "$*" "$GOOS" "$GOARCH" "$CGO_ENABLED" >> "$XPLAT_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then git -C "$2" rev-parse --git-dir >/dev/null 2>&1 && echo "go ran inside a git worktree" >> "$XPLAT_LOG"; fi
  shift
done
[ "$GOOS" = "$FAIL_GOOS" ] && { echo "vet: something is wrong" >&2; exit 1; }
exit 0
"""

FAKE_CARGO = """#!/bin/sh
printf 'cargo %s\\n' "$*" >> "$XPLAT_LOG"
case "$1" in
  xwin) [ -n "$HAS_XWIN" ] || { echo "error: no such command: xwin" >&2; exit 101; } ;;
  check) [ -n "$FAIL_MAC_CHECK" ] && { echo "error[E0425]: nope" >&2; exit 101; } ;;
esac
exit 0
"""


class XplatCheckTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.bin = Path(directory.name) / "bin"
        self.bin.mkdir()
        for name, body in (("go", FAKE_GO), ("cargo", FAKE_CARGO)):
            (self.bin / name).write_text(body, encoding="utf-8")
            (self.bin / name).chmod(0o755)
        self.log = Path(directory.name) / "calls.log"
        self.log.touch()

    def run_check(self, **environment):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": os.environ.get("HOME", "/tmp"), "XPLAT_LOG": str(self.log), **environment}
        return subprocess.run([str(SCRIPT)], capture_output=True, encoding="utf-8", env=env)

    def test_xplat_check_passes_every_available_leg(self):
        result = self.run_check(HAS_XWIN="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for line in ("PASS  go vet (darwin/arm64)", "PASS  go vet (linux/amd64)", "PASS  go vet (windows/amd64)",
                     "PASS  cargo check (x86_64-apple-darwin)", "PASS  cargo xwin check (x86_64-pc-windows-msvc)"):
            self.assertIn(line, result.stdout)

    def test_xplat_check_reports_a_missing_cargo_xwin_as_skipped_never_pass(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("SKIP  cargo xwin check (x86_64-pc-windows-msvc)", result.stdout)
        self.assertNotIn("PASS  cargo xwin", result.stdout)
        self.assertNotIn("cargo xwin check", self.log.read_text(encoding="utf-8"))

    def test_xplat_check_fails_when_go_vet_fails_for_one_target(self):
        result = self.run_check(FAIL_GOOS="windows")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL  go vet (windows/amd64)", result.stdout)
        self.assertIn("vet: something is wrong", result.stdout)
        self.assertIn("PASS  go vet (linux/amd64)", result.stdout)

    def test_xplat_check_fails_when_the_intel_mac_check_fails(self):
        result = self.run_check(FAIL_MAC_CHECK="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL  cargo check (x86_64-apple-darwin)", result.stdout)

    def test_xplat_check_never_runs_go_inside_the_repository(self):
        self.run_check()
        calls = self.log.read_text(encoding="utf-8")
        self.assertNotIn("go ran inside a git worktree", calls)
        go_calls = [line for line in calls.splitlines() if line.startswith("go ")]
        self.assertEqual(len(go_calls), 3, calls)
        for call in go_calls:
            self.assertNotIn(str(REPO), call)
            self.assertIn("CGO_ENABLED=0", call)


if __name__ == "__main__":
    unittest.main()
