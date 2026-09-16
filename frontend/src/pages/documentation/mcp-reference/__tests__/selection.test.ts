// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { parseSelectionHash, selectionHash } from "../selection";

describe("parseSelectionHash", () => {
  it("round-trips a resource uri through percent-encoding", () => {
    const selection = { kind: "resource", id: "valaris://workspaces" } as const;
    expect(parseSelectionHash(selectionHash(selection))).toEqual(selection);
  });

  it("returns null for a truncated percent-escape instead of throwing", () => {
    // Chat apps cut long shared URLs mid-escape; must degrade, not crash.
    expect(parseSelectionHash("#resource-valaris%2")).toBeNull();
  });
});
