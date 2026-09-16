#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Adds the 2-line copyright + SPDX header to every source file, per the
# license map in LICENSES.md. Idempotent: files that already carry an
# SPDX-License-Identifier in their first lines are left untouched.
# Enforcement counterpart: scripts/check-license-headers.sh (keep the
# file-selection and license rules in the two scripts identical).
set -euo pipefail

cd "$(dirname "$0")/.."

COPYRIGHT="Copyright (c) 2026 Valaris Studio"

license_for() {
  # LICENSES.md: runner/ is MIT, everything else defaults to AGPL-3.0-or-later
  case "$1" in
    runner/*) echo "MIT" ;;
    *)        echo "AGPL-3.0-or-later" ;;
  esac
}

comment_prefix() {
  case "$1" in
    *.py|*.sh) echo "#" ;;
    *)         echo "//" ;;
  esac
}

is_generated() {
  head -n 3 "$1" | grep -qE '^(//|#|/\*).*(DO NOT EDIT|[Aa]uto-?generated|@generated|Code generated)'
}

has_header() {
  head -n 12 "$1" | grep -q 'SPDX-License-Identifier:'
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

main() {
added=0
skipped=0

while IFS= read -r f; do
  if has_header "$f" || is_generated "$f"; then
    skipped=$((skipped + 1))
    continue
  fi

  prefix="$(comment_prefix "$f")"
  h1="$prefix $COPYRIGHT"
  h2="$prefix SPDX-License-Identifier: $(license_for "$f")"
  tmp="$(mktemp)"

  first_line="$(head -n 1 "$f" 2>/dev/null || true)"
  if [[ "$first_line" == '#!'* ]]; then
    # Header goes AFTER the shebang line.
    {
      head -n 1 "$f"
      printf '%s\n%s\n' "$h1" "$h2"
      second_line="$(sed -n '2p' "$f")"
      [[ -n "$second_line" ]] && echo ""
      tail -n +2 "$f"
    } > "$tmp"
  else
    {
      printf '%s\n%s\n' "$h1" "$h2"
      [[ -s "$f" && -n "$first_line" ]] && echo ""
      cat "$f"
    } > "$tmp"
  fi

  # cat-into (not mv) keeps the original file's permissions/exec bit
  cat "$tmp" > "$f"
  rm -f "$tmp"
  added=$((added + 1))
done < <(list_source_files)

echo "license headers: added=$added skipped=$skipped"
}

# The sweep edits this very script on a fresh checkout; `main` is parsed
# before any file changes, and `exit` on the invocation line stops bash
# from re-reading the (now shifted) script bytes afterwards.
main "$@"; exit "$?"
