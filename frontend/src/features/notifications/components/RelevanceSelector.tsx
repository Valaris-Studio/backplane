// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RelevanceScope } from "../api/notifications-api";

interface RelevanceSelectorProps {
  value: RelevanceScope;
  onChange: (scope: RelevanceScope) => void;
  disabled?: boolean;
}

const SCOPES: RelevanceScope[] = ["watching", "everything"];

/**
 * The headline anti-flood lever. `watching` (the default) notifies only for
 * things the user is involved in; `everything` opens up to general workspace
 * activity. Changing it PUTs `relevance_scope` and the backend recomputes the
 * grid's `effective` values (defaults are keyed by scope).
 */
export function RelevanceSelector({
  value,
  onChange,
  disabled,
}: RelevanceSelectorProps) {
  const { t } = useTranslation();
  const helpKey =
    value === "watching"
      ? "notifications.prefs.relevance.watchingHelp"
      : "notifications.prefs.relevance.everythingHelp";

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">
        {t("notifications.prefs.relevance.label")}
      </label>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as RelevanceScope)}
      >
        <SelectTrigger
          aria-label={t("notifications.prefs.relevance.label")}
          disabled={disabled}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCOPES.map((scope) => (
            <SelectItem key={scope} value={scope}>
              {t(`notifications.prefs.relevance.${scope}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs leading-relaxed text-muted-foreground">{t(helpKey)}</p>
    </div>
  );
}
