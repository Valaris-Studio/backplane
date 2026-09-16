# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`skills_setup` lifecycle kind + default-pipeline wiring (Skills Registry W3).

The runner materializes a board's effective skills before the LLM runs, so:

  - LIFECYCLE_KINDS gains "skills_setup" (non-decision, non-terminal, with a
    params_schema — the closed-registry contract; Go mirror lands in the same
    commit via runner/internal/lifecycle/kinds.go, covered by the existing
    parity test, deliberately NOT re-tested here).
  - Every default-pipeline role that prepares a working tree (git_setup) also
    materializes skills: git_setup's `next` now points at a skills_setup step,
    and that step's `next` reaches the llm step git_setup previously targeted.
"""

from __future__ import annotations

from app.services.agents.lifecycle_kinds import KIND_DOCS, LIFECYCLE_KINDS
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


def test_skills_setup_kind_registered():
    entry = LIFECYCLE_KINDS["skills_setup"]
    assert entry["name"] == "skills_setup"
    assert entry["produces_decision"] is False
    assert entry["terminal"] is False
    assert isinstance(entry["params_schema"], dict)


def test_skills_setup_kind_has_operator_docs():
    # test_config_lifecycle_kinds.py gates KIND_DOCS completeness; pin the
    # entry here too so the RED phase names the whole surface.
    doc = KIND_DOCS.get("skills_setup")
    assert doc is not None
    assert doc.get("summary")


def _steps_by_name(stage: dict) -> dict[str, dict]:
    return {step["name"]: step for step in stage["lifecycle"]}


def test_default_pipelines_insert_skills_setup_between_git_setup_and_llm():
    """Structural walk over every default stage that carries a git_setup step:
    git_setup → skills_setup → llm. The llm hop is the step git_setup pointed
    at before the insertion (all four sites targeted an llm step directly)."""
    stages_with_git = [
        stage
        for stage in DEFAULT_PIPELINE_CONFIG["stages"]
        if any(step["kind"] == "git_setup" for step in stage.get("lifecycle", []))
    ]
    # implementer, reviewer, rework_mediator, ui_validator
    assert len(stages_with_git) == 4

    for stage in stages_with_git:
        steps = _steps_by_name(stage)
        git_steps = [s for s in stage["lifecycle"] if s["kind"] == "git_setup"]
        assert len(git_steps) == 1, stage["role"]
        git_step = git_steps[0]

        after_git = steps[git_step["next"]]
        assert after_git["kind"] == "skills_setup", (
            f"{stage['role']}: git_setup must chain into skills_setup, "
            f"got {after_git['kind']!r}"
        )
        assert isinstance(after_git.get("params", {}), dict)

        after_skills = steps[after_git["next"]]
        assert after_skills["kind"] == "llm", (
            f"{stage['role']}: skills_setup must hand off to the llm step "
            f"git_setup previously targeted, got {after_skills['kind']!r}"
        )
