// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, Cpu, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { useDocsBasePath } from "@/pages/documentation/use-docs-base-path";

// The #1 confusion this wizard has to clear: people assume MCP access requires
// standing up a runner. It does not — they are two ways into the same board,
// and only the first one is on today's path.
export function StepPositioning({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const docsBasePath = useDocsBasePath();

  return (
    <div className="space-y-4" data-testid="wizard-step-positioning">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("mcpOnboarding.positioningIntro")}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Pane
          icon={Bot}
          title={t("mcpOnboarding.positioningMcpTitle")}
          body={t("mcpOnboarding.positioningMcpBody")}
          highlighted
        />
        <Pane
          icon={Cpu}
          title={t("mcpOnboarding.positioningRunnersTitle")}
          body={t("mcpOnboarding.positioningRunnersBody")}
          badge={t("onboarding.experimentalBadge")}
        />
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("mcpOnboarding.positioningCoexistence")}
      </p>

      <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-primary/25 bg-primary/5 px-3 py-2.5">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p className="text-sm font-medium leading-relaxed text-foreground">
          {t("mcpOnboarding.positioningNoRunnerNeeded")}
        </p>
      </div>

      {/* One segment only: the docs router matches /documentation/:sectionSlug,
          so a DOC_GROUPS group id in the path resolves to nothing. */}
      <Link
        to={`${docsBasePath}/runners`}
        data-testid="wizard-runners-docs-link"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        {t("mcpOnboarding.positioningDocsLink")}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>

      <DialogFooter>
        <Button variant="outline" onClick={onBack} data-testid="wizard-back">
          {t("mcpOnboarding.back")}
        </Button>
        <Button onClick={onNext} data-testid="wizard-next">
          {t("mcpOnboarding.next")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function Pane({
  icon: Icon,
  title,
  body,
  badge,
  highlighted,
}: {
  icon: typeof Bot;
  title: string;
  body: string;
  badge?: string;
  highlighted?: boolean;
}) {
  return (
    <div
      className={
        highlighted
          ? "rounded-[var(--radius-md)] border border-primary/35 bg-[color:color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))] p-3.5"
          : "rounded-[var(--radius-md)] border border-border/60 bg-card/60 p-3.5"
      }
    >
      <div className="flex items-center gap-2">
        <div
          className={
            highlighted
              ? "flex h-7 w-7 items-center justify-center rounded-[var(--radius-cap)] bg-primary/15 text-primary"
              : "flex h-7 w-7 items-center justify-center rounded-[var(--radius-cap)] bg-muted text-muted-foreground"
          }
        >
          <Icon className="h-4 w-4" aria-hidden />
        </div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {badge ? <Badge variant="outline">{badge}</Badge> : null}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
