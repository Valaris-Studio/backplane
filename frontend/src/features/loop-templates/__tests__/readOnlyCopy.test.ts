// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";

// Card 2c18790f (F6) — the read-only COPY contract.
//
// Read as raw JSON rather than through i18next: resolving through the live
// instance lets es and pt-BR fall back to the en bundle, which is precisely
// the drift this file exists to catch.

const LOCALES = { en, es, "pt-BR": ptBR } as Record<
  string,
  { loopTemplates: Record<string, Record<string, unknown>> }
>;

const EDITING_TABS = ["slots", "rails", "contract", "prompts"] as const;

/**
 * The in-tab notice is PINNED to an exact string per locale, not screened by a
 * blocklist of banned phrasings. A blocklist only rejects the wordings someone
 * thought of: a mutation that reintroduced the reason claim in unaccented
 * Portuguese sailed straight through one. Equality has no such gap — any
 * rewrite has to come back through this table and be read by a human.
 */
const TAB_NOTICE: Record<string, Record<string, string>> = {
  en: {
    slots: "This template is read-only.",
    rails: "This template is read-only.",
    contract: "This template is read-only.",
    prompts: "This template is read-only. Previews still work.",
  },
  es: {
    slots: "Esta plantilla es de solo lectura.",
    rails: "Esta plantilla es de solo lectura.",
    contract: "Esta plantilla es de solo lectura.",
    prompts:
      "Esta plantilla es de solo lectura. Las vistas previas siguen funcionando.",
  },
  "pt-BR": {
    slots: "Este modelo é somente leitura.",
    rails: "Este modelo é somente leitura.",
    contract: "Este modelo é somente leitura.",
    prompts:
      "Este modelo é somente leitura. As pré-visualizações continuam funcionando.",
  },
};

describe("read-only copy (card 2c18790f)", () => {
  for (const [name, bundle] of Object.entries(LOCALES)) {
    describe(name, () => {
      it("names both read-only reasons distinctly", () => {
        const readOnly = bundle.loopTemplates.draft?.readOnly as
          | Record<string, string>
          | undefined;

        expect(readOnly?.system).toBeTruthy();
        expect(readOnly?.role).toBeTruthy();
        // AC7: the two remedies differ, so the two strings must too. One
        // string reused for both is the bug, not a translation shortcut.
        expect(readOnly?.system).not.toBe(readOnly?.role);
      });

      it("names both save-failure modes distinctly", () => {
        const saveFailed = bundle.loopTemplates.draft?.saveFailed as
          | Record<string, string>
          | undefined;

        expect(saveFailed?.forbidden).toBeTruthy();
        expect(saveFailed?.generic).toBeTruthy();
        expect(saveFailed?.forbidden).not.toBe(saveFailed?.generic);
      });

      for (const tab of EDITING_TABS) {
        it(`${tab}'s in-tab notice states the FACT, never a reason`, () => {
          const text = bundle.loopTemplates[tab]?.readOnly as string;

          // The shell banner owns the reason. A tab that says "system
          // templates are defined in code" tells a MEMBER holding a WORKSPACE
          // template something flatly untrue about why they cannot type.
          expect(text).toBe(TAB_NOTICE[name]?.[tab]);
        });
      }
    });
  }
});
