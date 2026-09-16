#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Verifies every source file carries the SPDX header that matches the
# license map in LICENSES.md. Exits non-zero listing offending files.
# Fixer counterpart: scripts/add-license-headers.sh (keep the
# file-selection and license rules in the two scripts identical).
set -euo pipefail

cd "$(dirname "$0")/.."

license_for() {
  # LICENSES.md: runner/ is MIT, everything else defaults to AGPL-3.0-or-later
  case "$1" in
    runner/*) echo "MIT" ;;
    *)        echo "AGPL-3.0-or-later" ;;
  esac
}

is_generated() {
  head -n 3 "$1" | grep -qE '^(//|#|/\*).*(DO NOT EDIT|[Aa]uto-?generated|@generated|Code generated)'
}

list_source_files() {
  find backend frontend mcp-server runner scripts infra -type f \
    \( -name '*.py' -o -name '*.go' -o -name '*.ts' -o -name '*.tsx' -o -name '*.sh' \) \
    -not -path '*/node_modules/*' \
    -not -path '*/.venv/*' \
    -not -path '*/venv/*' \
    -not -path '*/dist/*' \
    -not -path '*/build/*' \
    -not -path 'runner/repos*'
}

missing=0

while IFS= read -r f; do
  is_generated "$f" && continue
  expected="SPDX-License-Identifier: $(license_for "$f")"
  if ! head -n 12 "$f" | grep -qF "$expected"; then
    echo "missing or wrong license header: $f (expected: $expected)"
    missing=$((missing + 1))
  fi
done < <(list_source_files)

if [[ "$missing" -gt 0 ]]; then
  echo "license header check FAILED: $missing file(s)"
  exit 1
fi
echo "license header check OK"
