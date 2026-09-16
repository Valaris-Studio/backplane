// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ApplyLabelStep,
  BranchStep,
  ClaimStep,
  CreateFixCardsStep,
  CreateNoteStep,
  CreatePRStep,
  DiscoverStep,
  EnableAutoMergeStep,
  EndStep,
  EnqueueForMergeStep,
  GitSetupStep,
  LLMStep,
  LifecycleKindName,
  LifecycleStep,
  MCPCallStep,
  MergePRStep,
  MoveCardStep,
  PostPRReviewStep,
  RemoveLabelStep,
  SensorStep,
  ShipStep,
  WakeRoleStep,
} from "../../../api/pipelineConfig";

// Map kind discriminant -> the `params` shape from the discriminated union.
// `NonNullable` because every step variant types `params?` as optional —
// editors always render a non-null view so the user can fill fields.
export type KindParams<K extends LifecycleKindName> = NonNullable<
  Extract<LifecycleStep, { kind: K }>["params"]
>;

export interface KindEditorProps<K extends LifecycleKindName> {
  params: KindParams<K>;
  onChange: (next: KindParams<K>) => void;
  disabled?: boolean;
}

export type {
  DiscoverStep,
  ClaimStep,
  GitSetupStep,
  LLMStep,
  SensorStep,
  MoveCardStep,
  ApplyLabelStep,
  RemoveLabelStep,
  CreateNoteStep,
  EnqueueForMergeStep,
  MCPCallStep,
  CreateFixCardsStep,
  BranchStep,
  WakeRoleStep,
  CreatePRStep,
  EnableAutoMergeStep,
  MergePRStep,
  PostPRReviewStep,
  ShipStep,
  EndStep,
};
