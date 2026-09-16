// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CardType, Priority } from "@/types/kanban";

// Corner-tag color tokens shared by KanbanCard (board view) and the table view
// so a card's type/priority reads identically across layouts. The hue drives a
// gradient on the card; in the table it backs a compact pill.
export const CARD_TYPE_TINT: Record<CardType, string> = {
  task: "var(--color-info)",
  bug: "var(--color-destructive)",
  feature: "var(--color-success)",
  issue: "var(--color-warning)",
};

export const CARD_TYPE_TEXT: Record<CardType, string> = {
  task: "text-[color:var(--color-info)]",
  bug: "text-destructive",
  feature: "text-[color:var(--color-success)]",
  issue: "text-[color:var(--color-warning)]",
};

export const PRIORITY_TINT: Record<Priority, string> = {
  none: "var(--color-muted-foreground)",
  low: "var(--color-muted-foreground)",
  medium: "var(--color-warning)",
  high: "var(--color-data-4)",
  urgent: "var(--color-destructive)",
};

export const PRIORITY_TEXT: Record<Priority, string> = {
  none: "text-muted-foreground",
  low: "text-muted-foreground",
  medium: "text-[color:var(--color-warning)]",
  high: "text-[color:var(--color-data-4)]",
  urgent: "text-destructive",
};
