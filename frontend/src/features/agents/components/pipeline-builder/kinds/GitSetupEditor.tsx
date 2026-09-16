// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldCheckbox } from "../FieldCheckbox";
import { FieldLabel } from "./FieldLabel";
import type { KindEditorProps } from "./types";

const ACTIONS = ["create_branch", "checkout_pr_branch", "none"] as const;
type Action = (typeof ACTIONS)[number];
const BASE_REFS = ["default_branch", "integration_branch"] as const;
type BaseRef = (typeof BASE_REFS)[number];

export function GitSetupEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"git_setup">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });
  const action = params.action ?? "";

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor={id("action")} tooltipKey="pipelineGitSetupAction">
            {t("pipelineBuilder.lifecycle.kinds.git_setup.params.action.label")}
          </FieldLabel>
          <Select
            value={action}
            onValueChange={(v) => patch({ action: (v || undefined) as Action | undefined })}
          >
            <SelectTrigger id={id("action")} className="h-9 text-xs" disabled={disabled}>
              <SelectValue>
                {action
                  ? t(`pipelineBuilder.lifecycle.kinds.git_setup.params.action.options.${action}`)
                  : ""}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`pipelineBuilder.lifecycle.kinds.git_setup.params.action.options.${a}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {action === "create_branch" && (
          <div>
            <FieldLabel htmlFor={id("branchPrefix")} tooltipKey="pipelineGitSetupBranchPrefix">
              {t("pipelineBuilder.lifecycle.kinds.git_setup.params.branch_prefix.label")}
            </FieldLabel>
            <Input
              id={id("branchPrefix")}
              value={params.branch_prefix ?? ""}
              disabled={disabled}
              placeholder={t(
                "pipelineBuilder.lifecycle.kinds.git_setup.params.branch_prefix.placeholder",
              )}
              onChange={(e) => patch({ branch_prefix: e.target.value })}
              className="h-9 text-xs"
            />
          </div>
        )}

        <div>
          <FieldLabel htmlFor={id("baseRef")} tooltipKey="pipelineGitSetupBaseRef">
            {t("pipelineBuilder.lifecycle.kinds.git_setup.params.base_ref.label")}
          </FieldLabel>
          <Select
            value={params.base_ref ?? ""}
            onValueChange={(v) => patch({ base_ref: (v || undefined) as BaseRef | undefined })}
          >
            <SelectTrigger id={id("baseRef")} className="h-9 text-xs" disabled={disabled}>
              <SelectValue>
                {params.base_ref
                  ? t(
                      `pipelineBuilder.lifecycle.kinds.git_setup.params.base_ref.options.${params.base_ref}`,
                    )
                  : ""}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BASE_REFS.map((b) => (
                <SelectItem key={b} value={b}>
                  {t(`pipelineBuilder.lifecycle.kinds.git_setup.params.base_ref.options.${b}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <FieldCheckbox
          id={id("createPr")}
          label={t("pipelineBuilder.lifecycle.kinds.git_setup.params.create_pr.label")}
          checked={Boolean(params.create_pr)}
          disabled={disabled}
          onChange={(v) => patch({ create_pr: v })}
          tooltipKey="pipelineGitSetupCreatePr"
        />
        <FieldCheckbox
          id={id("forcePushOnRework")}
          label={t("pipelineBuilder.lifecycle.kinds.git_setup.params.force_push_on_rework.label")}
          checked={Boolean(params.force_push_on_rework)}
          disabled={disabled}
          onChange={(v) => patch({ force_push_on_rework: v })}
          tooltipKey="pipelineGitSetupForcePushOnRework"
        />
      </div>
    </div>
  );
}
