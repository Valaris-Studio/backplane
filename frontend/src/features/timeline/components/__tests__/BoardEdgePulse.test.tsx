// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { BoardEdgePulse } from "../BoardEdgePulse";
import { describeEvent } from "../../utils/event-descriptor";
import type { TimelineEvent } from "../../types";

// BoardEdgePulse is a presentational overlay: it renders a soft accent edge
// light-sweep ONLY for off-board events (descriptor.touchesBoard === false) that
// are NOT column edits (column lanes are board chrome). Anything that touches the
// board, or a column event, renders nothing. Reduced-motion → a static thin line
// (no sweep animation). Keyed on the event id so each step re-triggers.

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

function setup(ev: TimelineEvent, reducedMotion = false) {
  renderWithProviders(
    <BoardEdgePulse
      eventId={ev.id}
      descriptor={describeEvent(ev)}
      reducedMotion={reducedMotion}
    />,
  );
}

const PULSE = "board-edge-pulse";

describe("BoardEdgePulse — renders for off-board non-column events", () => {
  it("renders for a note event (off-board, kind !== column)", () => {
    setup(event({ entity_type: "note", action: "created", entity_id: "note1" }));
    expect(screen.getByTestId(PULSE)).toBeInTheDocument();
  });

  it("renders for a dependency event (touchesBoard=false)", () => {
    setup(
      event({
        action: "dependency_added" as never,
        entity_id: "cardA",
        changes: { depends_on: "cardB" },
      }),
    );
    expect(screen.getByTestId(PULSE)).toBeInTheDocument();
  });

  it("renders for an 'other' event (unknown entity)", () => {
    setup(event({ entity_type: "resource" as never, action: "uploaded" }));
    expect(screen.getByTestId(PULSE)).toBeInTheDocument();
  });

  it("tints the sweep with the descriptor accent token", () => {
    setup(event({ entity_type: "note", action: "created", entity_id: "note1" }));
    const pulse = screen.getByTestId(PULSE);
    // accent token is referenced via a CSS custom property, never a literal color
    expect(pulse.outerHTML).toContain("--color-data-5");
  });
});

describe("BoardEdgePulse — renders nothing for board-touching or column events", () => {
  it("renders nothing for a card create (touchesBoard=true)", () => {
    setup(event({ action: "created", entity_id: "card1" }));
    expect(screen.queryByTestId(PULSE)).toBeNull();
  });

  it("renders nothing for a card move (touchesBoard=true)", () => {
    setup(
      event({
        action: "moved",
        entity_id: "card1",
        changes: { column_id: { old: "a", new: "b" } },
      }),
    );
    expect(screen.queryByTestId(PULSE)).toBeNull();
  });

  it("renders nothing for a column event (column lanes are board chrome)", () => {
    setup(event({ entity_type: "column", action: "moved", entity_id: "col1" }));
    expect(screen.queryByTestId(PULSE)).toBeNull();
  });
});

describe("BoardEdgePulse — reduced motion", () => {
  it("renders a static line (no animation) under reduced motion", () => {
    setup(event({ entity_type: "note", action: "created", entity_id: "note1" }), true);
    const pulse = screen.getByTestId(PULSE);
    expect(pulse).toHaveAttribute("data-static", "true");
  });

  it("renders an animated sweep when motion is allowed", () => {
    setup(event({ entity_type: "note", action: "created", entity_id: "note1" }), false);
    const pulse = screen.getByTestId(PULSE);
    expect(pulse).toHaveAttribute("data-static", "false");
  });
});
