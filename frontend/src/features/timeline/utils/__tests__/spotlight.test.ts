// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { shouldBurst } from "../spotlight";
import type { StepDescriptor } from "../event-descriptor";

// shouldBurst is the PURE rule behind the spotlight particle burst: it fires
// ONLY during active Play, with motion allowed, and ONLY for a SPECIAL milestone
// kind (card create/delete) so the heavier burst differentiates those notable
// moments from routine moves/updates. Role-agnostic — keys off the descriptor's
// structural kind, never any opaque classifier value.

function descriptor(overrides: Partial<StepDescriptor> = {}): StepDescriptor {
  return {
    kind: "card-create",
    targetCardId: "card1",
    relatedCardId: null,
    touchesBoard: true,
    accentToken: "--color-success",
    iconName: "Plus",
    detail: {},
    ...overrides,
  };
}

describe("shouldBurst", () => {
  it("bursts for a card CREATE while playing with motion allowed", () => {
    expect(shouldBurst(descriptor({ kind: "card-create" }), true, false)).toBe(true);
  });

  it("bursts for a card DELETE (the other milestone kind)", () => {
    expect(
      shouldBurst(
        descriptor({ kind: "card-delete", accentToken: "--color-destructive" }),
        true,
        false,
      ),
    ).toBe(true);
  });

  it("does NOT burst for a routine MOVE (glow/ring only)", () => {
    expect(shouldBurst(descriptor({ kind: "card-move" }), true, false)).toBe(false);
  });

  it("does NOT burst for a routine UPDATE", () => {
    expect(shouldBurst(descriptor({ kind: "card-update" }), true, false)).toBe(false);
  });

  it("does NOT burst for a dependency or note step", () => {
    expect(
      shouldBurst(descriptor({ kind: "dependency", touchesBoard: false }), true, false),
    ).toBe(false);
    expect(
      shouldBurst(descriptor({ kind: "note", touchesBoard: false, targetCardId: null }), true, false),
    ).toBe(false);
  });

  it("does NOT burst when paused", () => {
    expect(shouldBurst(descriptor(), false, false)).toBe(false);
  });

  it("NEVER bursts under reduced motion, even while playing", () => {
    expect(shouldBurst(descriptor(), true, true)).toBe(false);
  });
});
