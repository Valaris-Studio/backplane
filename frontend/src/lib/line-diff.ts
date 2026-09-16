// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Line diff, in house.
 *
 * The MIT-only direct-dependency rule rules out jsdiff (BSD-3), and a template
 * prompt diff needs nothing more than line granularity, so this is a plain
 * LCS walk rather than Myers: prompts are hundreds of lines, not thousands.
 */

export type DiffRowType = "eq" | "add" | "del";

export interface DiffRow {
  type: DiffRowType;
  line: string;
}

export interface LineDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** True when the guard tripped: `rows` is empty and callers must say so. */
  tooLarge: boolean;
}

/**
 * Per-side line ceiling. The LCS table is O(n*m) cells, so 5 000 x 5 000 is
 * the point where the tab would jank instead of render; past it we show a
 * "too large to diff" notice rather than freezing the page.
 */
export const DIFF_LINE_LIMIT = 5000;

// Trailing \r would make every line of a CRLF document differ from its LF
// twin, which reads as a whole-file rewrite for what is not a content change.
const splitLines = (text: string): string[] => text.replace(/\r\n?/g, "\n").split("\n");

export function diffLines(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > DIFF_LINE_LIMIT || b.length > DIFF_LINE_LIMIT) {
    return { rows: [], added: 0, removed: 0, tooLarge: true };
  }

  // lcs[i * width + j] = length of the longest common subsequence of a[i:] and
  // b[j:]. One flat Int32Array rather than an array of arrays: it types as a
  // total function over the index space (no `number | undefined` at every
  // read under noUncheckedIndexedAccess) and keeps the table in one buffer.
  // Filled backwards so the forward walk can pick the longer branch with a
  // single comparison.
  const width = b.length + 1;
  const lcs = new Int32Array((a.length + 1) * width);
  // Every (i, j) in 0..len is allocated above, so a read is always in bounds;
  // `at` exists to say that once instead of asserting at each of the six reads
  // (noUncheckedIndexedAccess types even a TypedArray read as possibly undefined).
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const left = a[i] as string;
    const right = b[j] as string;
    if (left === right) {
      rows.push({ type: "eq", line: left });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      // Emitting the del before the add makes a replaced line read "was → now"
      // in a unified render instead of pooling removals at the end of a hunk.
      rows.push({ type: "del", line: left });
      removed++;
      i++;
    } else {
      rows.push({ type: "add", line: right });
      added++;
      j++;
    }
  }
  while (i < a.length) {
    rows.push({ type: "del", line: a[i] as string });
    removed++;
    i++;
  }
  while (j < b.length) {
    rows.push({ type: "add", line: b[j] as string });
    added++;
    j++;
  }

  return { rows, added, removed, tooLarge: false };
}
