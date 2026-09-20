#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
# Same isolated binary/API/PTY acceptance matrix in CI and local verification.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GATE_DIR="$(mktemp -d)"
trap 'rm -rf "$GATE_DIR"' EXIT
command -v uvx >/dev/null || { echo 'Artifact gate requires uvx (install uv).' >&2; exit 1; }
PYTHON="${BACKPLANE_TEST_PYTHON:-$ROOT/backend/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then PYTHON="$(command -v python3)"; fi
if [[ -z "${BACKPLANE_RUNNER_BIN:-}" ]]; then
  command -v go >/dev/null || { echo 'Source artifact gate requires Go.' >&2; exit 1; }
  # Ambient GIT_DIR/config injection must not misidentify the source checkout.
  source_git() { env -i PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$ROOT" "$@"; }
  if [[ "$(source_git rev-parse --show-toplevel)" != "$ROOT" ]]; then
    echo 'Build qualification requires its own Git checkout; otherwise supply BACKPLANE_RUNNER_BIN.' >&2
    exit 1
  fi
  if [[ -n "$(source_git status --porcelain --untracked-files=all -- runner)" ]]; then
    echo 'Artifact gate refuses to label a source build: runner source has uncommitted changes.' >&2
    exit 1
  fi
  export BACKPLANE_RUNNER_BIN="$GATE_DIR/backplane-runner"
  export BACKPLANE_RUNNER_ARTIFACT_KIND=source-build
  SOURCE_COMMIT="$(source_git rev-parse HEAD)"
  VERSION_PACKAGE=github.com/Valaris-Studio/backplane/runner/internal/version
  go build -C "$ROOT/runner" -trimpath \
    -ldflags "-X $VERSION_PACKAGE.GitCommit=$SOURCE_COMMIT -X $VERSION_PACKAGE.Version=artifact-gate" \
    -o "$BACKPLANE_RUNNER_BIN" ./cmd/backplane-runner
else
  export BACKPLANE_RUNNER_ARTIFACT_KIND="${BACKPLANE_RUNNER_ARTIFACT_KIND:-operator-supplied-artifact}"
fi
[[ -x "$BACKPLANE_RUNNER_BIN" ]] || { echo 'BACKPLANE_RUNNER_BIN must name an executable artifact.' >&2; exit 1; }
BACKPLANE_RUNNER_BIN="$("$PYTHON" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve(strict=True))' "$BACKPLANE_RUNNER_BIN")"
export BACKPLANE_RUNNER_BIN
# Unset the old manual-PTY opt-in: this gate must never wait for a human.
unset BACKPLANE_RUNNER_INTERACTIVE_DIR PYTEST_ADDOPTS
export BACKPLANE_MCP_CACHE_DIR="$GATE_DIR/uv-cache"
cd "$ROOT/backend"
"$PYTHON" -m pytest tests/test_runner_readiness_artifact.py \
  tests/test_runner_fixture_database.py tests/test_runner_fixture_terminal.py \
  tests/test_runner_fixture_git.py -o addopts= -q -s --tb=short --junitxml="$GATE_DIR/results.xml"
"$PYTHON" - "$GATE_DIR/results.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
suites = [root] if root.tag == 'testsuite' else list(root)
assert sum(int(suite.get('tests', '0')) for suite in suites) > 0, 'artifact gate collected no tests'
assert not any(int(suite.get('skipped', '0')) for suite in suites), 'artifact gate skipped a required acceptance test'
required = {'pr-denied', 'review', 'validation', 'missing-runtime', 'budget-history',
            'recovery', 'failed-review-rework', 'interactive', 'interactive-fresh'}
prefix = 'test_built_runner_real_api_readiness_and_preserved_completion['
passed = set()
for case in root.iter('testcase'):
    name = case.get('name', '')
    if name.startswith(prefix) and name.endswith(']') and not any(case.find(tag) is not None for tag in ('failure', 'error', 'skipped')):
        passed.add(name[len(prefix):-1])
assert required <= passed, 'missing required artifact scenarios: ' + ', '.join(sorted(required - passed))
PY
