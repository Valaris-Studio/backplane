// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { LOCALE_REGISTRY } from "@/i18n/locale-registry";

const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    resources: Object.fromEntries(LOCALE_REGISTRY.map(({ code, translation }) => [code, { translation }])),
    supportedLngs: LOCALE_REGISTRY.map(({ code }) => code),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

describe("Localized evidence counts remain truthful across plural categories", () => {
  it("reports zero loaded calls in Brazilian Portuguese without substituting one", () => {
    const result = i18n.t("sessions.evidence.loaded", { lng: "pt-BR", count: 0, returnDetails: true });
    expect(result.usedLng).toBe("pt-BR");
    expect(result.res).toMatch(/^0 chamadas? correspondentes? carregadas?$/);
  });

  it.each([
    ["es", "sessions.evidence.loaded", "1000000 llamadas coincidentes cargadas"],
    ["pt-BR", "sessions.evidence.loaded", "1000000 chamadas correspondentes carregadas"],
    ["es", "sessions.rail.linked.calls", "1000000 llamadas de herramienta registradas"],
    ["pt-BR", "sessions.rail.linked.calls", "1000000 chamadas de ferramenta registradas"],
  ])("keeps %s %s localized and qualified in the many category", (locale, key, expected) => {
    const result = i18n.t(key, { lng: locale, count: 1_000_000, returnDetails: true });
    expect(result.usedLng).toBe(locale);
    expect(result.res).toBe(expected);
  });
});
