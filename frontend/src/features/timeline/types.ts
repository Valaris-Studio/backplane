// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Activity, ActivityEntityType, ActivityAction } from "@/types/activity";

// ── Snapshot shapes (the minimal entity state carried on each event) ──────────
// All free-text classifier fields are opaque strings: never enumerate
// card_type / priority / status / role. Any user-defined value must round-trip.

export interface ParticipantSnapshot {
  user_id: string;
  agent_id: string | null;
  name: string;
  role: string; // OPAQUE — passed through verbatim (e.g. "hero", "ux-pilot", anything)
  avatar_url: string | null;
}

export interface CardSnapshot {
  id: string;
  title: string;
  card_type: string; // opaque
  priority: string; // opaque
  column_id: string | null;
  position: number;
  status: string | null; // opaque
  labels: string[] | null;
  participants: ParticipantSnapshot[];
  // When the card was born (v1.2, optional — older backends omit it). Lets the
  // engine withhold baseline cards created INSIDE the logged window even when
  // no per-card create event exists (bulk creates record one event for N).
  created_at?: string | null;
}

export interface ColumnSnapshot {
  id: string;
  name: string;
  column_type: string | null; // opaque
  position: number;
}

// Union so a consumer can narrow on entity_type. Board/other entity_types
// carry unknown snapshots — the engine ignores them (only card/column fold).
export type EntitySnapshot = CardSnapshot | ColumnSnapshot | Record<string, unknown>;

// ── TimelineEvent: Activity + the two NEW nullable snapshot fields ────────────
export interface TimelineEvent extends Activity {
  before_state: EntitySnapshot | null;
  after_state: EntitySnapshot | null;
  // Re-required here: `changes` is optional on Activity because the activity
  // FEED fetches trimmed rows, but /timeline never trims and the replay
  // engine folds this field on every event.
  changes: Record<string, unknown> | null;
}

// Re-export the action/entity unions so timeline consumers don't reach into
// the activity module; keeps the feature self-contained.
export type { ActivityEntityType, ActivityAction };

// ── Current-state baseline (v1.1) ─────────────────────────────────────────────
// The board's LIVE columns + cards, built from the same snapshot helpers as
// before_state/after_state. The engine seeds from this before folding events so
// legacy boards (null-snapshot activity) still render real titles/columns
// instead of "Untitled in Unknown". columns ordered by position; cards flat.
export interface BoardBaseline {
  columns: ColumnSnapshot[];
  cards: CardSnapshot[];
}

// ── Endpoint response (GET .../timeline) ──────────────────────────────────────
export interface TimelineResponse {
  board_id: string;
  generated_at: string; // ISO
  truncated: boolean; // backend hit the 5000-event cap (oldest kept)
  events: TimelineEvent[]; // ASC by created_at
  baseline?: BoardBaseline | null; // v1.1 — optional; absent on old backends
}

// ── Reconstructed frame (output of reconstructState) ──────────────────────────
// A card placed in a frame. Carries the snapshot plus a flag for legacy cards
// that landed in the synthetic Unknown column with no real snapshot.
export interface FrameCard {
  snapshot: CardSnapshot;
  legacy: boolean; // true => reconstructed best-effort from a null-snapshot event
}

export interface FrameColumn {
  snapshot: ColumnSnapshot;
  cards: FrameCard[]; // ordered by snapshot.position ASC
}

export interface BoardFrame {
  columns: FrameColumn[]; // ordered by snapshot.position ASC; Unknown bucket last
  // true iff ANY legacy (null-snapshot) event was applied to reach this frame
  // — drives the "partial history" note in the UI (later phase).
  partial: boolean;
}

// Sentinel id/position for the synthetic holding column that catches legacy
// cards with no resolvable column. Exported so the UI can label/skip it.
export const UNKNOWN_COLUMN_ID = "__timeline_unknown__";

// ── Per-card analytics (derived purely on the client) ─────────────────────────
export interface CardHolder {
  key: string; // stable identity: agent_id ?? user_id (dedupe across snapshots)
  name: string;
  role: string; // OPAQUE — verbatim
  ms: number; // total time this holder held the card
}

export interface CardAnalytics {
  cardId: string;
  // ms spent in each column, keyed by column_id. The card's current (open)
  // segment is closed at the endTime PARAM passed in by the caller.
  dwellByColumn: Record<string, number>;
  // who held the card and for how long, derived from participant snapshots
  // over time. Sorted by ms DESC, then key for determinism.
  holders: CardHolder[];
}

export interface HistoryCoverage {
  quality: "reconstructed" | "partial";
  unknown_origin: boolean;
  missing_structural_snapshots: string;
  reasons: Array<"unknown_origin" | "missing_structural_snapshot" | "conflicting_snapshot">;
}
export interface HistoryAnchor {
  through_seq: string | null;
  state: BoardBaseline;
  coverage: HistoryCoverage;
}
export interface HistoryGeneration {
  id: string;
  board_id: string;
  created_at: string;
  expires_at: string;
  first_seq: string | null;
  head_seq: string | null;
  event_count: string;
}
export interface HistoryOverview {
  generation_id: string;
  first_seq: string | null;
  head_seq: string | null;
  first_at: string | null;
  last_at: string | null;
  event_count: string;
  buckets: Array<{ start_at: string; end_at: string; count: string; first_seq: string | null; last_seq: string | null }>;
}
export interface HistoryWindow {
  status: "ready";
  generation_id: string;
  anchor: HistoryAnchor;
  events: Array<TimelineEvent & { seq: string }>;
  window: { first_seq: string | null; last_seq: string | null; previous_cursor: string | null; next_cursor: string | null };
  coverage: HistoryCoverage;
}
export interface HistoryPreparation {
  status: "preparing" | "failed";
  generation_id: string;
  preparation_id: string;
  progress: { through_seq: string | null; target_seq: string | null; processed_events: string };
  retryable: boolean;
  error: { code: string; message: string } | null;
}
export type HistorySelector = { at_seq: string } | { at_time: string } | { cursor: string } | Record<string, never>;
export interface HistorySearchPage {
  generation_id: string;
  scope: "generation";
  matches: Array<{ id: string; seq: string; created_at: string; summary: string }>;
  next_cursor: string | null;
}
export interface HistoryLiveHead {
  generation_id: string;
  observed_at: string;
  head_seq: string | null;
  state: BoardBaseline;
}
