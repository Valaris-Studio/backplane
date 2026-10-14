// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

interface WithheldChipProps {
  label: string;
  accessibleLabel?: string;
  className?: string;
}

// Content the capture level kept on the device: a dashed outline says
// "something was here", unlike plain "No output".
export function WithheldChip({ label, accessibleLabel, className }: WithheldChipProps) {
  return (
    <span
      role={accessibleLabel ? "img" : undefined}
      aria-label={accessibleLabel}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-cap)] border border-dashed border-muted-foreground/45 px-1.5 py-px text-[0.76rem] font-semibold text-muted-foreground",
        className,
      )}
    >
      <Lock aria-hidden className="size-3 shrink-0" />
      <span aria-hidden={accessibleLabel ? true : undefined}>{label}</span>
    </span>
  );
}
