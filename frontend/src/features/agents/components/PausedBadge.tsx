// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Pause } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Status pill shown next to a runner's name when the backend reports
 * is_paused=true. Reads only from server state — never from local UI flags.
 */
export function PausedBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge variant="warning" className={className}>
      <Pause className="h-3 w-3" />
      {t("agents.paused")}
    </Badge>
  );
}
