# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pathlib import Path

from valaris_mcp.prompts import pickup
from valaris_mcp.server import mcp
from valaris_mcp.tools.assignments import next_assignment


def test_pickup_contract_distinguishes_pipeline_loop_and_interactive():
    for text in (mcp.instructions, pickup("acme", "board")):
        assert "Pipeline mode" in text
        assert "Loop mode" in text
        assert "no atomic reservation" in text
        assert "next_assignment" in text
        assert "Interactive" in text
        assert "autonomous runners/pipelines" not in text.lower()
    assert "pipeline" in next_assignment.__doc__.lower()


def test_skill_guidance_routes_by_credential_identity():
    assert "human-key interactive AI" in mcp.instructions
    assert "runner-bound" in mcp.instructions
    assert "draft" in mcp.instructions
    assert "Skills Library" in mcp.instructions
    assert "authorized human workspace admin" in mcp.instructions


def test_evidence_only_contract_has_human_completion_without_fake_pr():
    root = Path(__file__).resolve().parents[2]
    text = (root / "docs/loop-mode-contract.md").read_text()
    assert "Evidence-only completion" in text
    section = text.split("Evidence-only completion", 1)[1].split("\n## ", 1)[0]
    for required in ("blocked_on_human", "human", "evidence note", "fabricate", "postmerge"):
        assert required in section
