// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import i18n from "i18next";
import "@/i18n/config";
import {
  NOTE_KINDS,
  NOTE_KIND_META,
  noteOrigin,
  isAgentNote,
  isBadgedKind,
  isKnownFailureClass,
  failureClassLabelKey,
  matchesOriginFilter,
  kindsForOrigins,
  FAILURE_CLASSES,
} from "../noteKinds";

describe("note kind origin", () => {
  it("treats user_note as human and everything else as agent", () => {
    expect(noteOrigin("user_note")).toBe("human");
    expect(isAgentNote("user_note")).toBe(false);
    for (const kind of NOTE_KINDS.filter((k) => k !== "user_note")) {
      expect(noteOrigin(kind)).toBe("agent");
      expect(isAgentNote(kind)).toBe(true);
    }
  });

  it("defaults unknown kinds to human (never falsely marks them agentic)", () => {
    expect(noteOrigin("totally_made_up")).toBe("human");
    expect(isAgentNote("totally_made_up")).toBe(false);
  });
});

describe("origin filter predicate", () => {
  it("passes everything when nothing is selected", () => {
    expect(matchesOriginFilter("plan", [])).toBe(true);
    expect(matchesOriginFilter("user_note", [])).toBe(true);
  });

  it("filters to the selected origin", () => {
    expect(matchesOriginFilter("user_note", ["human"])).toBe(true);
    expect(matchesOriginFilter("plan", ["human"])).toBe(false);
    expect(matchesOriginFilter("plan", ["agent"])).toBe(true);
    expect(matchesOriginFilter("user_note", ["agent"])).toBe(false);
  });

  it("passes when either origin is selected", () => {
    expect(matchesOriginFilter("plan", ["human", "agent"])).toBe(true);
    expect(matchesOriginFilter("user_note", ["human", "agent"])).toBe(true);
  });
});

describe("badged kinds", () => {
  it("excludes the human default but includes every agent kind", () => {
    expect(isBadgedKind("user_note")).toBe(false);
    expect(isBadgedKind("plan")).toBe(true);
    expect(isBadgedKind("review_verdict")).toBe(true);
    expect(isBadgedKind("unknown")).toBe(false);
  });
});

describe("i18n coverage", () => {
  it("every note kind has a non-key label and description", () => {
    for (const kind of NOTE_KINDS) {
      const meta = NOTE_KIND_META[kind];
      const label = i18n.t(meta.labelKey);
      const description = i18n.t(meta.descriptionKey);
      expect(label).not.toBe(meta.labelKey);
      expect(description).not.toBe(meta.descriptionKey);
      expect(label.length).toBeGreaterThan(0);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it("every failure class has a non-key label", () => {
    for (const fc of FAILURE_CLASSES) {
      expect(isKnownFailureClass(fc)).toBe(true);
      const label = i18n.t(failureClassLabelKey(fc));
      expect(label).not.toBe(failureClassLabelKey(fc));
    }
  });
});

describe("kindsForOrigins — the server-side form of the origin filter", () => {
  it("returns undefined for an empty selection (no filter)", () => {
    expect(kindsForOrigins([])).toBeUndefined();
  });

  it("returns undefined when every origin is selected", () => {
    // Sending an explicit allowlist here would hide any operator-added kind
    // the frontend catalog doesn't know about.
    expect(kindsForOrigins(["human", "agent"])).toBeUndefined();
  });

  it("expands 'agent' to every agent-origin kind", () => {
    expect([...(kindsForOrigins(["agent"]) ?? [])].sort()).toEqual(
      ["plan", "review_verdict", "rework_brief", "system"].sort(),
    );
  });

  it("expands 'human' to the human kinds", () => {
    expect(kindsForOrigins(["human"])).toEqual(["user_note"]);
  });
});
