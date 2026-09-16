// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { CircleCheckBig, Rocket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { OnboardingVariantProps, StepId } from "../model";
import { TimelineStepDialog } from "./TimelineStepDialog";
import { TimelineRail } from "./variants/TimelineRail";

export function TimelineExperience({
  steps,
  resolvedCount,
  progress,
  activeStepId,
  onComplete,
  onSkip,
  onRevisit,
}: OnboardingVariantProps) {
  const [selectedStepId, setSelectedStepId] = useState<StepId | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const focusTimerRef = useRef<number | null>(null);
  const restoreTimerRef = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();
  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? null;

  useEffect(
    () => () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      if (restoreTimerRef.current !== null) {
        window.clearTimeout(restoreTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = trackRef.current;
      const active = root?.querySelector<HTMLElement>(
        `[data-timeline-step="${activeStepId}"]`,
      );
      const scroller = active?.closest<HTMLElement>("[data-timeline-scroll]");
      if (!active || !scroller || scroller.scrollWidth <= scroller.clientWidth) return;
      if (typeof scroller.scrollTo !== "function") return;

      const scrollerRect = scroller.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const target =
        scroller.scrollLeft +
        activeRect.left -
        scrollerRect.left -
        (scroller.clientWidth - activeRect.width) / 2;
      scroller.scrollTo({
        left: Math.max(0, target),
        behavior: reducedMotion ? "auto" : "smooth",
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [activeStepId, reducedMotion]);

  function openStep(id: StepId) {
    if (focusTimerRef.current !== null) {
      window.clearTimeout(focusTimerRef.current);
    }
    if (restoreTimerRef.current !== null) {
      window.clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
    setSelectedStepId(id);
    setDialogOpen(true);
    focusTimerRef.current = window.setTimeout(() => {
      focusTimerRef.current = null;
      const dialog = document.querySelector<HTMLElement>(
        `[data-timeline-step-dialog="${id}"]`,
      );
      // The dialog's own focus trap may already have moved focus, and the user
      // can Tab away before this fires — only seed focus if it is still outside.
      if (!dialog || dialog.contains(document.activeElement)) return;
      dialog.querySelector<HTMLElement>("[data-timeline-initial-focus]")?.focus();
    }, 50);
  }

  function closeStep() {
    const triggerId = selectedStepId;
    if (focusTimerRef.current !== null) {
      window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    }
    setDialogOpen(false);
    restoreTimerRef.current = window.setTimeout(() => {
      trackRef.current
        ?.querySelector<HTMLElement>(`[data-timeline-step="${triggerId}"]`)
        ?.focus();
      restoreTimerRef.current = null;
    }, reducedMotion ? 0 : 200);
  }

  return (
    <>
      <Card className="onboarding-prototype-enter overflow-hidden">
        <CardContent className="p-4 sm:p-5">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary">
                <Rocket className="h-4 w-4" aria-hidden="true" />
              </div>
              <h2 className="text-sm font-bold leading-tight tracking-[-0.03em] sm:text-lg">
                Haz tuyo este espacio
              </h2>
            </div>
            <Badge
              variant={resolvedCount === steps.length ? "success" : "outline"}
              className="shrink-0 whitespace-nowrap"
            >
              <CircleCheckBig className="h-3 w-3" aria-hidden="true" />
              {resolvedCount} de {steps.length}
            </Badge>
          </div>

          <div ref={trackRef}>
            <TimelineRail
              steps={steps}
              progress={progress}
              activeStepId={activeStepId}
              onOpen={openStep}
            />
          </div>
        </CardContent>
      </Card>

      <TimelineStepDialog
        step={selectedStep}
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeStep();
        }}
        onComplete={onComplete}
        onSkip={onSkip}
        onRevisit={onRevisit}
      />
    </>
  );
}
