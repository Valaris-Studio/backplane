// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { gsap } from "gsap";
import { Check, CircleDashed, Minus, type LucideIcon } from "lucide-react";
import { pillVariants } from "@/components/ui/pill";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

const PROGRESS_TRANSITION_MS = 220;

export type RailStepState = "empty" | "done" | "skipped";

// Status presentation is data, not branches: done/skipped/pending each own a
// glyph and a container treatment, so the pill markup stays single-path.
const STATUS_META: Record<
  RailStepState,
  { icon: LucideIcon; labelKey: string; buttonClass: string; iconClass: string }
> = {
  done: {
    icon: Check,
    labelKey: "onboarding.checklist.done",
    buttonClass:
      "border-success/35 bg-[color:color-mix(in_oklab,var(--color-success)_10%,var(--color-card))] text-foreground hover:border-success/55",
    iconClass: "text-[color:var(--color-success)]",
  },
  empty: {
    icon: CircleDashed,
    labelKey: "onboarding.checklist.pending",
    buttonClass:
      "border-border/75 bg-card text-foreground hover:border-primary/45 hover:bg-[color:color-mix(in_oklab,var(--color-primary)_5%,var(--color-card))]",
    iconClass: "text-primary",
  },
  skipped: {
    icon: Minus,
    labelKey: "onboarding.checklist.skipped",
    buttonClass:
      "border-border/55 bg-muted/70 text-muted-foreground hover:border-border hover:bg-muted",
    iconClass: "text-muted-foreground",
  },
};

// Celebrate only a false→true transition during this session — a pill that
// mounts already done gets no ceremony. The ring's color-mix() boxShadow is
// STATIC css; gsap only tweens numbers (scale/rotation/opacity) on it, and
// never autoAlpha, which would drop the pill from the a11y tree.
function useStepCelebration(done: boolean) {
  const reducedMotion = useReducedMotion();
  const statusIconRef = useRef<SVGSVGElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const prevDoneRef = useRef(done);

  useEffect(() => {
    const wasDone = prevDoneRef.current;
    prevDoneRef.current = done;
    if (wasDone || !done || reducedMotion) return;

    const icon = statusIconRef.current;
    const ring = ringRef.current;
    const tweens = [
      icon &&
        gsap.fromTo(
          icon,
          { scale: 0.3, rotation: -30 },
          { scale: 1, rotation: 0, duration: 0.4, ease: "back.out(2.2)" },
        ),
      ring &&
        gsap.fromTo(
          ring,
          { opacity: 1, scale: 0.97 },
          { opacity: 0, scale: 1.03, duration: 0.7, ease: "power2.out" },
        ),
    ];
    return () => {
      for (const tween of tweens) tween?.kill();
      const targets = [icon, ring].filter(Boolean) as Element[];
      // gsap.set([], ...) warns "GSAP target not found" — guard the case where
      // this pill unmounts before either ref ever mounted.
      if (targets.length) gsap.set(targets, { clearProps: "all" });
    };
  }, [done, reducedMotion]);

  return { statusIconRef, ringRef };
}

function RailStepPill<Id extends string>({
  step,
  active,
  onOpen,
}: {
  step: RailStep<Id>;
  active: boolean;
  onOpen: (id: Id) => void;
}) {
  const { t } = useTranslation();
  const { statusIconRef, ringRef } = useStepCelebration(step.state === "done");
  const StepIcon = step.icon;
  const status = STATUS_META[step.state];
  const StatusIcon = status.icon;

  return (
    // The <li> — not the button — owns the step's identity and state, so the
    // ring (a sibling of the pill) resolves to its step by `closest()` and
    // `[data-onboarding-step]` never matches two nested nodes.
    <li
      data-onboarding-step={step.id}
      data-step-state={step.state}
      className="relative flex min-w-0 justify-center"
    >
      <span
        ref={ringRef}
        data-step-celebration-ring
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[var(--radius-cap)] opacity-0 shadow-[0_0_0_6px_color-mix(in_oklab,var(--color-success)_45%,transparent)]"
      />
      <button
        type="button"
        data-rail-step={step.id}
        aria-current={active ? "step" : undefined}
        onClick={() => onOpen(step.id)}
        className={cn(
          pillVariants({ tint: "none" }),
          "h-10 w-full max-w-[8rem] justify-center gap-2 border px-3 py-0 normal-case tracking-normal outline-none transition-[transform,background-color,border-color,color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none",
          status.buttonClass,
          active &&
            "border-primary/55 bg-[color:color-mix(in_oklab,var(--color-primary)_9%,var(--color-card))] shadow-soft ring-1 ring-primary/20",
        )}
      >
        {/* One treatment for the step's own glyph in every state — the
            done/skipped signal is the pill's tint and the status icon beside
            it, never a recolored step glyph. */}
        <StepIcon
          data-step-icon
          className="h-3.5 w-3.5 shrink-0 text-current"
          aria-hidden="true"
        />
        <span className="min-w-0 truncate text-xs font-semibold">
          {step.label}
        </span>
        <StatusIcon
          ref={statusIconRef}
          data-step-status-icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active ? "text-primary" : status.iconClass,
          )}
          aria-hidden="true"
        />
        <span className="sr-only">
          {t("onboarding.checklist.stepStatusAria", {
            status: t(status.labelKey),
          })}
        </span>
      </button>
    </li>
  );
}

export interface RailStep<Id extends string = string> {
  id: Id;
  icon: LucideIcon;
  label: string;
  state: RailStepState;
}

interface OnboardingRailProps<Id extends string> {
  steps: RailStep<Id>[];
  progress: number;
  activeStepId: Id | null;
  onOpen: (id: Id) => void;
}

export function OnboardingRail<Id extends string>({
  steps,
  progress,
  activeStepId,
  onOpen,
}: OnboardingRailProps<Id>) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const progressValue = Math.min(Math.max(progress, 0), 100);

  // The rail overflows on narrow viewports; keep the step the user is being
  // pointed at in view. Guarded on scrollWidth so a fitting rail never scrolls
  // the page, and on scrollTo so jsdom without the API stays silent.
  useEffect(() => {
    if (!activeStepId) return;
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      const active = scroller?.querySelector<HTMLElement>(
        `[data-rail-step="${activeStepId}"]`,
      );
      if (!scroller || !active) return;
      if (scroller.scrollWidth <= scroller.clientWidth) return;
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

  return (
    <div
      ref={scrollerRef}
      data-onboarding-rail
      className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <span className="sr-only" aria-live="polite">
        {t("onboarding.checklist.progressAnnouncement", {
          percent: Math.round(progressValue),
        })}
      </span>
      <div className="relative min-w-[45rem] py-2 sm:min-w-[48rem]">
        {/* The dotted line sits behind the pills and is inset by half a
            column so it spans between the first and last pill centers rather
            than running past them. */}
        <div
          role="progressbar"
          aria-label={t("onboarding.checklist.progressAria")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressValue)}
          data-rail-progress
          className="pointer-events-none absolute left-[8.333%] right-[8.333%] top-1/2 h-px -translate-y-1/2"
        >
          {/* Dark --color-border is a DARK gray (oklch .308) against a dark
              canvas, where light's is near-white (oklch .89) — the same /65
              alpha that reads as subtle on light all but disappears on dark.
              Lift the track's alpha and borrow the brighter foreground token
              per theme instead of thickening the line. */}
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-0 border-t border-dotted border-border/65 dark:border-[color:color-mix(in_oklab,var(--color-foreground)_28%,transparent)]"
          />
          <span
            data-rail-progress-fill
            aria-hidden="true"
            className="absolute inset-x-0 top-0 border-t border-dotted border-primary/40 transition-[clip-path] will-change-[clip-path] motion-reduce:transition-none dark:border-primary/70"
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
          aria-label={t("onboarding.checklist.railAria")}
        >
          {steps.map((step) => (
            <RailStepPill
              key={step.id}
              step={step}
              active={step.id === activeStepId && step.state === "empty"}
              onOpen={onOpen}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}
