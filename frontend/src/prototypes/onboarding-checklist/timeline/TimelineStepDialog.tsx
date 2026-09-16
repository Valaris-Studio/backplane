// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check, Circle, CircleCheck, CircleMinus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OnboardingStepIllustration } from "@/features/dashboard/components/OnboardingStepIllustration";
import type { StepId, StepView } from "../model";
import { TIMELINE_COPY } from "./model";
import { TimelineStepForm } from "./TimelineStepForm";

interface TimelineStepDialogProps {
  step: StepView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (id: StepId) => void;
  onSkip: (id: StepId) => void;
  onRevisit: (id: StepId) => void;
}

const STATUS = {
  done: { label: "Listo", variant: "success" as const, icon: CircleCheck },
  pending: { label: "Pendiente", variant: "default" as const, icon: Circle },
  skipped: { label: "Omitido", variant: "warning" as const, icon: CircleMinus },
};

export function TimelineStepDialog({
  step,
  open,
  onOpenChange,
  onComplete,
  onSkip,
  onRevisit,
}: TimelineStepDialogProps) {
  if (!step) return null;

  const copy = TIMELINE_COPY[step.id];
  const status = STATUS[step.status];
  const StatusIcon = status.icon;
  const StepIcon = step.icon;

  function finish(handler: (id: StepId) => void) {
    return (id: StepId) => {
      handler(id);
      onOpenChange(false);
    };
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        role="dialog"
        aria-modal="true"
        aria-label={`${copy.label}: ${step.title}`}
        data-timeline-step-dialog={step.id}
        className="max-w-2xl"
      >
        <DialogHeader className="pr-8">
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary shadow-soft">
              <StepIcon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-primary">
                  {step.group}
                </span>
                <Badge variant={status.variant}>
                  <StatusIcon className="h-3 w-3" aria-hidden="true" />
                  {status.label}
                </Badge>
                {step.optional ? <Badge variant="outline">Opcional</Badge> : null}
              </div>
              <DialogTitle>{step.title}</DialogTitle>
            </div>
          </div>
          <DialogDescription className="pt-1 text-left">{step.hint}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_15rem] md:items-start">
          <div className="grid gap-3">
            <p className="text-sm leading-relaxed text-muted-foreground">{copy.intro}</p>
            <ul className="grid gap-2">
              {copy.bullets.map((bullet) => (
                <li key={bullet} className="flex items-start gap-2 text-sm leading-relaxed">
                  <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </div>
          <OnboardingStepIllustration id={step.id} />
        </div>

        <div className="border-t border-border/60 pt-4">
          <p className="mb-3 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Hazlo ahora
          </p>
          <TimelineStepForm
            key={`${step.id}-${step.status}`}
            step={step}
            onComplete={finish(onComplete)}
            onSkip={finish(onSkip)}
            onRevisit={finish(onRevisit)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
