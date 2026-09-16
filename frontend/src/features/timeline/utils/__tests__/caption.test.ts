// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import { deriveCaption } from "../caption";
import type { TimelineEvent } from "../../types";

// deriveCaption(event, t, columnNames?) builds a ROLE-AGNOSTIC event sentence:
//   1. prefer structured localized copy, with `summary` as exact fallback;
//   2. else synthesize from entity_type + action via t("timeline.caption.<action>");
//   3. unknown actions fall back to a generic sentence with a humanized action.
// Actor is `actor_name`, falling back to a generic "someone" — never a role.

let seq = 0;
function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    workspace_id: "ws1",
    board_id: "board1",
    actor_id: "actor1",
    actor_name: "Alice",
    actor_email: "alice@valaris.dev",
    agent_id: null,
    entity_type: "card",
    entity_id: "card1",
    action: "created",
    summary: "",
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: "2026-01-01T00:00:00Z",
    before_state: null,
    after_state: null,
    ...overrides,
  };
}

// Stub `t` that interpolates {{var}} so we can assert the assembled sentence.
const t = ((key: string, opts?: Record<string, unknown>) => {
  const templates: Record<string, string> = {
    "timeline.caption.someone": "Someone",
    "timeline.caption.agentQualifier": "(runner)",
    "timeline.caption.created": "{{actor}} created {{entity}}",
    "timeline.caption.updated": "{{actor}} updated {{entity}}",
    "timeline.caption.moved": "{{actor}} moved {{entity}} from {{from}} to {{to}}",
    "timeline.caption.deleted": "{{actor}} deleted {{entity}}",
    "timeline.caption.generic": "{{actor}} {{action}} {{entity}}",
  };
  let out = templates[key] ?? (opts?.defaultValue as string) ?? key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return out;
}) as unknown as Parameters<typeof deriveCaption>[1];

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("deriveCaption", () => {
  it("prefers a non-empty backend summary verbatim", () => {
    const e = event({ summary: "Alice shipped the thing", action: "updated" });
    expect(deriveCaption(e, t)).toBe("Alice shipped the thing");
  });

  it("localizes a structured backend summary for Board Timeline/Replay", async () => {
    await i18n.changeLanguage("pt-BR");
    const e = event({
      summary: "created card 'Launch'",
      message_key: "activity.card.created",
      message_params: { card_title: "Launch" },
    });

    expect(deriveCaption(e, i18n.t.bind(i18n))).toBe(
      "criou o cartão 'Launch'",
    );
  });

  it("synthesizes a 'created' sentence when summary is empty", () => {
    const e = event({ action: "created", after_state: { id: "card1", title: "Login bug" } as never });
    expect(deriveCaption(e, t)).toContain("Alice created");
  });

  it("synthesizes a 'moved' sentence resolving column ids to NAMES", () => {
    const e = event({
      action: "moved",
      changes: {
        column_id: { old: "col-a", new: "col-b" },
      },
    });
    const columnNames = { "col-a": "Backlog", "col-b": "Active" };
    const caption = deriveCaption(e, t, columnNames);
    expect(caption).toContain("Backlog");
    expect(caption).toContain("Active");
    expect(caption).toContain("Alice moved");
  });

  it("falls back to 'Someone' when actor_name is null", () => {
    const e = event({ actor_name: null, summary: "" });
    expect(deriveCaption(e, t)).toContain("Someone");
  });

  it("unknown action falls back to a generic sentence with a humanized action", () => {
    const e = event({ action: "dependency_added" as never, summary: "" });
    const caption = deriveCaption(e, t);
    // underscores humanized to spaces; no enumerated/role wording
    expect(caption).toContain("dependency added");
    expect(caption).toContain("Alice");
  });

  it("is ROLE-AGNOSTIC: an invented actor role never changes the sentence", () => {
    // The caption derives from actor_name + action only; participant roles play
    // no part. A moved event by an actor (whatever their role) reads the same.
    const e = event({
      action: "moved",
      summary: "",
      changes: { column_id: { old: "col-a", new: "col-b" } },
    });
    const caption = deriveCaption(e, t, { "col-a": "Backlog", "col-b": "Active" });
    expect(caption).toBe("Alice moved card from Backlog to Active");
  });
});
