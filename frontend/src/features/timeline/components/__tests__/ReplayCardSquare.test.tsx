// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ReplayCardSquare } from "../ReplayCardSquare";
import type { CardSnapshot, FrameCard, ParticipantSnapshot } from "../../types";

// ReplayCardSquare is the VERY compact tile: a 1-line ellipsis title, a card-type
// tint, a priority dot and ONE holder avatar with +N overflow. Same read-only
// select + keyboard + data-replay-card contract as ReplayCard, plus the optional
// spotlight prop (glow/ring/burst) so the spotlight engine works in compact mode.

function participant(overrides: Partial<ParticipantSnapshot> = {}): ParticipantSnapshot {
  return {
    user_id: "u1",
    agent_id: null,
    name: "Alice Doe",
    role: "hero",
    avatar_url: null,
    ...overrides,
  };
}

function cardSnapshot(overrides: Partial<CardSnapshot> = {}): CardSnapshot {
  return {
    id: "card1",
    title: "Login crashes on submit",
    card_type: "bug",
    priority: "high",
    column_id: "col1",
    position: 1024,
    status: "in_progress",
    labels: ["auth"],
    participants: [participant()],
    ...overrides,
  };
}

function frameCard(overrides: Partial<CardSnapshot> = {}, legacy = false): FrameCard {
  return { snapshot: cardSnapshot(overrides), legacy };
}

function setup(card: FrameCard, props: Partial<Parameters<typeof ReplayCardSquare>[0]> = {}) {
  const onClick = props.onClick ?? vi.fn();
  renderWithProviders(
    <ReplayCardSquare
      card={card}
      selected={props.selected ?? false}
      onClick={onClick}
      reducedMotion={props.reducedMotion ?? true}
      spotlight={props.spotlight}
    />,
  );
  return { onClick };
}

describe("ReplayCardSquare — content", () => {
  it("renders the title (trimmed to one line) and exposes the full title via title=", () => {
    setup(frameCard());
    expect(screen.getByText("Login crashes on submit")).toBeInTheDocument();
    // the full title is reachable as a tooltip for the truncated text.
    expect(screen.getByTitle("Login crashes on submit")).toBeInTheDocument();
  });

  it("renders an 'untitled' placeholder when the snapshot title is empty", () => {
    setup(frameCard({ title: "", labels: null, participants: [] }, true));
    expect(screen.queryByText("Login crashes on submit")).toBeNull();
    expect(screen.getByText(/untitled/i)).toBeInTheDocument();
  });

  it("renders ONE holder avatar and a +N overflow count for extra holders", () => {
    setup(
      frameCard({
        participants: [
          participant({ user_id: "u1", name: "Alice Doe" }),
          participant({ user_id: "u2", name: "Bob Stone" }),
          participant({ user_id: "u3", name: "Cara Lin" }),
        ],
      }),
    );
    // exactly one avatar (first holder, initials AD); the rest collapse to +2.
    expect(screen.getByText("AD")).toBeInTheDocument();
    expect(screen.queryByText("BS")).toBeNull();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("renders an invented card_type / priority without enumerating (role-agnostic)", () => {
    setup(frameCard({ card_type: "spike", priority: "p0", participants: [] }));
    // no crash, no 'unknown' placeholder — the tile renders the opaque values.
    expect(screen.getByText("Login crashes on submit")).toBeInTheDocument();
  });
});

describe("ReplayCardSquare — read-only selection", () => {
  it("carries the data-replay-card attribute with the card id", () => {
    setup(frameCard());
    expect(document.querySelector('[data-replay-card="card1"]')).not.toBeNull();
  });

  it("clicking the tile invokes onClick (selection only)", async () => {
    const user = userEvent.setup();
    const { onClick } = setup(frameCard());
    await user.click(screen.getByText("Login crashes on submit"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("pressing Enter or Space selects the tile", async () => {
    const user = userEvent.setup();
    const { onClick } = setup(frameCard());
    const tile = screen.getByRole("button");
    tile.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("exposes NO mutation affordances (no kebab, no combobox)", () => {
    setup(frameCard());
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("ReplayCardSquare — spotlight", () => {
  // Emphasis is a box-shadow inline style (NOT a border/ring class) so toggling
  // it never reflows the tile. The active spotlight threads the accent token in.
  it("applies an accent box-shadow when the spotlight is active", () => {
    setup(frameCard(), {
      spotlight: { active: true, accentToken: "--color-success", burst: false },
    });
    const tile = screen.getByRole("button");
    expect(tile.style.boxShadow).toContain("--color-success");
  });

  it("applies NO accent box-shadow when there is no spotlight", () => {
    setup(frameCard());
    const tile = screen.getByRole("button");
    expect(tile.style.boxShadow).not.toContain("--color-success");
  });

  it("applies NO accent box-shadow when the spotlight is inactive", () => {
    setup(frameCard(), {
      spotlight: { active: false, accentToken: "--color-success", burst: false },
    });
    const tile = screen.getByRole("button");
    expect(tile.style.boxShadow).not.toContain("--color-success");
  });

  it("shows a compact actor avatar (tooltip = name · role) when spotlighted with an actor", () => {
    setup(frameCard(), {
      spotlight: {
        active: true,
        accentToken: "--color-info",
        burst: false,
        actor: { name: "Runner Bot", avatarUrl: null, role: "implementer" },
      },
    });
    const badge = document.querySelector("[data-testid='spotlight-actor']") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("title") ?? "").toContain("Runner Bot");
    expect((badge.getAttribute("title") ?? "").toLowerCase()).toContain("implementer");
  });

  it("shows NO actor badge when the actor is unknown", () => {
    setup(frameCard(), {
      spotlight: { active: true, accentToken: "--color-info", burst: false, actor: null },
    });
    expect(document.querySelector("[data-testid='spotlight-actor']")).toBeNull();
  });
});
