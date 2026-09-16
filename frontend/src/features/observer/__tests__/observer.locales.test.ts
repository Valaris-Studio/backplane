// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

// The Event Inspector page was folded into the Observer sheet (card 43fcab09).
// Its user-facing strings were MOVED, not retranslated — so the es catalog must
// carry every new observer.* key, and no eventInspector.* key may survive in
// either catalog. i18next silently falls back to English on a missing key, so
// without this guard a half-finished move ships as English-in-Spanish.

const MOVED_KEYS = [
  "observer.search.placeholder",
  "observer.search.label",
  "observer.counts",
  "observer.namespaces.other",
];

function lookup(catalog: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, seg) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[seg]
          : undefined,
      catalog,
    );
}

describe("observer i18n parity after the Event Inspector consolidation", () => {
  it.each(MOVED_KEYS)("defines %s in both en and es", (key) => {
    expect(typeof lookup(en, key)).toBe("string");
    expect(typeof lookup(es, key)).toBe("string");
  });

  it("has no eventInspector namespace left in either catalog", () => {
    expect(lookup(en, "eventInspector")).toBeUndefined();
    expect(lookup(es, "eventInspector")).toBeUndefined();
  });

  it("has no nav.eventInspector label left in either catalog", () => {
    expect(lookup(en, "nav.eventInspector")).toBeUndefined();
    expect(lookup(es, "nav.eventInspector")).toBeUndefined();
  });

  it("translated the moved strings rather than copying the English", () => {
    // These four are prose, not identifiers — an identical es value means the
    // move dropped the existing Spanish translation on the floor.
    for (const key of MOVED_KEYS) {
      expect(lookup(es, key)).not.toBe(lookup(en, key));
    }
  });
});
