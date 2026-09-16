// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";
import type { NotificationRead } from "../api/notifications-api";

export interface NotificationCopy {
  title: string;
  body: string;
}

// The i18n params every category copy may interpolate. Composed purely from the
// notification's pre-resolved `params` plus a derived actor label — the backend
// ships structured values (INV-5), the FE owns the sentence. Unknown categories
// fall back to the raw key humanized via i18next `defaultValue`, never an
// "unknown" placeholder, so a category added backend-first still renders.
function interpolationParams(
  notification: NotificationRead,
  t: TFunction,
): Record<string, unknown> {
  const { params, is_agent_actor } = notification;
  const actor =
    (params.actor_name as string | undefined) ??
    (params.actor_email as string | undefined) ??
    (is_agent_actor
      ? t("notifications.actor.agent")
      : t("notifications.actor.someone"));
  const derived: Record<string, unknown> = { actor };

  // The backend ships a raw decision token ("approved"/"rejected"). Localize it
  // before interpolation so es copy doesn't render an English token ("fue
  // approved"); the category body interpolates {{decisionLabel}}. Falls back to
  // the raw token for any unmapped decision so nothing renders blank.
  if (typeof params.decision === "string") {
    derived.decisionLabel = t(`notifications.decision.${params.decision}`, {
      defaultValue: params.decision,
    });
  }

  return { ...params, ...derived };
}

function humanizeKey(category: string): string {
  return category.replace(/[_-]+/g, " ").trim();
}

/**
 * Compose the display title + body for one notification from its `category` +
 * `params` via i18n. Data-driven: a new category needs only an i18n key pair
 * (`notifications.category.<key>.{title,body}`) — no code change here.
 */
export function notificationCopy(
  notification: NotificationRead,
  t: TFunction,
): NotificationCopy {
  const vars = interpolationParams(notification, t);
  const titleKey = `notifications.category.${notification.category}.title`;
  const bodyKey = `notifications.category.${notification.category}.body`;
  return {
    title: t(titleKey, { ...vars, defaultValue: humanizeKey(notification.category) }),
    body: t(bodyKey, { ...vars, defaultValue: "" }),
  };
}

export function isUnread(notification: NotificationRead): boolean {
  return notification.read_at === null;
}
