// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";
import type { NotificationCategory } from "../api/notifications-api";

// Display order for the preferences grid. Grouped "relevant to me first": the
// categories a user is directly involved in lead, the higher-volume / opt-in
// ones trail. This mirrors the contract's taxonomy table intent — it is purely
// presentational, NOT the white-label key set (those live in the api type).
export const CATEGORY_ORDER: NotificationCategory[] = [
  "card_assigned",
  "card_participant_changed",
  "card_comment",
  "dependency_blocking",
  "mention",
  "approval_requested",
  "approval_decided",
  "workspace_member",
  "board_run_finished",
  "card_created",
  "resource_note_shared",
];

// Categories the contract reserves but that have NO event producer yet. They
// still appear in the (total) grid and stay toggleable — the saved choice
// applies the moment a producer ships — but we mark them with a quiet hint.
// `mention` shipped its producer (cards + notes), so it's no longer reserved;
// `board_run_finished` still awaits an idle-detector.
export const RESERVED_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  "board_run_finished",
]);

// Channel label with a humanize fallback: a backend-added channel renders
// immediately from its key (e.g. "telegram" → "Telegram") even before an i18n
// label exists, so the grid is fully data-driven over the channels endpoint.
export function channelLabel(channel: string, t: TFunction): string {
  return t(`notifications.prefs.channel.${channel}`, {
    defaultValue: humanizeChannel(channel),
  });
}

function humanizeChannel(channel: string): string {
  return channel
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
