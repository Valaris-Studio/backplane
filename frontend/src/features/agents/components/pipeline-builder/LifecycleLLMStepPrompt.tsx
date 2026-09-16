// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import type { LifecycleStep } from "../../api/pipelineConfig";

// Resolved prompt entry for a single lifecycle LLM step. Computed at the page
// level from the workspace prompt_configs + prompt_defaults queries (override
// beats default) and threaded down through LifecycleRoleCard ->
// SortableLifecycleStep -> this row. `role` and `stageToken` are carried
// explicitly because the slug shape `${role}-${stage}` is not reversibly
// splittable when either half contains a hyphen.
export interface ResolvedLifecycleStepPrompt {
  stepName: string;
  stageToken: string;
  role: string;
  slug: string;
  contentPreview: string;
  workspaceSlug: string;
  isCustom: boolean;
  isMissing: boolean;
}

interface LifecycleLLMStepPromptProps {
  step: LifecycleStep;
  resolved: ResolvedLifecycleStepPrompt | undefined;
  role: string;
  workspaceSlug: string;
}

export function LifecycleLLMStepPrompt({
  step,
  resolved,
  role,
  workspaceSlug,
}: LifecycleLLMStepPromptProps) {
  const { t } = useTranslation();

  // The row only makes sense for LLM steps with a stage token. Non-LLM kinds
  // never mount this; an LLM step with no stage yet renders nothing so the
  // operator can complete the form before a prompt link is offered.
  if (step.kind !== "llm") return null;
  const stageToken = step.params?.stage;
  if (!stageToken) return null;

  // Both links target the standalone prompts page directly (never the legacy
  // /agents/prompts redirect). Param shape carries the intent: role+stage opens
  // the create-new-stage dialog prefilled (author a missing prompt); role-only
  // filters the page to the role's existing prompts (edit/customize).
  const authorHref = `/${workspaceSlug}/runner/prompts?role=${encodeURIComponent(
    role,
  )}&stage=${encodeURIComponent(stageToken)}`;
  const editHref = `/${workspaceSlug}/runner/prompts?role=${encodeURIComponent(role)}`;

  if (!resolved) {
    return (
      <div
        data-testid="lifecycle-llm-step-prompt-missing"
        className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
      >
        <div className="flex items-center justify-between gap-2">
          <span>
            {t("pipeline.lifecycle.step.llm.promptMissing", { stage: stageToken })}
          </span>
          <Link
            to={authorHref}
            aria-label={t("pipeline.lifecycle.step.llm.authorPromptAriaLabel", {
              stage: stageToken,
            })}
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-[0.7rem] hover:bg-amber-500/10"
          >
            <ExternalLink className="h-3 w-3" />
            {t("pipeline.lifecycle.step.llm.authorPrompt")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold uppercase tracking-wider text-muted-foreground/80 text-[0.65rem]">
            {t("pipeline.lifecycle.step.llm.resolvedPrompt")}
          </span>
          <code
            data-testid="lifecycle-llm-step-prompt-slug"
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.65rem]"
          >
            {resolved.slug}
          </code>
          <Badge
            variant={resolved.isCustom ? "default" : "secondary"}
            className="text-[0.6rem]"
          >
            {resolved.isCustom ? t("prompts.custom") : t("prompts.default")}
          </Badge>
        </div>
        <Link
          to={editHref}
          aria-label={t("pipeline.lifecycle.step.llm.promptLinkAriaLabel", {
            slug: resolved.slug,
          })}
          className="inline-flex h-7 items-center gap-1 rounded px-2 text-[0.7rem] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          {t("pipeline.lifecycle.step.llm.editPrompt")}
        </Link>
      </div>
    </div>
  );
}
