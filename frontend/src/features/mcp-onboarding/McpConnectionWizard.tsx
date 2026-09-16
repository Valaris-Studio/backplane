// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, Plug } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { WizardSteps } from "@/components/ui/wizard-steps";
import { fadeInUp } from "@/lib/animations";
import { useApiKeys } from "@/features/settings/api/use-api-keys";
import type { ApiKey } from "@/types/api-key";
import { StepIntro } from "./components/StepIntro";
import { StepPositioning } from "./components/StepPositioning";
import { StepKey, type SelectedKey } from "./components/StepKey";
import { DEFAULT_HANDOFF_INTENT, type ConnectionPreset } from "./agent-handoff";
import { StepConnect } from "./components/StepConnect";
import { StepVerify } from "./components/StepVerify";

interface McpConnectionWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "intro" | "positioning" | "key" | "connect" | "verify";
const STEP_ORDER: Step[] = ["intro", "positioning", "key", "connect", "verify"];

// The activation moment: from "I have a workspace" to "my coding agent just
// made its first authenticated MCP call". The step cursor is never persisted —
// on every open it is derived from live key state (see openingStep), so a user
// who already minted a key is not walked through the explainers again.
function openingStep(keys: ApiKey[]): Step {
  if (keys.length === 0) return "intro";
  return keys.some((key) => key.last_used_at) ? "verify" : "key";
}

export function McpConnectionWizard({ open, onOpenChange }: McpConnectionWizardProps) {
  const { t } = useTranslation();
  const { data: keys, isLoading } = useApiKeys();
  const [step, setStep] = useState<Step | null>(null);
  const [intent, setIntent] = useState<ConnectionPreset>(DEFAULT_HANDOFF_INTENT);
  const [selected, setSelected] = useState<SelectedKey | null>(null);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

  // A secret minted this session exists ONLY here. Closing without copying it
  // strands a key that is live server-side but unusable.
  const holdsUnsavedSecret = selected?.rawKey != null;

  // Derive the entry point once the key list lands. Deliberately gated on
  // `step === null` so it seeds the cursor without yanking the user backwards
  // when a later mutation refetches the list.
  useEffect(() => {
    if (!open || step !== null || !keys) return;
    setStep(openingStep(keys));
  }, [open, step, keys]);

  // Deferred past the dialog's exit tween (~180ms): resetting synchronously
  // swapped the step content for the loading spinner while the dialog was
  // still fading out.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => {
      setStep(null);
      setSelected(null);
      setIntent(DEFAULT_HANDOFF_INTENT);
      setCloseGuardOpen(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [open]);

  // fadeInUp hardcodes `autoAlpha: 0` in its FROM vars, so it cannot be opted
  // out of from the caller — passing autoAlpha in the options only touches the
  // TO vars and leaves the pane at visibility:hidden. Let the preset run whole:
  // it ends on autoAlpha:1, which restores visibility along with opacity.
  useEffect(() => {
    if (!step || !paneRef.current) return;
    fadeInUp(paneRef.current, { offset: 8, duration: 0.22 });
  }, [step]);

  const close = () => onOpenChange(false);
  const requestClose = () => {
    if (holdsUnsavedSecret) {
      setCloseGuardOpen(true);
      return;
    }
    close();
  };
  const go = (direction: 1 | -1) =>
    setStep((current) => {
      if (!current) return current;
      const next = STEP_ORDER.indexOf(current) + direction;
      return STEP_ORDER[next] ?? current;
    });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      {/* The shared DialogContent deliberately omits role="dialog" — set it
          here so assistive tech (and getByRole) sees a dialog. */}
      <DialogContent role="dialog" aria-modal="true" className="max-w-2xl grid-cols-1">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" />
            {t("mcpOnboarding.title")}
          </DialogTitle>
          <DialogDescription>{t("mcpOnboarding.subtitle")}</DialogDescription>
        </DialogHeader>

        {step === null ? (
          <div
            data-testid="wizard-loading"
            className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {isLoading ? t("mcpOnboarding.loading") : null}
          </div>
        ) : (
          <>
            <StepIndicator step={step} />
            <div ref={paneRef} data-testid="wizard-pane">
              {step === "intro" ? (
                <StepIntro onNext={() => go(1)} />
              ) : step === "positioning" ? (
                <StepPositioning onNext={() => go(1)} onBack={() => go(-1)} />
              ) : step === "key" ? (
                <StepKey
                  existingKeys={keys ?? []}
                  selected={selected}
                  onSelect={setSelected}
                  onNext={() => go(1)}
                  onBack={() => go(-1)}
                />
              ) : step === "connect" ? (
                <StepConnect
                  origin={window.location.origin}
                  apiKey={selected?.rawKey ?? null}
                  intent={intent}
                  onIntentChange={setIntent}
                  onNext={() => go(1)}
                  onBack={() => go(-1)}
                />
              ) : (
                <StepVerify
                  apiKeyId={selected?.id ?? null}
                  intent={intent}
                  // Derived from key state, not from `selected === null`: the
                  // step is also reachable by walking forward from step 4, and
                  // arriving with nothing selected is not by itself evidence
                  // that a key has ever been used.
                  alreadyConnected={
                    selected === null && (keys ?? []).some((key) => key.last_used_at)
                  }
                  onConnectAnother={() => setStep("key")}
                  onDone={requestClose}
                />
              )}
            </div>
          </>
        )}
        {/* Rendered INSIDE the wizard's own content rather than as a sibling
            Dialog: a second Dialog mounted next to an open one fights it for
            focus and the Escape that opened the guard would close both. */}
        {closeGuardOpen ? (
          <CloseGuard
            onCancel={() => setCloseGuardOpen(false)}
            onConfirm={() => {
              setCloseGuardOpen(false);
              close();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CloseGuard({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const guardRef = useRef<HTMLDivElement>(null);

  // A warning that pops into an otherwise-settled dialog is exactly the
  // jarring appearance the entrance presets exist for.
  useEffect(() => {
    if (!guardRef.current) return;
    fadeInUp(guardRef.current, { offset: 6, duration: 0.2 });
  }, []);

  return (
    <div
      ref={guardRef}
      data-testid="wizard-close-guard"
      role="alertdialog"
      aria-label={t("mcpOnboarding.closeGuardTitle")}
      className="rounded-[var(--radius-md)] border border-[color:var(--color-warning)]/40 bg-[color:color-mix(in_oklab,var(--color-warning)_8%,var(--color-card))] p-3.5"
    >
      <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-foreground">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]"
          aria-hidden
        />
        {t("mcpOnboarding.closeGuardBody")}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          data-testid="wizard-close-guard-cancel"
        >
          {t("mcpOnboarding.closeGuardCancel")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          data-testid="wizard-close-guard-confirm"
        >
          {t("mcpOnboarding.closeGuardConfirm")}
        </Button>
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const { t } = useTranslation();
  const labels: Record<Step, string> = {
    intro: t("mcpOnboarding.stepIntro"),
    positioning: t("mcpOnboarding.stepPositioning"),
    key: t("mcpOnboarding.stepKey"),
    connect: t("mcpOnboarding.stepConnect"),
    verify: t("mcpOnboarding.stepVerify"),
  };

  return (
    <WizardSteps
      aria-label={t("a11y.mcpOnboarding.steps")}
      steps={STEP_ORDER.map((id) => ({ id, label: labels[id] }))}
      currentIndex={STEP_ORDER.indexOf(step)}
    />
  );
}
