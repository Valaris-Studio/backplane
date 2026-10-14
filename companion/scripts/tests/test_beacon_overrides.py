# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_beacon  # noqa: E402
import build_beacon_otelcol  # noqa: E402
import build_bundle  # noqa: E402
import build_desktop  # noqa: E402
import desktop_payload  # noqa: E402
import licenses  # noqa: E402

SPEC = {"commit": "c" * 40, "archive_sha256": "a" * 64}
LOG = "go.opentelemetry.io/otel/sdk/log"
NET = "golang.org/x/net"
UNLINKED_FLOOR = "go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"


def linked_graph(**overrides):
    """otelcol build info with every declared floor and replacement in effect;
    keyword overrides swap one module's Module entry (None drops it)."""
    modules = {module: licenses.Module(module, version) for module, (version, _) in build_beacon_otelcol.DEPENDENCY_FLOORS.items()}
    for module, (upstream, override) in build_beacon_otelcol.REPLACE_OVERRIDES.items():
        modules[module] = licenses.Module(module, upstream, module, override)
    for key, module in overrides.items():
        path = {"log": LOG, "net": NET, "unlinked": UNLINKED_FLOOR}[key]
        if module is None:
            del modules[path]
        else:
            modules[path] = module
    return licenses.BuildInfo("go1.26.9", "go.opentelemetry.io/collector/cmd/beacon-otelcol", list(modules.values()))


def generated_go_mod(directory, log_replacement="v0.19.0"):
    module = Path(directory) / "beacon-otelcol"
    module.mkdir()
    replaces = "".join(f"replace {path} => {path} {log_replacement if path == LOG else upstream}\n\n"
                       for path, (upstream, _) in build_beacon_otelcol.REPLACE_OVERRIDES.items())
    (module / "go.mod").write_text(f"module go.opentelemetry.io/collector/cmd/beacon-otelcol\n\ngo 1.25.0\n\n{replaces}", encoding="utf-8")
    return module


class DeclaredOverridesTest(unittest.TestCase):
    def test_every_floor_and_replacement_names_the_advisory_or_constraint_it_answers(self):
        for module, (version, reasons) in build_beacon_otelcol.DEPENDENCY_FLOORS.items():
            self.assertRegex(version, r"^v\d+\.\d+\.\d+$", module)
            self.assertTrue(reasons, module)
        for module, (upstream, override) in build_beacon_otelcol.REPLACE_OVERRIDES.items():
            self.assertNotEqual(upstream, override, module)
        self.assertEqual(build_beacon_otelcol.DEPENDENCY_FLOORS[NET][0], "v0.60.0")
        self.assertEqual(build_beacon_otelcol.REPLACE_OVERRIDES[LOG], ("v0.19.0", "v0.21.0"))

    def test_module_versions_compare_semantically(self):
        newer = build_beacon_otelcol.version_at_least
        self.assertTrue(newer("v0.60.0", "v0.60.0"))
        self.assertTrue(newer("v1.18.10", "v1.18.7"))
        self.assertFalse(newer("v0.58.0", "v0.60.0"))
        self.assertFalse(newer("v1.45.0-rc.1", "v1.45.0"))
        self.assertTrue(newer("v1.45.1-0.20260901000000-abcdefabcdef", "v1.45.0"))


class LinkedOverridesTest(unittest.TestCase):
    def test_the_linked_graph_is_recorded_against_each_declaration(self):
        recorded = build_beacon_otelcol.linked_overrides(linked_graph(net=licenses.Module(NET, "v0.61.0")))
        floors = {entry["module"]: entry for entry in recorded["dependency_floors"]}
        self.assertEqual(floors[NET], {"module": NET, "floor": "v0.60.0", "linked": "v0.61.0",
                                       "reasons": build_beacon_otelcol.DEPENDENCY_FLOORS[NET][1]})
        replaces = {entry["module"]: entry for entry in recorded["replace_overrides"]}
        self.assertEqual(replaces[LOG], {"module": LOG, "builder_config": "v0.19.0", "override": "v0.21.0", "linked": "v0.21.0"})
        self.assertEqual(recorded["builder_config"], "collector-builder/builder.yaml (unmodified)")

    def test_a_floor_whose_module_is_not_linked_is_recorded_as_such(self):
        recorded = build_beacon_otelcol.linked_overrides(linked_graph(unlinked=None))
        floors = {entry["module"]: entry for entry in recorded["dependency_floors"]}
        self.assertIsNone(floors[UNLINKED_FLOOR]["linked"])

    def test_a_module_linked_below_its_floor_fails_the_build(self):
        with self.assertRaisesRegex(build_beacon_otelcol.OverrideError, "golang.org/x/net v0.58.0 is below its floor v0.60.0"):
            build_beacon_otelcol.linked_overrides(linked_graph(net=licenses.Module(NET, "v0.58.0")))

    def test_a_replacement_that_did_not_take_effect_fails_the_build(self):
        upstream_only = licenses.Module(LOG, "v0.19.0", LOG, "v0.19.0")
        with self.assertRaisesRegex(build_beacon_otelcol.OverrideError, "sdk/log links v0.19.0, not the override v0.21.0"):
            build_beacon_otelcol.linked_overrides(linked_graph(log=upstream_only))


class ApplyOverridesTest(unittest.TestCase):
    def test_replacements_are_rewritten_before_the_floors_are_resolved(self):
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            module = generated_go_mod(directory)
            with mock.patch.object(build_beacon_otelcol, "run", lambda *command, **_: calls.append(command) or ""):
                build_beacon_otelcol.apply_generated_module_overrides(module, {})
        edits = [call for call in calls if call[:3] == ("go", "mod", "edit")]
        self.assertEqual(len(edits), len(build_beacon_otelcol.REPLACE_OVERRIDES))
        self.assertIn(("go", "mod", "edit", f"-replace={LOG}={LOG}@v0.21.0"), edits)
        get = calls.index(next(call for call in calls if call[:2] == ("go", "get")))
        self.assertGreater(get, max(calls.index(edit) for edit in edits))
        self.assertEqual(sorted(calls[get][2:]), sorted(f"{module}@{version}" for module, (version, _) in build_beacon_otelcol.DEPENDENCY_FLOORS.items()))
        self.assertEqual(calls[get + 1:], [("go", "mod", "tidy")])

    def test_a_builder_config_that_no_longer_pins_the_declared_version_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            module = generated_go_mod(directory, log_replacement="v0.20.0")
            with mock.patch.object(build_beacon_otelcol, "run") as run, \
                    self.assertRaisesRegex(build_beacon_otelcol.OverrideError, "builder.yaml now replaces .*sdk/log with v0.20.0"):
                build_beacon_otelcol.apply_generated_module_overrides(module, {})
            run.assert_not_called()


class ToolchainTest(unittest.TestCase):
    def test_go_releases_at_or_after_the_minimum_are_accepted(self):
        for version in ("go1.26.9", "go1.26.10", "go1.27.0", "go1.27rc1", "go2.0.0"):
            build_beacon.require_go_toolchain(version)

    def test_older_or_unreadable_toolchains_are_refused(self):
        for version in ("go1.26.8", "go1.26.2", "go1.25.12", "go1.26", "devel go1.27-abcdef", ""):
            with self.assertRaisesRegex(build_beacon.ToolchainError, "go1.26.9"):
                build_beacon.require_go_toolchain(version)

    def test_the_standalone_hooks_build_refuses_an_old_toolchain_before_downloading(self):
        environment = json.dumps({"GOOS": "darwin", "GOARCH": "arm64", "GOVERSION": "go1.26.8", "GOROOT": "/go"})
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(build_beacon, "run", return_value=environment), \
                mock.patch.object(build_beacon, "download_source") as download, \
                self.assertRaises(build_beacon.ToolchainError):
            build_beacon.build(Path(directory))
        download.assert_not_called()

    def test_the_standalone_collector_build_refuses_an_old_toolchain_before_downloading(self):
        environment = json.dumps({"GOOS": "darwin", "GOARCH": "arm64", "GOVERSION": "go1.26.8"})
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(build_beacon_otelcol, "run", return_value=environment), \
                mock.patch.object(build_beacon_otelcol, "download_source") as download, \
                self.assertRaises(build_beacon.ToolchainError):
            build_beacon_otelcol.build(Path(directory))
        download.assert_not_called()


class ReleasePathsTest(unittest.TestCase):
    """The bundle and desktop builds with the Go builds replaced by fixed bytes
    and build info, so only the toolchain gate and the manifests are under test."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "LICENSE").write_text("MIT License\n", encoding="utf-8")
        (self.root / "go").mkdir()
        (self.root / "go" / "LICENSE").write_text("BSD\n", encoding="utf-8")
        self.go_version = "go1.26.9"
        self.otelcol_info = linked_graph()

        def built(path, name):
            path.write_bytes(name.encode("ascii"))
            return path

        def read_build_info(binary):
            if binary.name.startswith("beacon-otelcol"):
                return licenses.BuildInfo(self.go_version, self.otelcol_info.main, self.otelcol_info.modules)
            return licenses.BuildInfo(self.go_version, "example.com/" + binary.name)

        patches = [
            mock.patch.object(build_bundle, "build_companion", lambda stage, goos, *_: [built(stage / build_bundle.exe(goos, "backplane-companion"), "companion").name]),
            mock.patch.object(build_bundle, "build_hooks", lambda source, stage, goos, *_: built(stage / "beacon" / build_bundle.exe(goos, "beacon-hooks"), "hooks")),
            mock.patch.object(build_bundle, "build_otelcol", lambda source, stage, goos, *_: built(stage / "beacon" / build_bundle.exe(goos, "beacon-otelcol"), "otelcol")),
            mock.patch.object(licenses, "read_build_info", read_build_info),
            mock.patch.object(licenses, "inventory", lambda *_, **__: []),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def build_target(self):
        return build_bundle.build_target("linux/amd64", self.root / "dist", self.source, None, SPEC, "1.0.0", "d" * 40, False,
                                         self.root / "modcache", self.root / "go")

    def test_a_bundle_built_with_an_old_toolchain_is_refused(self):
        self.go_version = "go1.26.8"
        with self.assertRaisesRegex(build_beacon.ToolchainError, "backplane-companion was built with go1.26.8"):
            self.build_target()

    def test_desktop_payload_binaries_built_with_an_old_toolchain_are_refused(self):
        self.go_version = "go1.26.2"
        with self.assertRaises(build_beacon.ToolchainError):
            desktop_payload.build_go_binaries(self.root / "stage", "linux", "amd64", "1.0.0", "d" * 40, self.source, None)

    def test_the_bundle_otelcol_manifest_discloses_the_overrides_and_keeps_the_pinned_source(self):
        stage, _, _ = self.build_target()
        otelcol = json.loads((stage / "beacon" / "otelcol.json").read_text(encoding="utf-8"))
        hooks = json.loads((stage / "beacon" / "artifact.json").read_text(encoding="utf-8"))
        self.assertEqual((otelcol["source_commit"], otelcol["source_archive_sha256"]), (SPEC["commit"], SPEC["archive_sha256"]))
        self.assertEqual(otelcol["generated_module_overrides"], build_beacon_otelcol.linked_overrides(self.otelcol_info))
        self.assertNotIn("generated_module_overrides", hooks)

    def test_a_bundle_whose_otelcol_misses_a_floor_is_refused(self):
        self.otelcol_info = linked_graph(net=licenses.Module(NET, "v0.58.0"))
        with self.assertRaises(build_beacon_otelcol.OverrideError):
            self.build_target()

    def test_desktop_payload_and_mac_contents_disclose_the_overrides(self):
        overrides = build_beacon_otelcol.linked_overrides(self.otelcol_info)
        binaries = {}
        for name in ("backplane-companion", "beacon-hooks", "beacon-otelcol"):
            binaries[name] = self.root / "bin" / name
            binaries[name].parent.mkdir(exist_ok=True)
            binaries[name].write_bytes(name.encode("ascii"))
        payload = desktop_payload.stage_payload(self.root / "payload", binaries, SPEC, "go1.26.9", "linux", "amd64", otelcol_overrides=overrides)
        contents = build_desktop.stage_contents(self.root / "Contents", binaries, SPEC, "go1.26.9", lambda paths: None, otelcol_overrides=overrides)
        for manifest in (payload / "beacon" / "otelcol.json", contents / "Resources" / "beacon" / "otelcol.json"):
            self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["generated_module_overrides"], overrides, manifest)


if __name__ == "__main__":
    unittest.main()
