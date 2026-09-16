// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type CalloutVariant =
  | "honest"
  | "important"
  | "what-is-not"
  | "protip"
  | "danger"
  | "future"
  | "code"
  | "screenshot";

interface CalloutShellProps {
  variant: CalloutVariant;
  icon: LucideIcon;
  title?: string;
  colorClass: string;
  children: ReactNode;
  className?: string;
}

export function CalloutShell({
  variant,
  icon: Icon,
  title,
  colorClass,
  children,
  className,
}: CalloutShellProps) {
  return (
    <aside
      data-callout={variant}
      data-stagger-item
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-lg)] border bg-[color:var(--color-surface-1)]/80 shadow-soft",
        "px-[var(--card-padding)] py-[calc(var(--card-padding)*0.95)]",
        "my-5",
        colorClass,
        className,
      )}
    >
      <div className="flex gap-3">
        <span
          aria-hidden
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
            "bg-[color:var(--color-surface-2)]",
            colorClass,
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5 text-sm leading-6">
          {title ? (
            <p className="font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </p>
          ) : null}
          <div className="text-foreground/90 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-[color:var(--color-muted)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em]">
            {children}
          </div>
        </div>
      </div>
    </aside>
  );
}
