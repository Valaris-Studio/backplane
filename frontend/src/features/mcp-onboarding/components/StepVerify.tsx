// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { apiKeyKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import { fadeInUp } from "@/lib/animations";
import { useDocsBasePath } from "@/pages/documentation/use-docs-base-path";
import type { ApiKey } from "@/types/api-key";
import { DEFAULT_HANDOFF_INTENT, type ConnectionPreset } from "../agent-handoff";
import { buildVerificationPrompt } from "../verification-prompt";
import { CopyableBlock } from "./CopyableBlock";

// How long we wait before offering troubleshooting hints. Long enough that a
// user who is genuinely mid-install (agent downloading uv, editing config) is
// not told something is wrong, short enough that someone who typo'd an env var
// is not left staring at a spinner. The listener keeps running past this — the
// timeout only changes what we SAY, never what we do.
export const VERIFY_TIMEOUT_MS = 3 * 60 * 1000;

// Backstop cadence for the keys query while we're waiting. The `api_key.first_used`
// WS event is a latency optimisation the backend drops on publish failure by
// design, so polling is the backstop for observing key activity.
// Slow on purpose: one in-flight request per 25s costs nothing and the WS path
// covers the common case in milliseconds.
export const VERIFY_POLL_MS = 25_000;

export interface StepVerifyProps {
  intent?: ConnectionPreset;
  // The key the user created or picked in step 3. Null only if the wizard was
  // resumed straight into this step from an already-used key.
  apiKeyId: string | null;
  // True when the wizard opened here because a key already has last_used_at —
  // this is historical activity, not proof of present MCP health.
  alreadyConnected: boolean;
  // Jumps back to the key step. Only meaningful (and only rendered) in the
  // authenticated state: without it the verify shortcut traps a returning
  // user who wants to connect a SECOND agent.
  onConnectAnother: () => void;
  onDone: () => void;
}

export function StepVerify({
  intent = DEFAULT_HANDOFF_INTENT,
  apiKeyId,
  alreadyConnected,
  onConnectAnother,
  onDone,
}: StepVerifyProps) {
  const { t } = useTranslation();
  const [timedOut, setTimedOut] = useState(false);
  const [result, setResult] = useState<keyof typeof RESULT_LABELS>("pending");
  const resultId = useId();
  const { slug } = useParams<{ slug: string }>();
  const docsBasePath = useDocsBasePath();

  // Latency path only. Unprovided (as in tests, or any surface mounted outside
  // WebSocketProvider) useWebSocketEvent subscribes to nothing and this is
  // simply inert — the polling observer below still carries the feature.
  useDomainSync("api_key", apiKeyKeys.all, {
    filter: (event) =>
      apiKeyId != null &&
      (event.payload as { api_key_id?: string } | null)?.api_key_id === apiKeyId,
  });

  // A second observer on the SAME key as useApiKeys: React Query dedupes them
  // into one cache entry, so this adds the waiting-only poll without giving the
  // rest of the app a background refetch loop. Stops after key activity is observed.
  const { data: keys, isError, isFetching, refetch } = useQuery({
    queryKey: apiKeyKeys.all,
    queryFn: async () => {
      const { data } = await api.get<ApiKey[]>("/me/api-keys");
      return data;
    },
    retry: false,
    refetchInterval: (query) => alreadyConnected || query.state.status === "error" ||
      query.state.data?.some((key) => key.id === apiKeyId && key.last_used_at != null)
      ? false : VERIFY_POLL_MS,
  });

  const usedKey = keys?.find((key) => key.id === apiKeyId && key.last_used_at != null);
  const authenticationObserved = alreadyConnected || usedKey != null;

  // One-shot by design: the timer is keyed on `authenticationObserved` alone, so dismissing
  // the hints via "keep waiting" retires them for the rest of the session
  // rather than re-arming. Someone who has read the checklist and chosen to
  // wait should not be handed it again every three minutes.
  useEffect(() => {
    if (authenticationObserved) return;
    const timer = setTimeout(() => setTimedOut(true), VERIFY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [authenticationObserved]);

  return (
    <div className="space-y-4" data-testid="wizard-step-verify">
      {authenticationObserved ? (
        <div data-testid="wizard-verify-auth-observed" role="status" className="space-y-1 rounded-[var(--radius-md)] border border-border/60 p-3 text-sm">
          <h3 className="font-medium">{t("mcpOnboarding.verifyAuthObservedTitle")}</h3>
          <p className="text-muted-foreground">{t(alreadyConnected ? "mcpOnboarding.verifyAuthHistoricalBody" : "mcpOnboarding.verifyAuthObservedBody")}</p>
          {usedKey?.name && <p className="break-words text-muted-foreground">{usedKey.name}</p>}
        </div>
      ) : isError ? (
        <div role="alert" className="space-y-2 rounded-[var(--radius-md)] border border-destructive/40 p-3 text-sm">
          <p>{t("mcpOnboarding.verifyRequestError")}</p>
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            {t("mcpOnboarding.verifyRetry")}
          </Button>
        </div>
      ) : <div
        role="status"
        aria-live="polite"
        data-testid="wizard-verify-waiting"
        className="flex items-start gap-3 rounded-[var(--radius-md)] border border-border/60 bg-[color:var(--color-surface-2)] px-3.5 py-3"
      >
        <Loader2
          className="mt-0.5 h-4 w-4 shrink-0 motion-safe:animate-spin text-primary"
          aria-hidden
        />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t("mcpOnboarding.verifyWaitingTitle")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("mcpOnboarding.verifyWaitingBody")}
          </p>
        </div>
      </div>}

      {timedOut && !isError && !authenticationObserved ? (
        <Troubleshooting onKeepWaiting={() => setTimedOut(false)} onSkip={onDone} />
      ) : null}

      <p data-testid="wizard-verify-tool-status" className="text-sm text-muted-foreground">
        {t("mcpOnboarding.verifyToolCheckPending")}
      </p>
      <CopyableBlock
        label={t("mcpOnboarding.verifyCheckLabel")}
        value={buildVerificationPrompt(intent, slug)}
        copyLabel={t("mcpOnboarding.verifyCopyCheck")}
        testid="wizard-verification-prompt"
      />
      <div className="space-y-2">
        <label htmlFor={resultId} className="block text-sm font-medium">{t("mcpOnboarding.verifyAgentResultLabel")}</label>
        <select id={resultId} value={result} onChange={(event) => setResult(event.target.value as keyof typeof RESULT_LABELS)}
          className="w-full rounded-[var(--radius-md)] border border-border bg-background p-2 text-sm">
          {Object.entries(RESULT_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
        <p data-testid="wizard-verification-result" aria-live="polite" className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
          {t(RESULT_HELP[result])}
        </p>
      </div>
      <Link to={`${docsBasePath}/mcp-toolsets#discovery`} data-testid="wizard-verify-docs-link"
        target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline">
        <BookOpen className="h-3.5 w-3.5" aria-hidden />
        {t("mcpOnboarding.verifyDocsLink")}
      </Link>
      <DialogFooter>
        {authenticationObserved && <Button variant="outline" onClick={onConnectAnother} data-testid="wizard-connect-another">
          {t("mcpOnboarding.verifyConnectAnother")}
        </Button>}
        <Button onClick={onDone} data-testid="wizard-done">
          {t("mcpOnboarding.close")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function Troubleshooting({
  onKeepWaiting,
  onSkip,
}: {
  onKeepWaiting: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  // Materialises after three minutes of quiet waiting — soften the arrival so
  // it reads as an offer, not an alarm.
  useEffect(() => {
    if (!panelRef.current) return;
    fadeInUp(panelRef.current, { offset: 6, duration: 0.2 });
  }, []);

  return (
    <div
      ref={panelRef}
      data-testid="wizard-verify-troubleshooting"
      className="rounded-[var(--radius-md)] border border-border/70 bg-[color:var(--color-muted)] px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-sm font-medium text-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {t("mcpOnboarding.verifyTroubleshootingTitle")}
      </p>
      <ul className="mt-2.5 space-y-1.5 pl-6 text-sm leading-relaxed text-muted-foreground">
        <li className="list-disc">{t("mcpOnboarding.verifyHintApiUrl")}</li>
        <li className="list-disc">{t("mcpOnboarding.verifyHintApiKey")}</li>
        <li className="list-disc">{t("mcpOnboarding.verifyHintUvx")}</li>
      </ul>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onSkip}
          data-testid="wizard-verify-skip"
        >
          {t("mcpOnboarding.verifySkip")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onKeepWaiting}
          data-testid="wizard-verify-keep-waiting"
        >
          {t("mcpOnboarding.verifyKeepWaiting")}
        </Button>
      </div>
    </div>
  );
}

const RESULT_LABELS = {
  pending: "mcpOnboarding.verifyResultPending",
  success: "mcpOnboarding.verifyResultSuccess",
  "missing-tools": "mcpOnboarding.verifyResultMissingTools",
  auth: "mcpOnboarding.verifyResultAuth",
  network: "mcpOnboarding.verifyResultNetwork",
  "version-allowlist": "mcpOnboarding.verifyResultVersionAllowlist",
};

const RESULT_HELP: Record<keyof typeof RESULT_LABELS, string> = {
  pending: "mcpOnboarding.verifyToolCheckPending",
  success: "mcpOnboarding.verifyResultReported",
  "missing-tools": "mcpOnboarding.verifyRecoveryMissingTools",
  auth: "mcpOnboarding.verifyRecoveryAuth",
  network: "mcpOnboarding.verifyRecoveryNetwork",
  "version-allowlist": "mcpOnboarding.verifyRecoveryVersionAllowlist",
};
