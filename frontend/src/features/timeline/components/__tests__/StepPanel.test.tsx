// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, userEvent, within } from "@/test/test-utils";
import i18n from "@/i18n/config";
import { StepPanel } from "../StepPanel";
import { describeEvent } from "../../utils/event-descriptor";
import type { TimelineEvent } from "../../types";

// StepPanel is presentational: it consumes describeEvent's StepDescriptor + the
// raw event + a column_id→name map, and renders a rich, role-agnostic summary of
// "what happened this step" — an accent icon chip, the action-verb label, the
// entity title, an event-specific secondary line (move from→to, dependency edge,
// changed-field chips, or localized copy with an exact legacy fallback) — while KEEPING the absolute
// timestamp + the fine-grained deriveCaption text so no information is lost.

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
    created_at: "2026-01-01T12:00:00Z",
    before_state: null,
    after_state: null,
    ...overrides,
  };
}

interface SetupExtras {
  firstEventAt?: string;
  prevEventAt?: string | null;
  reducedMotion?: boolean;
  onInspect?: () => void;
}

function setup(
  ev: TimelineEvent,
  columnNames: Record<string, string> = {},
  cardTitles: Record<string, string> = {},
  extras: SetupExtras = {},
) {
  return renderWithProviders(
    <StepPanel
      event={ev}
      descriptor={describeEvent(ev)}
      columnNames={columnNames}
      cardTitles={cardTitles}
      {...extras}
    />,
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("StepPanel — always-present chrome", () => {
  it("renders the absolute timestamp", () => {
    const ev = event({ action: "created", created_at: "2026-01-01T12:00:00Z" });
    setup(ev);
    const stamp = new Date(ev.created_at).toLocaleString();
    expect(screen.getByText(stamp)).toBeInTheDocument();
  });

  it("has a FIXED height + clipped overflow so it can't reflow the board", () => {
    setup(event({ action: "created" }));
    const panel = screen.getByTestId("step-panel-overview");
    // A fixed height (not min-height) keeps the panel the SAME size for every
    // event, so the board below never jumps as the scrubber moves. min-h alone
    // let tall events grow past the floor — that was the reflow bug.
    expect(panel.className).toMatch(/h-\[4\.5rem\]/);
    expect(panel.className).not.toMatch(/min-h-/);
    expect(panel.className).toContain("overflow-hidden");
  });

  it("keeps the full event caption available through Details", () => {
    // A backend summary is the highest-precedence caption source.
    setup(event({ action: "updated", summary: "Alice tweaked the estimate" }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(within(screen.getByRole("region", { name: "Event details" })).getByText("Alice tweaked the estimate")).toBeInTheDocument();
  });

  it("renders the entity title from the snapshot", () => {
    setup(
      event({
        action: "created",
        after_state: { id: "card1", title: "Login crashes" } as never,
      }),
    );
    expect(screen.getByText("Login crashes")).toBeInTheDocument();
  });
});

describe("StepPanel — compact overview and accessible event details", () => {
  it("asks playback to pause only when Details opens", () => {
    const onInspect = vi.fn();
    setup(event(), {}, {}, { onInspect });
    const toggle = screen.getByRole("button", { name: "Details" });
    fireEvent.click(toggle);
    expect(onInspect).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle);
    expect(onInspect).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle);
    expect(onInspect).toHaveBeenCalledTimes(2);
  });

  it("keeps attribution, title, delta and time visible without a redundant summary row", () => {
    const ev = event({ action: "updated", actor_name: "Dev", via_api_key: "Codex", after_state: { title: "Protect the login flow" }, changes: { priority: { old: "low", new: "high" } }, summary: "A complete explanation of why the priority changed" });
    setup(ev);
    expect(screen.getByTestId("step-actor")).toHaveTextContent("Dev · via Codex");
    expect(screen.getByText("Protect the login flow")).toBeVisible();
    expect(screen.getByText("Low → High")).toBeVisible();
    expect(screen.getByText(new Date(ev.created_at).toLocaleString())).toBeVisible();
    expect(screen.queryByText(ev.summary)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens and closes a labelled details region with the keyboard", async () => {
    const user = userEvent.setup();
    const summary = "Historical event evidence ".repeat(18).trim();
    setup(event({ action: "updated", summary }));
    const toggle = screen.getByRole("button", { name: "Details" });
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByRole("region", { name: "Event details" });
    expect(detail.id).toBe(toggle.getAttribute("aria-controls"));
    expect(within(detail).getByText(summary)).not.toHaveClass("truncate");
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Event details" })).not.toBeInTheDocument();
  });

  it("keeps the user's disclosure choice and control focus when the event changes", () => {
    const first = event({ action: "updated", summary: "First event evidence" });
    const { rerender } = setup(first);
    const toggle = screen.getByRole("button", { name: "Details" });
    toggle.focus();
    fireEvent.click(toggle);
    const next = event({ action: "updated", summary: "Second event evidence" });
    rerender(<StepPanel event={next} descriptor={describeEvent(next)} columnNames={{}} />);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByRole("region", { name: "Event details" });
    expect(within(detail).getByText("Second event evidence")).toBeVisible();
    expect(within(detail).queryByText("First event evidence")).not.toBeInTheDocument();
  });

  it("reveals every recorded change and an arbitrary acting role without truncation", () => {
    setup(event({ action: "updated", agent_id: "runner1", summary: "reserved card for role ux-pilot-9000", changes: { title: { old: "Before", new: "After" }, priority: { old: "low", new: "high" }, labels: { old: [], new: ["review"] }, status: { old: null, new: "operator-defined-phase" } } }));
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const detail = screen.getByRole("region", { name: "Event details" });
    expect(within(detail).getByText("— → operator-defined-phase")).toBeVisible();
    expect(within(detail).getByText("ux-pilot-9000")).toBeVisible();
  });

  it("reveals note changes alongside the section and linked card", () => {
    setup(event({ entity_type: "note", action: "updated", changes: { fields: ["content", "pinned"], card_id: "cardA", mode: "replace_section", anchor_heading: "Validation" } }), {}, { cardA: "Login flow" });
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const detail = screen.getByRole("region", { name: "Event details" });
    expect(within(detail).getByText("Section: Validation · On Login flow")).toBeVisible();
    expect(within(detail).getByText("Content")).toBeVisible();
    expect(within(detail).getByText("Pinned")).toBeVisible();
  });
});

describe("StepPanel — event attribution", () => {
  it.each(["card", "note", "column"] as const)("names the person before the action for %s events", (entity_type) => {
    setup(event({ entity_type, action: "updated", actor_name: "Dev" }));
    const actor = screen.getByTestId("step-actor");
    expect(actor).toHaveTextContent("Dev");
    const action = screen.getByText(entity_type === "note" ? "Note updated" : entity_type === "column" ? "Column" : "Updated");
    expect(actor.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the recorded API tool name without requiring a linked runner", () => {
    setup(event({ actor_name: "Dev", via_api_key: "Codex", agent_id: null }));
    expect(screen.getByTestId("step-actor")).toHaveTextContent("Dev · via Codex");
  });

  it("keeps owner and arbitrary API key attribution when runner metadata is unavailable", () => {
    setup(event({ actor_name: "Dev", via_api_key: "Custom design agent", agent_id: "unindexed-agent" }));
    expect(screen.getByTestId("step-actor")).toHaveTextContent("Dev · via Custom design agent");
  });

  it("uses the actor email when the display name is unavailable", () => {
    setup(event({ actor_name: null, actor_email: "dev@example.test" }));
    expect(screen.getByTestId("step-actor")).toHaveTextContent("dev@example.test");
  });

  it("retains the actor identifier when both name and email are unavailable", () => {
    setup(event({ actor_name: null, actor_email: null, actor_id: "user-123" }));
    expect(screen.getByTestId("step-actor")).toHaveTextContent("user-123");
  });

  it("keeps complete long attribution available while reserving room for the action", () => {
    const actorName = "A very long operator display name";
    const tool = "A custom tool with a long name";
    setup(event({ actor_name: actorName, via_api_key: tool }));
    expect(screen.getByTestId("step-actor")).toHaveAttribute("title", `${actorName} · via ${tool}`);
    expect(screen.getByText("Created")).toBeVisible();
  });
});

describe("StepPanel — move shows from → to column names", () => {
  it("resolves both column ids to names via columnNames", () => {
    setup(
      event({
        action: "moved",
        entity_id: "card2",
        after_state: { id: "card2", title: "Ship it", column_id: "col-b" } as never,
        changes: { column_id: { old: "col-a", new: "col-b" } },
      }),
      { "col-a": "Backlog", "col-b": "Active" },
    );
    // the detail line renders the resolved column names with a → separator
    expect(screen.getByText("Backlog → Active")).toBeInTheDocument();
  });

  it("falls back to the raw column id when no name is known", () => {
    setup(
      event({
        action: "moved",
        entity_id: "card2",
        changes: { column_id: { old: "col-a", new: "col-b" } },
      }),
      {},
    );
    expect(screen.getByText("col-a → col-b")).toBeInTheDocument();
  });
});

describe("StepPanel — update shows humanized changed-field chips", () => {
  it("uses theme-readable text for the action and delta while retaining the event tint", () => {
    setup(event({ action: "updated", changes: { priority: { old: "low", new: "high" } } }));
    const action = screen.getByText("Updated");
    const change = screen.getByTitle("Priority: Low → High");
    expect(action).toHaveClass("text-foreground");
    expect(action.style.color).toBe("");
    expect(change).toHaveClass("text-foreground");
    expect(change.style.color).toBe("");
    expect(change.style.background).toContain("--color-warning");
    expect(screen.getByText("Priority")).not.toHaveClass("opacity-75");
  });

  it("shows the actual priority and label changes from captured snapshots", () => {
    setup(event({
      action: "updated",
      changes: { fields: ["priority", "labels"] },
      before_state: { priority: "low", labels: ["triaged"] },
      after_state: { priority: "high", labels: ["ready", "release"] },
    }));
    expect(screen.getByText("Low → High")).toBeInTheDocument();
    expect(screen.getByText("triaged → ready, release")).toBeInTheDocument();
  });

  it("prefers explicit change pairs and preserves operator-defined status strings", () => {
    setup(event({
      action: "updated",
      changes: { status: { old: "awaiting-capacity", new: "ux-pilot-ready" } },
      before_state: { status: "earlier" },
      after_state: { status: "later" },
    }));
    expect(screen.getByText("awaiting-capacity → ux-pilot-ready")).toBeInTheDocument();
    expect(screen.queryByText("earlier → later")).not.toBeInTheDocument();
  });

  it("represents cleared values and omits unavailable or unchanged deltas", () => {
    setup(event({
      action: "updated",
      changes: { fields: ["labels", "status", "description"] },
      before_state: { labels: ["ready"], status: "waiting" },
      after_state: { labels: null, status: "waiting" },
    }));
    expect(screen.getByText("ready → —")).toBeInTheDocument();
    expect(screen.queryByText("waiting → waiting")).not.toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
  });

  it("keeps a long renamed title available on hover while bounding the preview row", () => {
    const oldTitle = "An unusually long original title ".repeat(8).trim();
    const newTitle = "A thoroughly revised historical title ".repeat(8).trim();
    setup(event({ action: "updated", changes: { title: { old: oldTitle, new: newTitle }, priority: { old: "low", new: "high" }, labels: { old: null, new: ["ready"] }, status: { old: null, new: "waiting" } } }));
    const titleChip = screen.getByTitle(`Title: ${oldTitle} → ${newTitle}`);
    expect(titleChip.className).toContain("max-w-72");
    expect(screen.getByText("+1")).toHaveAttribute("title", "Status: — → waiting");
  });

  it("renders one chip per changed field, humanized", () => {
    setup(
      event({
        action: "updated",
        entity_id: "card4",
        changes: {
          title: { old: "A", new: "B" },
          due_date: { old: null, new: "2026-02-01" },
          position: { old: 1, new: 2 },
        },
      }),
    );
    expect(screen.getByText("Title")).toBeInTheDocument();
    // underscores humanized to spaces; internal `position` excluded by descriptor
    expect(screen.getByText("Due date")).toBeInTheDocument();
    expect(screen.queryByText(/position/)).toBeNull();
  });
});

describe("StepPanel — dependency shows the edge", () => {
  it("names every explicit endpoint of a bulk dependency replacement", () => {
    setup(event({ action: "dependencies_replaced", entity_id: "cardA", changes: { depends_on_card_ids: ["cardB", "cardC"] } }), {}, { cardA: "Release", cardB: "API", cardC: "Web" });
    expect(screen.getByText("Release ↔ API, Web")).toBeInTheDocument();
  });

  it("does not invent an endpoint when dependencies are cleared", () => {
    setup(event({ action: "dependencies_replaced", entity_id: "cardA", changes: { depends_on_card_ids: [] }, summary: "cleared dependencies" }), {}, { cardA: "Release" });
    expect(screen.queryByText(/Release ↔/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("cleared dependencies")).toBeInTheDocument();
  });

  it("renders this card ↔ related card titles when resolvable", () => {
    setup(
      event({
        action: "dependency_added" as never,
        entity_id: "cardA",
        changes: { depends_on: "cardB" },
      }),
      {},
      { cardA: "Auth refactor", cardB: "Token rotation" },
    );
    expect(screen.getByText(/Auth refactor/)).toBeInTheDocument();
    expect(screen.getByText(/Token rotation/)).toBeInTheDocument();
  });

  it("falls back to ids when titles are unknown", () => {
    setup(
      event({
        action: "dependency_added" as never,
        entity_id: "cardA",
        changes: { depends_on: "cardB" },
      }),
    );
    expect(screen.getByText(/cardA/)).toBeInTheDocument();
    expect(screen.getByText(/cardB/)).toBeInTheDocument();
  });
});

describe("StepPanel — localized action verb + labels (i18n keys must exist)", () => {
  it("renders the localized verb for a known kind, not the raw action", () => {
    setup(event({ action: "updated", entity_id: "card9" }));
    // timeline.step.kind.card-update => "Updated" (EN). Locks the i18n key so a
    // missing key (which would fall back to the raw humanized action) regresses.
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.queryByText("updated")).toBeNull();
  });

  it("renders the localized 'Changed' label above the update chips", () => {
    setup(
      event({
        action: "updated",
        entity_id: "card9",
        changes: { title: { old: "A", new: "B" } },
      }),
    );
    expect(screen.getByText("Changed")).toBeInTheDocument();
  });

  it("renders the localized verb for a created card", () => {
    setup(event({ action: "created", entity_id: "card9" }));
    expect(screen.getByText("Created")).toBeInTheDocument();
  });
});

describe("StepPanel — note / board / other activity copy", () => {
  it("gives notes an action and historical title even after the live note is renamed", () => {
    setup(event({ entity_type: "note", action: "updated", entity_id: "note1", entity_title: "Current name", message_params: { note_title: "Decision at the time" }, changes: { fields: ["content"] } }));
    expect(screen.getByText("Note updated")).toBeInTheDocument();
    expect(screen.getByText("Decision at the time")).toBeInTheDocument();
    expect(screen.queryByText("Current name")).not.toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
  });

  it("shows the referenced card for card-scoped notes without substituting the note id", () => {
    setup(event({ entity_type: "note", entity_id: "note1", changes: { card_id: "cardA" }, message_params: { note_title: "Review evidence" } }), {}, { cardA: "Ship login" });
    expect(screen.getByText("On Ship login")).toBeInTheDocument();
    expect(screen.getByText("Review evidence")).toBeInTheDocument();
  });

  it("shows the section being edited while preserving the full event caption", () => {
    setup(event({ entity_type: "note", action: "updated", changes: { fields: ["content"], mode: "replace_section", anchor_heading: "Validation" }, summary: "Alice replaced the validation evidence", message_params: { note_title: "Decision log" } }));
    expect(screen.getByText("Section updated")).toBeInTheDocument();
    expect(screen.getByText("Section: Validation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Alice replaced the validation evidence")).toBeInTheDocument();
  });

  it("renders modern field arrays as useful localized names", async () => {
    await i18n.changeLanguage("es");
    setup(event({ action: "updated", changes: { fields: ["priority", "labels"] } }));
    expect(screen.getByText("Prioridad")).toBeInTheDocument();
    expect(screen.getByText("Etiquetas")).toBeInTheDocument();
    expect(screen.queryByText("fields")).not.toBeInTheDocument();
  });

  it("renders the summary sentence for a note event", () => {
    setup(
      event({
        entity_type: "note",
        action: "created",
        entity_id: "note1",
        summary: "Alice pinned a retro note about the outage",
      }),
    );
    expect(
      screen.getByText("Alice pinned a retro note about the outage"),
    ).toBeInTheDocument();
  });

  it("shows localized structured copy while preserving legacy fallback", async () => {
    await i18n.changeLanguage("es");
    setup(
      event({
        entity_type: "note",
        action: "created",
        entity_id: "note1",
        summary: "created note 'Retrospective'",
        message_key: "activity.note.created",
        message_params: { note_title: "Retrospective" },
      }),
    );

    expect(screen.getByText("creó la nota 'Retrospective'")).toBeInTheDocument();
    expect(screen.queryByText("created note 'Retrospective'")).toBeNull();
  });
});

describe("StepPanel — board-time context chips (Day N + time-jump gap)", () => {
  const T0 = "2026-01-01T00:00:00Z";

  it("shows a 'Day N' chip relative to the first event in the log", () => {
    setup(event({ created_at: "2026-01-04T06:00:00Z" }), {}, {}, { firstEventAt: T0 });
    expect(screen.getByTestId("step-day-chip")).toHaveTextContent("Day 4");
  });

  it("shows 'Day 1' when the event is on the same day as the first event", () => {
    setup(event({ created_at: T0 }), {}, {}, { firstEventAt: T0 });
    expect(screen.getByTestId("step-day-chip")).toHaveTextContent("Day 1");
  });

  it("renders no day chip when firstEventAt is not provided", () => {
    setup(event());
    expect(screen.queryByTestId("step-day-chip")).toBeNull();
  });

  it("shows an accent '+6d later' chip when the gap from the previous event is days", () => {
    setup(
      event({ created_at: "2026-01-07T00:00:00Z" }),
      {},
      {},
      { firstEventAt: T0, prevEventAt: T0 },
    );
    expect(screen.getByTestId("step-gap-chip")).toHaveTextContent("+6d later");
  });

  it("shows the gap chip at exactly the 1h threshold", () => {
    setup(
      event({ created_at: "2026-01-01T01:00:00Z" }),
      {},
      {},
      { firstEventAt: T0, prevEventAt: T0 },
    );
    expect(screen.getByTestId("step-gap-chip")).toHaveTextContent("+1h later");
  });

  it("hides the gap chip when the gap is under the threshold", () => {
    setup(
      event({ created_at: "2026-01-01T00:40:00Z" }),
      {},
      {},
      { firstEventAt: T0, prevEventAt: T0 },
    );
    expect(screen.queryByTestId("step-gap-chip")).toBeNull();
  });

  it("renders no gap chip for the first event (no prevEventAt)", () => {
    setup(event({ created_at: "2026-01-07T00:00:00Z" }), {}, {}, { firstEventAt: T0 });
    expect(screen.queryByTestId("step-gap-chip")).toBeNull();
  });

  it("renders the gap chip statically under reduced motion (never broken)", () => {
    setup(
      event({ created_at: "2026-01-07T00:00:00Z" }),
      {},
      {},
      { firstEventAt: T0, prevEventAt: T0, reducedMotion: true },
    );
    expect(screen.getByTestId("step-gap-chip")).toHaveTextContent("+6d later");
  });
});

describe("StepPanel — cross-fade frame (reflow-free by construction)", () => {
  it("keeps the FIXED height + testid on the static outer div, animating only an inner frame", () => {
    setup(event({ action: "created" }));
    const panel = screen.getByTestId("step-panel-overview");
    expect(panel.className).toMatch(/h-\[4\.5rem\]/);
    expect(panel.className).toContain("overflow-hidden");
    const frame = screen.getByTestId("step-panel-frame");
    expect(frame).not.toBe(panel);
    expect(panel.contains(frame)).toBe(true);
  });

  it("mounts the new step's content immediately when the event changes", () => {
    const first = event({
      action: "created",
      after_state: { id: "card1", title: "First step" } as never,
    });
    const { rerender } = setup(first);
    expect(screen.getByText("First step")).toBeInTheDocument();

    const second = event({
      action: "created",
      after_state: { id: "card1", title: "Second step" } as never,
    });
    rerender(
      <StepPanel event={second} descriptor={describeEvent(second)} columnNames={{}} />,
    );
    // popLayout mounts the incoming frame without waiting for the exit animation.
    expect(screen.getByText("Second step")).toBeInTheDocument();
  });

  it("renders a plain (instant-swap) frame under reduced motion", () => {
    setup(event({ action: "created" }), {}, {}, { reducedMotion: true });
    expect(screen.getByTestId("step-panel-frame")).toBeInTheDocument();
  });
});

describe("StepPanel — runner-role chip (summary-named role only)", () => {
  // The role is read from the event summary ("… for role <x>"), the only
  // trustworthy per-event signal (one agent serves all roles).
  const reservedFor = (role: string) =>
    event({
      action: "updated",
      entity_id: "cardZ",
      agent_id: "agent-7",
      summary: `reserved card 'Ship it' for role ${role}`,
    });

  it("shows the humanized role named in the summary", () => {
    setup(reservedFor("implementer"));
    expect(screen.getByTestId("step-role")).toHaveTextContent(/implementer/i);
  });

  it("passes ANY user-defined role through verbatim (roles are configs, not enumerated)", () => {
    setup(reservedFor("ux-pilot-9000"));
    expect(screen.getByTestId("step-role")).toHaveTextContent(/ux pilot 9000/i);
  });

  it("shows NO chip when the summary names no role (a plain move/update)", () => {
    setup(event({ action: "moved", entity_id: "cardZ", agent_id: "agent-7", summary: "moved card 'Ship it' to 'Done'" }));
    expect(screen.queryByTestId("step-role")).toBeNull();
  });

  it("shows NO chip for a human (no agent_id) even with a role summary", () => {
    setup(event({ action: "updated", entity_id: "cardZ", agent_id: null, summary: "reserved card 'Ship it' for role reviewer" }));
    expect(screen.queryByTestId("step-role")).toBeNull();
  });

  it("shows NO chip for a non-card event", () => {
    setup(event({ entity_type: "note", action: "created", agent_id: "agent-7", summary: "created note 'x' for role reviewer" }));
    expect(screen.queryByTestId("step-role")).toBeNull();
  });
});

it.each(["created", "deleted"] as const)("does not repeat the %s card summary", (action) => {
  const ev = event({ action, summary: "Recorded card change" });
  renderWithProviders(<StepPanel event={ev} descriptor={describeEvent(ev)} columnNames={{}} reducedMotion />);
  expect(screen.getAllByText("Recorded card change")).toHaveLength(1);
});
