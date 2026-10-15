# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The published dependency range must exclude the affected HTTP SDK releases."""
import tomllib
from pathlib import Path

import pytest
from packaging.requirements import Requirement


@pytest.mark.parametrize(
    ("version", "admitted"),
    [("1.12.0", False), ("1.29.1", False), ("1.30.0", True), ("2.0.0", False)],
)
def test_published_sdk_range_admits_fixed_compatible_releases_only(version, admitted):
    project = tomllib.loads(
        (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    )["project"]
    requirements = [Requirement(value) for value in project["dependencies"]]
    sdk = next(requirement for requirement in requirements if requirement.name == "mcp")
    assert (version in sdk.specifier) is admitted, str(sdk)
