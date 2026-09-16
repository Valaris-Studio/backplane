#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Secrets gate for Backplane. Exits non-zero if a live-looking credential is
# found in anything git tracks. Used by CI and the public-export pipeline
# (docs/opensource-consolidation-plan.md, Session 1).
#
# Scope is deliberately GIT-TRACKED FILES ONLY. Untracked and gitignored paths
# (per-user state, runner run-configs, logs, agent worktrees) hold real keys by
# design and can never be published, so scanning them only produces noise that
# trains people to ignore the gate.
#
# Prefers gitleaks (respects .gitleaks.toml). Falls back to a grep sweep with an
# equivalent allowlist so the gate still works without an install.
#
# Usage:
#   scripts/scan-secrets.sh            # tracked working-tree files (default)
#   scripts/scan-secrets.sh --staged   # staged changes only (pre-commit)
#   scripts/scan-secrets.sh --history  # full git history (gitleaks only)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:-worktree}"

# Redact any key body before it reaches a terminal or CI log.
redact() { sed -E 's/(vlr_.{6}|sk-ant-.{6})[A-Za-z0-9_-]+/\1…REDACTED/g'; }

if command -v gitleaks >/dev/null 2>&1; then
  echo "→ gitleaks $(gitleaks version 2>/dev/null) (config: .gitleaks.toml)"

  case "$MODE" in
    --history)
      # Whole history, including deleted files and rewritten blobs.
      if gitleaks detect --config .gitleaks.toml --redact --no-banner; then
        echo "✓ history is clean"; exit 0
      fi
      echo "✗ secrets found in git history — a fresh-history export is required"
      exit 1
      ;;
    --staged)
      if gitleaks protect --staged --config .gitleaks.toml --redact --no-banner; then
        echo "✓ staged changes are clean"; exit 0
      fi
      echo "✗ secrets found in staged changes — do not commit"
      exit 1
      ;;
  esac

  # Default: scan the working tree, then keep only findings in tracked files.
  # gitleaks --no-git walks everything on disk, so filter its JSON report
  # rather than trusting its exit code, which counts untracked noise.
  REPORT="$(mktemp -t gitleaks-report-XXXXXX.json)"
  trap 'rm -f "$REPORT" "${SCANNER_LOG:-}"' EXIT
  SCANNER_LOG="$(mktemp -t gitleaks-stderr-XXXXXX)"
  scanner_rc=0
  gitleaks detect --config .gitleaks.toml --no-git --redact --no-banner \
    --report-format json --report-path "$REPORT" >/dev/null 2>"$SCANNER_LOG" || scanner_rc=$?

  # A scanner that never ran must fail CLOSED, never read as "no secrets".
  # The exit code alone cannot tell: gitleaks 8.30.1 exits 1 both for findings
  # and for a config/parse error (which writes no report), so the report being
  # present, non-empty and a JSON list is the usable signal.
  scanner_error() {
    echo "✗ scanner error: $1 — refusing to report clean"
    redact <"$SCANNER_LOG" | sed 's/^/    /'
    exit 2
  }
  case "$scanner_rc" in 0|1) ;; *) scanner_error "gitleaks exited $scanner_rc" ;; esac
  [ -s "$REPORT" ] || scanner_error "report missing or empty"

  # The filter names its own failure on stderr (appended to the scanner log)
  # and exits non-zero, which is mapped onto the scanner-error path.
  filter_rc=0
  TRACKED_HITS="$(
    python3 - "$REPORT" <<'PY' 2>>"$SCANNER_LOG"
import json, subprocess, sys
path = sys.argv[1]
try:
    findings = json.load(open(path))
except ValueError:
    findings = None
if not isinstance(findings, list):
    sys.exit("report is not a JSON list")
try:
    ls_files = subprocess.run(["git", "ls-files"], capture_output=True, text=True)
except FileNotFoundError:
    sys.exit("git ls-files failed: git is not on PATH")
if ls_files.returncode != 0:
    sys.exit(f"git ls-files failed: {ls_files.stderr.strip()}")
tracked = set(ls_files.stdout.splitlines())
try:
    for f in findings:
        if f["File"] in tracked:
            print(f'{f["File"]}:{f["StartLine"]}: {f["RuleID"]}')
except (KeyError, TypeError) as exc:
    sys.exit(f"report entry malformed: {exc!r}")
PY
  )" || filter_rc=$?
  [ "$filter_rc" -eq 0 ] || scanner_error "report filter failed"

  if [ -n "$TRACKED_HITS" ]; then
    echo "✗ secrets found in git-tracked files:"
    echo "$TRACKED_HITS" | redact | sed 's/^/    /'
    exit 1
  fi
  echo "✓ no secrets in git-tracked files"
  exit 0
fi

echo "→ gitleaks not installed; using the built-in fallback sweep."
echo "  (install for history scanning and full rule coverage: brew install gitleaks)"
if [ "$MODE" = "--history" ]; then
  echo "✗ --history requires gitleaks"; exit 2
fi

# Same live-key shapes as .gitleaks.toml: a real key is the prefix plus 40+
# url-safe chars, so short sentinels and placeholders never match.
PATTERN='vlr_[A-Za-z0-9_-]{40,}|sk-ant-[A-Za-z0-9_-]{20,}'
# Keep in sync with the [allowlist] in .gitleaks.toml.
ALLOW_PATHS='\.example\.|^runner/configs/|^backend/tests/|^mcp-server/tests/|__tests__/|^frontend/src/i18n/locales/.*\.json|^frontend/dist/|^\.claude/|^docs/pipeline-design/HANDOVER-|^runner/docs/PLAYBOOK-'
ALLOW_LINES='vlr_your|vlr_REPLACE|vlr_test|vlr_other|vlr_invalid|vlr_secret|vlr_fake|vlr_dummy|vlr_example|vlr_ab12cd34|\$\{VALARIS_API_KEY\}'

if [ "$MODE" = "--staged" ]; then
  FILES="$(git diff --cached --name-only --diff-filter=ACM)"
else
  FILES="$(git ls-files)"
fi

HITS=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  [ -f "$file" ] || continue
  printf '%s\n' "$file" | grep -qE "$ALLOW_PATHS" && continue
  match="$(grep -nE "$PATTERN" "$file" 2>/dev/null | grep -vE "$ALLOW_LINES" || true)"
  [ -n "$match" ] && HITS+="$(printf '%s\n' "$match" | sed "s|^|${file}:|")"$'\n'
done <<< "$FILES"

if [ -n "${HITS//[$'\n' ]/}" ]; then
  echo "✗ secrets found in git-tracked files:"
  printf '%s' "$HITS" | redact | sed 's/^/    /'
  exit 1
fi
echo "✓ no secrets in git-tracked files"
