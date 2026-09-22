// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import { SUPPORTED_LANGUAGES } from "@/i18n/supported-languages";
import { isUnread, notificationCopy } from "../category-copy";
import type { NotificationRead } from "../../api/notifications-api";

function makeNotification(
  overrides: Partial<NotificationRead> = {},
): NotificationRead {
  return {
    id: "n1",
    recipient_user_id: "u1",
    workspace_id: "w1",
    board_id: "b1",
    category: "card_participant_changed",
    actor_id: "u2",
    is_agent_actor: false,
    entity_type: "card",
    entity_id: "c1",
    params: {},
    link: null,
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("notificationCopy", () => {
  it("interpolates card + actor params into the category copy (en)", () => {
    const copy = notificationCopy(
      makeNotification({
        category: "card_participant_changed",
        params: { card: "Ship the bell", actor_name: "Ada" },
      }),
      i18n.t.bind(i18n),
    );
    expect(copy.title).toBe("Ship the bell was updated");
    expect(copy.body).toBe("Ada changed a card you're following.");
  });

  it("localizes copy in Spanish", async () => {
    await i18n.changeLanguage("es");
    const copy = notificationCopy(
      makeNotification({
        category: "card_created",
        params: { card: "Tarjeta", board: "Tablero", actor_name: "Ada" },
      }),
      i18n.t.bind(i18n),
    );
    expect(copy.title).toBe("Nueva tarjeta: Tarjeta");
    expect(copy.body).toBe("Ada creó una tarjeta en Tablero.");
  });

  it("falls back to the agent actor label when no actor name is present", () => {
    const copy = notificationCopy(
      makeNotification({
        category: "card_comment",
        is_agent_actor: true,
        params: { card: "Card" },
      }),
      i18n.t.bind(i18n),
    );
    expect(copy.body).toBe("An agent commented on a card you're following.");
  });

  it("falls back to a humanized key for an unknown category (backend-first add)", () => {
    const copy = notificationCopy(
      makeNotification({ category: "brand_new_thing", params: {} }),
      i18n.t.bind(i18n),
    );
    expect(copy.title).toBe("brand new thing");
    expect(copy.body).toBe("");
  });

  it("localizes the raw decision token via decisionLabel (en)", () => {
    const copy = notificationCopy(
      makeNotification({
        category: "approval_decided",
        params: { card: "Ship it", decision: "approved" },
      }),
      i18n.t.bind(i18n),
    );
    expect(copy.title).toBe("Approval Approved");
    expect(copy.body).toBe("Your request on Ship it was Approved.");
  });

  it("renders a Spanish decision label instead of the English token", async () => {
    await i18n.changeLanguage("es");
    const copy = notificationCopy(
      makeNotification({
        category: "approval_decided",
        params: { card: "Lanzarlo", decision: "rejected" },
      }),
      i18n.t.bind(i18n),
    );
    // Regression: previously rendered "fue rejected" (English token in Spanish).
    expect(copy.body).toBe("Tu solicitud sobre Lanzarlo fue Rechazada.");
    expect(copy.body).not.toMatch(/rejected/);
  });

  it("falls back to the raw decision token for an unmapped decision", () => {
    const copy = notificationCopy(
      makeNotification({
        category: "approval_decided",
        params: { card: "X", decision: "withdrawn" },
      }),
      i18n.t.bind(i18n),
    );
    expect(copy.body).toBe("Your request on X was withdrawn.");
  });
});

describe("isUnread", () => {
  it("is true only when read_at is null", () => {
    expect(isUnread(makeNotification({ read_at: null }))).toBe(true);
    expect(
      isUnread(makeNotification({ read_at: new Date().toISOString() })),
    ).toBe(false);
  });
});

describe("mention copy across supported locales", () => {
  it.each(SUPPORTED_LANGUAGES)("renders old note mentions without placeholders in %s", async (locale) => {
    await i18n.changeLanguage(locale);
    const copy = notificationCopy(
      makeNotification({
        category: "mention",
        entity_type: "note",
        params: { actor_name: "Jordan" },
        link: { kind: "note", note_id: "n1" },
      }),
      i18n.t.bind(i18n),
    );
    expect(copy.body).not.toMatch(/\{\{|<target>|notifications\./);
    expect(copy.body).toContain(i18n.t("notifications.mentionTarget.note"));
  });
});
