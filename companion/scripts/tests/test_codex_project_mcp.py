# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codex_project_mcp import configure  # noqa: E402


class CodexProjectMCPTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.project = self.root / "project"
        self.project.mkdir()
        self.launcher = self.root / "backplane-companion"
        self.launcher.touch(mode=0o700)
        self.state = {"endpoint": "https://example.test", "mappings": {
            "mapping": {"enabled": True, "root": str(self.project), "board_id": "board"}
        }}

    def run_configure(self, apply=False):
        return configure(self.project, self.launcher, self.state, "https://example.test", apply=apply)

    def test_dry_run_and_idempotent_apply_preserve_existing_settings(self):
        folder = self.project / ".codex"
        folder.mkdir()
        path = folder / "config.toml"
        original = 'model_reasoning_effort = "high"\n'
        path.write_text(original, encoding="utf-8")
        self.assertTrue(self.run_configure())
        self.assertEqual(path.read_text(encoding="utf-8"), original)
        self.assertTrue(self.run_configure(True))
        after = path.read_text(encoding="utf-8")
        self.assertTrue(after.startswith(original))
        self.assertIn('[mcp_servers.valaris]', after)
        self.assertIn('args = ["mcp"]', after)
        self.assertIn('[mcp_servers.backplane]\nenabled = false', after)
        self.assertFalse(self.run_configure(True))
        self.assertEqual(path.read_text(encoding="utf-8"), after)

    def test_refuses_wrong_endpoint_disabled_mapping_and_foreign_config(self):
        for mutation in ("endpoint", "disabled", "foreign"):
            with self.subTest(mutation=mutation):
                self.setUp()
                if mutation == "endpoint":
                    self.state["endpoint"] = "https://other.test"
                elif mutation == "disabled":
                    self.state["mappings"]["mapping"]["enabled"] = False
                else:
                    folder = self.project / ".codex"
                    folder.mkdir()
                    (folder / "config.toml").write_text('[mcp_servers.valaris]\ncommand = "custom"\n', encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.run_configure(True)

    def test_refuses_symlinked_config_directory(self):
        global_config = self.root / "global"
        global_config.mkdir()
        (self.project / ".codex").symlink_to(global_config)
        with self.assertRaises(ValueError):
            self.run_configure(True)
        self.assertEqual(list(global_config.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
