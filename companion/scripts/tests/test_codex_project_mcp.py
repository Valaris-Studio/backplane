# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import codex_project_mcp  # noqa: E402
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

    def apply_while(self, concurrent_change):
        """Applies with concurrent_change made after the new file is flushed, just before replacement."""
        real_fsync = os.fsync

        def fsync_then_change(descriptor):
            real_fsync(descriptor)
            concurrent_change()

        with mock.patch.object(codex_project_mcp.os, "fsync", side_effect=fsync_then_change):
            return self.run_configure(True)

    def test_refuses_a_concurrent_content_edit(self):
        folder = self.project / ".codex"
        folder.mkdir()
        path = folder / "config.toml"
        path.write_text('model_reasoning_effort = "high"\n', encoding="utf-8")
        edited = 'model_reasoning_effort = "low"\n'
        with self.assertRaises(ValueError):
            self.apply_while(lambda: path.write_text(edited, encoding="utf-8"))
        self.assertEqual(path.read_text(encoding="utf-8"), edited)
        self.assertEqual([entry.name for entry in folder.iterdir()], ["config.toml"])

    def test_refuses_a_concurrent_deletion(self):
        folder = self.project / ".codex"
        folder.mkdir()
        path = folder / "config.toml"
        path.write_text('model_reasoning_effort = "high"\n', encoding="utf-8")
        with self.assertRaises(ValueError):
            self.apply_while(path.unlink)
        self.assertFalse(path.exists())
        self.assertEqual(list(folder.iterdir()), [])

    def test_refuses_a_configuration_created_concurrently(self):
        # An empty file reads exactly like the absence it replaced.
        for created in ("", 'model = "created meanwhile"\n'):
            with self.subTest(created=created):
                self.setUp()
                path = self.project / ".codex" / "config.toml"
                with self.assertRaises(ValueError):
                    self.apply_while(lambda: path.write_text(created, encoding="utf-8"))
                self.assertEqual(path.read_text(encoding="utf-8"), created)
                self.assertEqual([entry.name for entry in path.parent.iterdir()], ["config.toml"])

    def test_dry_run_leaves_an_absent_configuration_absent(self):
        self.assertTrue(self.run_configure())
        self.assertFalse((self.project / ".codex").exists())

    def test_applies_to_an_absent_configuration_with_a_valid_absolute_root(self):
        self.assertTrue(Path(self.state["mappings"]["mapping"]["root"]).is_absolute())
        self.assertTrue(self.run_configure(True))
        path = self.project / ".codex" / "config.toml"
        self.assertIn("[mcp_servers.valaris]", path.read_text(encoding="utf-8"))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_refuses_an_absent_empty_or_relative_mapping_root(self):
        # Each malformed root would resolve to the project from this working directory.
        for case, root, cwd in (("absent", None, self.project), ("empty", "", self.project),
                                ("relative", "project", self.root), ("dot", ".", self.project)):
            with self.subTest(case=case):
                mapping = {"enabled": True, "board_id": "board"}
                if root is not None:
                    mapping["root"] = root
                self.state["mappings"] = {"mapping": mapping}
                previous = os.getcwd()
                os.chdir(cwd)
                try:
                    with self.assertRaises(ValueError):
                        self.run_configure()
                finally:
                    os.chdir(previous)
        self.assertFalse((self.project / ".codex").exists())


if __name__ == "__main__":
    unittest.main()
