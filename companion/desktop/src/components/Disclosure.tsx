// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { AnimatePresence, m } from "motion/react";
import { useId, type ReactNode } from "react";

import { useMotionTokens, useReducedMotionPreference } from "../motion/reduced-motion";
import { disclosureMotion } from "../motion/variants";
import { Icon } from "./Icon";

interface DisclosurePanelProps {
  open: boolean;
  /** Point the trigger's aria-controls here. */
  id: string;
  children: ReactNode;
  className?: string;
}

/** The animated body of a disclosure, for custom triggers (a session row that expands). */
export function DisclosurePanel({ open, id, children, className = "" }: DisclosurePanelProps) {
  const recipe = disclosureMotion(useMotionTokens(), useReducedMotionPreference());
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <m.div key="panel" id={id} data-disclosure-panel className={className} initial={recipe.initial} animate={recipe.animate} exit={recipe.exit}>
          {children}
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

interface DisclosureProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger's text, e.g. "Advanced: use another server". */
  summary: ReactNode;
  children: ReactNode;
  panelClassName?: string;
}

/** DK-0's chevron disclosure: a quiet text button that reveals a panel below it. */
export function Disclosure({ open, onOpenChange, summary, children, panelClassName }: DisclosureProps) {
  const panelId = useId();
  return (
    <>
      <button type="button" className="bp-disclosure" aria-expanded={open} aria-controls={panelId} onClick={() => onOpenChange(!open)}>
        <Icon name="chev-right" />
        {summary}
      </button>
      <DisclosurePanel open={open} id={panelId} {...(panelClassName ? { className: panelClassName } : {})}>
        {children}
      </DisclosurePanel>
    </>
  );
}
