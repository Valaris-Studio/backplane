// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  // Warning-tinted when selected: a choice that sends more than usual.
  tone?: "warning";
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 gap-0.5 rounded-[var(--radius-cap)] border border-border bg-muted p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-7 whitespace-nowrap rounded-[var(--radius-cap)] px-2.5 text-[0.82rem] font-semibold transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "bg-card text-foreground shadow-[0_1px_2px_color-mix(in_oklab,black_12%,transparent)]"
                : "text-muted-foreground hover:text-foreground",
              selected && option.tone === "warning" && "text-[color:var(--color-warning-foreground)]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  // In a table cell the column header carries the visible label.
  hideLabel?: boolean;
}

export function Switch({ label, checked, onChange, hideLabel = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group relative inline-flex h-9 items-center gap-2 rounded-[var(--radius-cap)] px-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className={cn(
          "relative h-[1.1rem] w-[1.9rem] shrink-0 rounded-full border transition-colors duration-150",
          checked ? "border-transparent bg-foreground" : "border-border bg-input",
        )}
      >
        <span
          className={cn(
            "absolute top-[0.1rem] size-[0.8rem] rounded-full bg-card shadow-[0_1px_2px_color-mix(in_oklab,black_25%,transparent)] transition-[left] duration-150 ease-out",
            checked ? "left-[calc(100%-0.9rem)]" : "left-[0.1rem]",
          )}
        />
      </span>
      {hideLabel ? <span className="sr-only">{label}</span> : label}
    </button>
  );
}
