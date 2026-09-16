# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WS3: setup_contract — the board-provisioning contract derived from a pipeline_config.

The contract makes board setup machine-readable: which COLUMNS (+types) a board
needs, the LABEL vocabulary each role applies/removes/gates on, and a prose
role-orchestration overview. `build_setup_contract` DERIVES it from the live
config (never hardcoded) so it can't drift from the actual discover/lifecycle
predicates. A drift validator (appended to validate_pipeline_config) catches a
hand-authored contract that omits a label/column the config actually uses.

Expectations are pinned against the shipped DEFAULT_PIPELINE_CONFIG (the promoted
6-role production pipeline) so the test doubles as a regression fence on the default.
"""

from __future__ import annotations

import copy

from app.services.pipeline_config_validation import validate_pipeline_config
from app.services.setup_contract import build_setup_contract
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


# The 6-role default's actual label vocabulary. NOTE: `rework-brief-ready` was
# REMOVED in the hardening fixes (the freshness gate replaced it) — the contract
# must reflect the live config, not the stale production-run extraction.
EXPECTED_LABELS = {
    "planned",
    "planning-failed",
    "direct-implement",
    "needs-ui-validation",
    "ui-validated",
    "rework-mediation-failed",
    # Cell #3 loop-breaker: the reviewer parks a card whose review_diff LLM step
    # failed with `review-failed` (now applied on the fail path + excluded by the
    # reviewer discover, mirroring planning-failed / rework-mediation-failed).
    "review-failed",
    "documented",
    # run-B FIX #5: the runner's no-change backstop parks a card by
    # applying `blocked`; every build role excludes it so the park is
    # column-independent.
    "blocked",
    # run-B FIX #3 sibling: the runner's approval park-and-continue
    # applies `awaiting-approval` while a human approval is pending; same
    # intrinsic-park exclusion contract as `blocked`.
    "awaiting-approval",
    # A1b no-op-loop cure: the implementer/planner park a card they can't close
    # cleanly with `needs-reconcile` (excluded by build roles, included by
    # board_reconciler); a superseded duplicate is closed with `superseded`.
    "needs-reconcile",
    "superseded",
    # FCH-1 loop-breaker: board_reconciler parks a card whose decide_disposition
    # LLM step failed with `reconciliation-failed` (applied on its fail path +
    # excluded by its own discover, mirroring review-failed / planning-failed /
    # rework-mediation-failed for the 7th role the catalog missed).
    "reconciliation-failed",
}
EXPECTED_COLUMN_TYPES = {"backlog", "active", "review", "done"}
# Contract orders roles by scheduler priority_order (the walk order), NOT stage
# declaration order — reviewer runs first so a finished card clears before new work.
EXPECTED_ROLES = [
    "reviewer",
    "rework_mediator",
    "implementer",
    "planner",
    "documentator",
    "ui_validator",
    "board_reconciler",
]


def test_extract_setup_contract_from_default_config():
    """build_setup_contract on the shipped default yields the right columns,
    labels, and role orchestration — derived, not hardcoded."""
    contract = build_setup_contract(DEFAULT_PIPELINE_CONFIG)
    d = contract.to_dict()

    assert {c["column_type"] for c in d["columns"]} == EXPECTED_COLUMN_TYPES
    assert {label["name"] for label in d["labels"]} == EXPECTED_LABELS
    assert [r["role"] for r in d["role_orchestration"]] == EXPECTED_ROLES
    assert isinstance(d["prose_overview"], str) and d["prose_overview"]


def test_setup_contract_columns_in_board_layout_order():
    """Columns are positioned in canonical board layout order (backlog→done),
    NOT scheduler priority order — a board reads left-to-right."""
    contract = build_setup_contract(DEFAULT_PIPELINE_CONFIG)
    cols = contract.to_dict()["columns"]
    assert [c["column_type"] for c in cols] == ["backlog", "active", "review", "done"]
    assert [c["position"] for c in cols] == [0, 1, 2, 3]


def test_setup_contract_does_not_invent_removed_label():
    """The removed `rework-brief-ready` label must NOT appear in the contract —
    proves the contract derives from live config, not the stale design extraction."""
    contract = build_setup_contract(DEFAULT_PIPELINE_CONFIG)
    names = {label["name"] for label in contract.to_dict()["labels"]}
    assert "rework-brief-ready" not in names


def test_setup_contract_label_applies_and_removes_roles():
    """Each label records which role applies it (apply_label) and removes it
    (remove_label), derived from lifecycle steps."""
    contract = build_setup_contract(DEFAULT_PIPELINE_CONFIG)
    by_name = {label["name"]: label for label in contract.to_dict()["labels"]}

    # planner applies 'planned'
    assert by_name["planned"]["applies_in_role"] == "planner"
    # ui_validator applies 'ui-validated' and removes 'needs-ui-validation'
    assert by_name["ui-validated"]["applies_in_role"] == "ui_validator"
    assert by_name["needs-ui-validation"]["removes_in_role"] == "ui_validator"


def test_setup_contract_label_gated_by_roles():
    """gated_by_roles lists every role whose discover filters reference the label
    (require/include/exclude)."""
    contract = build_setup_contract(DEFAULT_PIPELINE_CONFIG)
    by_name = {label["name"]: label for label in contract.to_dict()["labels"]}

    # needs-ui-validation is excluded by build roles and included by ui_validator.
    gated = set(by_name["needs-ui-validation"]["gated_by_roles"])
    assert {"implementer", "reviewer", "rework_mediator", "ui_validator"} <= gated


def test_setup_contract_role_order_reflects_scheduler():
    """role_orchestration ordering follows scheduling.priority_order, not stage
    declaration order."""
    contract = build_setup_contract(DEFAULT_PIPELINE_CONFIG)
    order = [r["role"] for r in contract.to_dict()["role_orchestration"]]
    priority = DEFAULT_PIPELINE_CONFIG["scheduling"]["priority_order"]
    assert order == priority


def test_setup_contract_serialization_idempotent():
    """build → to_dict is stable: a second build of the same config is identical."""
    a = build_setup_contract(DEFAULT_PIPELINE_CONFIG).to_dict()
    b = build_setup_contract(DEFAULT_PIPELINE_CONFIG).to_dict()
    assert a == b


def test_setup_contract_absent_passes_validation():
    """A config WITHOUT setup_contract validates fine — the field is optional."""
    config = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    config.pop("setup_contract", None)
    errors = [e for e in validate_pipeline_config(config) if e["severity"] == "error"]
    assert errors == []


def test_setup_contract_self_consistent_passes_validation():
    """A config carrying the auto-derived contract has zero drift → validates."""
    config = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    config["setup_contract"] = build_setup_contract(config).to_dict()
    errors = [
        e
        for e in validate_pipeline_config(config)
        if e["severity"] == "error"
        and e["code"].startswith("setup_contract")
    ]
    assert errors == []


def test_setup_contract_drift_missing_label_errors():
    """A hand-authored contract that omits a label used in discover/lifecycle
    raises setup_contract_label_drift."""
    config = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    contract = build_setup_contract(config).to_dict()
    # Drop the 'planned' label the planner applies + the implementer-era flow gates.
    contract["labels"] = [
        label for label in contract["labels"] if label["name"] != "planned"
    ]
    config["setup_contract"] = contract

    errors = validate_pipeline_config(config)
    drift = [e for e in errors if e["code"] == "setup_contract_label_drift"]
    assert len(drift) == 1
    assert "planned" in drift[0]["value"]


def test_setup_contract_drift_missing_column_errors():
    """A contract omitting a column_type a stage discovers in raises
    setup_contract_column_drift."""
    config = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    contract = build_setup_contract(config).to_dict()
    contract["columns"] = [c for c in contract["columns"] if c["column_type"] != "done"]
    config["setup_contract"] = contract

    errors = validate_pipeline_config(config)
    drift = [e for e in errors if e["code"] == "setup_contract_column_drift"]
    assert len(drift) == 1
    assert "done" in drift[0]["value"]


def test_setup_contract_invalid_shape_errors():
    """A non-object setup_contract raises invalid_setup_contract (not a crash)."""
    config = copy.deepcopy(DEFAULT_PIPELINE_CONFIG)
    config["setup_contract"] = ["not", "an", "object"]
    errors = validate_pipeline_config(config)
    assert any(e["code"] == "invalid_setup_contract" for e in errors)


def test_setup_contract_prose_carries_board_composition_rule():
    """P4 (post-run-B 2026-06-10): the setup contract is the bootstrap
    surface, so it must carry the board-composition rule — every board needs a
    final acceptance card (ACCEPT- prefix, SMOKE- per milestone on long
    boards) dependency-gated on all siblings with an artifact-level Done
    condition. White-label: keyed on board structure, names no project."""
    contract = build_setup_contract(DEFAULT_PIPELINE_CONFIG)
    prose = contract.prose_overview
    assert "ACCEPT-" in prose
    assert "SMOKE-" in prose
    assert "bulk_set_card_dependencies" in prose
    assert "composition root" in prose
    # The rule must also survive serialization (it travels with WS2 bundles).
    assert "ACCEPT-" in contract.to_dict()["prose_overview"]
