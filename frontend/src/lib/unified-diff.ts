// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reader for the unified-diff TEXT the backend computes.
 *
 * `GET /loop/binding/diff` does the diffing server-side (difflib), so unlike
 * the Versions tab there is no before/after pair to feed `diffLines` — the
 * work is already done and re-deriving it client-side could only disagree with
 * what the backend decided drifted. This parser therefore translates difflib's
 * output into the SAME `DiffRow` vocabulary `LineDiff` renders, so both diff
 * surfaces look identical without duplicating the presentation.
 */

import type { DiffRow } from "./line-diff";

// Order matters: a body line inside a hunk also begins with `+`/`-`, so the
// file headers can only be recognised BEFORE any hunk has started.
const HUNK_HEADER = /^@@ /;

export function parseUnifiedDiff(text: string): DiffRow[] {
  if (!text) return [];

  const rows: DiffRow[] = [];
  let inHunk = false;

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (HUNK_HEADER.test(raw)) {
      inHunk = true;
      continue;
    }
    // difflib's ---/+++ pair precedes the first @@; once inside a hunk the same
    // prefixes are content (a prompt line of `---` arrives as `+---`).
    if (!inHunk) continue;
    // "\ No newline at end of file" describes the previous line rather than
    // being one; rendering it as an add would invent a change.
    if (raw.startsWith("\\")) continue;
    if (raw === "") continue;

    const marker = raw[0];
    const line = raw.slice(1);
    if (marker === "+") rows.push({ type: "add", line });
    else if (marker === "-") rows.push({ type: "del", line });
    else rows.push({ type: "eq", line });
  }

  return rows;
}
