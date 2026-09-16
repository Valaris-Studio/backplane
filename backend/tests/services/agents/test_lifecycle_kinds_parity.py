# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Parity contract between Python LIFECYCLE_KINDS and Go lifecycle.Kinds.

Both sides must agree on the closed set of kind names and on the
produces_decision / terminal flags for each kind. Drift means the runner's
walker (lane A.2) and the backend's validator disagree on what shape a
pipeline_config can take — silent misroutes.

The Go side is parsed via stdlib regex so this test runs without the Go
toolchain in the venv.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.services.agents.lifecycle_kinds import LIFECYCLE_KINDS

_GO_KINDS_FILE = (
    Path(__file__).resolve().parents[4]
    / "runner"
    / "internal"
    / "lifecycle"
    / "kinds.go"
)

# Matches one map entry, e.g.
#     "discover": {Name: "discover", ProducesDecision: false, Terminal: false},
_GO_ENTRY = re.compile(
    r'"(?P<key>[a-z_]+)":\s*\{'
    r"Name:\s*\"(?P<name>[a-z_]+)\",\s*"
    r"ProducesDecision:\s*(?P<produces>true|false),\s*"
    r"Terminal:\s*(?P<terminal>true|false)"
    r"\s*\}",
)


def _parse_go_kinds() -> dict[str, dict]:
    text = _GO_KINDS_FILE.read_text()
    parsed: dict[str, dict] = {}
    for match in _GO_ENTRY.finditer(text):
        key = match.group("key")
        parsed[key] = {
            "name": match.group("name"),
            "produces_decision": match.group("produces") == "true",
            "terminal": match.group("terminal") == "true",
        }
    return parsed


def test_go_kinds_file_exists():
    assert _GO_KINDS_FILE.is_file(), (
        f"expected Go mirror at {_GO_KINDS_FILE}; lane A.1 must ship it"
    )


def test_kind_name_sets_match():
    go_kinds = _parse_go_kinds()
    py_names = set(LIFECYCLE_KINDS.keys())
    go_names = set(go_kinds.keys())

    missing_in_go = sorted(py_names - go_names)
    missing_in_py = sorted(go_names - py_names)
    assert not missing_in_go and not missing_in_py, (
        f"lifecycle kind drift — missing in Go: {missing_in_go}; "
        f"missing in Python: {missing_in_py}"
    )


def test_kind_name_field_matches_map_key():
    go_kinds = _parse_go_kinds()
    for key, entry in go_kinds.items():
        assert entry["name"] == key, (
            f"Go Kinds[{key!r}].Name = {entry['name']!r} (must equal map key)"
        )


def test_produces_decision_flags_match():
    go_kinds = _parse_go_kinds()
    mismatches = []
    for name, schema in LIFECYCLE_KINDS.items():
        py_flag = schema["produces_decision"]
        go_flag = go_kinds[name]["produces_decision"]
        if py_flag != go_flag:
            mismatches.append(
                f"{name}: python.produces_decision={py_flag}, go={go_flag}"
            )
    assert not mismatches, "produces_decision drift: " + "; ".join(mismatches)


def test_terminal_flags_match():
    go_kinds = _parse_go_kinds()
    mismatches = []
    for name, schema in LIFECYCLE_KINDS.items():
        py_flag = schema["terminal"]
        go_flag = go_kinds[name]["terminal"]
        if py_flag != go_flag:
            mismatches.append(f"{name}: python.terminal={py_flag}, go={go_flag}")
    assert not mismatches, "terminal drift: " + "; ".join(mismatches)
