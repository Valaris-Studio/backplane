// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Code + selector label only — deliberately catalog-free. This module is what
// the running app imports (the switcher, the docs section registry), so it must
// never statically import a locale JSON: that would drag every catalog (~1.2 MB
// raw) into the entry chunk. Catalogs load on demand via LOCALE_LOADERS; the
// eager code+catalog view lives in `./locale-registry` for build-time consumers.
export const LOCALE_METADATA = [
  { code: "en", label: "EN" },
  { code: "es", label: "ES" },
  { code: "pt-BR", label: "PT-BR" },
] as const;

export type SupportedLanguage = (typeof LOCALE_METADATA)[number]["code"];

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] =
  LOCALE_METADATA.map(({ code }) => code);

// Lazy catalog loaders keyed by code. `en` is deliberately absent: it is the
// static fallback bundle and is always present from boot.
export const LOCALE_LOADERS: Record<
  Exclude<SupportedLanguage, "en">,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  es: () => import("./locales/es.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
};
