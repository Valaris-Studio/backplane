# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exercise packaging cleanup without running Go, packaging tools or native apps."""

import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

import pytest

GATE_SCRIPT = Path(__file__).resolve().parents[3] / "scripts/companion-source-gate.sh"

SHIM = r'''
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

settings = json.loads(Path(SETTINGS_PATH).read_text())
name = Path(sys.argv[0]).name
if name == "mktemp":
    assert sys.argv[1:] == ["-d"]
    print(tempfile.mkdtemp(prefix="owned gate ", dir=settings["scratch"]))
elif name in {"find", "rm"}:
    if name == settings["fail_cleanup"]:
        sys.exit(31)
    os.execv(settings["tools"][name], [name, *sys.argv[1:]])
elif sys.argv[1:3] == ["-B", "-c"]:
    if "sys.executable" in sys.argv[3]:
        print(Path(sys.argv[0]).resolve())
    else:
        exec(sys.argv[3])
else:
    assert sys.argv[1:5] == ["-B", "-m", "unittest", "-v"]
    assert os.environ["BACKPLANE_BUNDLE_TEST"] == "0"
    assert "GOFLAGS" not in os.environ
    home = Path(os.environ["HOME"])
    module = home / "go/pkg/mod/fixture.invalid/license@v1"
    nested = module / "nested"
    nested.mkdir(parents=True)
    payload = nested / "LICENSE"
    payload.write_text("synthetic license\n")
    payload.chmod(0o400)
    nested.chmod(0o500)
    module.chmod(0o500)
    (home / "external-cache").symlink_to(settings["neighbor"], target_is_directory=True)
    Path(settings["log"]).write_text(json.dumps({
        "owned": str(home.parent), "module_mode": stat.S_IMODE(module.stat().st_mode),
        "nested_mode": stat.S_IMODE(nested.stat().st_mode),
        "file_mode": stat.S_IMODE(payload.stat().st_mode), "args": sys.argv[1:],
    }))
    sys.exit(settings["test_exit"])
'''


def snapshot_neighbor(neighbor):
    payload = neighbor / "LICENSE"
    return stat.S_IMODE(neighbor.stat().st_mode), stat.S_IMODE(payload.stat().st_mode), payload.read_bytes()


@pytest.fixture
def run_packaging(tmp_path):
    repo = tmp_path / "checkout with spaces"
    (repo / "scripts").mkdir(parents=True)
    (repo / "companion/scripts/tests").mkdir(parents=True)
    script = repo / "scripts/companion-source-gate.sh"
    shutil.copyfile(GATE_SCRIPT, script)
    scratch = tmp_path / "fresh temporary homes"
    scratch.mkdir()
    neighbor = tmp_path / "outside the owned home"
    neighbor.mkdir()
    (neighbor / "LICENSE").write_text("do not modify\n")
    (neighbor / "LICENSE").chmod(0o400)
    neighbor.chmod(0o500)
    original_neighbor = snapshot_neighbor(neighbor)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("dirname", "mkdir", "env", "chmod"):
        (bin_dir / name).symlink_to(shutil.which(name))
    settings_path = tmp_path / "settings.json"
    for name in ("test-python", "mktemp", "find", "rm"):
        executable = bin_dir / name
        executable.write_text(f"#!{sys.executable}\nSETTINGS_PATH = {str(settings_path)!r}\n" + SHIM)
        executable.chmod(0o755)
    log = tmp_path / "invocation.json"

    def run(*, test_exit=0, fail_cleanup=""):
        settings_path.write_text(json.dumps({
            "scratch": str(scratch), "neighbor": str(neighbor), "log": str(log),
            "test_exit": test_exit, "fail_cleanup": fail_cleanup,
            "tools": {name: shutil.which(name) for name in ("find", "rm")},
        }))
        result = subprocess.run(
            ["/bin/bash", str(script), "packaging"], cwd=tmp_path,
            env={"PATH": str(bin_dir), "BACKPLANE_TEST_PYTHON": str(bin_dir / "test-python"),
                 "PYTHONDONTWRITEBYTECODE": "1", "GOFLAGS": "caller setting must not leak"},
            capture_output=True, text=True, timeout=10,
        )
        invocation = json.loads(log.read_text())
        owned = Path(invocation["owned"])
        assert owned.parent == scratch
        assert invocation["module_mode"] == invocation["nested_mode"] == 0o500
        assert invocation["file_mode"] == 0o400
        assert snapshot_neighbor(neighbor) == original_neighbor
        return result, owned

    yield run
    # Pytest owns these fixtures; never follow the simulated cache's external link.
    for current, _, _ in os.walk(tmp_path, followlinks=False):
        Path(current).chmod(0o700)


def test_packaging_removes_its_read_only_cache_without_following_symlinks(run_packaging):
    result, owned = run_packaging()
    assert result.returncode == 0, result.stdout + result.stderr
    assert not owned.exists()


def test_packaging_preserves_test_failure_after_cleaning_read_only_cache(run_packaging):
    result, owned = run_packaging(test_exit=23)
    assert result.returncode == 23, result.stdout + result.stderr
    assert not owned.exists()


@pytest.mark.parametrize("command", ["find", "rm"])
def test_packaging_cleanup_failure_cannot_report_success(run_packaging, command):
    result, owned = run_packaging(fail_cleanup=command)
    assert result.returncode == 31, result.stdout + result.stderr
    assert owned.exists()
