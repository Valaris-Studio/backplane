// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Activity } from "./activity";

/** Cards per column_type. `untyped` covers columns with no column_type set, so
 * the buckets always sum to the board's card_count. */
export interface BoardCardDistribution {
  backlog: number;
  active: number;
  review: number;
  done: number;
  blocked: number;
  untyped: number;
}

export interface BoardStats {
  board_id: string;
  name: string;
  slug: string | null;
  card_count: number;
  overdue_count: number;
  distribution: BoardCardDistribution;
}

/** One calendar day of the activity sparkline. `day` is an ISO date (no time). */
export interface ActivityTrendPoint {
  day: string;
  count: number;
}

export interface DashboardSummary {
  board_count: number;
  card_count: number;
  note_count: number;
  channel_count: number;
  recent_activity: Activity[];
  // Optional so a frontend deployed ahead of the backend still renders — the
  // panel treats a missing field as "no boards to report".
  board_stats?: BoardStats[];
  // Oldest day first, 30 entries, zero-filled. Optional for the same
  // forward-compat reason as board_stats.
  activity_trend?: ActivityTrendPoint[];
}
