// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Wraps a (disabled) control with the "board is frozen" explanation. Renders
// children untouched when the board isn't frozen.
//
// Disabled buttons emit no pointer events, so the trigger wraps a <span> that
// still receives hover — same idiom as ConnectGitHubButton.
export function FrozenActionTooltip({
  frozen,
  children,
  className,
}: {
  frozen: boolean;
  children: React.ReactNode;
  /** Layout utilities the wrapped control needs on its flex parent (e.g. mr-auto). */
  className?: string;
}) {
  const { t } = useTranslation();

  if (!frozen) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className}>{children}</span>
      </TooltipTrigger>
      <TooltipContent>{t("kanban.frozen.actionDisabled")}</TooltipContent>
    </Tooltip>
  );
}
