# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import licenses  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "licenses"


def fixture(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


# The reviewer's fail-open cases: each names or embeds an allowed license but
# is not one.
BUSL = """Business Source License 1.1

Parameters

Licensor:             Example Corp
Licensed Work:        Example Server
Additional Use Grant: None
Change Date:          2030-01-01
Change License:       Apache License, Version 2.0

Terms

The Licensor hereby grants you the right to copy, modify, create derivative
works, redistribute, and make non-production use of the Licensed Work. The
Licensor may make an Additional Use Grant, above, permitting limited production
use. Effective on the Change Date, or the fourth anniversary of the first
publicly available distribution of a specific version of the Licensed Work
under this License, whichever comes first, the Licensor hereby grants you
rights under the terms of the Change License, and the rights granted in the
paragraph above terminate.
"""
APACHE_WITH_GPL_PORTIONS = fixture("apache-2.0.txt") + (
    "\nPortions of this software, in the vendored/ directory, are licensed under\n"
    "the GNU General Public License, version 3 (GPL-3.0).\n"
)
JSON_LICENSE = fixture("mit.txt").replace(
    "The above copyright notice", "The Software shall be used for Good, not Evil.\n\nThe above copyright notice", 1
)


BUILD_INFO = """/tmp/bin/beacon-otelcol: go1.26.2
\tpath\tgithub.com/asymptote-labs/agent-beacon/collector-builder
\tmod\tgithub.com/asymptote-labs/agent-beacon/collector-builder\t(devel)\t
\tdep\tgithub.com/BurntSushi/toml\tv1.4.0\th1:abc=
\tdep\tgithub.com/asymptote-labs/agent-beacon/collector-builder/exporter/beaconjsonexporter\tv0.0.0
\t=>\t./exporter/beaconjsonexporter\t(devel)\t
\tdep\tgolang.org/x/sys\tv0.30.0\th1:def=
\t=>\tgolang.org/x/sys\tv0.31.0\th1:ghi=
\tbuild\t-trimpath=true
\tbuild\tGOOS=linux
"""


class JudgeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def judge(self, **texts):
        paths = {}
        for name, text in texts.items():
            paths[name] = self.root / name
            paths[name].write_text(text, encoding="utf-8")
        verdicts = licenses.judge_files(list(paths.values()))
        return {name: verdicts[path] for name, path in paths.items()}

    def test_allowed_licenses_are_recognized(self):
        cases = {"mit": "MIT", "bsd2": "BSD-2-Clause", "bsd3": "BSD-3-Clause", "apache": "Apache-2.0", "isc": "ISC", "mpl": "MPL-2.0"}
        files = {"mit": "mit.txt", "bsd2": "bsd-2-clause.txt", "bsd3": "bsd-3-clause.txt", "apache": "apache-2.0.txt", "isc": "isc.txt", "mpl": "mpl-2.0.txt"}
        verdicts = self.judge(**{name: fixture(files[name]) for name in cases})
        for name, spdx in cases.items():
            self.assertEqual((verdicts[name].licenses, verdicts[name].problem), ([spdx], None), name)

    def test_composite_texts_keep_every_license(self):
        verdict = self.judge(yaml=fixture("mit-and-apache-2.0.txt"))["yaml"]
        self.assertEqual((verdict.licenses, verdict.problem), (["MIT", "Apache-2.0"], None))
        self.assertEqual(licenses.expression(verdict.licenses), "MIT AND Apache-2.0")
        mixed = self.judge(mixed=fixture("mit.txt") + "\n" + fixture("gpl-3.0.txt"))["mixed"]
        self.assertIn("GPL-3.0", mixed.problem)

    def test_disallowed_and_composite_look_alikes_fail_closed(self):
        verdicts = self.judge(
            gpl=fixture("gpl-3.0.txt"), busl=BUSL, apache_gpl=APACHE_WITH_GPL_PORTIONS, json=JSON_LICENSE,
            noncommercial=fixture("mit.txt") + "\nThis software may be used for non-commercial purposes only.\n",
            unknown="All rights reserved. You may not copy this software.\n",
        )
        for name, verdict in verdicts.items():
            self.assertIsNotNone(verdict.problem, name)

    def test_allowlist(self):
        for spdx in ["MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "MPL-2.0"]:
            self.assertTrue(licenses.allowed(spdx))
        self.assertFalse(licenses.allowed("GPL-3.0"))
        self.assertFalse(licenses.allowed(None))
        self.assertIn("MPL-2.0", licenses.FLAGGED)


class BuildInfoTest(unittest.TestCase):
    def test_parses_main_module_dependencies_and_replacements(self):
        info = licenses.parse_build_info(BUILD_INFO)
        self.assertEqual(info.main, "github.com/asymptote-labs/agent-beacon/collector-builder")
        self.assertEqual(info.go_version, "go1.26.2")
        modules = {module.path: module for module in info.modules}
        self.assertEqual(set(modules), {"github.com/BurntSushi/toml", "github.com/asymptote-labs/agent-beacon/collector-builder/exporter/beaconjsonexporter", "golang.org/x/sys"})
        self.assertEqual(modules["golang.org/x/sys"].source, ("golang.org/x/sys", "v0.31.0"))
        self.assertEqual(modules["github.com/BurntSushi/toml"].source, ("github.com/BurntSushi/toml", "v1.4.0"))
        self.assertTrue(modules["github.com/asymptote-labs/agent-beacon/collector-builder/exporter/beaconjsonexporter"].local)

    def test_module_cache_paths_escape_capitals(self):
        self.assertEqual(licenses.module_cache_dir(Path("/cache"), "github.com/BurntSushi/toml", "v1.4.0"), Path("/cache/github.com/!burnt!sushi/toml@v1.4.0"))


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def module(self, path, version, files):
        root = licenses.module_cache_dir(self.cache, path, version)
        root.mkdir(parents=True)
        for name, text in files.items():
            (root / name).write_text(text, encoding="utf-8")

    def info(self, *modules):
        lines = ["bin: go1.26.2", "\tpath\texample.com/main", "\tmod\texample.com/main\t(devel)\t"]
        lines += [f"\tdep\t{path}\t{version}\th1:x=" for path, version in modules]
        return licenses.parse_build_info("\n".join(lines) + "\n")

    def test_collects_licenses_per_module_and_the_components_using_them(self):
        self.module("golang.org/x/sys", "v0.31.0", {"LICENSE": fixture("bsd-3-clause.txt"), "PATENTS": "Additional IP Rights Grant"})
        self.module("github.com/hashicorp/golang-lru", "v1.0.0", {"LICENSE": fixture("mpl-2.0.txt")})
        self.module("gopkg.in/yaml.v3", "v3.0.1", {"LICENSE": fixture("mit-and-apache-2.0.txt")})
        self.module("github.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve", "v0.0.0-1", {"LICENSE": fixture("mit.txt")})
        entries = licenses.inventory({
            "backplane-companion": self.info(("golang.org/x/sys", "v0.31.0"), ("github.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve", "v0.0.0-1")),
            "beacon-otelcol": self.info(("golang.org/x/sys", "v0.31.0"), ("github.com/hashicorp/golang-lru", "v1.0.0"), ("gopkg.in/yaml.v3", "v3.0.1")),
        }, self.cache)
        by_module = {entry.module: entry for entry in entries}
        self.assertEqual(by_module["golang.org/x/sys"].licenses, ["BSD-3-Clause"])
        self.assertEqual(by_module["golang.org/x/sys"].used_by, ["backplane-companion", "beacon-otelcol"])
        self.assertEqual([path.name for path in by_module["golang.org/x/sys"].files], ["LICENSE", "PATENTS"])
        self.assertEqual(by_module["github.com/hashicorp/golang-lru"].licenses, ["MPL-2.0"])
        self.assertEqual(by_module["github.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve"].licenses, ["MIT"])
        self.assertEqual(by_module["gopkg.in/yaml.v3"].expression, "MIT AND Apache-2.0")

    def test_unknown_or_missing_license_fails(self):
        self.module("example.com/gpl", "v1.0.0", {"LICENSE": fixture("gpl-3.0.txt")})
        self.module("example.com/none", "v1.0.0", {"README.md": "hello"})
        for module in ["example.com/gpl", "example.com/none"]:
            with self.assertRaises(licenses.LicenseError) as raised:
                licenses.inventory({"c": self.info((module, "v1.0.0"))}, self.cache)
            self.assertIn(module, str(raised.exception))

    def test_local_replacements_must_be_beacon(self):
        info = licenses.parse_build_info(BUILD_INFO.replace("github.com/BurntSushi/toml\tv1.4.0\th1:abc=", "example.com/x\tv1\n\t=>\t../x\t(devel)\t"))
        with self.assertRaises(licenses.LicenseError):
            licenses.inventory({"c": info}, self.cache, beacon_license=Path(__file__))


if __name__ == "__main__":
    unittest.main()
