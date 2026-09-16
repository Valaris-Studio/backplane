// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { parseCsv } from "../parse-csv";

describe("parseCsv", () => {
  it("parses a simple grid", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    expect(parseCsv('name,note\n"Doe, John","hi, there"')).toEqual([
      ["name", "note"],
      ["Doe, John", "hi, there"],
    ]);
  });

  it("handles escaped double-quotes", () => {
    expect(parseCsv('q\n"she said ""hi"""')).toEqual([
      ["q"],
      ['she said "hi"'],
    ]);
  });

  it("handles embedded newlines inside quotes", () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([
      ["a"],
      ["line1\nline2"],
    ]);
  });

  it("treats \\r\\n as a single line break", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("does not emit a trailing empty row for a clean final newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});
