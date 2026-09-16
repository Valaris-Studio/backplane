// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { DEP_EVENTS, isDependencyEvent } from "../dependency-events";

// FE<->backend parity: the dependency-edit WS events the FE must react to.
// The bulk-set path (mcp bulk_set_card_dependencies) emits the 'ies' spelling
// `dependencies_replaced`, which the old `startsWith("activity.card.dependency_")`
// prefix DID match but is asserted here explicitly to lock the contract.
describe("isDependencyEvent", () => {
  it("matches all three real backend dependency event names", () => {
    expect(isDependencyEvent("activity.card.dependency_added")).toBe(true);
    expect(isDependencyEvent("activity.card.dependency_removed")).toBe(true);
    expect(isDependencyEvent("activity.card.dependencies_replaced")).toBe(true);
  });

  it("matches the bulk dependencies_replaced event (the dropped one)", () => {
    // Regression: bulk_set_card_dependencies emits 'dependencies_' WITH an
    // 'ies'. A naive `activity.card.dependency_` prefix without the explicit
    // set would silently drop it; this is the surface agents use.
    expect(isDependencyEvent("activity.card.dependencies_replaced")).toBe(true);
    expect(DEP_EVENTS.has("activity.card.dependencies_replaced")).toBe(true);
  });

  it("does NOT match unrelated card events", () => {
    expect(isDependencyEvent("activity.card.updated")).toBe(false);
    expect(isDependencyEvent("activity.card.moved")).toBe(false);
    expect(isDependencyEvent("card.updated")).toBe(false);
    // Guard against a too-loose prefix matching a future unrelated name.
    expect(isDependencyEvent("activity.card.dependency_graph_recomputed")).toBe(
      false,
    );
  });

  it("exposes exactly the three names in the set", () => {
    expect([...DEP_EVENTS].sort()).toEqual(
      [
        "activity.card.dependencies_replaced",
        "activity.card.dependency_added",
        "activity.card.dependency_removed",
      ].sort(),
    );
  });
});
