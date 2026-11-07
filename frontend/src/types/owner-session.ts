// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CaptureLevel, DisplayState, LinkPreview, SessionCoverage, SessionStatus } from "./agent-session";

export interface OwnerSessionLinkPreview extends LinkPreview {
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  board_name: string | null;
}

export interface OwnerSession {
  id: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  board_id: string | null;
  board_name: string | null;
  parent_session_id: string | null;
  harness: string;
  harness_display_name: string;
  title: string | null;
  repository: string | null;
  branch: string | null;
  status: SessionStatus;
  display_state: DisplayState;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
  ended_reason: "session_end_event" | "abandoned" | null;
  idle_since: string | null;
  event_count: number;
  activity_event_count: number | null;
  coverage: SessionCoverage | null;
  capture_gaps: number;
  capture_levels: CaptureLevel[];
  child_count: number;
  link_count: number;
  link_preview: OwnerSessionLinkPreview[];
}

export interface OwnerSessionPage {
  items: OwnerSession[];
  next_cursor: string | null;
}

export interface OwnerSessionOverviewData {
  active: OwnerSession[];
  recent: OwnerSession[];
  active_more: boolean;
  recent_more: boolean;
  generated_at: string;
}

export interface OwnerSessionListQuery {
  limit?: number;
  workspace_id?: string;
  board_id?: string;
  harness?: string;
  status?: SessionStatus;
  state?: DisplayState[];
  q?: string;
  linked_only?: boolean;
  since?: string;
  root_only: boolean;
  sort?: "recent" | "started";
}
