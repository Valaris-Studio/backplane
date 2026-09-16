// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createInstance, type ResourceLanguage } from "i18next";
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBr from "@/i18n/locales/pt-BR.json";
import { ApiError } from "../api-error";
import {
  resolveApiErrorMessage,
  resolvePipelineValidationMessage,
} from "../localized-errors";

const catalogs = { en, es, "pt-BR": ptBr } as const;

async function translator(locale: keyof typeof catalogs) {
  const instance = createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: false,
    resources: {
      [locale]: {
        translation: catalogs[locale] as unknown as ResourceLanguage,
      },
    },
    interpolation: { escapeValue: false },
  });
  return instance;
}

describe("localized error resolvers", () => {
  it.each([
    ["en", "This email domain is not allowed for this workspace."],
    ["es", "Este dominio de correo no está permitido para este espacio de trabajo."],
    ["pt-BR", "Este domínio de e-mail não é permitido para este espaço de trabalho."],
  ] as const)("renders a known backend code in %s", async (locale, expected) => {
    const i18n = await translator(locale);
    const error = new ApiError("raw backend detail", 400, "raw backend detail", {
      errorCode: "email_domain_not_allowed",
      errorParams: {},
    });

    expect(resolveApiErrorMessage(error, i18n.t, i18n)).toBe(expected);
    expect(error.detail).toBe("raw backend detail");
  });

  // Both codes reach the UI through resolveApiErrorMessage and had no catalog
  // line, so an operator saw the generic "Something went wrong" instead of the
  // one sentence that says what to do. Each names the offender the backend
  // sends in errorParams — a list slot's name, the landing the gate is armed
  // under — because "a slot" is not actionable on a template with 20 of them.
  it.each(["en", "es", "pt-BR"] as const)(
    "names the offending slot for list_slot_expects_array in %s",
    async (locale) => {
      const i18n = await translator(locale);
      const error = new ApiError("raw", 422, "raw", {
        errorCode: "list_slot_expects_array",
        errorParams: { slot: "GUIDING_PRINCIPLES" },
      });

      const message = resolveApiErrorMessage(error, i18n.t, i18n);
      expect(message).not.toBe(i18n.t("errors.unknown"));
      expect(message).toContain("GUIDING_PRINCIPLES");
    },
  );

  it.each(["en", "es", "pt-BR"] as const)(
    "names the armed landing for relax_gate_requires_self_merge in %s",
    async (locale) => {
      const i18n = await translator(locale);
      const error = new ApiError("raw", 422, "raw", {
        errorCode: "relax_gate_requires_self_merge",
        errorParams: { loop_landing: "human" },
      });

      const message = resolveApiErrorMessage(error, i18n.t, i18n);
      expect(message).not.toBe(i18n.t("errors.unknown"));
      expect(message).toContain("human");
      expect(message).toContain("self_merge");
    },
  );

  it("uses a localized fallback for an unknown code without mutating diagnostics", async () => {
    const i18n = await translator("es");
    const detail = { provider: "github", reason: "opaque diagnostic" };
    const error = new ApiError("opaque diagnostic", 502, detail, {
      errorCode: "future_provider_failure",
      errorParams: { provider: "github" },
    });

    expect(resolveApiErrorMessage(error, i18n.t, i18n)).toBe(
      "Algo salió mal. Inténtalo de nuevo.",
    );
    expect(error.errorCode).toBe("future_provider_failure");
    expect(error.errorParams).toEqual({ provider: "github" });
    expect(error.detail).toBe(detail);
  });

  it("renders pipeline validation from code and params instead of raw English", async () => {
    const i18n = await translator("pt-BR");
    const finding = {
      code: "dangling_next",
      field: "stages[0].lifecycle[0].next",
      message: "raw English should not render",
      params: { step: "implement", target: "missing" },
    };

    expect(resolvePipelineValidationMessage(finding, i18n.t, i18n)).toBe(
      "O passo implement referencia o próximo passo desconhecido missing.",
    );
    expect(finding.message).toBe("raw English should not render");
  });
});
