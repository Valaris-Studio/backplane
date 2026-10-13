// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { AnimatePresence, m, useIsPresent, type Variants } from "motion/react";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { useMotionTokens, useReducedMotionPreference } from "./reduced-motion";
import { viewSwapMotion, type MotionRecipe, type ViewSwapKind } from "./variants";

// Variant functions read the recipe from `custom`, so a view that is already
// leaving still exits the way the *latest* navigation asks (push vs pop).
const VIEW_VARIANTS: Variants = {
  enter: (recipe: MotionRecipe) => recipe.initial || {},
  shown: (recipe: MotionRecipe) => recipe.animate,
  leave: (recipe: MotionRecipe) => recipe.exit,
};

function ViewFrame({ recipe, className, children }: { recipe: MotionRecipe; className: string; children: ReactNode }) {
  const isPresent = useIsPresent();
  return (
    <m.div
      data-view
      data-leaving={isPresent ? undefined : "true"}
      inert={!isPresent}
      className={className}
      custom={recipe}
      variants={VIEW_VARIANTS}
      initial={recipe.initial === false ? false : "enter"}
      animate="shown"
      exit="leave"
    >
      {children}
    </m.div>
  );
}

interface ViewSwapProps {
  /** Changing the key swaps the view; the same key re-renders in place. */
  viewKey: string;
  kind: ViewSwapKind;
  children: ReactNode;
  /** Classes for the scroll container this renders. */
  className?: string;
  /** Classes for each view inside it. */
  viewClassName?: string;
  id?: string;
  role?: string;
  "aria-labelledby"?: string;
  "aria-label"?: string;
  tabIndex?: number;
}

/**
 * The scroll body that swaps whole views: the new view slides in while the
 * old one, pinned where the user had scrolled it, slides out underneath.
 */
export function ViewSwap({ viewKey, kind, children, className = "", viewClassName = "bp-view", ...containerProps }: ViewSwapProps) {
  const reduced = useReducedMotionPreference();
  const tokens = useMotionTokens();
  const recipe = viewSwapMotion(kind, tokens, reduced);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrolledBy = scroller.scrollTop;
    const leaving = scroller.querySelector<HTMLElement>(':scope > [data-leaving="true"]');
    if (leaving) leaving.style.top = `${-scrolledBy}px`;
    scroller.scrollTop = 0;
  }, [viewKey]);

  return (
    <div ref={scrollerRef} className={`relative ${className}`} {...containerProps}>
      <AnimatePresence initial={false} custom={recipe}>
        <ViewFrame key={viewKey} recipe={recipe} className={viewClassName}>
          {children}
        </ViewFrame>
      </AnimatePresence>
    </div>
  );
}
