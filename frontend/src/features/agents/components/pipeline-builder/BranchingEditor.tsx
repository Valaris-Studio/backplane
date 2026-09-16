// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Info } from "lucide-react";
import type { LifecycleStep } from "../../api/pipelineConfig";

interface BranchingEditorProps {
  step: LifecycleStep;
  // Names of OTHER steps in the same role's lifecycle. Drives the Select
  // options for `next` and per-branch targets so the user cannot point at
  // an undefined step name.
  peerStepNames: string[];
  onChange: (next: LifecycleStep) => void;
  disabled?: boolean;
}

const TERMINAL_SENTINEL = "__end__";
const NO_FAILURE_SENTINEL = "__none__";

// A step produces a decision when it can fan out into named branches.
// LLM steps produce a decision only when `post_process_kind ===
// "produces_decision"`. sensor and branch kinds always do.
function producesDecision(step: LifecycleStep): boolean {
  if (step.kind === "sensor" || step.kind === "branch") return true;
  if (step.kind === "llm") {
    return step.params?.post_process_kind === "produces_decision";
  }
  return false;
}

export function BranchingEditor({
  step,
  peerStepNames,
  onChange,
  disabled,
}: BranchingEditorProps) {
  const { t } = useTranslation();
  const rootId = useId();
  const nextId = `${rootId}-next`;

  const hasBranches = !!step.branches && Object.keys(step.branches).length > 0;
  const hasNext = !!step.next;
  const branchesAvailable = producesDecision(step);

  // The Next select's options. "(end)" is a sentinel value because the
  // Select primitive doesn't allow empty-string values without a real item.
  const nextOptions = peerStepNames.filter((n) => n !== step.name);

  function setNext(value: string) {
    const cleaned = value === TERMINAL_SENTINEL ? undefined : value;
    onChange({ ...step, next: cleaned });
  }

  function setOnFailure(value: string) {
    const cleaned = value === NO_FAILURE_SENTINEL ? undefined : value;
    onChange({ ...step, on_failure: cleaned });
  }

  function addBranch() {
    const branches = { ...(step.branches ?? {}) };
    // Generate a unique placeholder key — empty key would collide with
    // any existing empty-key row.
    let key = "decision";
    let suffix = 1;
    while (key in branches) {
      key = `decision_${++suffix}`;
    }
    branches[key] = peerStepNames[0] ?? "";
    onChange({ ...step, branches });
  }

  function renameBranchKey(oldKey: string, newKey: string) {
    if (oldKey === newKey) return;
    const next = { ...(step.branches ?? {}) };
    const target = next[oldKey];
    delete next[oldKey];
    next[newKey] = target ?? "";
    onChange({ ...step, branches: next });
  }

  function setBranchTarget(key: string, target: string) {
    onChange({
      ...step,
      branches: { ...(step.branches ?? {}), [key]: target },
    });
  }

  function removeBranch(key: string) {
    const next = { ...(step.branches ?? {}) };
    delete next[key];
    onChange({
      ...step,
      branches: Object.keys(next).length === 0 ? undefined : next,
    });
  }

  return (
    <div className="space-y-3" data-testid="lifecycle-branching">
      <div data-testid="lifecycle-next-select">
        <label
          htmlFor={nextId}
          className="mb-1 block text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {t("pipeline.lifecycle.next.label")}
        </label>
        <Select
          value={step.next ?? TERMINAL_SENTINEL}
          onValueChange={setNext}
        >
          <SelectTrigger
            id={nextId}
            className="h-9 text-xs"
            disabled={disabled || hasBranches}
          >
            <SelectValue>
              {step.next ?? t("pipeline.lifecycle.next.terminal")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TERMINAL_SENTINEL}>
              {t("pipeline.lifecycle.next.terminal")}
            </SelectItem>
            {nextOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasBranches && (
          <p className="mt-1 text-[0.65rem] text-muted-foreground">
            {t("pipeline.lifecycle.next.disabledByBranches")}
          </p>
        )}
      </div>

      <div data-testid="lifecycle-on-failure-select">
        <div className="mb-1 flex items-center gap-1">
          <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("pipeline.lifecycle.onFailure.label")}
          </span>
          <RichTooltip i18nKey="pipelineStepOnFailure" side="top">
            <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
          </RichTooltip>
        </div>
        <Select
          value={step.on_failure ?? NO_FAILURE_SENTINEL}
          onValueChange={setOnFailure}
        >
          <SelectTrigger className="h-9 text-xs" disabled={disabled}>
            <SelectValue>
              {step.on_failure ?? t("pipeline.lifecycle.onFailure.none")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_FAILURE_SENTINEL}>
              {t("pipeline.lifecycle.onFailure.none")}
            </SelectItem>
            {nextOptions.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {branchesAvailable && (
        <div data-testid="lifecycle-branches-block" className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("pipeline.lifecycle.branches.label")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addBranch}
              disabled={disabled || hasNext}
              data-testid="lifecycle-branches-add"
            >
              <Plus className="mr-1 h-3 w-3" />
              {t("pipeline.lifecycle.branches.add")}
            </Button>
          </div>
          {hasNext && (
            <p className="text-[0.65rem] text-muted-foreground">
              {t("pipeline.lifecycle.branches.disabledByNext")}
            </p>
          )}
          <p className="text-[0.65rem] text-muted-foreground">
            {t("pipeline.lifecycle.branches.hint")}
          </p>
          {Object.entries(step.branches ?? {}).map(([key, target]) => (
            <div
              key={key}
              className="grid grid-cols-[1fr_1fr_auto] items-center gap-2"
              data-testid={`lifecycle-branch-row-${key}`}
            >
              <Input
                value={key}
                onChange={(e) => renameBranchKey(key, e.target.value)}
                placeholder={t("pipeline.lifecycle.branches.decisionPlaceholder")}
                className="h-8 text-xs"
                disabled={disabled}
              />
              <Select
                value={target}
                onValueChange={(v) => setBranchTarget(key, v)}
              >
                <SelectTrigger className="h-8 text-xs" disabled={disabled}>
                  <SelectValue>{target || "—"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {nextOptions.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => removeBranch(key)}
                aria-label={t("pipeline.lifecycle.branches.remove")}
                disabled={disabled}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
