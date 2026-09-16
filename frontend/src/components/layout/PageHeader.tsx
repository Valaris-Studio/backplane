// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@/lib/utils";
import { Marquee } from "@/components/ui/marquee";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  /**
   * One-line bar: title left, actions right; eyebrow and description are
   * dropped entirely. For board tabs, where the surrounding chrome (board
   * header + tab nav) already says where you are and every vertical pixel
   * belongs to the content.
   */
  slim?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  compact = false,
  slim = false,
  className,
}: PageHeaderProps) {
  if (slim) {
    return (
      <header
        className={cn(
          "flex items-center justify-between gap-3 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.4rem))] border border-border/70 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-2 shadow-panel",
          className,
        )}
      >
        <h1 className="min-w-0 truncate text-sm font-semibold text-foreground sm:text-base">
          {title}
        </h1>
        {actions ? (
          <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </header>
    );
  }

  return (
    <header
      className={cn(
        "flex flex-col gap-3 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.4rem))] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel lg:flex-row lg:items-center lg:justify-between",
        compact
          ? "px-[var(--card-padding)] py-[calc(var(--card-padding)*0.55)]"
          : "px-[var(--card-padding)] py-[calc(var(--card-padding)*0.7)]",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? (
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-primary/70">
            {eyebrow}
          </p>
        ) : null}
        <h1
          className={cn(
            "font-bold text-balance text-foreground",
            compact ? "text-lg sm:text-xl" : "text-xl sm:text-2xl",
          )}
        >
          {title}
        </h1>
        {description ? (
          // A plain-string description scrolls only when it can't fit — a
          // marquee that reclaims the vertical space the old wrapped paragraph
          // used. A ReactNode description (rare) is rendered verbatim.
          typeof description === "string" ? (
            <Marquee
              text={description}
              className="max-w-2xl"
              textClassName="text-sm leading-5 text-muted-foreground"
            />
          ) : (
            <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
              {description}
            </p>
          )
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 lg:flex-shrink-0">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
