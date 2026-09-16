// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { TimelineScrubber } from "../TimelineScrubber";
import type { TimelineEvent } from "../../types";

// Controllable reduced-motion preference (jsdom's matchMedia stub always
// reports false) — drives the hover bubble's static-fallback path.
const { reducedMotionState } = vi.hoisted(() => ({
  reducedMotionState: { value: false },
}));
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => reducedMotionState.value,
}));

beforeEach(() => {
  reducedMotionState.value = false;
});

// TimelineScrubber is the index-based seek bar. These tests lock the two
// "time-aware" layers on top of it: (a) endpoint date labels + day-boundary
// hairlines derived from event created_at, and (b) ticks colored by the SAME
// describeEvent accent tokens the StepPanel uses, plus the micro-legend that
// teaches the mapping.

let seq = 0;
// created_at is intentionally timezone-NAIVE ("2026-01-01T12:00:00") so Date
// parses it as LOCAL time — day-boundary tests stay deterministic across TZs.
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
    entity_id: `card-${seq}`,
    action: "created",
    summary: "",
    changes: null,
    via_api_key: null,
    created_at: "2026-01-01T12:00:00",
    before_state: null,
    after_state: null,
    ...overrides,
  } as TimelineEvent;
}

function setup(
  events: TimelineEvent[],
  frameIndex = 0,
  extras: { flags?: number[]; onSeek?: (i: number) => void } = {},
) {
  renderWithProviders(
    <TimelineScrubber
      frameIndex={frameIndex}
      frameCount={events.length}
      events={events}
      columnNames={{}}
      onSeek={extras.onSeek ?? (() => {})}
      flags={extras.flags}
    />,
  );
}

function shortDate(iso: string, withYear = false) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(iso));
}

describe("TimelineScrubber — endpoint date labels", () => {
  it("renders the first and last event dates (short month+day, no year within one year)", () => {
    setup([
      event({ created_at: "2026-01-01T09:00:00" }),
      event({ created_at: "2026-01-05T10:00:00" }),
      event({ created_at: "2026-01-12T18:00:00" }),
    ]);
    expect(screen.getByTestId("scrubber-start-date")).toHaveTextContent(
      shortDate("2026-01-01T09:00:00"),
    );
    expect(screen.getByTestId("scrubber-end-date")).toHaveTextContent(
      shortDate("2026-01-12T18:00:00"),
    );
    // no year when the range stays within one calendar year
    expect(screen.getByTestId("scrubber-start-date").textContent).not.toMatch(/2026/);
  });

  it("includes the year on both labels when the range crosses years", () => {
    setup([
      event({ created_at: "2025-12-30T09:00:00" }),
      event({ created_at: "2026-01-02T10:00:00" }),
    ]);
    expect(screen.getByTestId("scrubber-start-date")).toHaveTextContent(
      shortDate("2025-12-30T09:00:00", true),
    );
    expect(screen.getByTestId("scrubber-end-date")).toHaveTextContent(
      shortDate("2026-01-02T10:00:00", true),
    );
  });

  it("renders no date labels for an empty board", () => {
    setup([]);
    expect(screen.queryByTestId("scrubber-start-date")).toBeNull();
    expect(screen.queryByTestId("scrubber-end-date")).toBeNull();
  });

  it("renders no date labels for a single-event board (no range to read)", () => {
    setup([event()]);
    expect(screen.queryByTestId("scrubber-start-date")).toBeNull();
    expect(screen.queryByTestId("scrubber-end-date")).toBeNull();
  });
});

describe("TimelineScrubber — day-boundary markers", () => {
  it("emits one hairline per calendar-day crossing", () => {
    setup([
      event({ created_at: "2026-01-01T09:00:00" }),
      event({ created_at: "2026-01-01T17:00:00" }),
      event({ created_at: "2026-01-02T08:00:00" }), // crossing #1
      event({ created_at: "2026-01-02T12:00:00" }),
      event({ created_at: "2026-01-04T12:00:00" }), // crossing #2 (gap days collapse to one)
    ]);
    expect(screen.getAllByTestId("scrubber-day-boundary")).toHaveLength(2);
  });

  it("emits none when every event falls on the same day", () => {
    setup([
      event({ created_at: "2026-01-01T09:00:00" }),
      event({ created_at: "2026-01-01T23:00:00" }),
    ]);
    expect(screen.queryByTestId("scrubber-day-boundary")).toBeNull();
  });

  it("caps dense multi-month logs to at most 30 markers via stride-thinning", () => {
    const events = Array.from({ length: 80 }, (_, day) =>
      event({
        created_at: `2026-0${Math.floor(day / 28) + 1}-${String((day % 28) + 1).padStart(2, "0")}T12:00:00`,
      }),
    );
    setup(events);
    const markers = screen.getAllByTestId("scrubber-day-boundary");
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.length).toBeLessThanOrEqual(30);
  });

  it("paints boundaries as muted hairlines (token-based, low alpha)", () => {
    setup([
      event({ created_at: "2026-01-01T09:00:00" }),
      event({ created_at: "2026-01-02T09:00:00" }),
    ]);
    const marker = screen.getAllByTestId("scrubber-day-boundary")[0]!;
    expect(marker.className).toContain("--color-muted-foreground");
    expect(marker.className).toMatch(/opacity-/);
  });
});

describe("TimelineScrubber — story-arc tick colors (describeEvent accents)", () => {
  it("colors ticks by step kind: create=success, delete=destructive, update=warning, move=info", () => {
    setup(
      [
        event({ action: "created" }),
        event({ action: "deleted" }),
        event({ action: "updated" }),
        event({
          action: "moved",
          changes: { column_id: { old: "a", new: "b" } },
        }),
      ],
      // park the playhead PAST the ticks under test so none get the primary override
      3,
    );
    const ticks = screen.getAllByTestId("scrubber-event-tick");
    expect(ticks[0]!.style.backgroundColor).toContain("--color-success");
    expect(ticks[1]!.style.backgroundColor).toContain("--color-destructive");
    expect(ticks[2]!.style.backgroundColor).toContain("--color-warning");
    // the current frame's tick stays the primary playhead color
    expect(ticks[3]!.style.backgroundColor).toContain("--color-primary");
  });

  it("keeps non-card structural events on neutral/structure tokens (no false story color)", () => {
    setup(
      [
        event({ entity_type: "column", action: "created", entity_id: "col1" }),
        event({ entity_type: "note", action: "created", entity_id: "note1" }),
      ],
      1,
    );
    const ticks = screen.getAllByTestId("scrubber-event-tick");
    expect(ticks[0]!.style.backgroundColor).toContain("--color-data-4");
  });
});

// jsdom rects are all-zero; give the range input a real geometry so the hover
// math (track inset = 4px each side) resolves to deterministic indices.
function primeSliderRect(slider: HTMLElement, width = 208) {
  slider.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: width,
      bottom: 24,
      width,
      height: 24,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function hoverAt(slider: HTMLElement, clientX: number, pointerType = "mouse") {
  fireEvent.pointerMove(slider, { clientX, pointerType });
}

describe("TimelineScrubber — hover preview bubble", () => {
  const threeEvents = () => [
    event({ summary: "First thing happened", created_at: "2026-01-01T09:30:00" }),
    event({ action: "deleted", summary: "Second thing happened" }),
    event({ summary: "Third thing happened" }),
  ];

  it("shows no bubble before any pointer interaction", () => {
    setup(threeEvents());
    expect(screen.queryByTestId("scrubber-hover-preview")).toBeNull();
  });

  it("shows the hovered event's caption, accent dot, and local date+time on pointer move", () => {
    setup(threeEvents());
    const slider = screen.getByRole("slider");
    primeSliderRect(slider);
    // track spans x=4..204; x=4 is the first event
    hoverAt(slider, 4);
    const bubble = screen.getByTestId("scrubber-hover-preview");
    expect(bubble).toHaveTextContent("First thing happened");
    expect(
      screen.getByTestId("scrubber-hover-dot").style.backgroundColor,
    ).toContain("--color-success");
    const expectedTime = new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date("2026-01-01T09:30:00"));
    expect(screen.getByTestId("scrubber-hover-time")).toHaveTextContent(
      expectedTime,
    );
  });

  it("tracks the cursor to the nearest event index (right edge = last event)", () => {
    setup(threeEvents());
    const slider = screen.getByRole("slider");
    primeSliderRect(slider);
    hoverAt(slider, 204);
    expect(screen.getByTestId("scrubber-hover-preview")).toHaveTextContent(
      "Third thing happened",
    );
    expect(
      screen.getByTestId("scrubber-hover-dot").style.backgroundColor,
    ).toContain("--color-success");
  });

  it("uses the hovered event's kind accent for the dot (delete = destructive)", () => {
    setup(threeEvents());
    const slider = screen.getByRole("slider");
    primeSliderRect(slider);
    hoverAt(slider, 104); // midpoint → index 1 (deleted)
    expect(
      screen.getByTestId("scrubber-hover-dot").style.backgroundColor,
    ).toContain("--color-destructive");
  });

  it("clears the bubble on pointer leave", () => {
    setup(threeEvents());
    const slider = screen.getByRole("slider");
    primeSliderRect(slider);
    hoverAt(slider, 4);
    expect(screen.getByTestId("scrubber-hover-preview")).toBeInTheDocument();
    fireEvent.pointerLeave(slider);
    expect(screen.queryByTestId("scrubber-hover-preview")).toBeNull();
  });

  it("ignores touch pointers (no bubble under a finger)", () => {
    setup(threeEvents());
    const slider = screen.getByRole("slider");
    primeSliderRect(slider);
    hoverAt(slider, 4, "touch");
    expect(screen.queryByTestId("scrubber-hover-preview")).toBeNull();
  });

  it("still renders the bubble content under reduced motion (static fallback)", () => {
    reducedMotionState.value = true;
    setup(threeEvents());
    const slider = screen.getByRole("slider");
    primeSliderRect(slider);
    hoverAt(slider, 4);
    expect(screen.getByTestId("scrubber-hover-preview")).toHaveTextContent(
      "First thing happened",
    );
  });

  it("drops the dead title tooltips from the pointer-events-none ticks", () => {
    setup(threeEvents());
    for (const tick of screen.getAllByTestId("scrubber-event-tick")) {
      expect(tick).not.toHaveAttribute("title");
    }
  });
});

describe("TimelineScrubber — playback glide (progress fill + active tick)", () => {
  it("the progress fill transitions width with a motion-reduce fallback", () => {
    setup([event(), event(), event()], 1);
    const fill = screen.getByTestId("scrubber-progress-fill");
    expect(fill.className).toContain("transition-[width]");
    expect(fill.className).toContain("motion-reduce:transition-none");
  });

  it("the active tick grows via transform scale (not a width swap), with motion-reduce fallback", () => {
    setup([event(), event(), event()], 1);
    const ticks = screen.getAllByTestId("scrubber-event-tick");
    expect(ticks[1]!.className).toMatch(/scale-x-150/);
    expect(ticks[1]!.className).toMatch(/scale-y-125/);
    expect(ticks[1]!.className).toContain("transition-transform");
    expect(ticks[1]!.className).toContain("motion-reduce:transition-none");
    expect(ticks[0]!.className).not.toMatch(/scale-x-150/);
  });
});

describe("TimelineScrubber — flag dots", () => {
  const fiveEvents = () =>
    Array.from({ length: 5 }, (_, i) =>
      event({ summary: `Event number ${i}`, created_at: "2026-01-01T12:00:00" }),
    );

  it("renders no dots without flags", () => {
    setup(fiveEvents());
    expect(screen.queryByTestId("scrubber-flag-dot")).toBeNull();
    setup(fiveEvents(), 0, { flags: [] });
    expect(screen.queryByTestId("scrubber-flag-dot")).toBeNull();
  });

  it("renders one clickable dot per flagged index, positioned along the track", () => {
    setup(fiveEvents(), 0, { flags: [0, 2, 4] });
    const dots = screen.getAllByTestId("scrubber-flag-dot");
    expect(dots).toHaveLength(3);
    expect(dots[0]!.style.left).toBe("0%");
    expect(dots[1]!.style.left).toBe("50%");
    expect(dots[2]!.style.left).toBe("100%");
  });

  it("clicking a dot seeks to its event index", () => {
    const onSeek = vi.fn();
    setup(fiveEvents(), 0, { flags: [2], onSeek });
    fireEvent.click(screen.getByTestId("scrubber-flag-dot"));
    expect(onSeek).toHaveBeenCalledWith(2);
  });

  it("hovering a dot shows the event preview bubble", () => {
    setup(fiveEvents(), 0, { flags: [3] });
    fireEvent.pointerEnter(screen.getByTestId("scrubber-flag-dot"));
    expect(screen.getByTestId("scrubber-hover-preview")).toHaveTextContent(
      "Event number 3",
    );
  });

  it("dims the story ticks while flags are active so the dots pop", () => {
    setup(fiveEvents(), 0, { flags: [1] });
    const ticks = screen.getAllByTestId("scrubber-event-tick");
    // the current frame's tick keeps its emphasis; the rest fade back
    expect(ticks[2]!.className).toMatch(/opacity-2\d/);
  });

  it("stride-thins past the dot cap so dense matches don't turn to mud", () => {
    const events = Array.from({ length: 400 }, () => event());
    setup(events, 0, { flags: events.map((_, i) => i) });
    expect(screen.getAllByTestId("scrubber-flag-dot").length).toBeLessThanOrEqual(120);
  });
});

describe("TimelineScrubber — micro-legend", () => {
  it("renders the legend intro plus the four kind labels from timeline.step.kind.*", () => {
    setup([event(), event({ created_at: "2026-01-02T12:00:00" })]);
    const legend = screen.getByTestId("scrubber-legend");
    expect(legend).toHaveTextContent("Created");
    expect(legend).toHaveTextContent("Deleted");
    expect(legend).toHaveTextContent("Updated");
    expect(legend).toHaveTextContent("Moved");
  });

  it("legend dots use the same accent tokens as the ticks", () => {
    setup([event()]);
    const legend = screen.getByTestId("scrubber-legend");
    const html = legend.innerHTML;
    for (const token of [
      "--color-success",
      "--color-destructive",
      "--color-warning",
      "--color-info",
    ]) {
      expect(html).toContain(token);
    }
  });
});


describe("TimelineScrubber — context and identity", () => {
  it("preserves a rare note between sampled card ticks in a dedicated context lane", () => {
    const events = Array.from({ length: 500 }, () => event());
    events[123] = event({ entity_type: "note", action: "updated", summary: "Decision revised" });
    const onSeek = vi.fn();
    setup(events, 0, { onSeek });
    const marker = screen.getByTestId("scrubber-context-event");
    expect(marker).toHaveAccessibleName(/Decision revised/);
    fireEvent.click(marker);
    expect(onSeek).toHaveBeenCalledWith(123);
  });

  it("colors match markers by actor and provides preview on keyboard focus", () => {
    setup([event({ actor_id: "alice" }), event({ actor_id: "bob" })], 0, { flags: [0, 1] });
    const dots = screen.getAllByTestId("scrubber-flag-dot");
    expect(dots[0]!.style.backgroundColor).not.toBe("");
    expect(dots[0]!.style.backgroundColor).not.toBe(dots[1]!.style.backgroundColor);
    fireEvent.focus(dots[1]!);
    expect(screen.getByTestId("scrubber-hover-preview")).toBeInTheDocument();
  });

  it("announces the current event and disables an empty scrubber", () => {
    setup([]);
    expect(screen.getByRole("slider")).toBeDisabled();
    expect(screen.getByText("Event 0 of 0")).toBeInTheDocument();
  });
});

describe("TimelineScrubber — dense context bursts", () => {
  it("groups neighboring context events without dropping any from the count", () => {
    const events = Array.from({ length: 5000 }, () => event());
    for (let index = 50; index < 100; index += 1) events[index] = event({ entity_type: "note", summary: `Note ${index}` });
    const onSeek = vi.fn();
    setup(events, 0, { onSeek });
    const markers = screen.getAllByTestId("scrubber-context-event");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveAccessibleName(/50 events/);
    fireEvent.click(markers[0]!);
    expect(onSeek).toHaveBeenCalledWith(50);
  });

  it.each(["hover", "focus"])("keeps the %s preview aligned with the next grouped target through cycling and wrap", (interaction) => {
    const events = Array.from({ length: 500 }, () => event());
    for (const index of [50, 51, 52]) events[index] = event({ entity_type: "note", summary: `Note ${index}` });
    function ControlledScrubber() {
      const [frameIndex, setFrameIndex] = useState(0);
      return <TimelineScrubber frameIndex={frameIndex} frameCount={events.length} events={events} columnNames={{}} onSeek={setFrameIndex} />;
    }
    renderWithProviders(<ControlledScrubber />);
    const marker = screen.getByTestId("scrubber-context-event");
    if (interaction === "hover") fireEvent.pointerEnter(marker);
    else fireEvent.focus(marker);
    expect(screen.getByTestId("scrubber-hover-preview")).toHaveTextContent("Note 50");
    for (const [selected, next] of [[50, 51], [51, 52], [52, 50]]) {
      fireEvent.click(marker);
      expect(screen.getByRole("slider")).toHaveValue(String(selected));
      expect(marker).toHaveAccessibleName(`3 events · Next: Note ${next}`);
      expect(screen.getByTestId("scrubber-hover-preview")).toHaveTextContent(`Note ${next}`);
    }
    fireEvent.change(screen.getByRole("slider"), { target: { value: "50" } });
    expect(screen.getByTestId("scrubber-hover-preview")).toHaveTextContent("Note 51");
  });
});
