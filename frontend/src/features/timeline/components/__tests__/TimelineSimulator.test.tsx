// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  within,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { TimelineSimulator } from "../TimelineSimulator";
import type {
  CardSnapshot,
  ColumnSnapshot,
  TimelineEvent,
  TimelineResponse,
} from "../../types";

const SLUG = "test-ws";
const BOARD = "board-1";
const URL = `/api/workspaces/${SLUG}/boards/${BOARD}/timeline`;

// ── fixture factories ─────────────────────────────────────────────────────────
let seq = 0;
function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    workspace_id: "ws1",
    board_id: BOARD,
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

function column(id: string, name: string, position: number): ColumnSnapshot {
  return { id, name, column_type: null, position };
}

function card(overrides: Partial<CardSnapshot> & { id: string }): CardSnapshot {
  return {
    title: overrides.id,
    card_type: "task",
    priority: "medium",
    column_id: null,
    position: 1024,
    status: null,
    labels: null,
    participants: [],
    ...overrides,
  };
}

function response(overrides: Partial<TimelineResponse> = {}): TimelineResponse {
  return {
    board_id: BOARD,
    generated_at: "2026-01-02T00:00:00Z",
    truncated: false,
    events: [],
    ...overrides,
  };
}

function mockTimeline(body: TimelineResponse) {
  server.use(http.get(URL, () => HttpResponse.json(body)));
}

function render() {
  return renderWithProviders(<TimelineSimulator slug={SLUG} boardId={BOARD} />);
}

// A minimal board log: column A + B created, a card created in A, then moved to B.
const COL_A = column("col-a", "Backlog", 1024);
const COL_B = column("col-b", "Active", 2048);

function boardLog(): TimelineEvent[] {
  return [
    event({ id: "e1", entity_type: "column", action: "created", entity_id: "col-a", after_state: COL_A }),
    event({ id: "e2", entity_type: "column", action: "created", entity_id: "col-b", after_state: COL_B }),
    event({
      id: "e3",
      action: "created",
      entity_id: "card1",
      summary: "Alice created card1",
      after_state: card({ id: "card1", title: "Login bug", column_id: "col-a" }),
      created_at: "2026-01-01T01:00:00Z",
    }),
    event({
      id: "e4",
      action: "moved",
      entity_id: "card1",
      summary: "Alice moved card1 from Backlog to Active",
      changes: { column_id: { old: "col-a", new: "col-b" } },
      after_state: card({ id: "card1", title: "Login bug", column_id: "col-b", position: 1024 }),
      created_at: "2026-01-01T02:00:00Z",
    }),
  ];
}

describe("TimelineSimulator — async states", () => {
  it("shows a loading skeleton before the timeline resolves", () => {
    server.use(
      http.get(URL, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json(response());
      }),
    );
    render();
    expect(screen.getByTestId("timeline-loading")).toBeInTheDocument();
  });

  it("shows an empty state when there are no events", async () => {
    mockTimeline(response({ events: [] }));
    render();
    await waitFor(() => {
      expect(screen.getByTestId("timeline-empty")).toBeInTheDocument();
    });
  });

  it("shows an error state with a retry control on a 500", async () => {
    server.use(http.get(URL, () => new HttpResponse(null, { status: 500 })));
    render();
    await waitFor(() => {
      expect(screen.getByTestId("timeline-error")).toBeInTheDocument();
    });
    // EmptyState's entrance cascade (GSAP autoAlpha) keeps the action invisible
    // for a few hundred ms — wait until the retry control becomes accessible.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });
});

describe("TimelineSimulator — board reconstruction + transport", () => {
  it("renders both columns once the log resolves", async () => {
    mockTimeline(response({ events: boardLog() }));
    render();
    await waitFor(() => {
      expect(screen.getByText("Backlog")).toBeInTheDocument();
    });
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("places the card in its origin column at frame 0, then in the target column after stepping", async () => {
    mockTimeline(response({ events: boardLog() }));
    render();

    // At the first meaningful frame the card lives in Backlog. The simulator
    // starts at frameIndex 0 (column created) — step forward to the card-created
    // frame, assert it's in Backlog, then to the moved frame, assert it's in Active.
    await waitFor(() => {
      expect(screen.getByText("Backlog")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const stepForward = screen.getByRole("button", { name: /next event/i });

    // advance frames until the card appears (created at e3)
    await user.click(stepForward); // -> e2
    await user.click(stepForward); // -> e3 (card created in col-a)

    await waitFor(() => {
      const backlog = screen.getByTestId("replay-column-col-a");
      expect(within(backlog).getByText("Login bug")).toBeInTheDocument();
    });

    await user.click(stepForward); // -> e4 (moved to col-b)

    await waitFor(() => {
      const active = screen.getByTestId("replay-column-col-b");
      expect(within(active).getByText("Login bug")).toBeInTheDocument();
    });
  });
});

describe("TimelineSimulator — StepPanel board-time wiring", () => {
  it("derives firstEventAt/prevEventAt so the step panel shows Day + gap chips", async () => {
    mockTimeline(response({ events: boardLog() }));
    render();
    await waitFor(() => {
      expect(screen.getByText("Backlog")).toBeInTheDocument();
    });

    // Frame 0 is the log's first event: Day 1, no previous event → no gap chip.
    expect(screen.getByTestId("step-day-chip")).toHaveTextContent("Day 1");
    expect(screen.queryByTestId("step-gap-chip")).toBeNull();

    const user = userEvent.setup();
    const stepForward = screen.getByRole("button", { name: /next event/i });
    await user.click(stepForward); // -> e2 (same instant as e1, gap 0)
    await user.click(stepForward); // -> e3 (1h after e2 → gap chip)

    await waitFor(() => {
      expect(screen.getByTestId("step-gap-chip")).toHaveTextContent("+1h later");
    });
  });
});

describe("TimelineSimulator — partial / truncated history notes", () => {
  it("shows a partial-history note when a legacy null-snapshot event is folded", async () => {
    const log: TimelineEvent[] = [
      event({ id: "p1", entity_type: "column", action: "created", entity_id: "col-a", after_state: COL_A }),
      // legacy card created with NO snapshot -> engine flags frame.partial
      event({ id: "p2", action: "created", entity_id: "legacy1", after_state: null, created_at: "2026-01-01T01:00:00Z" }),
    ];
    mockTimeline(response({ events: log }));
    render();
    await waitFor(() => {
      expect(screen.getByTestId("timeline-partial-note")).toBeInTheDocument();
    });
  });

  it("shows a truncated note when the backend capped the log", async () => {
    mockTimeline(response({ events: boardLog(), truncated: true }));
    render();
    await waitFor(() => {
      expect(screen.getByTestId("timeline-truncated-note")).toBeInTheDocument();
    });
  });
});

describe("TimelineSimulator — baseline (v1.1)", () => {
  // A legacy board: activity rows carry NO snapshots (pre-migration), so a pure
  // event-fold would render Untitled cards in an Unknown column. The baseline —
  // the board's CURRENT state — seeds the engine so real titles/columns render.
  function legacyLog(): TimelineEvent[] {
    return [
      event({
        id: "L1",
        action: "created",
        entity_id: "card1",
        after_state: null,
        created_at: "2026-01-01T01:00:00Z",
      }),
      event({
        id: "L2",
        action: "moved",
        entity_id: "card1",
        changes: { column_id: { old: "col-a", new: "col-b" } },
        after_state: null,
        created_at: "2026-01-01T02:00:00Z",
      }),
    ];
  }

  function baseline() {
    return {
      columns: [COL_A, COL_B],
      cards: [card({ id: "card1", title: "Login bug", column_id: "col-b" })],
    };
  }

  it("renders real card titles and column names (not Untitled/Unknown) when a baseline seeds the engine", async () => {
    mockTimeline(response({ events: legacyLog(), baseline: baseline() }));
    render();

    await waitFor(() => {
      expect(screen.getByText("Backlog")).toBeInTheDocument();
    });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Login bug")).toBeInTheDocument();
    expect(screen.queryByText("Untitled card")).toBeNull();
    expect(screen.queryByText("Unknown")).toBeNull();
  });

  it("still shows the limited-history note because legacy null-snapshot events were folded", async () => {
    mockTimeline(response({ events: legacyLog(), baseline: baseline() }));
    render();
    await waitFor(() => {
      expect(screen.getByTestId("timeline-partial-note")).toBeInTheDocument();
    });
  });

  it("renders the board (not the empty state) when there are no events but the baseline has cards", async () => {
    mockTimeline(response({ events: [], baseline: baseline() }));
    render();

    await waitFor(() => {
      expect(screen.getByText("Login bug")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("timeline-empty")).toBeNull();
  });

  it("still shows the empty state when there are no events AND no baseline cards", async () => {
    mockTimeline(
      response({ events: [], baseline: { columns: [COL_A], cards: [] } }),
    );
    render();
    await waitFor(() => {
      expect(screen.getByTestId("timeline-empty")).toBeInTheDocument();
    });
  });
});

describe("TimelineSimulator — read-only card detail", () => {
  it("opens a read-only detail panel with analytics when a card is clicked", async () => {
    mockTimeline(response({ events: boardLog() }));
    render();

    const user = userEvent.setup();
    await screen.findByTestId("replay-board");
    const stepForward = screen.getByRole("button", { name: /next event/i });
    await user.click(stepForward);
    await user.click(stepForward); // card now visible

    // "Login bug" now appears both on the board card and in the step panel's
    // entity title, so scope the query to the board region and click the card.
    const board = await screen.findByTestId("replay-board");
    const cardEl = within(board).getByText("Login bug");
    await user.click(cardEl);

    await waitFor(() => {
      expect(screen.getByTestId("timeline-card-detail")).toBeInTheDocument();
    });
    // analytics sections present; no edit affordances.
    const panel = screen.getByTestId("timeline-card-detail");
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /delete/i })).toBeNull();
  });
});

describe("TimelineSimulator — event flags", () => {
  it("typing a search flags matching events as scrubber dots with a count", async () => {
    mockTimeline(response({ events: boardLog() }));
    render();
    const user = userEvent.setup();
    const input = await screen.findByTestId("flag-search-input");
    await user.type(input, "login bug");
    // e3 (create, snapshot title) + e4 (move, snapshot title) match
    expect(screen.getByTestId("flag-count")).toHaveTextContent("2");
    expect(screen.getAllByTestId("scrubber-flag-dot")).toHaveLength(2);
  });

  it("flag next jumps the playhead to the following match", async () => {
    mockTimeline(response({ events: boardLog() }));
    render();
    const user = userEvent.setup();
    const input = await screen.findByTestId("flag-search-input");
    await user.type(input, "login bug");
    await user.click(screen.getByTestId("flag-next"));
    // playhead lands on e3 (index 2) — the scrubber readout reflects it
    expect(screen.getByText("Event 3 of 4")).toBeInTheDocument();
  });

  it("offers actor chips harvested from the log and never filters the board", async () => {
    mockTimeline(response({ events: boardLog() }));
    render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Filters" }));
    const chips = screen.getAllByTestId("flag-actor-chip");
    expect(chips[0]).toHaveTextContent("Alice");
    await user.click(chips[0]!);
    // all four events are Alice's → 4 flagged, board untouched
    expect(screen.getByTestId("flag-count")).toHaveTextContent("4");
    expect(screen.getByTestId("replay-board")).toBeInTheDocument();
  });
});

describe("TimelineSimulator — historical inspection", () => {
  it("keeps analytics at the playhead and pauses when opening a card", async () => {
    const events = boardLog();
    events.splice(3, 0, event({ entity_type: "note", entity_id: "n1", action: "updated", summary: "Reviewed design", created_at: "2026-01-01T01:30:00Z" }));
    mockTimeline(response({ events }));
    render();
    const user = userEvent.setup();
    await screen.findByTestId("replay-board");
    const slider = screen.getByRole("slider");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(slider, { target: { value: "3" } });
    await user.click(screen.getByRole("button", { name: /^play$/i }));
    await user.click(within(screen.getByTestId("replay-board")).getByText("Login bug"));
    const detail = await screen.findByTestId("timeline-card-detail");
    expect(within(detail).getByText("30m")).toBeInTheDocument();
    expect(within(detail).queryByText("Active")).toBeNull();
    expect(screen.getByRole("button", { name: /^play$/i, hidden: true })).toBeInTheDocument();
  });

  it("resolves baseline column names in historical card detail", async () => {
    mockTimeline(response({ events: [event({ after_state: card({ id: "card1", title: "Baseline card", column_id: "col-a" }) })], baseline: { columns: [COL_A], cards: [] } }));
    render();
    const user = userEvent.setup();
    const board = await screen.findByTestId("replay-board");
    await user.click(within(board).getByText("Baseline card"));
    const detail = await screen.findByTestId("timeline-card-detail");
    expect(within(detail).getByText(/Currently in Backlog/)).toBeInTheDocument();
  });
});

it("keeps actor-chip and marker colors aligned when some events have unnamed actors", async () => {
  mockTimeline(response({ events: [
    event({ actor_id: "u1", actor_name: null }),
    event({ actor_id: "u9", actor_name: "Bob" }),
  ] }));
  render();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Filters" }));
  const chip = screen.getByTestId("flag-actor-chip");
  await user.click(chip);
  const dot = screen.getByTestId("scrubber-flag-dot");
  expect(dot.style.backgroundColor).toBe(chip.style.getPropertyValue("--actor-accent"));
});


describe("TimelineSimulator — replay space", () => {
  it("reserves a usable board viewport independently of expanded controls", async () => {
    mockTimeline(response({ events: boardLog() }));
    render();
    const board = await screen.findByTestId("replay-board");
    expect(board.parentElement?.parentElement).toHaveClass("min-h-[24rem]");
    const controls = screen.getByTestId("timeline-controls");
    expect(controls).toHaveClass("shrink-0");
    expect(within(controls).getByRole("button", { name: /^play$/i })).toBeInTheDocument();
    expect(within(controls).getByRole("slider")).toBeInTheDocument();
    expect(within(controls).queryByTestId("replay-board")).toBeNull();
  });
});


it("pauses playback when opening the current event's full details", async () => {
  mockTimeline(response({ events: boardLog() }));
  render();
  const user = userEvent.setup();
  await screen.findByTestId("replay-board");
  await user.click(screen.getByRole("button", { name: /^play$/i }));
  expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByRole("region", { name: "Event details" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^play$/i })).toBeInTheDocument();
});
