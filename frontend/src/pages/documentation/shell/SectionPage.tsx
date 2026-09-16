// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fadeInUp } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  useDocumentationSectionEyebrow,
  useDocumentationSectionTitle,
} from "../section-title-context";
import {
  localizeDocumentationNode,
  useDocumentationSectionTranslations,
} from "../section-localization";

interface SectionPageProps {
  title: string;
  eyebrow?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

const STAGGER_SELECTOR = "[data-stagger-item]";

export function SectionPage({
  title,
  eyebrow,
  children,
  className,
  bodyClassName,
}: SectionPageProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();
  const localizedTitle = useDocumentationSectionTitle(title);
  const localizedEyebrow = useDocumentationSectionEyebrow(eyebrow);
  const translations = useDocumentationSectionTranslations();
  const localizedChildren = useMemo(
    () => localizeDocumentationNode(children, translations),
    [children, translations],
  );

  // H1 entrance: fade + 12px slide up on mount. Instant when reduced.
  useEffect(() => {
    if (reducedMotion || !headingRef.current) return;
    fadeInUp(headingRef.current, { offset: 12, duration: 0.32 });
  }, [reducedMotion]);

  // Callout-like direct children stagger in as they scroll into view.
  useEffect(() => {
    if (reducedMotion || !bodyRef.current) return;

    const targets = Array.from(
      bodyRef.current.querySelectorAll<HTMLElement>(STAGGER_SELECTOR),
    );
    if (!targets.length) return;

    targets.forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "translateY(12px)";
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries
          .filter((entry) => entry.isIntersecting)
          .forEach((entry) => {
            const element = entry.target as HTMLElement;
            fadeInUp(element, { offset: 12, duration: 0.28 });
            observer.unobserve(element);
          });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [reducedMotion, children]);

  return (
    <article className={cn("space-y-6", className)}>
      <header className="space-y-2">
        {localizedEyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/70">
            {localizedEyebrow}
          </p>
        ) : null}
        <h1
          ref={headingRef}
          className="font-bold text-balance text-3xl text-foreground sm:text-4xl"
        >
          {localizedTitle}
        </h1>
      </header>
      <div
        ref={bodyRef}
        className={cn(
          "prose-documentation max-w-prose space-y-4 text-[0.95rem] leading-7 text-foreground/90 [&_h2]:mt-10 [&_h2]:scroll-mt-24 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-[-0.025em] [&_h2]:text-foreground [&_h3]:mt-6 [&_h3]:scroll-mt-24 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_p]:leading-7 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:leading-7 [&_code]:rounded [&_code]:bg-[color:var(--color-muted)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_strong]:font-semibold",
          bodyClassName,
        )}
      >
        {localizedChildren}
      </div>
    </article>
  );
}
