// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CardSnapshot, ColumnSnapshot, TimelineEvent } from "../types";

export const HISTORY_BASE = "/workspaces/test-ws/boards/development/timeline";
export const GENERATION_ID = "af114d53-ed95-4c37-a2c5-2970cd0a5c33";
export const BOARD_UUID = "4b733c45-d729-4b72-b110-aa5a1eaf2743";
export const sequence = (offset: number) => (9007199254740993n + BigInt(offset)).toString();
export const generation = (id = GENERATION_ID) => ({
  id, board_id: BOARD_UUID, created_at: "2026-10-08T12:00:00Z", expires_at: "2099-10-09T12:00:00Z",
  first_seq: sequence(0), head_seq: sequence(10_000), event_count: "10001",
});
export const overview = (id = GENERATION_ID) => ({
  generation_id: id, first_seq: sequence(0), head_seq: sequence(10_000), event_count: "10001",
  first_at: "2025-01-01T00:00:00Z", last_at: "2026-10-08T12:00:00Z",
  buckets: [
    { start_at: "2025-01-01T00:00:00Z", end_at: "2026-01-01T00:00:00Z", count: "5000", first_seq: sequence(0), last_seq: sequence(4999) },
    { start_at: "2026-01-01T00:00:00Z", end_at: "2026-10-08T12:00:01Z", count: "5001", first_seq: sequence(5000), last_seq: sequence(10_000) },
  ],
});
export const coverage = () => ({
  quality: "reconstructed" as "reconstructed" | "partial", unknown_origin: false,
  missing_structural_snapshots: "0",
  reasons: [] as Array<"unknown_origin" | "missing_structural_snapshot" | "conflicting_snapshot">,
});
export const columns: ColumnSnapshot[] = [
  { id: "backlog", name: "Backlog", column_type: null, position: 1024 },
  { id: "done", name: "Done", column_type: null, position: 2048 },
];
export function card(overrides: Partial<CardSnapshot> = {}): CardSnapshot {
  return { id: "card-one", title: "Recorded draft", card_type: "task", priority: "medium", column_id: "backlog", position: 1024, status: null, labels: null, participants: [], ...overrides };
}
export function historyEvent(offset: number, overrides: Partial<TimelineEvent> = {}): TimelineEvent & { seq: string } {
  return {
    id: `event-${offset}`, seq: sequence(offset), workspace_id: "workspace", board_id: BOARD_UUID,
    actor_id: "actor", actor_name: "Alice", actor_email: null, agent_id: null,
    entity_type: "note", entity_id: `note-${offset}`, entity_title: null, action: "updated",
    summary: `Recorded event ${offset}`, changes: null, via_api_key: null,
    created_at: "2026-10-08T12:00:00Z", before_state: null, after_state: null, ...overrides,
  };
}
export function readyWindow(offset = 9998, id = GENERATION_ID) {
  return {
    status: "ready" as const, generation_id: id,
    anchor: { through_seq: sequence(offset - 1), state: { columns: structuredClone(columns), cards: [card()] }, coverage: coverage() },
    events: [historyEvent(offset), historyEvent(offset + 1), historyEvent(offset + 2)],
    window: { first_seq: sequence(offset), last_seq: sequence(offset + 2), previous_cursor: offset > 0 ? `before-${offset}` : null, next_cursor: offset < 9998 ? `after-${offset + 2}` : null },
    coverage: coverage(),
  };
}
export function preparation(status: "preparing" | "failed" = "preparing") {
  return {
    status, generation_id: GENERATION_ID, preparation_id: "b1641012-b719-4492-bbbb-f565c105a169",
    progress: { through_seq: sequence(500), target_seq: sequence(9997), processed_events: "501" },
    retryable: status === "failed", error: status === "failed" ? { code: "batch_failed", message: "Preparation interrupted" } : null,
  };
}
