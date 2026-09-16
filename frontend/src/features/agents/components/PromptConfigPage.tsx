// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreatePromptConfig } from "../hooks/usePromptConfigs";
import { usePipelineConfig } from "../hooks/usePipelineConfig";
import { useRunnerBasePath } from "../hooks/useRunnerBasePath";
import { RolePromptsPanel } from "./prompts/RolePromptsPanel";

export function PromptConfigPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { overview } = useRunnerBasePath();
  const [searchParams, setSearchParams] = useSearchParams();
  const { roles: pipelineRoles } = usePipelineConfig(slug);
  const ROLES = ["all", ...pipelineRoles];

  const [activeRole, setActiveRole] = useState<string>("all");

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newStageRole, setNewStageRole] = useState("");
  const [newStageName, setNewStageName] = useState("");
  const [newStageContent, setNewStageContent] = useState("");

  // Deep-link intent rides the param shape: role+stage prefills the
  // create-new-stage dialog (author a missing prompt); role-only just filters
  // the page to that role (edit an existing prompt from the pipeline canvas).
  // Clear params after applying so closing the dialog doesn't re-open it.
  useEffect(() => {
    const role = searchParams.get("role");
    const stage = searchParams.get("stage");
    if (!role) return;
    if (stage) {
      setNewStageRole(role);
      setNewStageName(stage);
      setCreateDialogOpen(true);
    } else {
      setActiveRole(role);
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const createConfig = useCreatePromptConfig(slug);

  const trimmedNewRole = newStageRole.trim();
  const trimmedNewStage = newStageName.trim();
  const trimmedNewContent = newStageContent.trim();
  const canSubmitNewStage =
    trimmedNewRole.length > 0 &&
    trimmedNewStage.length > 0 &&
    trimmedNewContent.length > 0;

  function resetNewStageForm() {
    setNewStageRole("");
    setNewStageName("");
    setNewStageContent("");
  }

  function handleCreateNewStage() {
    if (!canSubmitNewStage) return;
    const roleSlug = trimmedNewRole.toLowerCase();
    const stageSlug = trimmedNewStage.toLowerCase();
    createConfig.mutate(
      {
        name: trimmedNewStage,
        slug: `${roleSlug}-${stageSlug}`,
        team_role: trimmedNewRole,
        stage: trimmedNewStage,
        content: newStageContent,
      },
      {
        onSuccess: () => {
          toast.success(t("prompts.saved"));
          setCreateDialogOpen(false);
          resetNewStageForm();
        },
        onError: () => toast.error(t("prompts.saveError")),
      },
    );
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={t("prompts.title")}
        description={t("prompts.subtitle")}
        actions={
          <Button variant="ghost" onClick={() => navigate(overview)}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("agents.title")}
          </Button>
        }
      />

      {/* Role filter tabs + Create new stage */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RichTooltip i18nKey="prompts.rolesTabs" side="bottom">
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {ROLES.map((role) => (
              <Button
                key={role}
                variant={activeRole === role ? "default" : "ghost"}
                size="sm"
                onClick={() => setActiveRole(role)}
              >
                {role === "all"
                  ? t("common.all")
                  : t(`teams.roles.${role}`, { defaultValue: role })}
              </Button>
            ))}
          </div>
        </RichTooltip>
        <RichTooltip i18nKey="prompts.createNewStage" side="left">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("prompts.createNewStage")}
          </Button>
        </RichTooltip>
      </div>

      {/* Stage cards — the per-stage card/editor lives in RolePromptsPanel.
          "all" stacks one panel per pipeline role with a role subheading;
          a specific role renders a single panel. */}
      {activeRole === "all" ? (
        pipelineRoles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("prompts.noStagesForRole")}
          </p>
        ) : (
          <div className="space-y-6">
            {pipelineRoles.map((role) => (
              <section key={role} className="space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t(`teams.roles.${role}`, { defaultValue: role })}
                </h3>
                <RolePromptsPanel slug={slug} role={role} />
              </section>
            ))}
          </div>
        )
      ) : (
        <RolePromptsPanel slug={slug} role={activeRole} />
      )}

      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) resetNewStageForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("prompts.createNewStage")}</DialogTitle>
            <DialogDescription>
              {t("prompts.createNewStageHint")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="create-stage-role"
                className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                {t("prompts.fields.role")}
              </label>
              <Input
                id="create-stage-role"
                data-testid="create-stage-role"
                value={newStageRole}
                onChange={(e) => setNewStageRole(e.target.value)}
                placeholder="security-auditor"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="create-stage-stage"
                className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                {t("prompts.fields.stage")}
              </label>
              <Input
                id="create-stage-stage"
                data-testid="create-stage-stage"
                value={newStageName}
                onChange={(e) => setNewStageName(e.target.value)}
                placeholder="security_review"
              />
              <RichTooltip i18nKey="prompts.deepLinkHint" side="bottom">
                <p className="text-[0.7rem] text-muted-foreground cursor-help">
                  {t("prompts.fields.stageHint")}
                </p>
              </RichTooltip>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="create-stage-content"
                className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                {t("prompts.fields.content")}
              </label>
              <Textarea
                id="create-stage-content"
                data-testid="create-stage-content"
                value={newStageContent}
                onChange={(e) => setNewStageContent(e.target.value)}
                className="min-h-[200px] font-mono text-sm"
                placeholder={t("prompts.contentPlaceholder")}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setCreateDialogOpen(false);
                resetNewStageForm();
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              data-testid="create-stage-submit"
              onClick={handleCreateNewStage}
              disabled={!canSubmitNewStage || createConfig.isPending}
            >
              {createConfig.isPending
                ? t("agents.saving")
                : t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
