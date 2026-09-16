// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Info, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TagInput } from "@/components/shared/TagInput";
import { FieldCheckbox } from "./FieldCheckbox";
import { FieldError } from "./FieldError";
import type { ActionDef, PipelineValidationError } from "../../api/pipelineConfig";

const COLUMN_TYPES = ["", "backlog", "active", "review", "done"] as const;

interface ActionDefEditorProps {
  value: ActionDef;
  onChange: (next: ActionDef) => void;
  knownRoles: string[];
  fieldPath: string;
  errorsByPath: Map<string, PipelineValidationError[]>;
  // Nested branches come from conditional actions — we disable further nesting
  // at depth > 0 to keep the shape representable (the engine allows deeper
  // nesting but the UI doesn't.)
  depth?: number;
}

export function ActionDefEditor({
  value,
  onChange,
  knownRoles,
  fieldPath,
  errorsByPath,
  depth = 0,
}: ActionDefEditorProps) {
  const { t } = useTranslation();
  const rootId = useId();
  const fieldId = (name: string) => `${rootId}-${name}`;

  const patch = (diff: Partial<ActionDef>) => onChange({ ...value, ...diff });

  const conditional = Boolean(value.conditional);

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-[color:var(--color-surface-1)]/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            htmlFor={fieldId("moveToColumnType")}
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("pipelineBuilder.action.moveToColumnType")}
          </label>
          <Select
            value={value.move_to_column_type ?? ""}
            onValueChange={(v) => patch({ move_to_column_type: v })}
          >
            <SelectTrigger id={fieldId("moveToColumnType")} className="h-9 text-xs">
              <SelectValue placeholder={t("pipelineBuilder.action.stay")}>
                {value.move_to_column_type || t("pipelineBuilder.action.stay")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {COLUMN_TYPES.map((col) => (
                <SelectItem key={col || "stay"} value={col}>
                  {col || t("pipelineBuilder.action.stay")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError
            errors={errorsByPath.get(`${fieldPath}.move_to_column_type`)}
          />
        </div>

        <div>
          <label
            htmlFor={fieldId("wakeRoles")}
            className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground"
          >
            <span>{t("pipelineBuilder.action.wakeRoles")}</span>
            <RichTooltip i18nKey="pipelineBuilder.wakeRoles" side="top">
              <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
            </RichTooltip>
          </label>
          <TagInput
            id={fieldId("wakeRoles")}
            tags={value.wake_roles ?? []}
            onChange={(tags) => patch({ wake_roles: tags })}
            placeholder={knownRoles.join(", ") || t("common.add")}
          />
          <FieldError errors={errorsByPath.get(`${fieldPath}.wake_roles`)} />
        </div>

        <div>
          <label
            htmlFor={fieldId("addLabel")}
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("pipelineBuilder.action.addLabel")}
          </label>
          <Input
            id={fieldId("addLabel")}
            value={value.add_label ?? ""}
            onChange={(e) => patch({ add_label: e.target.value })}
            className="h-9 text-xs"
          />
        </div>
        <div>
          <label
            htmlFor={fieldId("removeLabel")}
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("pipelineBuilder.action.removeLabel")}
          </label>
          <Input
            id={fieldId("removeLabel")}
            value={value.remove_label ?? ""}
            onChange={(e) => patch({ remove_label: e.target.value })}
            className="h-9 text-xs"
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <FieldCheckbox
          label={t("pipelineBuilder.action.stayInColumn")}
          checked={Boolean(value.stay_in_column)}
          onChange={(v) => patch({ stay_in_column: v })}
        />
        <FieldCheckbox
          label={t("pipelineBuilder.action.unassign")}
          checked={Boolean(value.unassign)}
          onChange={(v) => patch({ unassign: v })}
        />
        <FieldCheckbox
          label={t("pipelineBuilder.action.unassignSelf")}
          checked={Boolean(value.unassign_self)}
          onChange={(v) => patch({ unassign_self: v })}
        />
        <FieldCheckbox
          label={t("pipelineBuilder.action.cleanupReviewNotes")}
          checked={Boolean(value.cleanup_review_notes)}
          onChange={(v) => patch({ cleanup_review_notes: v })}
        />
        <FieldCheckbox
          label={t("pipelineBuilder.action.createReviewNote")}
          checked={Boolean(value.create_review_note)}
          onChange={(v) => patch({ create_review_note: v })}
        />
        <FieldCheckbox
          label={t("pipelineBuilder.action.appendLearning")}
          checked={Boolean(value.append_learning)}
          onChange={(v) => patch({ append_learning: v })}
        />
        {depth === 0 && (
          <FieldCheckbox
            label={t("pipelineBuilder.action.conditional")}
            description={t("pipelineBuilder.action.conditionalDescription")}
            checked={conditional}
            onChange={(v) => patch({ conditional: v, branches: v ? (value.branches ?? {}) : undefined })}
            tooltipKey="pipelineBuilder.conditionalAction"
          />
        )}
      </div>

      {depth === 0 && conditional && (
        <BranchesEditor
          branches={value.branches ?? {}}
          onChange={(next) => patch({ branches: next })}
          knownRoles={knownRoles}
          fieldPath={`${fieldPath}.branches`}
          errorsByPath={errorsByPath}
        />
      )}
    </div>
  );
}

interface BranchesEditorProps {
  branches: Record<string, ActionDef>;
  onChange: (next: Record<string, ActionDef>) => void;
  knownRoles: string[];
  fieldPath: string;
  errorsByPath: Map<string, PipelineValidationError[]>;
}

function BranchesEditor({
  branches,
  onChange,
  knownRoles,
  fieldPath,
  errorsByPath,
}: BranchesEditorProps) {
  const { t } = useTranslation();
  const entries = Object.entries(branches);

  function updateKey(oldKey: string, newKey: string) {
    if (!newKey || newKey === oldKey) return;
    if (newKey in branches) return;
    const next: Record<string, ActionDef> = {};
    for (const [k, v] of Object.entries(branches)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  }

  function updateValue(key: string, value: ActionDef) {
    onChange({ ...branches, [key]: value });
  }

  function removeKey(key: string) {
    const next = { ...branches };
    delete next[key];
    onChange(next);
  }

  function addBranch() {
    const base = "decision";
    let idx = 1;
    while (`${base}_${idx}` in branches) idx += 1;
    onChange({ ...branches, [`${base}_${idx}`]: {} });
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border/60 p-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {t("pipelineBuilder.action.branches")}
      </p>
      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("pipelineBuilder.action.branchesEmpty")}
        </p>
      )}
      {entries.map(([key, branchAction]) => (
        <div key={key} className="space-y-2 rounded border border-border/50 p-2">
          <div className="flex items-center gap-2">
            <Input
              value={key}
              onChange={(e) => updateKey(key, e.target.value)}
              placeholder={t("pipelineBuilder.action.decisionKey")}
              className="h-8 flex-1 text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeKey(key)}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ActionDefEditor
            value={branchAction}
            onChange={(v) => updateValue(key, v)}
            knownRoles={knownRoles}
            fieldPath={`${fieldPath}.${key}`}
            errorsByPath={errorsByPath}
            depth={1}
          />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addBranch}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        {t("pipelineBuilder.action.addBranch")}
      </Button>
    </div>
  );
}
