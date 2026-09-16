// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// One metadata chip in a card footer. `field` ties it to a sort mode; when that
// mode is active the chip brightens and bolds (the "wow" highlight) while its
// siblings stay muted. `data-sort-*` attributes make the highlight testable and
// give the active chip a stable hook. Shared by WorkspaceCard and BoardCard so
// the landing page and the boards grid read as one design system.
export function MetaChip({
  field,
  active,
  icon: Icon,
  children,
  className,
  testId,
  ariaLabel,
}: {
  field: string;
  active: boolean;
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-sort-field={field}
      data-sort-active={active}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-1 transition-colors duration-200",
        active ? "font-semibold text-foreground" : "text-muted-foreground/70",
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {children}
    </span>
  );
}
