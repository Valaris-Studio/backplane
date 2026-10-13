// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

/** A UI label the user has to find on screen, set in curly quotes and bold. */
export function Quote({ children }: { children: ReactNode }) {
  return <q className="bp-quote">{children}</q>;
}

/** Numbered instructions (the Codex trust steps), shared by Onboarding and Agents. */
export function StepList({ steps, label, className = "" }: { steps: readonly ReactNode[]; label?: string; className?: string }) {
  return (
    <ol className={`bp-steps ${className}`} aria-label={label}>
      {steps.map((step, index) => (
        // Steps are a fixed script; their order is their identity.
        <li key={index}>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}
