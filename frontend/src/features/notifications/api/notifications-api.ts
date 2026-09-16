// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

// Stable taxonomy keys (the white-label contract, INV-5). The backend emits
// only the key + structured params; ALL display copy lives in FE i18n. The 7
// at the top fire in v1; the 4 below are reserved (no producer yet) but still
// get i18n copy so the Phase-6 preferences grid is total.
export type NotificationCategory =
  | "card_participant_changed"
  | "card_created"
  | "dependency_blocking"
  | "workspace_member"
  | "card_comment"
  | "approval_requested"
  | "approval_decided"
  // reserved (no v1 producer)
  | "mention"
  | "card_assigned"
  | "board_run_finished"
  | "resource_note_shared";

// Deep-link target. `kind:"card"` resolves to the board route with ?card=<id>;
// other kinds may arrive later (approval/resource) — `linkToRoute` degrades to
// the workspace root for shapes it can't resolve yet.
export interface NotificationLink {
  kind: string;
  workspace_slug?: string;
  board_id?: string | null;
  card_id?: string | null;
  note_id?: string | null;
  approval_id?: string | null;
  resource_id?: string | null;
}

export interface NotificationRead {
  id: string;
  recipient_user_id: string;
  workspace_id: string;
  board_id: string | null;
  category: string;
  actor_id: string | null;
  is_agent_actor: boolean;
  entity_type: string;
  entity_id: string | null;
  // Pre-resolved interpolation values (card title, column names, actor name,
  // count, …) — the FE composes copy from these, never re-queries.
  params: Record<string, unknown>;
  link: NotificationLink | null;
  read_at: string | null;
  created_at: string;
}

export interface UnreadCount {
  count: number;
}

export type RelevanceScope = "watching" | "everything";

// A (category → channel → on/off) map. Used for both the SPARSE user knobs
// (`category_overrides`) and the resolved `effective` map.
export type CategoryChannelMap = Record<string, Record<string, boolean>>;

// Effective + raw preferences. `category_overrides` is the SPARSE set of knobs
// the user has explicitly flipped; `effective` is the backend-RESOLVED on/off
// the grid renders (it already folds muted → override → default-by-scope), so
// the FE never re-derives defaults. A PUT returns a recomputed `effective`.
export interface NotificationPreferences {
  relevance_scope: RelevanceScope;
  category_overrides: CategoryChannelMap;
  muted: boolean;
  effective: CategoryChannelMap;
}

export interface NotificationChannels {
  channels: string[];
}

const MAX_LIMIT = 50;

export interface ListNotificationsParams {
  slug?: string;
  limit?: number;
  before?: string;
  unread?: boolean;
}

export async function listNotifications({
  slug,
  limit = MAX_LIMIT,
  before,
  unread,
}: ListNotificationsParams): Promise<NotificationRead[]> {
  const { data } = await api.get<NotificationRead[]>("/notifications", {
    params: {
      workspace: slug,
      limit,
      before,
      unread: unread ? true : undefined,
    },
  });
  return data;
}

export async function fetchUnreadCount(slug?: string): Promise<number> {
  const { data } = await api.get<UnreadCount>(
    "/notifications/unread-count",
    { params: { workspace: slug } },
  );
  return data.count;
}

export async function markNotificationRead(
  id: string,
): Promise<NotificationRead> {
  const { data } = await api.post<NotificationRead>(
    `/notifications/${id}/read`,
  );
  return data;
}

export async function markAllNotificationsRead(slug?: string): Promise<void> {
  await api.post("/notifications/read-all", null, {
    params: { workspace: slug },
  });
}

// --- Phase 6 scaffolding (preferences UI not built here) ---

export async function fetchNotificationPreferences(
  slug: string,
): Promise<NotificationPreferences> {
  const { data } = await api.get<NotificationPreferences>(
    "/notifications/preferences",
    { params: { workspace: slug } },
  );
  return data;
}

export async function updateNotificationPreferences(
  slug: string,
  prefs: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const { data } = await api.put<NotificationPreferences>(
    "/notifications/preferences",
    prefs,
    { params: { workspace: slug } },
  );
  return data;
}

export async function fetchNotificationChannels(): Promise<string[]> {
  const { data } = await api.get<NotificationChannels>(
    "/notifications/channels",
  );
  return data.channels;
}
