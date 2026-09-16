// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WizardStep {
  id: string;
  label: string;
}

// The one step indicator both wizards (MCP connection, runner launch) render.
// Extracted after the two local copies drifted apart on a11y (aria-label,
// aria-hidden arrows) and typography — one implementation, no drift.
export function WizardSteps({
  steps,
  currentIndex,
  "aria-label": ariaLabel,
}: {
  steps: WizardStep[];
  currentIndex: number;
  "aria-label": string;
}) {
  return (
    <ol
      aria-label={ariaLabel}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
    >
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold transition-[background-color,border-color,color] duration-200 ease-out",
              index < currentIndex
                ? "bg-primary text-primary-foreground"
                : index === currentIndex
                  ? "border border-primary text-primary"
                  : "border border-border/70 text-muted-foreground",
            )}
          >
            {index < currentIndex ? <Check className="h-3 w-3" /> : index + 1}
          </span>
          <span
            className={cn(
              "transition-colors duration-200",
              index === currentIndex
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {step.label}
          </span>
          {index < steps.length - 1 ? (
            <span className="text-muted-foreground/50" aria-hidden>
              →
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
