// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CompletionContextWarning } from "@/features/kanban/components/CompletionContextWarning";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Code, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { ExportButton } from "@/components/export/export-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  usePromptDefaults,
  usePromptConfigs,
  useCreatePromptConfig,
  useUpdatePromptConfig,
  useDeletePromptConfig,
} from "../../hooks/usePromptConfigs";
import { usePipelineConfig } from "../../hooks/usePipelineConfig";
import { getPromptWiringStatus } from "../../utils/promptWiringStatus";
import {
  declaredAliasesForStage,
  lintContextSourceWiring,
  CONTEXT_SOURCE_SNIPPET,
} from "../../utils/contextSourceWiring";
import { lookupPromptDescriptionKey } from "../../lib/promptDescriptionCatalog";
import type { PromptStageDefault, PromptConfig } from "../../api/prompts";

interface RolePromptsPanelProps {
  slug: string;
  // A SINGLE pipeline role (e.g. "reviewer"), never "all" — the page owns the
  // role-filter strip and fans this panel out per role for the "all" view.
  role: string;
}

// Per-stage prompt card list + inline editor for ONE pipeline role. The single
// source of truth for the prompt-editor behavior (expand / edit / save / reset,
// wiring + context-source badges, live lint). PromptConfigPage composes this;
// the page keeps the header, role tabs, and create-new-stage dialog.
export function RolePromptsPanel({ slug, role }: RolePromptsPanelProps) {
  const { t } = useTranslation();
  const { pipelineConfig } = usePipelineConfig(slug);

  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editingSlug, setEditingSlug] = useState<string | null>(null);

  const { data: defaults, isLoading: loadingDefaults } = usePromptDefaults(
    slug,
    role,
  );
  const { data: configs, isLoading: loadingConfigs } = usePromptConfigs(
    slug,
    role,
  );

  const createConfig = useCreatePromptConfig(slug);
  const updateConfig = useUpdatePromptConfig(slug);
  const deleteConfig = useDeletePromptConfig(slug);

  function getOverride(stageSlug: string): PromptConfig | undefined {
    return configs?.find((c) => c.slug === stageSlug);
  }

  function handleToggle(stage: PromptStageDefault) {
    if (expandedSlug === stage.slug) {
      setExpandedSlug(null);
      setEditingSlug(null);
    } else {
      setExpandedSlug(stage.slug);
      setEditingSlug(null);
    }
  }

  function handleStartEdit(stage: PromptStageDefault) {
    const override = getOverride(stage.slug);
    setEditContent(override?.content ?? stage.default_content);
    setEditingSlug(stage.slug);
  }

  function handleSave(stage: PromptStageDefault) {
    const override = getOverride(stage.slug);

    if (override) {
      updateConfig.mutate(
        { configId: override.id, data: { content: editContent } },
        {
          onSuccess: () => {
            toast.success(t("prompts.saved"));
            setEditingSlug(null);
          },
          onError: () => toast.error(t("prompts.saveError")),
        },
      );
    } else {
      createConfig.mutate(
        {
          name: stage.stage,
          slug: stage.slug,
          team_role: stage.role,
          stage: stage.stage,
          content: editContent,
        },
        {
          onSuccess: () => {
            toast.success(t("prompts.saved"));
            setEditingSlug(null);
          },
          onError: () => toast.error(t("prompts.saveError")),
        },
      );
    }
  }

  function handleReset(stageSlug: string) {
    const override = getOverride(stageSlug);
    if (override) {
      deleteConfig.mutate(override.id, {
        onSuccess: () => {
          toast.success(t("prompts.resetSuccess"));
          setEditingSlug(null);
        },
        onError: () => toast.error(t("prompts.resetError")),
      });
    }
  }

  const isLoading = loadingDefaults || loadingConfigs;
  const saving = createConfig.isPending || updateConfig.isPending;

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="role-prompts-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-24 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
          />
        ))}
      </div>
    );
  }

  if (!defaults || defaults.length === 0) {
    return (
      <p
        data-testid="role-prompts-empty"
        className="text-sm text-muted-foreground"
      >
        {t("prompts.noStagesForRole")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {defaults.map((stage) => {
        const descriptionKey = lookupPromptDescriptionKey(stage.slug);
        const description = descriptionKey
          ? t(descriptionKey)
          : stage.description;
        const override = getOverride(stage.slug);
        const isExpanded = expandedSlug === stage.slug;
        const isEditing = editingSlug === stage.slug;
        const wiring = getPromptWiringStatus(
          { team_role: stage.role, stage: stage.stage },
          pipelineConfig,
        );
        const declaredAliases = declaredAliasesForStage(
          pipelineConfig,
          stage.role,
          stage.stage,
        );
        // Live wiring lint against the in-progress edit buffer (or the saved
        // override when not editing) — backend stays authoritative.
        const lintContent = isEditing ? editContent : override?.content ?? "";
        const wiringWarnings =
          isEditing || override
            ? lintContextSourceWiring(declaredAliases, lintContent)
            : [];

        return (
          <Card key={stage.slug}>
            <CardContent className="p-0">
              {/* Header row — always visible, clickable to expand */}
              <button
                className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
                onClick={() => handleToggle(stage)}
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <Code className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">{stage.stage}</span>
                <Badge variant="outline" className="text-[0.6rem]">
                  {t(`teams.roles.${stage.role}`, { defaultValue: stage.role })}
                </Badge>
                <RichTooltip i18nKey="prompts.stageList" side="top">
                  {override ? (
                    <Badge variant="default" className="text-[0.6rem]">
                      {t("prompts.custom")} v{override.version}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[0.6rem]">
                      {t("prompts.default")}
                    </Badge>
                  )}
                </RichTooltip>
                {wiring.wired ? (
                  <RichTooltip i18nKey="prompts.wiredBadge" side="top">
                    <span
                      title={t("prompts.wiredInto.tooltip", {
                        stages: wiring.stages
                          .map((s) => `${s.role}.${s.stage}`)
                          .join(", "),
                      })}
                      data-testid={`prompt-wired-${stage.slug}`}
                    >
                      <Badge variant="success" className="text-[0.6rem]">
                        {t("prompts.wiredInto.badge")}
                      </Badge>
                    </span>
                  </RichTooltip>
                ) : (
                  <RichTooltip i18nKey="prompts.orphanBadge" side="top">
                    <span
                      title={t("prompts.orphan.tooltip")}
                      data-testid={`prompt-orphan-${stage.slug}`}
                    >
                      <Badge variant="destructive" className="text-[0.6rem]">
                        {t("prompts.orphan.badge")}
                      </Badge>
                    </span>
                  </RichTooltip>
                )}
                <span className="ml-auto text-xs text-muted-foreground hidden sm:block">
                  {description}
                </span>
              </button>

              {/* Expanded content */}
              {isExpanded && (
                <div className="border-t px-4 pb-4 pt-3 space-y-3">
                  {/* Description on mobile */}
                  <p className="text-xs text-muted-foreground sm:hidden">
                    {description}
                  </p>

                  {/* Template variables */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <RichTooltip i18nKey="prompts.templateVariables" side="top">
                      <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
                        {t("prompts.variables")}:
                      </span>
                    </RichTooltip>
                    {stage.template_variables.map((v) => (
                      <code
                        key={v}
                        className="rounded bg-muted px-1.5 py-0.5 text-[0.6rem] font-mono cursor-pointer hover:bg-primary/10"
                        onClick={() => {
                          if (isEditing) {
                            setEditContent((prev) => prev + `{{.${v}}}`);
                          }
                        }}
                      >
                        {"{{."}
                        {v}
                        {"}}"}
                      </code>
                    ))}
                  </div>

                  {/* Context sources — declared on this stage's pipeline
                      config; insert the index form, not {{.Var}}. */}
                  {declaredAliases.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RichTooltip i18nKey="prompts.contextSources" side="top">
                        <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
                          {t("prompts.contextSourcesLabel")}:
                        </span>
                      </RichTooltip>
                      {declaredAliases.map((alias) => {
                        const referenced = lintContent.includes(`"${alias}"`);
                        return (
                          <code
                            key={alias}
                            title={CONTEXT_SOURCE_SNIPPET(alias)}
                            data-testid={`context-source-chip-${alias}`}
                            className={`rounded px-1.5 py-0.5 text-[0.6rem] font-mono cursor-pointer ${
                              referenced
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                : "bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/25"
                            }`}
                            onClick={() => {
                              if (isEditing) {
                                setEditContent(
                                  (prev) => prev + CONTEXT_SOURCE_SNIPPET(alias),
                                );
                              }
                            }}
                          >
                            {alias}
                          </code>
                        );
                      })}
                    </div>
                  )}

                  {/* Live wiring warnings (amber, non-blocking) */}
                  {wiringWarnings.length > 0 && (
                    <div
                      role="status"
                      data-testid={`context-source-warnings-${stage.slug}`}
                      className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[0.7rem] text-amber-700 dark:text-amber-400"
                    >
                      <ul className="space-y-1">
                        {wiringWarnings.map((w, i) => (
                          <li key={`${w.code}-${i}`}>{w.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Content area */}
                  {override && !isEditing ? (
                    /* Show existing override content read-only */
                    <div className="space-y-2">
                      <pre className="rounded-lg bg-muted/50 border p-3 text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
                        {override.content}
                      </pre>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleStartEdit(stage)}
                        >
                          {t("common.edit")}
                        </Button>
                        <ExportButton
                          endpoint={`/workspaces/${slug}/prompt-configs/${override.id}/export`}
                          defaultFilename={`${override.slug}.valaris.prompt_config.json`}
                          entityLabel={t("export.entity.promptConfig")}
                        />
                        <RichTooltip i18nKey="prompts.resetButton" side="top">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleReset(stage.slug)}
                            disabled={deleteConfig.isPending}
                            className="text-muted-foreground"
                          >
                            <RotateCcw className="mr-1.5 h-3 w-3" />
                            {t("prompts.resetToDefault")}
                          </Button>
                        </RichTooltip>
                      </div>
                    </div>
                  ) : !override && !isEditing ? (
                    /* No override — show default content + create button */
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {t("prompts.noOverrideHint")}
                      </p>
                      <pre className="rounded-lg bg-muted/50 border p-3 text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
                        {stage.default_content}
                      </pre>
                      <RichTooltip i18nKey="prompts.createOverride" side="top">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleStartEdit(stage)}
                        >
                          {t("prompts.createOverride")}
                        </Button>
                      </RichTooltip>
                    </div>
                  ) : (
                    /* Editing mode — textarea */
                    <div className="space-y-2">
                      <RichTooltip i18nKey="prompts.editor" side="top">
                        <Textarea
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          rows={12}
                          className="min-h-[200px] font-mono text-sm"
                          placeholder={t("prompts.contentPlaceholder")}
                          autoFocus
                        />
                      </RichTooltip>
                      <CompletionContextWarning slug={slug} sourceKind={override ? "prompt" : "configuration"} sourceId={override?.id} />
                      <div className="flex gap-2">
                        <RichTooltip i18nKey="prompts.saveButton" side="top">
                          <Button
                            size="sm"
                            onClick={() => handleSave(stage)}
                            disabled={saving || !editContent.trim()}
                          >
                            {saving ? t("agents.saving") : t("common.save")}
                          </Button>
                        </RichTooltip>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingSlug(null)}
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
