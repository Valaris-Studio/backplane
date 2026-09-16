// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, GitBranch, Info, OctagonMinus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { LifecycleKindName, LifecycleStep } from "../../api/pipelineConfig";
import { useLifecycleKinds } from "../../api/lifecycleKinds";
import { localizeLifecycleKindDoc } from "../../lib/lifecycleKindCatalog";
import { BranchingEditor } from "./BranchingEditor";
import { KindEditor } from "./kinds/registry";
import {
  LifecycleLLMStepPrompt,
  type ResolvedLifecycleStepPrompt,
} from "./LifecycleLLMStepPrompt";

interface LifecycleStepEditorProps {
  step: LifecycleStep;
  peerStepNames: string[];
  knownKinds: LifecycleKindName[];
  role: string;
  workspaceSlug: string;
  resolvedPrompt?: ResolvedLifecycleStepPrompt;
  onChange: (next: LifecycleStep) => void;
  onDelete: () => void;
  // Drag handle rendered by the sortable wrapper; the focused inspector renders
  // this editor outside a DnD context, so the slot stays empty there.
  dragHandle?: ReactNode;
  className?: string;
}

// The single-step editor body — kind selector, name, per-kind params, prompt,
// and branching. Extracted from SortableLifecycleStep so the sortable list and
// the focused canvas inspector render the SAME editor (one source of truth for
// step editing). The DnD chrome lives in the wrapper, not here.
export function LifecycleStepEditor({
  step,
  peerStepNames,
  knownKinds,
  role,
  workspaceSlug,
  resolvedPrompt,
  onChange,
  onDelete,
  dragHandle,
  className,
}: LifecycleStepEditorProps) {
  const { t } = useTranslation();
  // Local name buffer so a duplicate-name draft doesn't immediately overwrite
  // the step (which would break peer refs). The parent canonicalizes on blur.
  const [nameDraft, setNameDraft] = useState(step.name);
  // The focused canvas inspector reuses ONE editor instance across step
  // selections, so the buffer must follow the step prop — otherwise the input
  // keeps the previous step's name and a blur would commit it onto the newly
  // selected step. (Adjust-during-render, not an effect: no stale frame.)
  const [lastStepName, setLastStepName] = useState(step.name);
  if (lastStepName !== step.name) {
    setLastStepName(step.name);
    setNameDraft(step.name);
  }

  function commitName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === step.name) {
      setNameDraft(step.name);
      return;
    }
    if (peerStepNames.includes(trimmed)) {
      // Reject duplicate names client-side. The parent's clientErrors will
      // surface the violation when the user persists it some other way.
      setNameDraft(step.name);
      return;
    }
    onChange({ ...step, name: trimmed });
  }

  function changeKind(nextKind: LifecycleKindName) {
    if (nextKind === step.kind) return;
    // Clear params on kind change — the previous shape doesn't match.
    onChange({
      ...step,
      kind: nextKind,
      params: {},
    } as LifecycleStep);
  }

  return (
    <div
      data-testid={`lifecycle-step-${step.name}`}
      className={cn(
        "rounded-lg border border-border/70 bg-card p-3 shadow-sm space-y-3",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {dragHandle}

        <Input
          aria-label={t("pipeline.lifecycle.step.nameLabel")}
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={t("pipeline.lifecycle.step.namePlaceholder")}
          className="h-8 text-sm font-semibold"
          data-testid={`lifecycle-step-name-${step.name}`}
        />

        <Select
          value={step.kind}
          onValueChange={(v) => changeKind(v as LifecycleKindName)}
        >
          <SelectTrigger
            className="h-8 w-[10rem] text-xs"
            aria-label={t("pipeline.lifecycle.step.kindLabel")}
          >
            <SelectValue>{step.kind}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {knownKinds.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
          aria-label={t("pipeline.lifecycle.step.delete")}
          data-testid="lifecycle-step-delete"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <KindKnowledge kind={step.kind} />

      {step.on_failure && (
        <div
          data-testid={`lifecycle-step-on-failure-${step.name}`}
          className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-[0.7rem] text-destructive/90"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          <span>{t("pipeline.lifecycle.onFailure.badge")}</span>
          <code className="rounded bg-destructive/10 px-1 py-0.5 font-mono">
            {step.on_failure}
          </code>
        </div>
      )}

      <KindEditor step={step} onChange={onChange} />

      {step.kind === "llm" && (
        <LifecycleLLMStepPrompt
          step={step}
          resolved={resolvedPrompt}
          role={role}
          workspaceSlug={workspaceSlug}
        />
      )}

      <BranchingEditor
        step={step}
        peerStepNames={peerStepNames}
        onChange={onChange}
      />
    </div>
  );
}

// The teach-the-kind panel: the selected kind's distilled knowledge (from the
// backend registry) so an operator configures the pipeline understanding what
// each step actually does. `useLifecycleKinds` is React-Query cached, so calling
// it per-editor is cheap; a fetch-in-flight simply renders nothing (the schema
// editor above still works).
function KindKnowledge({ kind }: { kind: LifecycleKindName }) {
  const { t } = useTranslation();
  const { data } = useLifecycleKinds();
  const doc = data?.docs?.[kind];
  const schema = data?.kinds?.[kind];
  if (!doc) return null;
  const localizedDoc = localizeLifecycleKindDoc(kind, doc, t);

  const producesDecision = schema?.produces_decision ?? false;
  const terminal = schema?.terminal ?? false;

  return (
    <div
      data-testid="kind-doc"
      className="space-y-2 rounded-md border border-[color:var(--color-info)]/30 bg-[color:var(--color-info)]/5 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-info)]" aria-hidden />
        <div className="space-y-1">
          <p className="text-sm text-foreground">{localizedDoc.summary}</p>
          <p className="text-xs text-muted-foreground">
            {localizedDoc.when_to_use}
          </p>
        </div>
      </div>

      {localizedDoc.gotcha ? (
        <div
          data-testid="kind-doc-gotcha"
          className="flex items-start gap-2 rounded border border-[color:var(--color-warning)]/30 bg-[color:var(--color-warning)]/10 px-2 py-1.5 text-[0.7rem] text-[color:var(--color-warning-foreground)]"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{localizedDoc.gotcha}</span>
        </div>
      ) : null}

      <div
        data-testid="kind-doc-flags"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] text-muted-foreground"
      >
        {producesDecision ? (
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3 text-[color:var(--color-info)]" aria-hidden />
            {t("pipeline.lifecycle.step.kindKnowledge.branches")}
          </span>
        ) : null}
        {terminal ? (
          <span className="flex items-center gap-1">
            <OctagonMinus className="h-3 w-3" aria-hidden />
            {t("pipeline.lifecycle.step.kindKnowledge.ends")}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            {t("pipeline.lifecycle.step.kindKnowledge.continues")}
          </span>
        )}
      </div>
    </div>
  );
}
