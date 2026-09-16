// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import {
  LOCALE_LOADERS,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "./supported-languages";

function matchSupportedLanguage(
  language: string | null | undefined,
): SupportedLanguage | undefined {
  const baseLanguage = language?.trim().toLowerCase().split(/[-_]/)[0];

  return SUPPORTED_LANGUAGES.find(
    (supportedLanguage) =>
      supportedLanguage.toLowerCase().split("-")[0] === baseLanguage,
  );
}

const savedLanguage = matchSupportedLanguage(localStorage.getItem("i18n-lang"));
const browserLanguage = matchSupportedLanguage(navigator.language);
const initialLanguage = savedLanguage ?? browserLanguage ?? "en";

function syncDocumentLanguage(language: string) {
  document.documentElement.lang = matchSupportedLanguage(language) ?? "en";
}

syncDocumentLanguage(initialLanguage);

// Only `en` ships in the entry chunk; the other catalogs are fetched on demand
// so a session never downloads the languages it isn't using.
async function loadCatalog(language: SupportedLanguage) {
  if (language === "en" || i18n.hasResourceBundle(language, "translation")) {
    return;
  }
  const { default: translation } = await LOCALE_LOADERS[language]();
  i18n.addResourceBundle(language, "translation", translation, true, true);
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  supportedLngs: [...SUPPORTED_LANGUAGES],
  lng: initialLanguage,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", syncDocumentLanguage);

// Fetch the catalog BEFORE i18next swaps the active language, both at boot and
// on every switch — otherwise the new language renders as raw fallback copy
// until the chunk lands. Wrapping `changeLanguage` keeps that guarantee at the
// one seam every caller already goes through (the switcher, tests, deep links).
const changeLanguage = i18n.changeLanguage.bind(i18n);
i18n.changeLanguage = (async (language?: string, ...rest) => {
  const supported = matchSupportedLanguage(language);
  if (supported) await loadCatalog(supported);
  return changeLanguage(language, ...rest);
}) as typeof i18n.changeLanguage;

// Await before the first render (see main.tsx) so a non-English session never
// flashes English copy. Not a top-level await: the build targets es2020/safari14,
// where that is unsupported. English sessions resolve immediately — the `en`
// catalog is static — so only non-English pays the extra chunk fetch.
//
// The re-`changeLanguage` is what makes the new bundle actually render: `init`
// above already set `lng`, so i18next built its translator against the
// not-yet-loaded catalog and resolved through the `en` fallback. Re-selecting
// the same language rebuilds it now that the resources are in memory.
export const initialCatalogReady =
  initialLanguage === "en"
    ? Promise.resolve()
    : loadCatalog(initialLanguage).then(() => {
        void i18n.changeLanguage(initialLanguage);
      });

export default i18n;
