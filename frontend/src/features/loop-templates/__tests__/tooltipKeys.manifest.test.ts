// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";
import {
  TOOLTIP_KEYS,
  RAIL_TOOLTIP_RAILS,
  SLOT_TOOLTIP_FIELDS,
} from "../lib/tooltip-keys";
import { SLOT_KINDS } from "../lib/slot-catalog";

// The catalogs are read as raw JSON, never through i18next. Going through the
// live instance would let es silently resolve against the en fallback bundle —
// which is exactly the drift this suite exists to catch.
type Panel = {
  summary?: unknown;
  rows?: unknown;
  callouts?: unknown;
  examples?: unknown;
  links?: unknown;
};

const CATALOGS: Array<[string, Record<string, unknown>]> = [
  ["en", en as Record<string, unknown>],
  ["es", es as Record<string, unknown>],
  // pt-BR is a contract-tested locale (locales.contract.test.ts), but the
  // resolution + scannability checks below were only ever run over two of the
  // three — a pt-BR tooltip could go missing and no gate would say so.
  ["pt-BR", ptBR as Record<string, unknown>],
];

function lookup(
  catalog: Record<string, unknown>,
  i18nKey: string,
): unknown | undefined {
  let node: unknown = catalog;
  for (const segment of `ui.tooltips.${i18nKey}`.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function panel(catalog: Record<string, unknown>, i18nKey: string): Panel {
  const raw = lookup(catalog, i18nKey);
  return raw && typeof raw === "object" ? (raw as Panel) : {};
}

describe("loop-template tooltip manifest", () => {
  it("lists every rail the rails catalog can render", () => {
    // A rail added to rails-catalog.ts renders an EMPTY tooltip rather than
    // throwing, so the manifest — not the component — is what catches it.
    expect(RAIL_TOOLTIP_RAILS).toContain("max_blocked_on_human");
    expect(RAIL_TOOLTIP_RAILS).toContain("starvation_policy");
    expect(RAIL_TOOLTIP_RAILS).toContain("provider");
    expect(RAIL_TOOLTIP_RAILS).toHaveLength(11);
  });

  it("lists every slot field the Slots tab explains (card 3ac481c5)", () => {
    // Card 7ca064f6 brought RichTooltips to these screens and the manifest
    // never listed the slots namespace, so the drift test stayed green over a
    // hole. Enumerating the fields here is what closes it: a tooltip added to
    // a slot control without copy now fails resolution below.
    for (const field of SLOT_TOOLTIP_FIELDS) {
      expect(TOOLTIP_KEYS).toContain(`loopTemplates.slots.${field}`);
    }
    expect(SLOT_TOOLTIP_FIELDS).toContain("variant");
  });

  it.each(CATALOGS)("resolves every manifest key in %s", (_locale, catalog) => {
    const missing = TOOLTIP_KEYS.filter((key) => {
      const summary = panel(catalog, key).summary;
      return typeof summary !== "string" || summary.trim() === "";
    });
    expect(missing).toEqual([]);
  });

  it.each(CATALOGS)("keeps %s summaries scannable (<=140 chars)", (_l, cat) => {
    const tooLong = TOOLTIP_KEYS.filter(
      (key) => String(panel(cat, key).summary ?? "").length > 140,
    );
    expect(tooLong).toEqual([]);
  });

  it("gives every rail panel a What/Why row pair", () => {
    for (const rail of RAIL_TOOLTIP_RAILS) {
      const rows = panel(
        en as Record<string, unknown>,
        `loopTemplates.rails.${rail}`,
      ).rows;
      expect(Array.isArray(rows), `${rail} has no rows`).toBe(true);
      const labels = (rows as Array<{ label?: string }>).map((r) => r.label);
      expect(labels, `${rail} rows`).toContain("What");
      expect(labels, `${rail} rows`).toContain("Why");
    }
  });

  it("cites the anatomy-note provenance on the rails that have a lesson", () => {
    // Spot-check five, each quoting the loop that taught the rail (anatomy
    // note 414a07b5 §2 rails table + §6 failure modes).
    const provenance: Array<[string, RegExp]> = [
      ["max_consecutive_failures", /Loop #4\/#5/],
      ["max_blocked_on_human", /Loop #6/],
      ["iteration_timeout_seconds", /Loop #7/],
      ["budget_usd", /\$30/],
      ["loop_landing", /self-improve/],
    ];
    for (const [rail, pattern] of provenance) {
      const callouts = panel(
        en as Record<string, unknown>,
        `loopTemplates.rails.${rail}`,
      ).callouts as Array<{ text?: string }> | undefined;
      const text = (callouts ?? []).map((c) => c.text ?? "").join(" ");
      expect(text, `${rail} callout`).toMatch(pattern);
    }
  });

  it("translates es rather than copying the en string", () => {
    // Identifiers (rail names, MCP tool names, enum values) are meant to be
    // verbatim, so only prose fields are compared.
    const IDENTIFIER = /^[\w.$<>{}\-/ ]+$/;
    const copied = TOOLTIP_KEYS.filter((key) => {
      const enSummary = String(
        panel(en as Record<string, unknown>, key).summary,
      );
      const esSummary = String(
        panel(es as Record<string, unknown>, key).summary,
      );
      return enSummary === esSummary && !IDENTIFIER.test(enSummary);
    });
    expect(copied).toEqual([]);
  });

  it("points docs links at a real documentation section", () => {
    // resolveHref turns a bare path into `/${slug}/${href}`, and the docs
    // router matches ONE segment after /documentation — so any deeper path
    // would 404. Anchors are fine; extra path segments are not.
    const hrefs: string[] = [];
    for (const key of TOOLTIP_KEYS) {
      const links = panel(en as Record<string, unknown>, key).links as
        Array<{ href?: string }> | undefined;
      for (const link of links ?? []) if (link.href) hrefs.push(link.href);
    }
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href, `${href} must target the loop-mode docs page`).toMatch(
        /^documentation\/loop-mode(#[a-z-]+)?$/,
      );
    }
  });
});

// Card d73aa054 (F5) — the "Variants → Presets" rename is COPY ONLY. These
// two halves have to stay apart: the operator must read "preset" everywhere,
// while `variant` survives untouched as the SlotKind the publish validator
// accepts and the `variants` array the backend stores.
describe("preset copy (card d73aa054)", () => {
  const LOCALES: Array<[string, Record<string, unknown>]> = [
    ["en", en as Record<string, unknown>],
    ["es", es as Record<string, unknown>],
    ["pt-BR", ptBR as Record<string, unknown>],
  ];

  function slotCopy(catalog: Record<string, unknown>) {
    const templates = catalog.loopTemplates as Record<string, unknown>;
    return (templates.slots as Record<string, unknown>) ?? {};
  }

  it.each(LOCALES)("carries every preset string in %s", (_locale, catalog) => {
    const slots = slotCopy(catalog);
    const variant = slots.variant as Record<string, string>;
    // fillAdd/fillRemove/effects/explainer are the strings F5 introduced; the
    // rest existed and were reworded, so a missing one is a parity break.
    const missing = [
      "add",
      "id",
      "label",
      "fillSlot",
      "fillNone",
      "fillValue",
      "fillAdd",
      "fillRemove",
      "effects",
      "explainer",
    ].filter((key) => typeof variant?.[key] !== "string" || !variant[key]);
    expect(missing).toEqual([]);
  });

  it.each(LOCALES)("says preset, never variant, in %s prose", (_l, catalog) => {
    const slots = slotCopy(catalog);
    const kindLabel = (slots.kinds as Record<string, string>).variant ?? "";
    const prose: string[] = [
      ...Object.values(slots.variant as Record<string, string>),
      kindLabel,
    ];
    // Every locale's kind LABEL reads "preset"…
    expect(kindLabel).toMatch(/preset/i);
    // …and no user-facing string still says "variant"/"variante".
    expect(prose.filter((copy) => /variante?\b/i.test(copy))).toEqual([]);
  });

  it("keeps `variant` as the wire kind the backend validates", () => {
    // SLOT_KINDS mirrors SlotKind in app/services/loop_template_render.py.
    // Renaming the VALUE would make every stored preset row fail publish.
    expect(SLOT_KINDS).toContain("variant");
    expect(SLOT_KINDS).not.toContain("preset");
  });
});
