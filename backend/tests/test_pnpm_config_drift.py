# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Drift guard: pnpm config lives in four hand-synced copies today.

`overrides` for the tiptap pin once existed in FOUR places: the root
package.json `pnpm` field, frontend/package.json's `pnpm` field, root
pnpm-workspace.yaml, and frontend/pnpm-workspace.yaml. The two package.json
copies drifted from the two workspace-yaml copies -- the structural defect
the OSS hardening audit's P1 finding hid behind: a contributor fixing an
override in one place had three other places silently keeping the stale
value, because nothing failed loudly. pnpm 11 ignores the package.json
`pnpm` field entirely (only pnpm-workspace.yaml's `overrides` is read), so
the convergence shipped here is two copies: the package.json fields are
deleted outright (pinned deleted below), and the two pnpm-workspace.yaml
overrides blocks are pinned equal. Both Dockerfiles now pin pnpm@11.5.1 and
install --frozen-lockfile from the standalone frontend lockfile -- the
dev-pnpm-9 era this file's history describes is over, and the version-match
test below keeps it that way.
"""

import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT_PACKAGE_JSON = REPO_ROOT / "package.json"
FRONTEND_PACKAGE_JSON = REPO_ROOT / "frontend" / "package.json"
ROOT_WORKSPACE_YAML = REPO_ROOT / "pnpm-workspace.yaml"
FRONTEND_WORKSPACE_YAML = REPO_ROOT / "frontend" / "pnpm-workspace.yaml"
FRONTEND_DOCKERFILE = REPO_ROOT / "frontend" / "Dockerfile"
FRONTEND_DOCKERFILE_DEV = REPO_ROOT / "frontend" / "Dockerfile.dev"

COREPACK_PNPM_VERSION = re.compile(r"corepack prepare pnpm@(?P<version>\S+) --activate")


def _load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def _load_json(path: Path) -> dict:
    import json

    return json.loads(path.read_text())


def _corepack_pnpm_version(dockerfile: Path) -> str:
    for line in dockerfile.read_text().splitlines():
        match = COREPACK_PNPM_VERSION.search(line)
        if match:
            return match.group("version")
    raise AssertionError(
        f"no `corepack prepare pnpm@<ver> --activate` line found in {dockerfile}"
    )


def test_workspace_overrides_agree():
    """The two pnpm-workspace.yaml `overrides` blocks must be identical.

    These are the two copies Plan-B keeps (unlike the package.json `pnpm`
    fields, which get deleted outright) -- so unlike those, this is a pin,
    not a red test. A hand-edit to one without the other is exactly the
    silent-drift bug class this file exists to catch.
    """
    root_overrides = _load_yaml(ROOT_WORKSPACE_YAML)["overrides"]
    frontend_overrides = _load_yaml(FRONTEND_WORKSPACE_YAML)["overrides"]
    assert root_overrides == frontend_overrides, (
        "pnpm-workspace.yaml overrides drifted between root and frontend/:\n"
        f"root-only or different: { {k: v for k, v in root_overrides.items() if frontend_overrides.get(k) != v} }\n"
        f"frontend-only or different: { {k: v for k, v in frontend_overrides.items() if root_overrides.get(k) != v} }"
    )


def test_package_json_pnpm_fields_removed():
    """Neither package.json may carry a `pnpm` field once dev moves to pnpm 11.

    pnpm 11 never reads this field (only pnpm-workspace.yaml `overrides`) --
    a `pnpm` field surviving here is dead config that looks load-bearing but
    silently does nothing, and it's the third/fourth copy of the same
    overrides list that let this drift in the first place.
    """
    root_pnpm_field = _load_json(ROOT_PACKAGE_JSON).get("pnpm")
    frontend_pnpm_field = _load_json(FRONTEND_PACKAGE_JSON).get("pnpm")
    assert (
        root_pnpm_field is None
    ), f"package.json still has a `pnpm` field (pnpm 11 ignores it): {root_pnpm_field!r}"
    assert (
        frontend_pnpm_field is None
    ), f"frontend/package.json still has a `pnpm` field (pnpm 11 ignores it): {frontend_pnpm_field!r}"


def test_dev_and_prod_pnpm_versions_match():
    """Dev and prod images must pin the same pnpm version.

    Different pnpm major versions resolve dependency trees differently (11
    reads pnpm-workspace.yaml overrides only; 9 reads package.json `pnpm`
    only) -- a dev/prod version split means dev is silently testing against
    a different resolution than what ships.
    """
    dev_version = _corepack_pnpm_version(FRONTEND_DOCKERFILE_DEV)
    prod_version = _corepack_pnpm_version(FRONTEND_DOCKERFILE)
    assert dev_version == prod_version, (
        f"frontend/Dockerfile.dev pins pnpm@{dev_version} but frontend/Dockerfile "
        f"(prod) pins pnpm@{prod_version} -- dev and prod must resolve dependencies "
        "with the same pnpm major version."
    )


def test_dev_dockerfile_builds_frozen_from_lockfile():
    """Dev image must build from the pinned lockfile, not resolve unpinned.

    Mirrors the prod Dockerfile's contract: COPY the lockfile + workspace
    yaml before installing, install with `--frozen-lockfile` in the image
    build, and never fall back to `--no-frozen-lockfile` at container
    startup -- that flag is exactly what lets the dev container silently
    resolve a dependency tree the lockfile never pinned.
    """
    dockerfile_text = FRONTEND_DOCKERFILE_DEV.read_text()
    lines = dockerfile_text.splitlines()

    copy_lines = [line for line in lines if line.strip().startswith("COPY")]
    assert any(
        "pnpm-lock.yaml" in line for line in copy_lines
    ), f"frontend/Dockerfile.dev must COPY pnpm-lock.yaml before installing. COPY lines:\n{copy_lines}"
    assert any(
        "pnpm-workspace.yaml" in line for line in copy_lines
    ), f"frontend/Dockerfile.dev must COPY pnpm-workspace.yaml before installing. COPY lines:\n{copy_lines}"

    run_install_lines = [
        line
        for line in lines
        if line.strip().startswith("RUN") and "pnpm install" in line
    ]
    assert any("--frozen-lockfile" in line for line in run_install_lines), (
        "frontend/Dockerfile.dev's build-time `RUN pnpm install` must use "
        f"--frozen-lockfile. RUN install lines:\n{run_install_lines}"
    )

    cmd_match = re.search(r"^CMD\s+(.*)$", dockerfile_text, re.MULTILINE)
    assert cmd_match, "frontend/Dockerfile.dev has no CMD line"
    cmd_line = cmd_match.group(1)
    assert (
        "--frozen-lockfile" in cmd_line
    ), f"frontend/Dockerfile.dev CMD must install with --frozen-lockfile: {cmd_line!r}"
    assert "--no-frozen-lockfile" not in cmd_line, (
        "frontend/Dockerfile.dev CMD must not fall back to --no-frozen-lockfile "
        f"(that's exactly the unpinned-resolution hole): {cmd_line!r}"
    )


def test_frontend_workspace_yaml_declares_packages_dot():
    """frontend/pnpm-workspace.yaml must declare `packages: ["."]`.

    The file's very presence makes frontend/ a workspace ROOT. Under the
    pnpm 9 of the 2026-07 incident, a missing `packages` refused every
    fresh Docker clone's install for 6 days; pinned pnpm 11.5.1 instead
    defaults an omitted `packages` to ["."], so no runtime path fails on
    this anymore -- this commit-time assertion is the only guard, pinning
    the explicit config as convention. (The quickstart gate still proves
    the fresh-clone boot end to end; its install step fails loudly only on
    package.json<->lockfile drift, via --frozen-lockfile.)
    """
    workspace = _load_yaml(FRONTEND_WORKSPACE_YAML)
    assert workspace.get("packages") == ["."], (
        "frontend/pnpm-workspace.yaml must declare packages: [\".\"] "
        "explicitly -- pnpm 11 would default an omitted key to [\".\"], but "
        "implicit config is exactly how the 2026-07 incident class hides. "
        f"Found: {workspace.get('packages')!r}"
    )


def test_prod_dockerfile_builds_frozen_from_lockfile():
    """Prod image must install from the pinned lockfile, frozen and scriptless.

    Same contract test_dev_dockerfile_builds_frozen_from_lockfile pins for
    dev: COPY the lockfile + workspace yaml before installing, and install
    with --frozen-lockfile (plus --ignore-scripts -- the bundle needs no
    native postinstall builds, and pnpm 11 hard-fails on unapproved ones).
    """
    lines = FRONTEND_DOCKERFILE.read_text().splitlines()

    copy_lines = [line for line in lines if line.strip().startswith("COPY")]
    assert any(
        "pnpm-lock.yaml" in line for line in copy_lines
    ), f"frontend/Dockerfile must COPY pnpm-lock.yaml before installing. COPY lines:\n{copy_lines}"
    assert any(
        "pnpm-workspace.yaml" in line for line in copy_lines
    ), f"frontend/Dockerfile must COPY pnpm-workspace.yaml before installing. COPY lines:\n{copy_lines}"

    run_install_lines = [
        line
        for line in lines
        if line.strip().startswith("RUN") and "pnpm install" in line
    ]
    assert run_install_lines, "frontend/Dockerfile has no `RUN pnpm install` line"
    assert all("--frozen-lockfile" in line for line in run_install_lines), (
        "frontend/Dockerfile's `RUN pnpm install` must use --frozen-lockfile. "
        f"RUN install lines:\n{run_install_lines}"
    )
    assert all("--ignore-scripts" in line for line in run_install_lines), (
        "frontend/Dockerfile's `RUN pnpm install` must use --ignore-scripts. "
        f"RUN install lines:\n{run_install_lines}"
    )


def test_doctor_target_exists():
    """`make doctor` must exist and delegate to an executable scripts/doctor.sh.

    Same executable-script precedent as scripts/quickstart-gate.sh and
    scripts/go-test-safe.sh -- a diagnostic entry point a contributor can
    run when `make dev` doesn't come up cleanly.
    """
    makefile_text = (REPO_ROOT / "Makefile").read_text()
    lines = makefile_text.splitlines()

    phony_lines = [line for line in lines if line.startswith(".PHONY:")]
    assert any(
        re.search(r"\bdoctor\b", line) for line in phony_lines
    ), f"`doctor` missing from .PHONY. .PHONY lines:\n{phony_lines}"

    assert "doctor:" in lines, "Makefile has no `doctor:` target"
    start = lines.index("doctor:")
    recipe = []
    for line in lines[start + 1 :]:
        if not line.startswith("\t"):
            break
        recipe.append(line)
    assert any(
        "scripts/doctor.sh" in line for line in recipe
    ), f"`doctor:` target recipe doesn't invoke scripts/doctor.sh. Recipe:\n{recipe}"

    doctor_script = REPO_ROOT / "scripts" / "doctor.sh"
    assert doctor_script.exists(), f"{doctor_script} does not exist"
    import os

    assert os.access(doctor_script, os.X_OK), f"{doctor_script} is not executable"
