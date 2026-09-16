// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LOCALE_METADATA, type SupportedLanguage } from "./supported-languages";
import en from "./locales/en.json";
import es from "./locales/es.json";
import ptBr from "./locales/pt-BR.json";

const CATALOGS: Record<SupportedLanguage, Record<string, unknown>> = {
  en,
  es,
  "pt-BR": ptBr,
};

// Eager code+label+catalog view, derived from the metadata so the codes and
// selector labels have exactly one definition. Importing this pulls in EVERY
// catalog, so it exists for build-time consumers only (locale contract suites,
// copy audits). App code imports LOCALE_METADATA instead — the runtime loads
// non-English catalogs on demand.
export const LOCALE_REGISTRY = LOCALE_METADATA.map(({ code, label }) => ({
  code,
  label,
  translation: CATALOGS[code],
}));
