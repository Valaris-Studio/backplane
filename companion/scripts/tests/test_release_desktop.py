# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import io
import json
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import release_desktop  # noqa: E402

VERSION = "0.2.0"
SIGNATURE = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ=="
PUBLIC = "https://storage.googleapis.com/backplane-artifacts/companion-desktop"
BUCKET = "gs://backplane-artifacts/companion-desktop"
ARCHIVE_URL = f"{PUBLIC}/v{VERSION}/Backplane-Companion-{VERSION}-universal.app.tar.gz"
RELEASE_PROJECT = "release-project"
RELEASE_ENVIRONMENT = {release_desktop.PROJECT_VARIABLE: RELEASE_PROJECT}


class FakeRunner:
    """Records every command; answers gcloud like an empty release bucket."""

    def __init__(self, project=RELEASE_PROJECT, existing_release=False, published_manifest=None):
        self.commands = []
        self.project = project
        self.existing_release = existing_release
        self.published_manifest = published_manifest

    def __call__(self, *command):
        self.commands.append(list(command))
        if command[:4] == ("gcloud", "config", "get-value", "project"):
            return 0, self.project + "\n"
        if command[:3] == ("gcloud", "storage", "ls"):
            return (0, f"{BUCKET}/v{VERSION}/x\n") if self.existing_release else (1, "")
        if command[0] == "curl" and "-I" not in command:
            return 0, self.published_manifest or ""
        return 0, ""

    def cloud_commands(self):
        return [command for command in self.commands if command[0] in ("gcloud", "gsutil")]


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dist = Path(directory.name) / "dist"
        self.built_with = None

    def fake_build(self, arguments):
        self.built_with = arguments
        self.dist.mkdir(parents=True, exist_ok=True)
        app = self.dist / "Backplane Companion.app"
        app.mkdir(exist_ok=True)
        dmg = self.dist / f"Backplane Companion_{VERSION}_universal.dmg"
        dmg.write_bytes(b"dmg")
        archive = self.dist / "Backplane Companion.app.tar.gz"
        archive.write_bytes(b"archive")
        signature = self.dist / "Backplane Companion.app.tar.gz.sig"
        signature.write_text(SIGNATURE + "\n", encoding="utf-8")
        return {"app": str(app), "dmg": str(dmg), "version": arguments.version, "updater_archive": str(archive),
                "updater_signature": str(signature), "signing": "developer_id", "notarization": "skipped"}

    def release(self, argv, runner, environ=RELEASE_ENVIRONMENT):
        arguments = release_desktop.parse_arguments(argv + ["--output", str(self.dist)])
        output = io.StringIO()
        with redirect_stdout(output), mock.patch.object(release_desktop, "utc_now", lambda: "2026-09-28T12:00:00Z"):
            plan = release_desktop.release(arguments, run=runner, build=self.fake_build, environ=environ)
        return plan, output.getvalue()

    def test_parse_arguments_defaults_to_a_stable_dry_run(self):
        arguments = release_desktop.parse_arguments([VERSION])
        self.assertEqual(arguments.channel, "stable")
        self.assertFalse(arguments.publish)

    def test_parse_arguments_refuses_an_unknown_channel_or_a_v_prefix(self):
        for argv in ([VERSION, "--channel", "nightly"], ["v0.2.0"], ["0.2"], ["latest"]):
            with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
                release_desktop.parse_arguments(argv)

    def test_latest_manifest_lists_both_darwin_architectures_with_the_signature(self):
        manifest = release_desktop.latest_manifest(VERSION, "Fixes", "2026-09-28T12:00:00Z", ARCHIVE_URL, SIGNATURE + "\n")
        self.assertEqual(set(manifest), {"version", "notes", "pub_date", "platforms"})
        self.assertEqual(manifest["version"], VERSION)
        self.assertEqual(manifest["notes"], "Fixes")
        self.assertEqual(manifest["pub_date"], "2026-09-28T12:00:00Z")
        self.assertEqual(set(manifest["platforms"]), {"darwin-aarch64", "darwin-x86_64"})
        for platform in manifest["platforms"].values():
            self.assertEqual(platform, {"url": ARCHIVE_URL, "signature": SIGNATURE})

    def test_latest_manifest_refuses_an_empty_signature(self):
        with self.assertRaises(release_desktop.ReleaseError):
            release_desktop.latest_manifest(VERSION, "", "2026-09-28T12:00:00Z", ARCHIVE_URL, "  \n")

    def test_release_builds_signed_notarized_updater_artifacts(self):
        self.release([VERSION], FakeRunner())
        self.assertTrue(self.built_with.sign)
        self.assertTrue(self.built_with.updater_artifacts)
        self.assertFalse(self.built_with.skip_notarize)
        self.assertEqual(self.built_with.version, VERSION)

    def test_release_passes_skip_notarize_through(self):
        self.release([VERSION, "--skip-notarize"], FakeRunner())
        self.assertTrue(self.built_with.skip_notarize)

    def test_release_refuses_to_publish_an_unnotarized_build(self):
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            release_desktop.parse_arguments([VERSION, "--skip-notarize", "--publish"])

    def test_release_without_publish_calls_no_cloud_tool(self):
        runner = FakeRunner()
        plan, output = self.release([VERSION, "--channel", "beta"], runner)
        self.assertEqual(runner.cloud_commands(), [])
        self.assertFalse([command for command in runner.commands if command[0] == "curl"])
        self.assertIn(f"{BUCKET}/beta/latest.json", output)
        self.assertIn(ARCHIVE_URL, output)
        self.assertIn("Dry run", output)
        manifest = json.loads((self.dist / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["platforms"]["darwin-aarch64"]["signature"], SIGNATURE)
        self.assertEqual(plan.manifest, manifest)

    def test_release_plan_uploads_versioned_files_then_the_channel_manifest_uncached(self):
        plan, _ = self.release([VERSION], FakeRunner())
        destinations = [upload.destination for upload in plan.uploads]
        self.assertEqual(destinations, [
            f"{BUCKET}/v{VERSION}/Backplane-Companion-{VERSION}-universal.app.tar.gz",
            f"{BUCKET}/v{VERSION}/Backplane-Companion-{VERSION}-universal.app.tar.gz.sig",
            f"{BUCKET}/v{VERSION}/Backplane-Companion-{VERSION}-universal.dmg",
            f"{BUCKET}/v{VERSION}/latest.json",
            f"{BUCKET}/stable/latest.json",
        ])
        self.assertEqual(plan.uploads[-1].cache_control, "no-cache, max-age=0")
        for upload in plan.uploads:
            self.assertNotIn(" ", upload.destination)
            self.assertTrue(Path(upload.source).is_file(), upload.source)

    def test_release_publish_uploads_the_channel_manifest_last_with_no_cache(self):
        manifest = release_desktop.latest_manifest(VERSION, f"Backplane Companion {VERSION}", "2026-09-28T12:00:00Z",
                                                   ARCHIVE_URL, SIGNATURE)
        runner = FakeRunner(published_manifest=release_desktop.manifest_text(manifest))
        self.release([VERSION, "--publish"], runner)
        uploads = [command for command in runner.commands if command[:3] == ["gcloud", "storage", "cp"]]
        self.assertEqual(uploads[-1][-1], f"{BUCKET}/stable/latest.json")
        self.assertIn("--cache-control=no-cache, max-age=0", uploads[-1])
        for upload in uploads[:-1]:
            self.assertFalse(upload[-1].endswith("/latest.json") and "/v" not in upload[-1], upload)
        after_last_upload = runner.commands[runner.commands.index(uploads[-1]):]
        self.assertTrue(any(command[0] == "curl" for command in after_last_upload))

    def test_release_publish_refuses_the_wrong_gcloud_project(self):
        runner = FakeRunner(project="some-other-project")
        with self.assertRaisesRegex(release_desktop.ReleaseError, re.escape(RELEASE_PROJECT)):
            self.release([VERSION, "--publish"], runner)
        self.assertFalse([command for command in runner.commands if command[:3] == ["gcloud", "storage", "cp"]])

    def test_release_publish_refuses_to_start_without_the_release_project(self):
        for environ in ({}, {release_desktop.PROJECT_VARIABLE: "  "}):
            runner = FakeRunner()
            with self.assertRaisesRegex(release_desktop.ReleaseError, release_desktop.PROJECT_VARIABLE):
                self.release([VERSION, "--publish"], runner, environ=environ)
            self.assertIsNone(self.built_with)
            self.assertEqual(runner.commands, [])

    def test_dry_run_needs_no_release_project(self):
        plan, _ = self.release([VERSION], FakeRunner(), environ={})
        self.assertTrue(plan.uploads)

    def test_release_publish_never_overwrites_a_published_version(self):
        runner = FakeRunner(existing_release=True)
        with self.assertRaisesRegex(release_desktop.ReleaseError, "already published"):
            self.release([VERSION, "--publish"], runner)
        self.assertFalse([command for command in runner.commands if command[:3] == ["gcloud", "storage", "cp"]])

    def test_release_publish_fails_when_the_live_manifest_differs(self):
        runner = FakeRunner(published_manifest="{}")
        with self.assertRaisesRegex(release_desktop.ReleaseError, "latest.json"):
            self.release([VERSION, "--publish"], runner)


if __name__ == "__main__":
    unittest.main()
