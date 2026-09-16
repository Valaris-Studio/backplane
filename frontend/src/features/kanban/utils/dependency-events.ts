// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Backend dependency-edit WS events the FE must react to. The bulk-set path
// (mcp bulk_set_card_dependencies) emits `dependencies_replaced` — note the
// 'ies' — so a `startsWith("activity.card.dependency_")` prefix is fragile and
// has historically dropped sibling spellings. Match the exact contract instead.
export const DEP_EVENTS = new Set<string>([
  "activity.card.dependency_added",
  "activity.card.dependency_removed",
  "activity.card.dependencies_replaced",
]);

export function isDependencyEvent(eventName: string): boolean {
  return DEP_EVENTS.has(eventName);
}
