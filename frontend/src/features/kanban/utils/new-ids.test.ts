// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { newIdsSince } from "./new-ids";

describe("newIdsSince", () => {
  it("returns all ids when nothing was seen before (first mount)", () => {
    expect(newIdsSince(["a", "b", "c"], null)).toEqual(["a", "b", "c"]);
  });

  it("returns only ids absent from the previous set", () => {
    const prev = new Set(["a", "b"]);
    expect(newIdsSince(["a", "b", "c"], prev)).toEqual(["c"]);
  });

  it("returns empty when nothing is new (reorder / single-card update)", () => {
    const prev = new Set(["a", "b", "c"]);
    expect(newIdsSince(["c", "a", "b"], prev)).toEqual([]);
  });

  it("ignores removals — only additions are 'new'", () => {
    const prev = new Set(["a", "b", "c"]);
    expect(newIdsSince(["a"], prev)).toEqual([]);
  });
});
