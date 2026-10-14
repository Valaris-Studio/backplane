// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ViewSwap } from "../../motion/ViewSwap";
import { statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";
import { AgentsStep } from "./AgentsStep";
import { CodeStep } from "./CodeStep";
import { DoneStep } from "./DoneStep";
import { effectiveStep, observeConnectedStatus, readOnboardingFinished, useOnboardingState, type OnboardingStep, type PendingPairing } from "./onboarding-store";
import { resumePendingPairing } from "./pairing-actions";
import { ProjectsStep } from "./ProjectsStep";
import { ServerStep } from "./ServerStep";
import { WelcomeStep } from "./WelcomeStep";
import "./onboarding.css";

function StepView({ step, pairing }: { step: OnboardingStep; pairing: PendingPairing | null }) {
  switch (step) {
    case "welcome":
      return <WelcomeStep />;
    case "server":
      return <ServerStep />;
    case "code":
      // Keyed by pairing so a new code starts with fresh poll, copy and error state.
      return pairing ? <CodeStep key={pairing.ticket.pairing_id} pairing={pairing} /> : <ServerStep />;
    case "agents":
      return <AgentsStep />;
    case "projects":
      return <ProjectsStep />;
    case "done":
      return <DoneStep />;
  }
}

/**
 * First run, shown by the shell while the device is not connected (and until
 * Done once pairing connects). The step is derived from daemon state plus
 * where the user has navigated in this webview; see effectiveStep.
 */
export function OnboardingScreen() {
  const connected = useStoreSelector(statusStore, (status) => status?.connected ?? false);
  const state = useOnboardingState();
  const [finishedBefore] = useState(readOnboardingFinished);
  const step = effectiveStep(state, connected, finishedBefore);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastStep = useRef<OnboardingStep | null>(null);

  // Every status, not just changes of the selected value: the reset needs the first false after a true.
  useEffect(() => {
    // A null status is a daemon gap (unreachable, reconnecting), not a disconnect: only a real `connected: false` counts.
    const observe = () => {
      const status = statusStore.get();
      if (status) observeConnectedStatus(status.connected);
    };
    observe();
    return statusStore.subscribe(observe);
  }, []);

  // Asked again on each mount until the daemon answers: at launch it may still be starting.
  useEffect(() => {
    if (!connected) void resumePendingPairing();
  }, [connected]);

  // A new step moves focus to its heading; the first step shown keeps the shell's opening focus.
  useLayoutEffect(() => {
    const previous = lastStep.current;
    lastStep.current = step;
    if (previous === null || previous === step) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-step-heading="${step}"]`)?.focus({ preventScroll: true });
  }, [step]);

  return (
    <div ref={rootRef} data-testid="screen-onboarding" className="ob-screen">
      <ViewSwap viewKey={step} kind={state.transition} className="ob-swap">
        <StepView step={step} pairing={state.pairing} />
      </ViewSwap>
    </div>
  );
}
