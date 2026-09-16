// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";
import { StuckReasonsPanel } from "../StuckReasonsPanel";
import * as StuckReasonsPanelModule from "../StuckReasonsPanel";
import type { StuckReason } from "../../utils/stuckReasons";

// The catalogs are read as raw JSON, never through i18next — going through the
// live instance would let es/pt-BR silently resolve against the en fallback
// bundle, which is exactly the drift these contracts exist to catch.
const CATALOGS: Array<[string, Record<string, unknown>]> = [
  ["en", en as Record<string, unknown>],
  ["es", es as Record<string, unknown>],
  ["pt-BR", ptBR as Record<string, unknown>],
];

function lookup(catalog: Record<string, unknown>, path: string): unknown {
  let node: unknown = catalog;
  for (const segment of path.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

// Every reason the panel can render, including the SWE-AF #2 park reason.
const ALL_REASON_KEYS = [
  "blockedColumn",
  "noHero",
  "awaitingPrompt",
  "requestChanges",
  "recentFailures",
  "stale",
  "needsAdvisor",
];

function toPascal(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

describe("StuckReasonsPanel — needsAdvisor reason", () => {
  it("renders localized title and body for a needsAdvisor reason, not raw keys", () => {
    renderWithProviders(
      <StuckReasonsPanel
        reasons={[{ key: "needsAdvisor" } as unknown as StuckReason]}
      />,
    );
    // i18next falls back to echoing the key when the leaf is missing — the
    // raw key on screen means the reason has no copy at all.
    expect(
      screen.queryByText("agentic.card.reasonNeedsAdvisor.title"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("agentic.card.reasonNeedsAdvisor.body"),
    ).not.toBeInTheDocument();
  });
});

describe("StuckReasonsPanel — i18n key contracts", () => {
  // The panel composes `agentic.card.reason${Pascal(key)}.title/.body`
  // (StuckReasonsPanel.tsx) for every reason it renders. Copy contract for
  // reasonNeedsAdvisor.body (not assertable here): it must tell the human HOW
  // to unpark — removing the `needs-advisor` label re-queues the card for the
  // scheduler.
  it.each(CATALOGS)(
    "agentic.card.reason*.title/.body exist for every reason in %s",
    (_locale, catalog) => {
      for (const key of ALL_REASON_KEYS) {
        const base = `agentic.card.reason${toPascal(key)}`;
        expect(
          typeof lookup(catalog, `${base}.title`),
          `${base}.title missing`,
        ).toBe("string");
        expect(
          typeof lookup(catalog, `${base}.body`),
          `${base}.body missing`,
        ).toBe("string");
      }
    },
  );

  // REASON_TOOLTIP_KEY maps each reason to a RichTooltip leaf. RichTooltip
  // resolves `i18nKey` under the `ui.tooltips.` prefix (rich-tooltip.tsx
  // useTooltipContent) and accepts either a plain string or an object with a
  // string `summary`. The map must be exported so this contract can hold it
  // to the locale files — a value that resolves to nothing renders an
  // empty-summary tooltip and the dead key is invisible at runtime.
  it("exports REASON_TOOLTIP_KEY with an entry for every reason incl. needsAdvisor", () => {
    const map = (StuckReasonsPanelModule as Record<string, unknown>)[
      "REASON_TOOLTIP_KEY"
    ] as Record<string, string> | undefined;
    expect(
      map,
      "StuckReasonsPanel must export REASON_TOOLTIP_KEY",
    ).toBeDefined();
    for (const key of ALL_REASON_KEYS) {
      expect(typeof map?.[key], `REASON_TOOLTIP_KEY.${key} missing`).toBe(
        "string",
      );
    }
  });

  it.each(CATALOGS)(
    "every REASON_TOOLTIP_KEY value resolves where RichTooltip reads it in %s",
    (_locale, catalog) => {
      const map = (StuckReasonsPanelModule as Record<string, unknown>)[
        "REASON_TOOLTIP_KEY"
      ] as Record<string, string> | undefined;
      expect(
        map,
        "StuckReasonsPanel must export REASON_TOOLTIP_KEY",
      ).toBeDefined();
      for (const [reason, i18nKey] of Object.entries(map ?? {})) {
        const resolved = lookup(catalog, `ui.tooltips.${i18nKey}`);
        const usable =
          typeof resolved === "string" ||
          (resolved != null &&
            typeof resolved === "object" &&
            typeof (resolved as { summary?: unknown }).summary === "string");
        expect(
          usable,
          `REASON_TOOLTIP_KEY.${reason} -> ui.tooltips.${i18nKey} resolves to nothing usable`,
        ).toBe(true);
      }
    },
  );
});
