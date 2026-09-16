// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { NotificationPreferences } from "../../api/notifications-api";
import { predictMute, predictScope, predictToggle } from "../prefs-mutations";

function makePrefs(
  overrides: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return {
    relevance_scope: "watching",
    category_overrides: {},
    muted: false,
    effective: {
      card_assigned: { in_app: true },
      card_created: { in_app: false },
    },
    ...overrides,
  };
}

describe("predictToggle", () => {
  it("writes the sparse override AND flips the matching effective cell", () => {
    const next = predictToggle(makePrefs(), "card_created", "in_app", true);
    expect(next.category_overrides).toEqual({ card_created: { in_app: true } });
    expect(next.effective.card_created).toEqual({ in_app: true });
  });

  it("leaves untouched cells alone", () => {
    const next = predictToggle(makePrefs(), "card_created", "in_app", true);
    expect(next.effective.card_assigned).toEqual({ in_app: true });
  });

  it("does not mutate the input prefs (new references for React Query)", () => {
    const prefs = makePrefs();
    const next = predictToggle(prefs, "card_created", "in_app", true);
    expect(prefs.category_overrides).toEqual({});
    expect(prefs.effective.card_created).toEqual({ in_app: false });
    expect(next).not.toBe(prefs);
    expect(next.effective).not.toBe(prefs.effective);
  });

  it("merges into an existing override for the same category", () => {
    const prefs = makePrefs({
      category_overrides: { card_created: { email: false } },
      effective: { card_created: { in_app: false, email: false } },
    });
    const next = predictToggle(prefs, "card_created", "in_app", true);
    expect(next.category_overrides.card_created).toEqual({
      email: false,
      in_app: true,
    });
  });
});

describe("predictMute", () => {
  it("forces every effective cell off when muting", () => {
    const next = predictMute(makePrefs(), true);
    expect(next.muted).toBe(true);
    expect(next.effective.card_assigned).toEqual({ in_app: false });
    expect(next.effective.card_created).toEqual({ in_app: false });
  });

  it("only flips the muted flag when unmuting (server repaints effective)", () => {
    const prefs = makePrefs({ muted: true });
    const next = predictMute(prefs, false);
    expect(next.muted).toBe(false);
    // effective is left for the PUT response to reconcile
    expect(next.effective).toEqual(prefs.effective);
  });
});

describe("predictScope", () => {
  it("sets only the scope field (server recomputes effective defaults)", () => {
    const next = predictScope(makePrefs(), "everything");
    expect(next.relevance_scope).toBe("everything");
    expect(next.effective).toEqual(makePrefs().effective);
  });
});
