# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""License inventory for the Go modules linked into a binary.

The module list comes from the binary itself (`go version -m`), so it is
exactly what was linked for that target; license texts come from the module
cache and are identified by github.com/google/licensecheck (the Go helper in
licensecheck/). A module whose license is missing, unrecognized, restrictive
or not on the allowlist fails the build instead of shipping unreviewed.
"""

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

ALLOWED = {"MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "MPL-2.0"}
# Allowed, but with an obligation worth stating next to the notice.
FLAGGED = {
    "MPL-2.0": "file-level copyleft: the module is shipped unmodified, and its source "
    "is available at the listed module version",
}
BEACON_PREFIX = "github.com/asymptote-labs/agent-beacon/"

# Files that carry the license itself, judged; notices ride along as-is.
_LICENSE_NAMES = ("LICENSE", "LICENCE", "COPYING")
_NOTICE_NAMES = ("NOTICE", "PATENTS")

# A license file passes only when the matched licenses cover at least this
# share of it (pkg.go.dev uses 75%); the lowest linked module, yaml.v3, is 85%.
COVERAGE_THRESHOLD = 80.0
# Restrictive terms that must not appear outside a matched license text. They
# are not searched inside a match because MPL-2.0 itself names the GPL family.
_DENYLIST = re.compile(
    r"\b(?:a|l)?gpl\b|general public license|business source license|\bbusl\b|server side public license|\bsspl\b"
    r"|commons clause|good,? not evil|elastic license|non-?commercial",
    re.IGNORECASE,
)
_HELPER = Path(__file__).resolve().parent / "licensecheck"


class LicenseError(RuntimeError):
    pass


def allowed(spdx):
    return spdx in ALLOWED


def expression(ids):
    return " AND ".join(ids)


@dataclass
class Verdict:
    # SPDX ids in order of first appearance.
    licenses: list[str]
    # Why the file fails, or None when it passes.
    problem: str | None


def _scan(paths):
    """licensecheck's findings per path, from the pinned Go helper."""
    output = subprocess.run(
        ["go", "run", "."], cwd=_HELPER, input=json.dumps([str(path) for path in paths]), capture_output=True, encoding="utf-8",
        env=dict(os.environ, GOFLAGS="-mod=readonly", GOTOOLCHAIN="local"), check=True,
    ).stdout
    return {Path(report["path"]): report for report in json.loads(output)}


def _judge(text, report):
    ids = []
    for match in report["matches"]:
        if match["id"] not in ids:
            ids.append(match["id"])
    uncovered, position = [], 0
    for match in sorted(report["matches"], key=lambda item: item["start"]):
        uncovered.append(text[position:match["start"]])
        position = max(position, match["end"])
    uncovered.append(text[position:])
    disallowed = [spdx for spdx in ids if not allowed(spdx)]
    if disallowed:
        return Verdict(ids, f"{', '.join(disallowed)} is not on the allowlist")
    restrictive = _DENYLIST.search("".join(uncovered))
    if restrictive:
        return Verdict(ids, f"restrictive terms outside the license text ({restrictive.group(0)!r})")
    if not ids or report["percent"] < COVERAGE_THRESHOLD:
        return Verdict(ids, f"only {report['percent']:.0f}% is a recognized license")
    return Verdict(ids, None)


def judge_files(paths):
    """A verdict per license file; unknown, restrictive or mixed texts fail
    closed."""
    paths = [Path(path) for path in paths]
    reports = _scan(paths) if paths else {}
    # licensecheck reports byte offsets, so the text is sliced as bytes.
    return {path: _judge(path.read_bytes().decode("latin-1"), reports[path]) for path in paths}


@dataclass
class Module:
    path: str
    version: str
    replace_path: str | None = None
    replace_version: str | None = None

    @property
    def local(self):
        return self.replace_path is not None and (self.replace_path.startswith((".", "/")) or self.replace_version in (None, "", "(devel)"))

    @property
    def source(self):
        """The module whose code was linked: the replacement when there is one."""
        if self.replace_path and not self.local:
            return self.replace_path, self.replace_version
        return self.path, self.version


@dataclass
class BuildInfo:
    go_version: str
    main: str
    modules: list[Module] = field(default_factory=list)


def parse_build_info(text):
    """Parse `go version -m` output for one binary."""
    lines = text.splitlines()
    go_version = lines[0].rsplit(" ", 1)[-1] if lines else ""
    info = BuildInfo(go_version=go_version, main="")
    for line in lines[1:]:
        fields = line.strip("\n").lstrip("\t").split("\t")
        kind = fields[0]
        if kind == "mod":
            info.main = fields[1]
        elif kind == "dep":
            info.modules.append(Module(fields[1], fields[2] if len(fields) > 2 else ""))
        elif kind == "=>" and info.modules:
            info.modules[-1].replace_path = fields[1]
            info.modules[-1].replace_version = fields[2] if len(fields) > 2 else None
    return info


def read_build_info(binary):
    return parse_build_info(subprocess.check_output(["go", "version", "-m", str(binary)], encoding="utf-8"))


def _escape(path):
    # The module cache spells each capital letter as "!" + its lowercase.
    return re.sub(r"[A-Z]", lambda match: "!" + match.group(0).lower(), path)


def module_cache_dir(gomodcache, path, version):
    return Path(gomodcache) / (_escape(path) + "@" + _escape(version))


@dataclass
class Entry:
    module: str
    version: str
    # Every license the module's files carry, so a dual-licensed module reads
    # as the SPDX expression "MIT AND Apache-2.0".
    licenses: list[str]
    files: list[Path]
    used_by: list[str]

    @property
    def expression(self):
        return expression(self.licenses)


def _license_files(root):
    if not root.is_dir():
        return [], []
    names = sorted(child for child in root.iterdir() if child.is_file())
    licensed = [path for path in names if path.name.upper().startswith(_LICENSE_NAMES)]
    notices = [path for path in names if path.name.upper().startswith(_NOTICE_NAMES)]
    return licensed, notices


def _module_files(module, gomodcache, beacon_license):
    path, version = module.source
    if module.local:
        if not module.path.startswith(BEACON_PREFIX) or beacon_license is None:
            raise LicenseError(f"{module.path}: replaced by a local directory outside Beacon; its license cannot be established")
        return version or "(devel)", [Path(beacon_license)], []
    licensed, notices = _license_files(module_cache_dir(gomodcache, path, version))
    if not licensed:
        raise LicenseError(f"{module.path}@{version}: no license file in the module cache")
    return version, licensed, notices


def inventory(infos, gomodcache, beacon_license=None):
    """One entry per linked module across the named binaries, sorted by
    module. Every license file of every module must pass."""
    modules = {}
    for component, info in sorted(infos.items()):
        for module in sorted(info.modules, key=lambda item: item.path):
            key = (module.path, module.source[1])
            if key not in modules:
                version, licensed, notices = _module_files(module, gomodcache, beacon_license)
                modules[key] = {"module": module, "version": version, "licensed": licensed, "notices": notices, "used_by": []}
            modules[key]["used_by"].append(component)
    verdicts = judge_files(sorted({path for found in modules.values() for path in found["licensed"]}))
    entries = []
    for key in sorted(modules):
        found = modules[key]
        ids = []
        for license_file in found["licensed"]:
            verdict = verdicts[license_file]
            if verdict.problem:
                raise LicenseError(f"{found['module'].path}@{found['version']}: {license_file.name}: {verdict.problem}")
            ids += [spdx for spdx in verdict.licenses if spdx not in ids]
        entries.append(Entry(found["module"].path, found["version"], ids, found["licensed"] + found["notices"], found["used_by"]))
    return entries
