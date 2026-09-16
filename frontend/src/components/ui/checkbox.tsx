// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  "data-testid"?: string;
}

// Accessible checkbox over a native <input type="checkbox">: the real input
// stays in the a11y tree (sr-only) while a styled box renders via peer-* state.
const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  (
    { checked, onCheckedChange, label, description, disabled, id, className, "data-testid": testId },
    ref,
  ) => {
    const reactId = React.useId();
    const inputId = id ?? reactId;
    const descriptionId = description ? `${inputId}-description` : undefined;

    return (
      <label
        htmlFor={inputId}
        className={cn(
          "flex cursor-pointer items-start gap-2.5 text-sm",
          disabled && "cursor-not-allowed opacity-60",
          className,
        )}
      >
        <span className="relative mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center">
          <input
            ref={ref}
            id={inputId}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-describedby={descriptionId}
            data-testid={testId}
            onChange={(e) => onCheckedChange(e.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className={cn(
              "h-4 w-4 rounded-sm border transition-colors",
              checked
                ? "border-primary bg-primary"
                : "border-input bg-[color:var(--color-surface-1)]",
              "peer-focus-visible:ring-2 peer-focus-visible:ring-ring/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
            )}
          />
          {checked && (
            <Check className="absolute h-3 w-3 text-primary-foreground" aria-hidden />
          )}
        </span>
        <span className="space-y-0.5">
          <span className="font-medium text-foreground">{label}</span>
          {description && (
            <span id={descriptionId} className="block text-xs text-muted-foreground">
              {description}
            </span>
          )}
        </span>
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
