# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_bundle  # noqa: E402

COMPANION = Path(__file__).resolve().parents[2]
REPO = COMPANION.parent
MODULE_LINE = re.compile(r"^module\s+(\S+)\s*$", re.MULTILINE)


def declared_module(go_mod: Path) -> str:
    match = MODULE_LINE.search(go_mod.read_text(encoding="utf-8"))
    if match is None:
        raise AssertionError(f"{go_mod} declares no module")
    return match.group(1)


def repository_module_root() -> str:
    # The runner already publishes under the repository's real import path;
    # every Go module in this repository hangs off the same root.
    runner = declared_module(REPO / "runner" / "go.mod")
    if not runner.endswith("/runner"):
        raise AssertionError(f"runner module {runner!r} does not end in /runner")
    return runner.removesuffix("/runner")


class ModuleIdentityTest(unittest.TestCase):
    def test_companion_module_lives_under_the_repository_import_path(self):
        self.assertEqual(declared_module(COMPANION / "go.mod"), repository_module_root() + "/companion")

    def test_licensecheck_helper_module_lives_under_the_companion_module(self):
        self.assertEqual(
            declared_module(COMPANION / "scripts" / "licensecheck" / "go.mod"),
            declared_module(COMPANION / "go.mod") + "/scripts/licensecheck",
        )

    def test_version_ldflags_target_the_declared_buildinfo_package(self):
        # `-X` against a package path the binary does not contain is silently
        # ignored, so a stale path ships a Companion without its version.
        self.assertEqual(build_bundle.BUILDINFO, declared_module(COMPANION / "go.mod") + "/internal/buildinfo")


if __name__ == "__main__":
    unittest.main()
