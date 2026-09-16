// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";

// Card 7f7eb6a7 (F10) — three DIFFERENT template actions, three different words.
//
// The board loop dialog puts all three within one screen of each other:
//
//   boardLoop.templates.applyTemplate  the link that OPENS the chooser, from
//                                      which a slotted template is BOUND
//   boardLoop.template.label           the legacy raw select, which COPIES a
//                                      slotless template's prompts in
//   boardLoop.templates.bind.save      the button that COMMITS a binding
//
// Before this card en read "Apply a template…" / "Apply template" for the
// first and third, and es and pt-BR collapsed to "Aplicar (una) plantilla".
// The operator had no way to tell which one they were about to press. The
// strings must differ by more than punctuation, in EVERY locale — i18next
// falls back to English silently, so a translated collision is invisible.

const CATALOGS = { en, es, "pt-BR": ptBR } as const;

/** The three keys the dialog renders side by side. */
const APPLY_KEYS = [
  "boardLoop.templates.applyTemplate",
  "boardLoop.template.label",
  "boardLoop.templates.bind.save",
] as const;

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

/**
 * Copy compared the way a reader tells labels apart: case, ellipsis, articles
 * and trailing punctuation carry no meaning here, so "Apply template" and
 * "Apply a template…" must NOT count as distinct.
 */
function significantWords(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[….,:;!?"'’“”()]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !["a", "an", "the", "un", "una", "um", "uma"].includes(word))
    .join(" ");
}

describe("loop-template apply copy is distinct per action (card 7f7eb6a7)", () => {
  it.each(Object.keys(CATALOGS))(
    "%s gives the chooser, the raw copy-in and the bind commit different words",
    (locale) => {
      const catalog = CATALOGS[locale as keyof typeof CATALOGS];
      const values = APPLY_KEYS.map((key) => {
        const value = lookup(catalog, key);
        expect(typeof value, `${locale} is missing ${key}`).toBe("string");
        return significantWords(value as string);
      });
      expect(new Set(values).size, `${locale}: ${values.join(" | ")}`).toBe(
        APPLY_KEYS.length,
      );
    },
  );

  it("names the chooser after the template, not after applying one", () => {
    // The chooser does not apply anything — it opens a picker. Naming it
    // "Apply…" is what made it indistinguishable from the button that does.
    expect(lookup(en, "boardLoop.templates.applyTemplate")).not.toMatch(
      /^apply/i,
    );
  });

  it("names the legacy select after what it does to the prompts", () => {
    // "Start from a template" reads like the chooser. The raw path REPLACES
    // the board's prompts in place, which is the fact the operator needs.
    expect(lookup(en, "boardLoop.template.label")).toMatch(/copy|replace/i);
  });
});
