// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@/lib/utils";

interface FilterToggleProps {
  label: string;
  active: boolean;
  onChange: (next: boolean) => void;
  icon?: React.ReactNode;
}

export function FilterToggle({ label, active, onChange, icon }: FilterToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border border-border/80 bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent",
        active && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
