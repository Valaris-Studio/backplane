// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { AlertCircle, AudioWaveform, RotateCw } from "lucide-react";
import { EmptyState } from "@/components/layout/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api-error";

export function SessionListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      data-testid="sessions-skeleton"
      aria-hidden
      className="overflow-hidden rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel"
    >
      <div className="h-9 border-b border-border bg-[color:var(--color-surface-2)]" />
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[1.9rem_minmax(0,1fr)_6rem] items-center gap-4 border-t border-border/60 px-[var(--card-padding)] py-3 sm:grid-cols-[1.9rem_minmax(0,1fr)_minmax(0,14rem)_5rem_5rem_6rem]"
        >
          <Skeleton className="size-[1.9rem]" />
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
          <Skeleton className="hidden h-6 w-4/5 sm:block" />
          <Skeleton className="hidden h-3.5 w-12 justify-self-end sm:block" />
          <Skeleton className="hidden h-3.5 w-12 justify-self-end sm:block" />
          <Skeleton className="h-3.5 w-14 justify-self-end" />
        </div>
      ))}
    </div>
  );
}

interface FirstRunStep {
  title: string;
  body: string;
}

export function FirstRunState() {
  const { t } = useTranslation();
  const steps: FirstRunStep[] = [
    { title: t("sessions.firstRun.install"), body: t("sessions.firstRun.installBody") },
    { title: t("sessions.firstRun.signIn"), body: t("sessions.firstRun.signInBody") },
    { title: t("sessions.firstRun.folder"), body: t("sessions.firstRun.folderBody") },
  ];
  return (
    <EmptyState
      icon={AudioWaveform}
      title={t("sessions.firstRun.title")}
      description={t("sessions.firstRun.description")}
      action={
        <ol aria-label={t("sessions.firstRun.stepsLabel")} className="mx-auto grid max-w-sm gap-3 text-left">
          {steps.map((step, index) => (
            <li key={step.title} className="grid grid-cols-[1.5rem_1fr] gap-x-3">
              <span
                aria-hidden
                className="grid size-6 place-items-center rounded-full border border-border bg-card text-xs font-bold tabular-nums text-muted-foreground"
              >
                {index + 1}
              </span>
              <span>
                <span className="block text-sm font-semibold text-foreground">{step.title}</span>
                <span className="block text-sm text-muted-foreground">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
      }
    />
  );
}

interface LoadErrorStateProps {
  error: unknown;
  title: string;
  description: string;
  onRetry: () => void;
  retrying?: boolean;
}

export function LoadErrorState({ error, title, description, onRetry, retrying }: LoadErrorStateProps) {
  const { t } = useTranslation();
  const agentKeyRefused = isApiError(error) && error.status === 403;
  return (
    <EmptyState
      icon={AlertCircle}
      title={title}
      description={agentKeyRefused ? t("sessions.loadError.agentKey") : description}
      action={
        agentKeyRefused ? undefined : (
          <Button variant="outline" onClick={onRetry} disabled={retrying}>
            <RotateCw aria-hidden className={retrying ? "motion-safe:animate-spin" : undefined} />
            {t("sessions.loadError.retry")}
          </Button>
        )
      }
    />
  );
}
