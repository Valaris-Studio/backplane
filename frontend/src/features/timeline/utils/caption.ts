// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";
import { resolveActivityMessage } from "@/features/activity/utils/resolve-activity-message";
import type { CardSnapshot, TimelineEvent } from "../types";

// ROLE-AGNOSTIC event sentence. Order of preference:
//   1. localized structured copy, with the backend `summary` as exact fallback;
//   2. a synthesized sentence from entity_type + action;
//   3. a generic fallback with the action humanized (underscores -> spaces).
// The actor is `actor_name`, falling back to a generic "someone" — never a role.
// Participant roles play NO part in the caption.

const KNOWN_ACTIONS = new Set(["created", "updated", "moved", "deleted"]);

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function entityLabel(event: TimelineEvent): string {
  // Prefer a real title from the after/before snapshot; fall back to the opaque
  // entity_type ("card", "column", …) so the sentence always reads naturally.
  const snapshot = (event.after_state ?? event.before_state) as
    | Partial<CardSnapshot>
    | null;
  const title = snapshot && typeof snapshot.title === "string" ? snapshot.title : "";
  return title || event.entity_type;
}

function resolveColumn(
  changes: Record<string, unknown> | null,
  side: "old" | "new",
  columnNames: Record<string, string>,
): string {
  const entry = changes?.column_id;
  if (entry && typeof entry === "object" && side in (entry as object)) {
    const id = (entry as Record<string, unknown>)[side];
    if (typeof id === "string") return columnNames[id] ?? id;
  }
  return "";
}

export function deriveCaption(
  event: TimelineEvent,
  t: TFunction,
  columnNames: Record<string, string> = {},
): string {
  const summary = resolveActivityMessage(event, t);
  if (summary.trim().length > 0) return summary;

  const actor = event.actor_name ?? t("timeline.caption.someone");
  const entity = entityLabel(event);

  if (KNOWN_ACTIONS.has(event.action)) {
    if (event.action === "moved") {
      return t("timeline.caption.moved", {
        actor,
        entity,
        from: resolveColumn(event.changes, "old", columnNames),
        to: resolveColumn(event.changes, "new", columnNames),
      });
    }
    return t(`timeline.caption.${event.action}`, { actor, entity });
  }

  return t("timeline.caption.generic", {
    actor,
    entity,
    action: humanize(event.action),
  });
}
