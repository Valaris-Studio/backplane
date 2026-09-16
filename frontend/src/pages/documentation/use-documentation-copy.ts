// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { getDocumentationCopy, resolveDocumentationLocale } from "./content";

export function useDocumentationCopy() {
  const { i18n } = useTranslation();
  const locale = resolveDocumentationLocale(
    i18n.resolvedLanguage ?? i18n.language,
  );

  return {
    locale,
    copy: getDocumentationCopy(locale),
  };
}
