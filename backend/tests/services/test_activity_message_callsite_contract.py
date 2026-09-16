# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Drift guard for localized, system-authored activity callsites."""

import ast
import json
from collections.abc import Iterator
from pathlib import Path


SERVICES_ROOT = Path(__file__).resolve().parents[2] / "app" / "services"
REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_PATH = (
    REPO_ROOT
    / "frontend"
    / "src"
    / "features"
    / "activity"
    / "activity-message-contract.json"
)
ALLOWED_PARAM_TYPES = {
    "boolean",
    "nullable_string",
    "number",
    "string",
    "string_array",
}
SENSITIVE_OR_NARRATIVE_PARAMS = {
    "body",
    "content",
    "cookie",
    "description",
    "message",
    "password",
    "prompt",
    "reason",
    "secret",
    "summary",
    "token",
}


def _contract() -> dict[str, dict]:
    return json.loads(CONTRACT_PATH.read_text())


def _call_label(path: Path, call: ast.Call) -> str:
    return f"{path.relative_to(SERVICES_ROOT)}:{call.lineno}"


def _activity_calls() -> Iterator[tuple[Path, ast.Call]]:
    for path in SERVICES_ROOT.rglob("*.py"):
        if path.name == "activity.py":
            continue
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(
                node.func, ast.Attribute
            ):
                continue
            if node.func.attr not in {"record", "_record_activity"}:
                continue
            keywords = {keyword.arg for keyword in node.keywords}
            if "summary" in keywords:
                yield path, node


def _keywords(call: ast.Call) -> dict[str, ast.expr]:
    return {
        keyword.arg: keyword.value
        for keyword in call.keywords
        if keyword.arg is not None
    }


def _literal_strings(node: ast.expr) -> set[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return {node.value}
    if isinstance(node, ast.IfExp):
        return _literal_strings(node.body) | _literal_strings(node.orelse)
    return set()


def _literal_dict_keys(node: ast.expr) -> set[str] | None:
    if isinstance(node, ast.Constant) and node.value is None:
        return set()
    if isinstance(node, ast.Dict):
        keys: set[str] = set()
        for key in node.keys:
            if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                return None
            keys.add(key.value)
        return keys
    if isinstance(node, ast.IfExp):
        body = _literal_dict_keys(node.body)
        orelse = _literal_dict_keys(node.orelse)
        if body is None or orelse is None:
            return None
        return body | orelse
    return None


def test_every_product_activity_record_with_summary_declares_structured_fields():
    calls = list(_activity_calls())
    direct_calls = [call for _, call in calls if call.func.attr == "record"]
    helper_calls = [call for _, call in calls if call.func.attr == "_record_activity"]

    # Pins the audited surface so a new callsite cannot slip through silently.
    assert len(direct_calls) == 66
    assert len(helper_calls) == 9
    missing = []
    for path, call in calls:
        keywords = set(_keywords(call))
        absent = {"message_key", "message_params"} - keywords
        if absent:
            missing.append(f"{_call_label(path, call)} missing {sorted(absent)}")
    assert not missing, "\n".join(missing)


def test_backend_keys_and_param_names_match_the_shared_frontend_contract_exactly():
    contract = _contract()
    actual_param_sets: dict[str, set[frozenset[str]]] = {}
    unresolved = []

    for path, call in _activity_calls():
        keywords = _keywords(call)
        message_keys = _literal_strings(keywords["message_key"])
        if not message_keys:
            # The dependencies helper forwards a key already audited at each
            # literal caller; it does not introduce another contract entry.
            continue

        param_names = _literal_dict_keys(keywords["message_params"])
        if param_names is None:
            unresolved.append(
                f"{_call_label(path, call)} message_params must be a literal dict"
            )
            continue
        for key in message_keys:
            actual_param_sets.setdefault(key, set()).add(frozenset(param_names))

    assert not unresolved, "\n".join(unresolved)
    assert set(actual_param_sets) == set(contract)

    mismatches = []
    for key, observed_sets in actual_param_sets.items():
        expected = frozenset(contract[key]["params"])
        if observed_sets != {expected}:
            mismatches.append(
                f"{key}: expected {sorted(expected)}, observed "
                f"{[sorted(values) for values in observed_sets]}"
            )
    assert not mismatches, "\n".join(mismatches)


def test_shared_contract_contains_only_data_params_and_valid_plural_metadata():
    violations = []
    for key, entry in _contract().items():
        params = entry.get("params")
        if not isinstance(params, dict):
            violations.append(f"{key}: params must be an object")
            continue

        for name, param_type in params.items():
            if name in SENSITIVE_OR_NARRATIVE_PARAMS:
                violations.append(f"{key}: unsafe or narrative param {name!r}")
            if param_type not in ALLOWED_PARAM_TYPES:
                violations.append(f"{key}: unsupported type {param_type!r} for {name}")

        plural_param = entry.get("pluralParam")
        if plural_param is not None and params.get(plural_param) != "number":
            violations.append(f"{key}: pluralParam must name a numeric contract param")

    assert not violations, "\n".join(violations)
