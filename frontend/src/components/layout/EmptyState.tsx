// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { gsap } from "gsap";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  const iconChipRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    // Static render is the reduced-motion fallback — skip animation entirely.
    if (reducedMotion) return;

    const iconChip = iconChipRef.current;
    if (!iconChip) return;

    const cascadeTargets: (HTMLElement | null)[] = [
      titleRef.current,
      descriptionRef.current,
      actionRef.current,
    ];
    const presentTargets = cascadeTargets.filter((el) => el !== null);

    // Entrance: icon chip pops in, then text/action cascade up. Only
    // transform/opacity are animated so the layout never shifts. Plain opacity
    // (NOT autoAlpha) — visibility:hidden would drop the title/CTA from the
    // accessibility tree mid-entrance, breaking screen readers and every
    // consumer test that queries by role.
    const timeline = gsap.timeline();
    timeline.fromTo(
      iconChip,
      { opacity: 0, scale: 0.8 },
      { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(1.6)" },
    );
    timeline.fromTo(
      presentTargets,
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.28, ease: "power2.out", stagger: 0.08 },
      "-=0.1",
    );

    // Perpetual gentle float on the chip; amplitude kept ≤4px so it reads
    // as alive, not broken.
    timeline.to(iconChip, {
      y: -4,
      duration: 2.8,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    });

    return () => {
      timeline.kill();
      // A mid-flight kill freezes whatever inline styles gsap had applied
      // (autoAlpha can leave visibility:hidden / partial opacity). Clear them
      // so the static render — also the reduced-motion fallback when the
      // preference flips while mounted — is fully restored.
      gsap.set([iconChip, ...presentTargets], {
        clearProps: "opacity,visibility,transform",
      });
    };
  }, [reducedMotion]);

  return (
    <Card
      className={cn(
        "overflow-hidden border-dashed bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-card)_84%,transparent),color-mix(in_oklab,var(--color-surface-2)_74%,transparent))]",
        className,
      )}
    >
      <CardContent className="flex min-h-72 flex-col items-center justify-center gap-5 px-[var(--card-padding)] py-[calc(var(--card-padding)*1.7)] text-center">
        <div
          ref={iconChipRef}
          data-testid="empty-state-icon-chip"
          className="flex h-18 w-18 items-center justify-center rounded-[var(--radius-cap)] border border-primary/15 bg-primary/10 text-primary shadow-soft"
        >
          <Icon className="h-8 w-8" />
        </div>
        <div className="space-y-2">
          <h2 ref={titleRef} className="text-2xl font-bold text-foreground">
            {title}
          </h2>
          <p
            ref={descriptionRef}
            className="mx-auto max-w-xl text-sm leading-6 text-muted-foreground sm:text-base"
          >
            {description}
          </p>
        </div>
        {action ? (
          <div ref={actionRef} className="pt-1">
            {action}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
