# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import hashlib
import json
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_desktop
import bundle


class DesktopLicenseNoticesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.package = self.root / "package"
        self.package.mkdir()
        self.catalog = self.root / "notices" / "catalog.json"
        self.catalog.parent.mkdir()
        self.text = b"Permission is hereby granted, free of charge, to any person\n"
        self.license = self.catalog.parent / "upstream-MIT.txt"
        self.license.write_bytes(self.text)
        self.record = {
            "files": {"upstream-MIT.txt": {"sha256": hashlib.sha256(self.text).hexdigest(),
                       "sources": ["https://example.invalid/upstream/" + "a" * 40 + "/LICENSE"]}},
            "packages": {"crates.io/example@1.0.0": {"license": "MIT", "vcs_commit": "a" * 40,
                         "license_files": ["upstream-MIT.txt"], "notice_files": []}},
        }
        (self.package / ".cargo_vcs_info.json").write_text(json.dumps({"git": {"sha1": "a" * 40}}), encoding="utf-8")
        self.write_catalog()
        for patcher in (
            mock.patch.object(build_desktop, "NOTICE_CATALOG", self.catalog, create=True),
            mock.patch.object(subprocess, "Popen", side_effect=AssertionError("subprocess forbidden")),
            mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_catalog(self):
        self.catalog.write_text(json.dumps(self.record), encoding="utf-8")

    def entry(self, ecosystem="crates.io", name="example", version="1.0.0", declared="MIT"):
        return build_desktop._declared_entry(ecosystem, name, version, declared, self.package, "desktop")

    def test_missing_text_refuses_unknown_rust_and_npm_packages(self):
        for ecosystem in ("crates.io", "npm"):
            with self.subTest(ecosystem=ecosystem), self.assertRaisesRegex(build_desktop.BuildError, "unknown"):
                self.entry(ecosystem, "unknown")

    def test_notice_only_and_empty_license_do_not_satisfy_text_requirement(self):
        (self.package / "NOTICE").write_text("Some attribution, no license terms", encoding="utf-8")
        with self.assertRaises(build_desktop.BuildError):
            self.entry(name="unknown")
        (self.package / "LICENSE").write_text("\n", encoding="utf-8")
        with self.assertRaises(build_desktop.BuildError):
            self.entry(name="unknown")

    def test_discovered_license_and_notice_are_preserved(self):
        licensed = self.package / "LICENSE"
        notice = self.package / "NOTICE"
        licensed.write_bytes(self.text)
        notice.write_text("upstream attribution", encoding="utf-8")
        self.assertEqual(self.entry().files, [licensed, notice])

    def test_pinned_text_is_copied_into_manifest_and_full_notices(self):
        entry = self.entry()
        self.assertEqual(entry.files, [self.license])
        stage = self.root / "stage"
        placed = bundle.copy_licenses([entry], stage, {})
        self.assertEqual((stage / placed[self.license]).read_bytes(), self.text)
        self.assertIn(self.text.decode().strip(), bundle.notices([], [entry], placed))
        manifest = bundle.manifest(version="1", commit="b" * 40, source_dirty=False, goos="darwin",
                                   goarch="universal", go_version="go1", components=[], entries=[entry], placed=placed)
        self.assertEqual(manifest["third_party"][0]["notices"], [placed[self.license]])

    def test_fallback_cannot_cross_version_license_or_vcs_identity(self):
        for kwargs in ({"version": "1.0.1"}, {"declared": "BSD-2-Clause"}, {"ecosystem": "npm"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(build_desktop.BuildError):
                self.entry(**kwargs)
        (self.package / ".cargo_vcs_info.json").write_text(json.dumps({"git": {"sha1": "c" * 40}}), encoding="utf-8")
        with self.assertRaises(build_desktop.BuildError):
            self.entry()
        (self.package / ".cargo_vcs_info.json").unlink()
        with self.assertRaises(build_desktop.BuildError):
            self.entry()

    def test_missing_or_modified_vendored_text_refuses(self):
        self.license.write_text("modified", encoding="utf-8")
        with self.assertRaises(build_desktop.BuildError):
            self.entry()
        self.license.unlink()
        with self.assertRaises(build_desktop.BuildError):
            self.entry()

    def test_declaration_only_fallback_refuses(self):
        package = self.record["packages"]["crates.io/example@1.0.0"]
        package["notice_files"] = package["license_files"]
        package["license_files"] = []
        self.write_catalog()
        with self.assertRaises(build_desktop.BuildError):
            self.entry()

    def test_fallback_cannot_read_outside_catalog_or_through_symlink(self):
        outside = self.root / "outside.txt"
        outside.write_bytes(self.text)
        self.license.unlink()
        self.license.symlink_to(outside)
        with self.assertRaises(build_desktop.BuildError):
            self.entry()
        self.record["files"]["../outside.txt"] = self.record["files"]["upstream-MIT.txt"]
        self.record["packages"]["crates.io/example@1.0.0"]["license_files"] = ["../outside.txt"]
        self.write_catalog()
        with self.assertRaises(build_desktop.BuildError):
            self.entry()


if __name__ == "__main__":
    unittest.main()
