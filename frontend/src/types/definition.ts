// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Objective {
  text: string;
  priority: "high" | "medium" | "low" | null;
}

export interface Milestone {
  title: string;
  date: string;
  type: "start" | "deadline" | "milestone";
}

export interface Stakeholder {
  name: string;
  role: string;
  member_id: string | null;
  channel_id: string | null;
}

export interface KeyDecision {
  decision: string;
  rationale: string;
}

export interface Reference {
  label: string;
  url: string;
}

export interface CustomField {
  key: string;
  value: string;
}

export interface DefinitionContent {
  objectives: Objective[];
  exclusions: string[];
  milestones: Milestone[];
  tech_stack: string[];
  stakeholders: Stakeholder[];
  constraints: string[];
  decisions: KeyDecision[];
  references: Reference[];
  custom_fields: CustomField[];
  _overflow: Record<string, unknown>;
}

export interface Definition {
  id: string;
  board_id: string;
  workspace_id: string;
  scope: string;
  content: DefinitionContent;
  updated_by: string;
  created_at: string;
  updated_at: string;
}
