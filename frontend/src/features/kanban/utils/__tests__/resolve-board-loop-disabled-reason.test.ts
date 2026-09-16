// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBr from "@/i18n/locales/pt-BR.json";
import {
  resolveBoardLoopDisabledDiagnostic,
  resolveBoardLoopDisabledReason,
} from "../resolve-board-loop-disabled-reason";

const PLURAL_REASON_KEYS = [
  "max_iterations_reached",
  "consecutive_failures",
] as const;

function disabledState(
  overrides: Partial<{
    disabled_reason: string | null;
    disabled_reason_code: string | null;
    disabled_reason_params: Record<string, unknown> | null;
    disabled_diagnostic: string | null;
  }> = {},
) {
  return {
    disabled_reason: "legacy reason",
    disabled_reason_code: null,
    disabled_reason_params: null,
    disabled_diagnostic: null,
    ...overrides,
  };
}

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("Board Loop reason catalog", () => {
  it.each([
    ["en", en],
    ["es", es],
    ["pt-BR", ptBr],
  ] as const)("defines every reason and the diagnostic label in %s", (_, catalog) => {
    for (const key of PLURAL_REASON_KEYS) {
      expect(catalog.boardLoop.reasons[key]).toEqual({
        one: expect.any(String),
        other: expect.any(String),
      });
    }
    expect(catalog.boardLoop.reasons.budget_exhausted).toEqual(
      expect.any(String),
    );
    expect(catalog.boardLoop.reasons.diagnosticLabel).toEqual(
      expect.any(String),
    );
  });
});

describe("resolveBoardLoopDisabledReason", () => {
  it.each([
    [
      "en",
      "Budget exhausted after spending $21.10 of $20.00.",
    ],
    [
      "es",
      "El presupuesto se agotó tras gastar 21,10\u00a0US$ de 20,00\u00a0US$.",
    ],
    [
      "pt-BR",
      "O orçamento se esgotou após gastar US$\u00a021,10 de US$\u00a020,00.",
    ],
  ] as const)(
    "localizes and regionally formats budget_exhausted in %s",
    async (locale, expected) => {
      await i18n.changeLanguage(locale);

      expect(
        resolveBoardLoopDisabledReason(
          disabledState({
            disabled_reason_code: "budget_exhausted",
            disabled_reason_params: {
              spent_usd: 21.1,
              budget_usd: 20,
            },
          }),
          i18n.t.bind(i18n),
        ),
      ).toBe(expected);
    },
  );

  it("formats max_iterations_reached with the selected locale", async () => {
    await i18n.changeLanguage("es");

    expect(
      resolveBoardLoopDisabledReason(
        disabledState({
          disabled_reason_code: "max_iterations_reached",
          disabled_reason_params: { max_iterations: 12_345 },
        }),
        i18n.t.bind(i18n),
      ),
    ).toBe("Se alcanzó el máximo de 12.345 iteraciones.");
  });

  it("localizes consecutive_failures and formats its count", async () => {
    await i18n.changeLanguage("pt-BR");

    expect(
      resolveBoardLoopDisabledReason(
        disabledState({
          disabled_reason_code: "consecutive_failures",
          disabled_reason_params: { count: 12_345 },
        }),
        i18n.t.bind(i18n),
      ),
    ).toBe("Desativado após 12.345 falhas consecutivas.");
  });

  it.each([
    [
      "en",
      "Maximum of 1 iteration reached.",
      "Maximum of 2 iterations reached.",
      "Disabled after 1 consecutive failure.",
      "Disabled after 2 consecutive failures.",
    ],
    [
      "es",
      "Se alcanzó el máximo de 1 iteración.",
      "Se alcanzó el máximo de 2 iteraciones.",
      "Se desactivó tras 1 fallo consecutivo.",
      "Se desactivó tras 2 fallos consecutivos.",
    ],
    [
      "pt-BR",
      "O máximo de 1 iteração foi atingido.",
      "O máximo de 2 iterações foi atingido.",
      "Desativado após 1 falha consecutiva.",
      "Desativado após 2 falhas consecutivas.",
    ],
  ] as const)(
    "selects singular and plural variants explicitly in %s",
    async (
      locale,
      maxOne,
      maxOther,
      failuresOne,
      failuresOther,
    ) => {
      await i18n.changeLanguage(locale);
      const resolve = (
        code: "max_iterations_reached" | "consecutive_failures",
        value: number,
      ) =>
        resolveBoardLoopDisabledReason(
          disabledState({
            disabled_reason_code: code,
            disabled_reason_params:
              code === "max_iterations_reached"
                ? { max_iterations: value }
                : { count: value },
          }),
          i18n.t.bind(i18n),
        );

      expect(resolve("max_iterations_reached", 1)).toBe(maxOne);
      expect(resolve("max_iterations_reached", 2)).toBe(maxOther);
      expect(resolve("consecutive_failures", 1)).toBe(failuresOne);
      expect(resolve("consecutive_failures", 2)).toBe(failuresOther);
    },
  );

  it("returns a human-authored legacy reason exactly when metadata is absent", () => {
    const legacy = "  Human -- reason <raw>  ";
    expect(
      resolveBoardLoopDisabledReason(
        disabledState({ disabled_reason: legacy }),
        i18n.t.bind(i18n),
      ),
    ).toBe(legacy);
  });

  it("returns the legacy reason exactly for an unknown code", () => {
    const legacy = "unknown-code fallback EXACT";
    expect(
      resolveBoardLoopDisabledReason(
        disabledState({
          disabled_reason: legacy,
          disabled_reason_code: "future_reason",
          disabled_reason_params: { value: 1 },
        }),
        i18n.t.bind(i18n),
      ),
    ).toBe(legacy);
  });

  it("returns the legacy reason exactly when known metadata is incomplete", () => {
    const legacy = "incomplete-metadata fallback EXACT";
    expect(
      resolveBoardLoopDisabledReason(
        disabledState({
          disabled_reason: legacy,
          disabled_reason_code: "budget_exhausted",
          disabled_reason_params: { spent_usd: 21.1 },
        }),
        i18n.t.bind(i18n),
      ),
    ).toBe(legacy);
  });

  it.each([
    ["zero max", "max_iterations_reached", { max_iterations: 0 }],
    ["negative max", "max_iterations_reached", { max_iterations: -1 }],
    ["fractional max", "max_iterations_reached", { max_iterations: 1.5 }],
    [
      "extra max key",
      "max_iterations_reached",
      { max_iterations: 10, extra: true },
    ],
    ["zero failures", "consecutive_failures", { count: 0 }],
    ["fractional failures", "consecutive_failures", { count: 1.5 }],
    [
      "negative spent",
      "budget_exhausted",
      { spent_usd: -1, budget_usd: 20 },
    ],
    [
      "zero budget",
      "budget_exhausted",
      { spent_usd: 20, budget_usd: 0 },
    ],
    [
      "budget not exhausted",
      "budget_exhausted",
      { spent_usd: 19.99, budget_usd: 20 },
    ],
    [
      "extra budget key",
      "budget_exhausted",
      { spent_usd: 20, budget_usd: 20, extra: true },
    ],
  ] as const)(
    "returns the legacy reason exactly for semantically invalid metadata: %s",
    (label, code, params) => {
      const legacy = `fallback EXACT: ${label}`;
      expect(
        resolveBoardLoopDisabledReason(
          disabledState({
            disabled_reason: legacy,
            disabled_reason_code: code,
            disabled_reason_params: params,
          }),
          i18n.t.bind(i18n),
        ),
      ).toBe(legacy);
    },
  );
});

describe("resolveBoardLoopDisabledDiagnostic", () => {
  it("suppresses a diagnostic identical to the legacy reason already visible", () => {
    const visibleReason = "raw server detail";
    expect(
      resolveBoardLoopDisabledDiagnostic(
        disabledState({
          disabled_reason: visibleReason,
          disabled_diagnostic: visibleReason,
        }),
        visibleReason,
      ),
    ).toBeNull();
  });

  it("returns a distinct diagnostic verbatim", () => {
    const diagnostic = "  worker_exit=137 -- raw <detail>  ";
    expect(
      resolveBoardLoopDisabledDiagnostic(
        disabledState({ disabled_diagnostic: diagnostic }),
        "localized reason",
      ),
    ).toBe(diagnostic);
  });
});
