// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  ArrowUpDown,
  CalendarPlus,
  Check,
  Clock,
  SortAsc,
  SquareStack,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { BOARD_SORT_MODES, type BoardSortMode } from "../hooks/use-board-sort";

interface Props {
  value: BoardSortMode;
  onChange: (next: BoardSortMode) => void;
}

// Each mode pairs an i18n label key with the icon that also marks the matching
// field on the card, so the dropdown choice and the highlighted card field read
// as the same concept.
const MODE_META: Record<BoardSortMode, { key: string; icon: LucideIcon }> = {
  activity: { key: "boards.sort.activity", icon: Clock },
  created: { key: "boards.sort.created", icon: CalendarPlus },
  cards: { key: "boards.sort.cards", icon: SquareStack },
  name: { key: "boards.sort.name", icon: SortAsc },
};

export function BoardSortDropdown({ value, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("boards.sort.label")}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "shrink-0 text-muted-foreground",
        )}
      >
        <ArrowUpDown className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline text-foreground">
          {t(MODE_META[value].key)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {BOARD_SORT_MODES.map((mode) => {
          const { key, icon: Icon } = MODE_META[mode];
          const active = value === mode;
          return (
            <DropdownMenuItem
              key={mode}
              role="menuitemradio"
              aria-checked={active}
              onClick={() => onChange(mode)}
              className={cn(active && "font-semibold text-primary")}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span className="flex-1">{t(key)}</span>
              {active ? <Check className="h-4 w-4" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
