// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

import { Button } from "../../components/Button";
import { AppIcon } from "../../components/Icon";
import { Stepper } from "../../components/Stepper";
import { STEP_COUNT, STEP_NUMBER, type OnboardingStep } from "./onboarding-store";

interface OnboardingFrameProps {
  step: OnboardingStep;
  title: string;
  lede?: ReactNode;
  /** Above the heading (the welcome's app icon, the done mark). */
  hero?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onBack?: () => void;
}

/** One onboarding step: brand and progress on top, the step's heading, its body, and the actions pinned below. */
export function OnboardingFrame({ step, title, lede, hero, children, actions, onBack }: OnboardingFrameProps) {
  return (
    <div className="ob" data-step={step}>
      <div className="ob-top" data-window-drag>
        <span className="ob-brand">
          <AppIcon size={22} />
          Companion
        </span>
        <Stepper current={STEP_NUMBER[step]} total={STEP_COUNT} />
      </div>
      {hero}
      {/* Focused on every step change (index.tsx), so screen readers start at the new step. */}
      <h1 className="ob-title" tabIndex={-1} data-step-heading={step}>
        {title}
      </h1>
      {lede ? <p className="ob-lede">{lede}</p> : null}
      {children}
      <div className="ob-actions">
        {onBack ? <Button onClick={onBack}>Back</Button> : null}
        <span className="ob-spacer" />
        {actions}
      </div>
    </div>
  );
}

export function Promises({ children }: { children: ReactNode }) {
  return <ul className="ob-promises">{children}</ul>;
}

export function PromiseItem({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li>
      {icon}
      <div>
        <b>{title}</b>
        <span>{children}</span>
      </div>
    </li>
  );
}
