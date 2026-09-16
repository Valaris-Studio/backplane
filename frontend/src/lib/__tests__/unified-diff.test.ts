// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../unified-diff";

// The backend (`loop_template_drift.diff_binding`) returns difflib unified-diff
// TEXT, not the before/after pair `diffLines` takes. These cases pin the shape
// difflib actually emits, so the renderer can share LineDiff's row vocabulary.
describe("parseUnifiedDiff", () => {
  it("drops the ---/+++ file headers and the @@ hunk header", () => {
    const text = [
      "--- system_prompt (bound)",
      "+++ system_prompt (current)",
      "@@ -1,3 +1,3 @@",
      " keep me",
      "-old line",
      "+new line",
      " tail",
      "",
    ].join("\n");

    const rows = parseUnifiedDiff(text);

    expect(rows.map((row) => row.line)).toEqual([
      "keep me",
      "old line",
      "new line",
      "tail",
    ]);
    expect(rows.map((row) => row.type)).toEqual(["eq", "del", "add", "eq"]);
  });

  it("returns no rows for the empty string the backend sends when nothing changed", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("strips only the ONE marker column, preserving leading whitespace of the line", () => {
    const text = ["@@ -1 +1 @@", "-    indented old", "+    indented new"].join(
      "\n",
    );

    expect(parseUnifiedDiff(text)).toEqual([
      { type: "del", line: "    indented old" },
      { type: "add", line: "    indented new" },
    ]);
  });

  it("keeps a body line that merely starts with --- or +++ when it carries a marker", () => {
    // A prompt containing a markdown rule (`---`) survives difflib as `+---`.
    // Header detection must not swallow it.
    const text = ["@@ -1 +2 @@", "+---", "+++ not a header because of the marker"].join(
      "\n",
    );

    expect(parseUnifiedDiff(text)).toEqual([
      { type: "add", line: "---" },
      { type: "add", line: "++ not a header because of the marker" },
    ]);
  });

  it("counts every hunk, not just the first", () => {
    const text = [
      "--- loop_prompt (bound)",
      "+++ loop_prompt (current)",
      "@@ -1,2 +1,2 @@",
      "-first",
      "+FIRST",
      "@@ -20,2 +20,2 @@",
      "-second",
      "+SECOND",
    ].join("\n");

    expect(parseUnifiedDiff(text).map((row) => row.line)).toEqual([
      "first",
      "FIRST",
      "second",
      "SECOND",
    ]);
  });

  it("renders difflib's \\ No newline marker as context, never as an addition", () => {
    const text = ["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join(
      "\n",
    );

    expect(parseUnifiedDiff(text).map((row) => row.type)).toEqual(["del", "add"]);
  });
});
