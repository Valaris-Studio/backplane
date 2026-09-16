// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactElement } from "react";
import type { LifecycleKindName, LifecycleStep } from "../../../api/pipelineConfig";
import { ApplyLabelEditor } from "./ApplyLabelEditor";
import { BranchEditor } from "./BranchEditor";
import { ClaimEditor } from "./ClaimEditor";
import { CreateFixCardsEditor } from "./CreateFixCardsEditor";
import { CreateNoteEditor } from "./CreateNoteEditor";
import { CreatePREditor } from "./CreatePREditor";
import { DiscoverEditor } from "./DiscoverEditor";
import { EnableAutoMergeEditor } from "./EnableAutoMergeEditor";
import { EndEditor } from "./EndEditor";
import { EnqueueForMergeEditor } from "./EnqueueForMergeEditor";
import { GitSetupEditor } from "./GitSetupEditor";
import { LlmEditor } from "./LlmEditor";
import { McpCallEditor } from "./McpCallEditor";
import { MergePREditor } from "./MergePREditor";
import { MoveCardEditor } from "./MoveCardEditor";
import { PostPRReviewEditor } from "./PostPRReviewEditor";
import { RemoveLabelEditor } from "./RemoveLabelEditor";
import { SensorEditor } from "./SensorEditor";
import { ShipEditor } from "./ShipEditor";
import { SkillsSetupEditor } from "./SkillsSetupEditor";
import { WakeRoleEditor } from "./WakeRoleEditor";

interface AnyEditorProps {
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
}

type EditorComponent = (props: AnyEditorProps) => ReactElement;

// Closed-set registry — exhaustive over `LifecycleKindName`. Adding a kind to
// the discriminated union without an entry here is a type error, which is
// the point: the union is the source of truth. There is no fallback —
// runners never ship a kind the frontend can't handle because both mirror
// backend/app/services/agents/lifecycle_kinds.py.
export const KIND_EDITORS: Record<LifecycleKindName, EditorComponent> = {
  discover: DiscoverEditor as EditorComponent,
  claim: ClaimEditor as EditorComponent,
  git_setup: GitSetupEditor as EditorComponent,
  skills_setup: SkillsSetupEditor as EditorComponent,
  llm: LlmEditor as EditorComponent,
  sensor: SensorEditor as EditorComponent,
  move_card: MoveCardEditor as EditorComponent,
  apply_label: ApplyLabelEditor as EditorComponent,
  remove_label: RemoveLabelEditor as EditorComponent,
  create_note: CreateNoteEditor as EditorComponent,
  enqueue_for_merge: EnqueueForMergeEditor as EditorComponent,
  mcp_call: McpCallEditor as EditorComponent,
  create_fix_cards: CreateFixCardsEditor as EditorComponent,
  branch: BranchEditor as EditorComponent,
  wake_role: WakeRoleEditor as EditorComponent,
  create_pr: CreatePREditor as EditorComponent,
  enable_auto_merge: EnableAutoMergeEditor as EditorComponent,
  merge_pr: MergePREditor as EditorComponent,
  post_pr_review: PostPRReviewEditor as EditorComponent,
  ship: ShipEditor as EditorComponent,
  end: EndEditor as EditorComponent,
};

interface KindEditorDispatchProps {
  step: LifecycleStep;
  onChange: (next: LifecycleStep) => void;
  disabled?: boolean;
}

export function KindEditor({ step, onChange, disabled }: KindEditorDispatchProps) {
  const Editor = KIND_EDITORS[step.kind];
  const params = (step as { params?: Record<string, unknown> }).params ?? {};
  return (
    <Editor
      params={params}
      disabled={disabled}
      onChange={(next: Record<string, unknown>) =>
        onChange({ ...(step as LifecycleStep), params: next } as LifecycleStep)
      }
    />
  );
}
