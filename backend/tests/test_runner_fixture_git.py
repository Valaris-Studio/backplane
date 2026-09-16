# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import os
import subprocess


def test_fixture_git_never_mutates_ambient_repository(tmp_path, monkeypatch):
    from tests.runner_fixture_git import fixture_git_environment

    foreign = tmp_path / "foreign"
    foreign.mkdir()
    clean = {
        "PATH": os.environ["PATH"],
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
    }
    subprocess.run(["git", "init", "-q", str(foreign)], env=clean, check=True)
    (foreign / "operator-work.txt").write_text("keep me unchanged\n")

    def snapshot():
        return {
            str(p.relative_to(foreign)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in foreign.rglob("*")
            if p.is_file()
        }

    before = snapshot()
    monkeypatch.setenv("GIT_DIR", str(foreign / ".git"))
    monkeypatch.setenv("GIT_WORK_TREE", str(foreign))
    monkeypatch.setenv("GIT_INDEX_FILE", str(foreign / ".git/index"))
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "core.worktree")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", str(foreign))
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "https:ssh")
    selected = tmp_path / "fixture"
    selected.mkdir()
    env = fixture_git_environment()
    assert env["GIT_ALLOW_PROTOCOL"] == "file"
    assert (
        not {"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT"}
        & env.keys()
    )
    subprocess.run(["git", "-C", str(selected), "init", "-q"], env=env, check=True)
    (selected / "candidate.txt").write_text("fixture only\n")
    subprocess.run(
        ["git", "-C", str(selected), "add", "candidate.txt"], env=env, check=True
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(selected),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "fixture",
        ],
        env=env,
        check=True,
    )
    assert (selected / ".git").is_dir()
    assert snapshot() == before
