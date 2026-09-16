// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Grid3X3, LayoutGrid, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ViewMode } from "../hooks/use-view-mode";

interface Props {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

const OPTIONS: { mode: ViewMode; icon: typeof Rows3; labelKey: string }[] = [
  { mode: "rich", icon: Rows3, labelKey: "timeline.view.rich" },
  { mode: "compact", icon: LayoutGrid, labelKey: "timeline.view.compact" },
  { mode: "dense", icon: Grid3X3, labelKey: "timeline.view.dense" },
];

export function ViewToggle({ viewMode, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <div
      role="group"
      aria-label={t("timeline.view.toggleLabel")}
      className="inline-flex items-center gap-0.5 rounded-[calc(var(--radius-md))] border border-border/70 bg-[color:var(--color-surface-1)] p-0.5"
    >
      {OPTIONS.map(({ mode, icon: Icon, labelKey }) => {
        const pressed = viewMode === mode;
        const label = t(labelKey);
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={pressed}
            aria-label={label}
            title={label}
            onClick={() => onChange(mode)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.15rem))] px-2.5 py-1 text-xs font-semibold transition-[background-color,color] duration-150",
              pressed
                ? "bg-[color:var(--color-surface-3)] text-foreground shadow-soft"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
