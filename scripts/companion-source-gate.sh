#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
# Shared CI/local source checks. No native app, Beacon, signing or publication.
# Requires Go 1.26.8 + a C compiler, Python 3.12+, Node 22.23.3 and pnpm 11.5.1.
# The separate rust mode requires macOS, Xcode command-line tools and Rust 1.98.1.
# Dependency downloads use the committed Go sums and frozen desktop lockfile.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GATE_PYTHON="${BACKPLANE_TEST_PYTHON:-python3}"

require_tool() {
  command -v "$1" >/dev/null || { echo "Companion source checks require $1." >&2; exit 1; }
}

require_python() {
  require_tool "$GATE_PYTHON"
  "$GATE_PYTHON" -B -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else "Companion contracts require Python 3.12+.")'
  GATE_PYTHON="$("$GATE_PYTHON" -B -c 'import os, sys; print(os.path.abspath(sys.executable))')"
}

require_node() {
  require_tool node
  if [[ "$(node --version)" != "v22.23.3" ]]; then
    echo "Companion source checks require Node 22.23.3 (CI toolchain)." >&2
    exit 1
  fi
}

run_go_tests() {
  local label="$1" status=0
  shift
  if env -i "${companion_check_env[@]}" go test -C "$companion_check_dir/companion" \
    -json "$@" | tee "$companion_report_dir/$label.jsonl"; then
    status=0
  else
    status=$?
  fi
  "$GATE_PYTHON" -B - "$companion_report_dir/$label.jsonl" "$status" <<'PY'
import collections
import json
from pathlib import Path
import sys

source = Path(sys.argv[1])
counts = collections.Counter()
skipped = []
output = collections.defaultdict(list)
for line in source.read_text().splitlines():
    event = json.loads(line)
    identity = (event.get("Package"), event.get("Test"))
    action = event.get("Action")
    if action == "output":
        output[identity].append(event.get("Output", "").rstrip())
        output[identity] = output[identity][-4:]
    elif action in {"pass", "fail", "skip"} and event.get("Test"):
        counts[action] += 1
        if action == "skip":
            skipped.append({"package": identity[0], "test": identity[1], "output": output[identity]})
summary = {"exit_code": int(sys.argv[2]), "test_events": dict(counts), "skipped": skipped}
source.with_suffix(".summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
if not counts:
    raise SystemExit("Go source gate produced no test completion events")
PY
  return "$status"
}

check_go() (
  require_python
  require_node
  require_tool go
  require_tool git
  require_tool cc
  if [[ "$(GOTOOLCHAIN=local go env GOVERSION)" != "go1.26.8" ]]; then
    echo "Companion source checks require Go 1.26.8 (CI toolchain)." >&2
    exit 1
  fi
  companion_check_dir="$(mktemp -d)"
  trap 'rm -rf "$companion_check_dir"' EXIT
  companion_report_dir="$(mktemp -d "${COMPANION_GATE_REPORT_DIR:-${TMPDIR:-/tmp}}/companion-go.XXXXXX")"
  echo "Companion Go test reports: $companion_report_dir"
  tar -C "$REPO_ROOT" -cf - companion/go.mod companion/go.sum companion/beacon-source.json \
    companion/cmd companion/internal companion/third_party contracts | tar -C "$companion_check_dir" -xf -
  chmod -R u+rwX,go-w "$companion_check_dir"
  if env -i PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -C "$companion_check_dir/companion" rev-parse --git-dir >/dev/null 2>&1; then
    echo "Refusing to run Companion checks inside a Git worktree." >&2
    exit 1
  fi
  mkdir -p "$companion_check_dir/home" "$companion_check_dir/data"
  # A local caller's Git/config or capture environment must not redirect tests.
  companion_check_env=(
    "PATH=$PATH"
    "HOME=$companion_check_dir/home"
    "BACKPLANE_COMPANION_HOME=$companion_check_dir/data"
    "GOCACHE=$(GOTOOLCHAIN=local go env GOCACHE)"
    "GOMODCACHE=$(GOTOOLCHAIN=local go env GOMODCACHE)"
    "GOPATH=$(GOTOOLCHAIN=local go env GOPATH)"
    "CC=$(command -v cc)"
    "GOTOOLCHAIN=local" "GOWORK=off" "GOENV=off" "CGO_ENABLED=1"
    "GIT_CONFIG_NOSYSTEM=1" "GIT_CONFIG_GLOBAL=/dev/null"
  )
  env -i "${companion_check_env[@]}" go vet -C "$companion_check_dir/companion" ./...
  env -i "${companion_check_env[@]}" go vet -C "$companion_check_dir/companion" -tags devkeyring ./...
  run_go_tests production -race -count=1 -timeout=600s ./...
  run_go_tests devkeyring -tags devkeyring -count=1 -timeout=600s ./cmd/backplane-companion ./internal/credentials
  env -i "${companion_check_env[@]}" go build -C "$companion_check_dir/companion" ./...
  for target in windows/amd64 darwin/arm64; do
    env -i "${companion_check_env[@]}" CGO_ENABLED=0 GOOS="${target%/*}" GOARCH="${target#*/}" \
      go vet -C "$companion_check_dir/companion" ./...
    env -i "${companion_check_env[@]}" CGO_ENABLED=0 GOOS="${target%/*}" GOARCH="${target#*/}" \
      go build -C "$companion_check_dir/companion" ./...
  done
)

check_packaging() (
  require_python
  companion_check_dir="$(mktemp -d)"
  # Go's license helper leaves read-only module directories in this private HOME.
  trap 'find -P "$companion_check_dir" -type d -exec chmod u+w {} +; rm -rf "$companion_check_dir"' EXIT
  mkdir -p "$companion_check_dir/home"
  cd "$REPO_ROOT/companion/scripts/tests"
  # Native macOS app verification and the live host bundle are separate gates.
  env -i PATH="$PATH" HOME="$companion_check_dir/home" \
    BACKPLANE_BUNDLE_TEST=0 PYTHONDONTWRITEBYTECODE=1 \
    "$GATE_PYTHON" -B -m unittest -v \
    test_build_bundle test_build_desktop test_build_desktop_linux test_build_desktop_windows \
    test_bundle test_licenses test_macos_signing test_release_desktop test_text_encoding test_xplat_check \
    test_module_identity
)

install_frontend() {
  require_node
  require_tool pnpm
  if [[ "$(pnpm --version)" != "11.5.1" ]]; then
    echo "Companion frontend checks require pnpm 11.5.1 (desktop packageManager)." >&2
    exit 1
  fi
  cd "$REPO_ROOT/companion/desktop"
  pnpm install --frozen-lockfile --ignore-scripts
}

check_frontend() (
  install_frontend
  pnpm check
  pnpm build
)

check_rust() (
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "The Companion Rust source-contract gate requires macOS with Xcode command-line tools." >&2
    exit 1
  fi
  require_tool rustup
  require_tool cargo
  rustup run 1.98.1 rustc --version
  install_frontend
  pnpm build
  cargo +1.98.1 test --locked --manifest-path src-tauri/Cargo.toml \
    --lib --test capability_grants --test update_grants --test linux_window_config
)

case "${1:-all}" in
  all) check_go; check_packaging; check_frontend ;;
  go) check_go ;;
  packaging) check_packaging ;;
  frontend) check_frontend ;;
  rust) check_rust ;;
  *) echo "Usage: $0 [all|go|packaging|frontend|rust]" >&2; exit 2 ;;
esac
