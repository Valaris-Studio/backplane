// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface NoteRevisionActor {
  user_id: string | null;
  user_name: string | null;
  authentication_method: string | null;
  principal_kind: string | null;
  agent_id: string | null;
  agent_name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  installation_id: string | null;
}

export interface NoteRevisionSummary {
  revision: number;
  recorded_at: string;
  capture_kind: "creation" | "edit" | "baseline" | "gap_baseline";
  operation: string;
  changed_fields: string[];
  content_bytes: number;
  content_sha256: string;
  revision_digest: string;
  title: string;
  pinned: boolean;
  card_id: string | null;
  kind: string;
  source_execution_id: string | null;
  actor: NoteRevisionActor | null;
  channel: "unconfirmed" | "mcp_reported";
}

export interface NoteRevisionSnapshot {
  content: string;
  title: string;
  pinned: boolean;
  card_id: string | null;
  kind: string;
  failure_class: string | null;
  findings: Record<string, unknown>[] | null;
  source_execution_id: string | null;
}

export interface NoteRevisionDetail extends NoteRevisionSummary {
  snapshot: NoteRevisionSnapshot;
}

export interface NoteRevisionPage {
  items: NoteRevisionSummary[];
  next_before_revision: number | null;
  latest_recorded_revision: number;
  capture_boundary: { first_revision: number; capture_kind: string } | null;
}

export interface NoteRevisionComparison {
  before: NoteRevisionDetail;
  after: NoteRevisionDetail;
  changed_fields: string[];
}
