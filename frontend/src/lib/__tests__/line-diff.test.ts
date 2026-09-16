// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { diffLines, DIFF_LINE_LIMIT, type DiffRow } from "../line-diff";

const types = (rows: DiffRow[]) => rows.map((r) => r.type).join(",");
const text = (rows: DiffRow[]) => rows.map((r) => `${r.type}:${r.line}`);

describe("diffLines", () => {
  it("marks every line equal when both sides are identical", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");

    expect(rows.tooLarge).toBe(false);
    expect(types(rows.rows)).toBe("eq,eq,eq");
    expect(rows.rows.map((r) => r.line)).toEqual(["a", "b", "c"]);
  });

  it("reports a pure addition as add rows and keeps the common prefix equal", () => {
    const rows = diffLines("a\nb", "a\nb\nc\nd");

    expect(text(rows.rows)).toEqual(["eq:a", "eq:b", "add:c", "add:d"]);
  });

  it("reports a pure deletion as del rows", () => {
    const rows = diffLines("a\nb\nc\nd", "a\nb");

    expect(text(rows.rows)).toEqual(["eq:a", "eq:b", "del:c", "del:d"]);
  });

  it("interleaves adds and dels around the preserved common subsequence", () => {
    // LCS of [a,b,c,d,e] / [a,x,c,y,e] is [a,c,e] — b→x and d→y are edits.
    const rows = diffLines("a\nb\nc\nd\ne", "a\nx\nc\ny\ne");

    expect(rows.rows.filter((r) => r.type === "eq").map((r) => r.line)).toEqual([
      "a",
      "c",
      "e",
    ]);
    expect(
      rows.rows.filter((r) => r.type === "del").map((r) => r.line),
    ).toEqual(["b", "d"]);
    expect(
      rows.rows.filter((r) => r.type === "add").map((r) => r.line),
    ).toEqual(["x", "y"]);
    // A del is emitted before the add that replaces it, so a unified render
    // reads as "was → now" rather than grouping all removals at the end.
    expect(types(rows.rows)).toBe("eq,del,add,eq,del,add,eq");
  });

  // The two tests below pin LCS OPTIMALITY, which the equality check in the
  // forward walk cannot provide on its own: they are the cases where a
  // mis-built or mis-indexed table silently yields a longer, wronger diff.
  it("keeps the maximal common subsequence when the sides are different lengths", () => {
    // LCS of [A..G] / [B,A,G] is [B,G]: a table read with transposed indices
    // loses the trailing G and reports one more add and one more del.
    const rows = diffLines("A\nB\nC\nD\nE\nF\nG", "B\nA\nG");

    expect(rows.rows.filter((r) => r.type === "eq").map((r) => r.line)).toEqual([
      "B",
      "G",
    ]);
    expect(rows.added).toBe(1);
    expect(rows.removed).toBe(5);
  });

  it("prefers the deletion branch when both branches keep the same run length", () => {
    // For [A,B,C,D] / [B,A,D,C] the table is tied at C: taking the shorter
    // branch (a min instead of a max) reorders the hunk to "aA dC".
    const rows = diffLines("A\nB\nC\nD", "B\nA\nD\nC");

    expect(text(rows.rows)).toEqual([
      "del:A",
      "eq:B",
      "del:C",
      "add:A",
      "eq:D",
      "add:C",
    ]);
  });

  it("treats two empty inputs as a single equal empty line, not a diff", () => {
    const rows = diffLines("", "");

    expect(rows.tooLarge).toBe(false);
    expect(rows.rows.every((r) => r.type === "eq")).toBe(true);
    expect(rows.added).toBe(0);
    expect(rows.removed).toBe(0);
  });

  it("diffs an empty original against content as all adds", () => {
    const rows = diffLines("", "a\nb");

    expect(rows.rows.filter((r) => r.type === "add").map((r) => r.line)).toEqual(
      ["a", "b"],
    );
    expect(rows.added).toBe(2);
  });

  it("counts added and removed lines", () => {
    const rows = diffLines("a\nb\nc", "a\nx\nc\nz");

    expect(rows.removed).toBe(1);
    expect(rows.added).toBe(2);
  });

  it("returns a tooLarge sentinel instead of running O(n*m) on huge inputs", () => {
    const huge = Array.from({ length: DIFF_LINE_LIMIT + 1 }, (_, i) => `L${i}`);
    const rows = diffLines(huge.join("\n"), "a");

    expect(rows.tooLarge).toBe(true);
    expect(rows.rows).toEqual([]);
  });

  it("stays under the guard when both sides are exactly at the limit", () => {
    const atLimit = Array.from({ length: DIFF_LINE_LIMIT }, (_, i) => `L${i}`);
    const rows = diffLines(atLimit.join("\n"), atLimit.join("\n"));

    expect(rows.tooLarge).toBe(false);
    expect(rows.rows).toHaveLength(DIFF_LINE_LIMIT);
  });

  it("normalizes CRLF so a line-ending change alone is not a diff", () => {
    const rows = diffLines("a\r\nb", "a\nb");

    expect(types(rows.rows)).toBe("eq,eq");
    expect(rows.added).toBe(0);
    expect(rows.removed).toBe(0);
  });
});
