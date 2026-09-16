// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check, CircleDashed, Minus } from "lucide-react";
import { pillVariants } from "@/components/ui/pill";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { getTimelineLabel, type TimelineVariantProps } from "../model";

const PROGRESS_TRANSITION_MS = 220;

const STATUS_META = {
  done: {
    label: "Listo",
    icon: Check,
    buttonClass:
      "border-success/35 bg-[color:color-mix(in_oklab,var(--color-success)_10%,var(--color-card))] text-foreground hover:border-success/55",
    iconClass: "text-[color:var(--color-success)]",
  },
  pending: {
    label: "Pendiente",
    icon: CircleDashed,
    buttonClass:
      "border-border/75 bg-card text-foreground hover:border-primary/45 hover:bg-[color:color-mix(in_oklab,var(--color-primary)_5%,var(--color-card))]",
    iconClass: "text-primary",
  },
  skipped: {
    label: "Omitido",
    icon: Minus,
    buttonClass:
      "border-border/55 bg-muted/70 text-muted-foreground hover:border-border hover:bg-muted",
    iconClass: "text-muted-foreground",
  },
} as const;

export function TimelineRail({
  steps,
  progress,
  activeStepId,
  onOpen,
}: TimelineVariantProps) {
  const reducedMotion = useReducedMotion();
  const progressValue = Math.min(Math.max(progress, 0), 100);

  return (
    <div data-timeline-scroll className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="sr-only" aria-live="polite">
        Progreso de configuración: {Math.round(progressValue)}%
      </span>
      <div className="relative min-w-[45rem] py-2 sm:min-w-[48rem]">
        <div
          role="progressbar"
          aria-label="Avance general de configuración"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressValue)}
          data-timeline-essential-progress
          className="pointer-events-none absolute left-[8.333%] right-[8.333%] top-1/2 h-px -translate-y-1/2"
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-0 border-t border-dotted border-border/65"
          />
          <span
            data-timeline-progress-fill
            aria-hidden="true"
            className="absolute inset-x-0 top-0 border-t border-dotted border-primary/40 transition-[clip-path] will-change-[clip-path] motion-reduce:transition-none"
            style={{
              clipPath: `inset(0 ${100 - progressValue}% 0 0)`,
              transitionDuration: reducedMotion
                ? "0ms"
                : `${PROGRESS_TRANSITION_MS}ms`,
              transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
            }}
          />
        </div>

        <ol
          className="relative z-[1] grid grid-cols-6 gap-3"
          aria-label="Progreso de configuración del espacio de trabajo"
        >
          {steps.map((step) => {
            const StepIcon = step.icon;
            const status = STATUS_META[step.status];
            const StatusIcon = status.icon;
            const active = step.id === activeStepId && step.status === "pending";

            return (
              <li key={step.id} className="flex min-w-0 justify-center">
                <button
                  type="button"
                  data-timeline-step={step.id}
                  data-step-state={step.status}
                  aria-current={active ? "step" : undefined}
                  onClick={() => onOpen(step.id)}
                  className={cn(
                    pillVariants({ tint: "none" }),
                    "h-10 w-full max-w-[8rem] justify-center gap-2 border px-3 py-0 normal-case tracking-normal shadow-[0_1px_0_color-mix(in_oklab,white_45%,transparent)] outline-none transition-[transform,background-color,border-color,color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none",
                    status.buttonClass,
                    active &&
                      "border-primary/55 bg-[color:color-mix(in_oklab,var(--color-primary)_9%,var(--color-card))] shadow-soft ring-1 ring-primary/20",
                  )}
                >
                  <StepIcon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-primary" : status.iconClass,
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate text-xs font-semibold">
                    {getTimelineLabel(step.id)}
                  </span>
                  <StatusIcon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-primary" : status.iconClass,
                    )}
                    aria-hidden="true"
                  />
                  <span className="sr-only">Estado: {status.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
