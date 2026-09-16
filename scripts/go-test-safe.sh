#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Shared recipe for running the runner's Go suite out-of-tree. Those tests
# drive REAL git (incl. reset --hard); a relative git.base_dir resolves
# against the process CWD, so running them in-checkout can rewind the live
# repo — see the README's "Running the tests" warning for the 2026-07-27
# incident this defends against.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

tar -C "$REPO_ROOT" -cf - --exclude='runner/repos*' runner | tar -C "$TMP" -xf -

# Belt-and-suspenders: mktemp -d can in theory land under a git-controlled
# tmp dir. Refuse to proceed if the copy has any .git ancestor at all.
if git -C "$TMP/runner" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ABORT: $TMP/runner unexpectedly resolves inside a git worktree — refusing to run go test here." >&2
  exit 1
fi

echo "go-test-safe: running go test out-of-tree at $TMP/runner (source: $REPO_ROOT/runner)"
go test -C "$TMP/runner" ./... "$@"
status=$?

echo "go-test-safe: exit $status, ran out-of-tree at $TMP/runner"
exit $status
