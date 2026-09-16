// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { ChevronDown, Globe } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  LOCALE_METADATA,
  type SupportedLanguage,
} from "@/i18n/supported-languages";
import { cn } from "@/lib/utils";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  function selectLanguage(language: SupportedLanguage) {
    void i18n.changeLanguage(language);
    localStorage.setItem("i18n-lang", language);
  }

  const current =
    LOCALE_METADATA.find(({ code }) => code === i18n.language) ??
    LOCALE_METADATA[0];

  return (
    <div
      className="relative inline-flex items-center"
      title={t("ui.tooltips.chrome.languageSwitcher.summary")}
    >
      <Globe
        className="pointer-events-none absolute left-3 h-4 w-4"
        aria-hidden="true"
      />
      <select
        value={current.code}
        onChange={(event) =>
          selectLanguage(event.target.value as SupportedLanguage)
        }
        aria-label={t("a11y.languageSwitcher")}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "min-w-[5.75rem] appearance-none pl-9 pr-7",
        )}
      >
        {LOCALE_METADATA.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}
