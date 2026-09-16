// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SupportedLanguage } from "@/i18n/supported-languages";
import { EN_DOCUMENTATION } from "./en";
import { ES_DOCUMENTATION } from "./es";
import { PT_BR_DOCUMENTATION } from "./pt-BR";
import type { DocumentationLocaleCopy } from "./types";

export const DOCUMENTATION_LOCALES = {
  en: EN_DOCUMENTATION,
  es: ES_DOCUMENTATION,
  "pt-BR": PT_BR_DOCUMENTATION,
} as const satisfies Record<SupportedLanguage, DocumentationLocaleCopy>;

export function resolveDocumentationLocale(language: string): SupportedLanguage {
  const normalized = language.trim().toLowerCase().replace("_", "-");
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("pt")) return "pt-BR";
  return "en";
}

export function getDocumentationCopy(language: string): DocumentationLocaleCopy {
  return DOCUMENTATION_LOCALES[resolveDocumentationLocale(language)];
}

export type {
  DocumentationLandingCopy,
  DocumentationLocale,
  DocumentationLocaleCopy,
  DocumentationMcpReferenceCopy,
  DocumentationShellCopy,
} from "./types";
