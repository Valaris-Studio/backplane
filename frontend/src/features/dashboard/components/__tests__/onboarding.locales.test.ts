// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

// There is no i18n parity test in this repo — a missed es key ships silently
// (i18next falls back to English). This guards the onboarding namespace: for
// every user-facing sample key the es value must exist AND differ from en,
// i.e. be hand-written Spanish, not a copied English string.
//
// Deliberately excluded: keys whose es value is legitimately identical
// (onboarding.experimentalBadge "experimental", checklist.footerRunners
// "Runners" — runner vocabulary stays in English by convention).

const SAMPLE_KEYS = [
  // Welcome modal
  "welcome.title",
  "welcome.subtitle",
  "welcome.runnerFootnote",
  "welcome.setUpAction",
  "welcome.exploreAction",
  // Headline of every checklist area
  "checklist.stepBoardTitle",
  "checklist.stepContextTitle",
  "checklist.stepNotesTitle",
  "checklist.stepMembersTitle",
  "checklist.stepChannelsTitle",
  "checklist.stepReposTitle",
  // Panel chrome + runner footer
  "checklist.title",
  "checklist.subtitle",
  "checklist.allDoneTitle",
  "checklist.footerText",
  // Per-card state affordances
  "checklist.done",
  "checklist.skipped",
  "checklist.revisit",
  // Stage-B mini-form strings
  "checklist.stepContextPlaceholder",
  "checklist.stepContextNeedsBoard",
  "checklist.stepNotesTitlePlaceholder",
  "checklist.stepNotesBodyPlaceholder",
  "checklist.stepMembersEmailPlaceholder",
  "checklist.stepMembersRoleLabel",
  "checklist.stepMembersAddRow",
  "checklist.stepMembersSoloSkip",
  "checklist.stepChannelsNamePlaceholder",
  "checklist.stepReposNamePlaceholder",
  "checklist.stepReposUrlPlaceholder",
  "checklist.stepReposNeedsBoard",
  // Didactic step modals: per-step intro + bullets, and the form heading that
  // separates "learn about this" from "do it now".
  "checklist.stepModalFormHeading",
  "checklist.stepBoardIntro",
  "checklist.stepBoardBullet1",
  "checklist.stepBoardBullet2",
  "checklist.stepBoardBullet3",
  "checklist.stepContextIntro",
  "checklist.stepContextBullet1",
  "checklist.stepContextBullet2",
  "checklist.stepContextBullet3",
  "checklist.stepNotesIntro",
  "checklist.stepNotesBullet1",
  "checklist.stepNotesBullet2",
  "checklist.stepMembersIntro",
  "checklist.stepMembersBullet1",
  "checklist.stepMembersBullet2",
  "checklist.stepChannelsIntro",
  "checklist.stepChannelsBullet1",
  "checklist.stepChannelsBullet2",
  "checklist.stepReposIntro",
  "checklist.stepReposBullet1",
  "checklist.stepReposBullet2",
];

function lookup(locale: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      locale,
    );
}

describe("onboarding locales — es is hand-written, never a silent en fallback", () => {
  const enOnboarding = (en as Record<string, unknown>)
    .onboarding as Record<string, unknown>;
  const esOnboarding = (es as Record<string, unknown>)
    .onboarding as Record<string, unknown>;

  it("has an onboarding namespace in both locales", () => {
    expect(enOnboarding).toBeDefined();
    expect(esOnboarding).toBeDefined();
  });

  it.each(SAMPLE_KEYS)("onboarding.%s exists in es and differs from en", (key) => {
    const enValue = lookup(enOnboarding, key);
    const esValue = lookup(esOnboarding, key);

    expect(enValue, `en missing onboarding.${key}`).toBeTypeOf("string");
    expect((enValue as string).length).toBeGreaterThan(0);
    expect(esValue, `es missing onboarding.${key}`).toBeTypeOf("string");
    expect((esValue as string).length).toBeGreaterThan(0);
    expect(esValue, `es value for onboarding.${key} mirrors en`).not.toBe(
      enValue,
    );
  });

  it("keeps copy free of exclamation marks in both locales", () => {
    for (const key of SAMPLE_KEYS) {
      expect(String(lookup(enOnboarding, key))).not.toContain("!");
      expect(String(lookup(esOnboarding, key))).not.toContain("¡");
      expect(String(lookup(esOnboarding, key))).not.toContain("!");
    }
  });
});
