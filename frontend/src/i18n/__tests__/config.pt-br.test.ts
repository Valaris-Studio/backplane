// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

const originalBrowserLanguage = navigator.language;

function setBrowserLanguage(language: string) {
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: language,
  });
}

async function loadFreshConfig({
  browserLanguage,
  savedLanguage,
}: {
  browserLanguage: string;
  savedLanguage?: string;
}) {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.lang = "";
  setBrowserLanguage(browserLanguage);

  if (savedLanguage !== undefined) {
    localStorage.setItem("i18n-lang", savedLanguage);
  }

  // The selected catalog is fetched on demand, so wait for the boot load the
  // app itself awaits before its first render (see main.tsx).
  const config = await import("../config");
  await config.initialCatalogReady;
  return config.default;
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.lang = "en";
  setBrowserLanguage(originalBrowserLanguage);
  vi.resetModules();
});

describe("i18n pt-BR configuration", () => {
  it("registers the pt-BR catalog and renders its translations", async () => {
    const i18n = await loadFreshConfig({
      browserLanguage: "en-US",
      savedLanguage: "pt-BR",
    });

    expect(i18n.language).toBe("pt-BR");
    expect(i18n.hasResourceBundle("pt-BR", "translation")).toBe(true);
    expect(i18n.t("common.save")).toBe("Salvar");
  });

  it.each(["pt-BR", "pt"])(
    "maps the browser locale %s to pt-BR",
    async (browserLanguage) => {
      const i18n = await loadFreshConfig({ browserLanguage });

      expect(i18n.language).toBe("pt-BR");
      expect(i18n.resolvedLanguage).toBe("pt-BR");
    },
  );

  it("restores a saved pt-BR preference on the next initialization", async () => {
    const i18n = await loadFreshConfig({
      browserLanguage: "es-CL",
      savedLanguage: "pt-BR",
    });

    expect(i18n.language).toBe("pt-BR");
    expect(i18n.t("common.cancel")).toBe("Cancelar");
  });

  it("falls back safely when localStorage contains an unsupported locale", async () => {
    const i18n = await loadFreshConfig({
      browserLanguage: "en-US",
      savedLanguage: "not-a-supported-locale",
    });

    expect(i18n.language).toBe("en");
    expect(i18n.resolvedLanguage).toBe("en");
  });

  it("keeps the document language synchronized initially and after changes", async () => {
    const i18n = await loadFreshConfig({ browserLanguage: "pt-BR" });

    expect(document.documentElement.lang).toBe("pt-BR");

    await i18n.changeLanguage("es");
    expect(document.documentElement.lang).toBe("es");
  });
});
