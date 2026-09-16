// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  replaceRange,
  replaceAll,
  deriveKind,
  countOccurrences,
  findMatchRange,
  RUNNER_VAR_PATTERN,
} from "../lib/slot-marking";

// Card 41bf51d3 (p3-08) — the pure half of "Save as template…".
//
// These helpers are what makes the marking view testable at all: jsdom's
// getSelection is partial, so the sheet injects a selection provider and the
// OFFSET MATH lives here, where it can be pinned exactly.
//
// The card's DoD named `frontend/src/lib/__tests__/slot-marking.test.ts`; the
// loop-templates feature owns its own `lib/`, and every sibling helper
// (slot-catalog, prompt-validation, rails-catalog) lives there, so this file
// follows the established module boundary instead.

describe("replaceRange", () => {
  it("substitutes the slot token for the selected offsets", () => {
    expect(replaceRange("deploy to acme-prod now", 10, 19, "TARGET")).toBe(
      "deploy to <<TARGET>> now",
    );
  });

  it("keeps text outside the range byte-identical", () => {
    const text = "a\n  indented\nb";
    expect(replaceRange(text, 4, 12, "X")).toBe("a\n  <<X>>\nb");
  });

  it("handles a range at the very start and very end", () => {
    expect(replaceRange("head tail", 0, 4, "A")).toBe("<<A>> tail");
    expect(replaceRange("head tail", 5, 9, "B")).toBe("head <<B>>");
  });

  it("returns the text unchanged when the range is collapsed", () => {
    // A caret with no selection must never inject an empty slot.
    expect(replaceRange("unchanged", 3, 3, "X")).toBe("unchanged");
  });

  it("returns the text unchanged when the range is inverted or out of bounds", () => {
    expect(replaceRange("abc", 2, 1, "X")).toBe("abc");
    expect(replaceRange("abc", -1, 2, "X")).toBe("abc");
    expect(replaceRange("abc", 1, 99, "X")).toBe("abc");
  });
});

describe("replaceAll", () => {
  it("replaces every identical occurrence and reports the count", () => {
    const text = "acme-prod is one, acme-prod is two";
    const result = replaceAll(text, "acme-prod", "TARGET");
    expect(result.text).toBe("<<TARGET>> is one, <<TARGET>> is two");
    expect(result.count).toBe(2);
  });

  it("treats the needle literally, not as a regex", () => {
    // A prompt legitimately contains regex metacharacters; a naive
    // `new RegExp(needle)` would either throw or match the wrong span.
    const text = "match a.c and abc";
    const result = replaceAll(text, "a.c", "DOT");
    expect(result.text).toBe("match <<DOT>> and abc");
    expect(result.count).toBe(1);
  });

  it("reports zero and leaves the text alone when the needle is absent", () => {
    const result = replaceAll("nothing here", "missing", "X");
    expect(result.text).toBe("nothing here");
    expect(result.count).toBe(0);
  });

  it("does not loop forever when the replacement contains the needle", () => {
    const result = replaceAll("X and X", "X", "X");
    expect(result.text).toBe("<<X>> and <<X>>");
    expect(result.count).toBe(2);
  });
});

describe("deriveKind", () => {
  // Operator direction 2026-08-16: newline in the range -> block, else scalar.
  it("calls a single-line range scalar", () => {
    expect(deriveKind("acme-prod")).toBe("scalar");
  });

  it("calls a multi-line range block", () => {
    expect(deriveKind("line one\nline two")).toBe("block");
  });

  it("calls a trailing newline block", () => {
    expect(deriveKind("one\n")).toBe("block");
  });
});

describe("countOccurrences", () => {
  it("counts literal occurrences, including regex metacharacters", () => {
    expect(countOccurrences("a.c a.c abc", "a.c")).toBe(2);
  });

  it("counts zero for an empty needle rather than dividing by nothing", () => {
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("findMatchRange", () => {
  // The leak-lint Finding carries `match` and a 1-based `line` but NO character
  // offset (backend app/services/loop_template_lint.py). The "make slot"
  // shortcut therefore has to recover offsets itself, and it must anchor on the
  // reported LINE — the same token often appears on several lines.
  it("locates the match on the reported line", () => {
    const text = "intro\nsee https://example.com/x now\ntail";
    expect(findMatchRange(text, "https://example.com/x", 2)).toEqual({
      start: 10,
      end: 31,
    });
  });

  it("prefers the occurrence on the reported line over an earlier one", () => {
    const text = "acme here\nacme there";
    expect(findMatchRange(text, "acme", 2)).toEqual({ start: 10, end: 14 });
  });

  it("falls back to the first occurrence when the line does not contain it", () => {
    const text = "acme here\nsomething else";
    expect(findMatchRange(text, "acme", 2)).toEqual({ start: 0, end: 4 });
  });

  it("returns null when the match is absent entirely", () => {
    expect(findMatchRange("nothing", "absent", 1)).toBeNull();
  });
});

describe("RUNNER_VAR_PATTERN", () => {
  // The five runner variables are a FIXED contract with the Go runner and are
  // never slots; marking must leave them intact.
  it("matches the double-brace runner vars", () => {
    const found = "run {{.Workspace}} on {{.BoardID}}".match(
      RUNNER_VAR_PATTERN,
    );
    expect(found).toEqual(["{{.Workspace}}", "{{.BoardID}}"]);
  });

  it("does not match slot tokens", () => {
    expect("<<TARGET>>".match(RUNNER_VAR_PATTERN)).toBeNull();
  });
});
