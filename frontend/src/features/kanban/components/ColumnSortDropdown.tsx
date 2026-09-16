// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { ArrowUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  COLUMN_SORT_MODES,
  type ColumnSortMode,
} from "../hooks/use-column-sort";

interface Props {
  value: ColumnSortMode;
  onChange: (next: ColumnSortMode) => void;
  /**
   * When true, the dropdown is rendered as a non-interactive icon with a
   * tooltip explaining that the board-level sort is overriding it. We still
   * render the icon (don't hide it) so the column header keeps its layout.
   */
  disabled?: boolean;
}

const MODE_KEYS: Record<ColumnSortMode, string> = {
  position: "columns.sortBy.position",
  updated: "columns.sortBy.updated",
  agent_activity: "columns.sortBy.agentActivity",
};

export function ColumnSortDropdown({ value, onChange, disabled = false }: Props) {
  const { t } = useTranslation();

  if (disabled) {
    return (
      <span
        aria-disabled="true"
        title={t("columns.sortBy.disabledByBoardSort")}
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/50"
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("columns.sortBy.label")}
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {COLUMN_SORT_MODES.map((mode) => (
          <DropdownMenuItem
            key={mode}
            onClick={() => onChange(mode)}
            aria-checked={value === mode}
            role="menuitemradio"
            className={cn(value === mode && "font-semibold text-primary")}
          >
            {t(MODE_KEYS[mode])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
