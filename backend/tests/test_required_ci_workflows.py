# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fnmatch import fnmatchcase
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"


@pytest.mark.parametrize("filename", ["ci.yml", "quickstart-gate.yml"])
def test_required_checks_run_on_eligible_promotion_and_contributor_events(filename):
    # Manual dispatch reports green jobs but cannot satisfy branch protection.
    workflow = yaml.load((WORKFLOWS / filename).read_text(), Loader=yaml.BaseLoader)
    events = workflow["on"]
    assert "pull_request" in events
    assert not events["pull_request"], "required PR checks must not use path filters"
    branches = events["push"]["branches"]
    for branch in ("main", "codex/preview-security-ci"):
        assert any(fnmatchcase(branch, pattern) for pattern in branches)
    assert workflow["permissions"] == {"contents": "read"}


def test_frontend_release_gate_handles_the_zero_before_sha_on_new_tags():
    workflow = yaml.load((WORKFLOWS / "ci.yml").read_text(), Loader=yaml.BaseLoader)
    test_step = next(step for step in workflow["jobs"]["frontend"]["steps"] if step.get("name") == "Tests")
    expression = test_step["env"]["I18N_COPY_BASE_SHA"]
    assert "github.event.before != '" + "0" * 40 + "'" in expression
    assert "|| 'HEAD^'" in expression
