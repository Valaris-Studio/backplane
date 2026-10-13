#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT
#
# Cross-platform compile gate, runnable on a Mac: go vet of the companion for
# macOS, Linux and Windows, the desktop shell for Intel macOS, and the desktop
# shell for Windows when `cargo xwin` is installed.
#
#   scripts/xplat_check.sh
#
# A leg whose tool is missing is reported as SKIP, never as PASS; only a FAIL
# makes the exit status non-zero.
set -uo pipefail

companion_dir="$(cd "$(dirname "$0")/.." && pwd)"
shell_manifest="$companion_dir/desktop/src-tauri/Cargo.toml"
go_targets=(darwin/arm64 linux/amd64 windows/amd64)

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
skip() { printf 'SKIP  %s\n' "$1"; }
indent() { sed 's/^/      /'; }

# The Go module is vetted from a copy with no .git ancestor: its tests drive
# real git, and nothing here may ever run them against the live checkout.
go_copy="$(mktemp -d)"
trap 'find "$go_copy" -delete' EXIT
tar -C "$companion_dir" -cf - go.mod go.sum cmd internal third_party | tar -C "$go_copy" -xf -
if git -C "$go_copy" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ABORT: $go_copy resolves inside a git worktree; refusing to run go here." >&2
  exit 1
fi

for target in "${go_targets[@]}"; do
  if output=$(CGO_ENABLED=0 GOOS="${target%/*}" GOARCH="${target#*/}" go vet -C "$go_copy" ./... 2>&1); then
    pass "go vet ($target)"
  else
    fail "go vet ($target)"
    printf '%s\n' "$output" | indent
  fi
done

if output=$(cargo check --manifest-path "$shell_manifest" --target x86_64-apple-darwin --all-targets 2>&1); then
  pass "cargo check (x86_64-apple-darwin)"
else
  fail "cargo check (x86_64-apple-darwin)"
  printf '%s\n' "$output" | tail -40 | indent
fi

if ! cargo xwin --version >/dev/null 2>&1; then
  skip "cargo xwin check (x86_64-pc-windows-msvc): cargo-xwin is not installed"
elif output=$(cargo xwin check --manifest-path "$shell_manifest" --target x86_64-pc-windows-msvc --all-targets 2>&1); then
  pass "cargo xwin check (x86_64-pc-windows-msvc)"
else
  fail "cargo xwin check (x86_64-pc-windows-msvc)"
  printf '%s\n' "$output" | tail -40 | indent
fi

if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "no check failed"
