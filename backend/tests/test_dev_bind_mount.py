# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The development container must not write bytecode into host source mounts."""

import os
from pathlib import Path
import subprocess
import sys

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_dev_backend_imports_leave_bind_mounted_source_unchanged(tmp_path):
    # Linux Docker preserves root ownership: a root-created __pycache__ makes
    # Quickstart's disposable source tree impossible for the host user to remove.
    source = tmp_path / "backend"
    package = source / "app"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "probe.py").write_text("VALUE = 42\n")
    before = set(source.rglob("*"))
    compose = yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text())
    backend_env = compose["services"]["backend"]["environment"]
    env = {
        key: value for key, value in os.environ.items()
        if key not in {"PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX"}
    }
    env.update({key: str(value) for key, value in backend_env.items() if "${" not in str(value)})

    result = subprocess.run(
        [sys.executable, "-c", "from app.probe import VALUE; assert VALUE == 42"],
        cwd=source, env=env, capture_output=True, text=True, timeout=10,
    )

    assert result.returncode == 0, result.stderr
    assert set(source.rglob("*")) == before, "Development imports wrote files into the source mount"
