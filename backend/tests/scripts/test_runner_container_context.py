# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
from pathlib import Path
import shutil

import yaml

ROOT = Path(__file__).resolve().parents[3]


def test_runner_release_context_contains_the_dockerfile_build_inputs(tmp_path):
    runner = ROOT / "runner"
    config = yaml.safe_load((runner / ".goreleaser.yaml").read_text())
    image = config["dockers_v2"][0]
    context = tmp_path / "context"
    context.mkdir()
    shutil.copy2(runner / image["dockerfile"], context / "Dockerfile")
    # GoReleaser's generated context includes artifacts and explicitly listed extras.
    for platform in image["platforms"]:
        binary = context / platform / "backplane-runner"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"built runner artifact")
    for relative in image.get("extra_files", []):
        source, target = runner / relative, context / relative
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    required = {Path("go.mod"), Path("go.sum")}
    required.update(path.relative_to(runner) for directory in ("cmd", "internal")
                    for path in (runner / directory).rglob("*.go")
                    if not path.name.endswith("_test.go"))
    assert Path("cmd/backplane-runner/main.go") in required
    missing = sorted(str(path) for path in required if not (context / path).is_file())
    assert not missing, f"release Docker context is missing build inputs: {missing}"
    for path in required:
        assert (context / path).read_bytes() == (runner / path).read_bytes()
    # Do not fix a filtered-context defect by shipping the entire checkout.
    assert not (context / ".git").exists()
    assert not (context / ".goreleaser.yaml").exists()
    assert not (context / "configs").exists()
