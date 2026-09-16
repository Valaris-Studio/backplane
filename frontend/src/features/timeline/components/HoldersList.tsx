// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { formatDuration } from "../utils/format-duration";
import { humanizeRole, initials } from "../utils/humanize";
import type { CardHolder } from "../types";

interface Props {
  holders: CardHolder[];
}

// Role-agnostic holders list: name · humanized role · duration. Order comes
// from the engine (ms DESC). Roles are rendered verbatim, never enumerated.
export function HoldersList({ holders }: Props) {
  const { t } = useTranslation();

  if (holders.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("timeline.detail.noHolders")}</p>;
  }

  return (
    <ul className="space-y-2">
      {holders.map((holder) => (
        <li key={holder.key} className="flex items-center gap-3">
          <Avatar className="h-7 w-7">
            <AvatarFallback>{initials(holder.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">{holder.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {humanizeRole(holder.role, t as TFunction)}
            </p>
          </div>
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
            {formatDuration(holder.ms, t as TFunction)}
          </span>
        </li>
      ))}
    </ul>
  );
}
