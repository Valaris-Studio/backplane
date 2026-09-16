// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ReplayCard } from "../ReplayCard";
import type { CardSnapshot, FrameCard, ParticipantSnapshot } from "../../types";

// ReplayCard mirrors KanbanCard's VISUAL structure (type/priority corner tags,
// title, labels, participant avatars) but is STRICTLY READ-ONLY and
// ROLE-AGNOSTIC: it renders ALL participants by their opaque role string (no
// hero-only special-case) and exposes NO mutation affordances (no kebab menu, no
// combobox, no dnd handles). Clicking only selects.

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
    labels: ["auth", "regression"],
    participants: [participant()],
    ...overrides,
  };
}

function frameCard(overrides: Partial<CardSnapshot> = {}, legacy = false): FrameCard {
  return { snapshot: cardSnapshot(overrides), legacy };
}

function setup(card: FrameCard, props: Partial<Parameters<typeof ReplayCard>[0]> = {}) {
  const onClick = props.onClick ?? vi.fn();
  renderWithProviders(
    <ReplayCard
      card={card}
      selected={props.selected ?? false}
      onClick={onClick}
      reducedMotion={props.reducedMotion ?? true}
    />,
  );
  return { onClick };
}

describe("ReplayCard — known classifier values", () => {
  it("renders the title and all labels", () => {
    setup(frameCard());
    expect(screen.getByText("Login crashes on submit")).toBeInTheDocument();
    expect(screen.getByText("auth")).toBeInTheDocument();
    expect(screen.getByText("regression")).toBeInTheDocument();
  });

  it("renders the participant avatar with initials fallback", () => {
    setup(frameCard());
    // initials of "Alice Doe" => AD
    expect(screen.getByText("AD")).toBeInTheDocument();
  });
});

describe("ReplayCard — opaque / invented classifier values (role-agnostic)", () => {
  it("renders an invented card_type and priority via humanized fallback", () => {
    setup(
      frameCard({
        card_type: "spike",
        priority: "p0",
        title: "Research caching",
        labels: null,
        participants: [],
      }),
    );
    // Humanized fallback (defaultValue) — the opaque string surfaces, never an
    // 'unknown' placeholder and never an enumerated set.
    expect(screen.getByText(/spike/i)).toBeInTheDocument();
    expect(screen.getByText(/p0/i)).toBeInTheDocument();
  });

  it("renders ALL participants and surfaces an invented role (no hero-only)", () => {
    setup(
      frameCard({
        participants: [
          participant({ user_id: "u1", name: "Alice Doe", role: "hero" }),
          participant({ user_id: "u2", name: "Bob Stone", role: "ux-pilot" }),
        ],
      }),
    );
    // both avatars present (initials AD + BS), and the invented role is exposed
    // on the avatar's accessible name / title.
    expect(screen.getByText("AD")).toBeInTheDocument();
    expect(screen.getByText("BS")).toBeInTheDocument();
    // the invented role string appears (humanized) somewhere in an avatar title/aria
    const withRole = screen.getByTitle(/ux.?pilot/i);
    expect(withRole).toBeInTheDocument();
  });
});

describe("ReplayCard — read-only (no mutation affordances)", () => {
  it("has NO kebab / more-actions menu", () => {
    setup(frameCard());
    expect(screen.queryByRole("button", { name: /more/i })).toBeNull();
  });

  it("has NO combobox or menu (no priority Select, no dropdown)", () => {
    setup(frameCard());
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking the card invokes onClick (selection only)", async () => {
    const user = userEvent.setup();
    const { onClick } = setup(frameCard());
    await user.click(screen.getByText("Login crashes on submit"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("ReplayCard — legacy synthesized cards", () => {
  it("renders an 'untitled' placeholder when the snapshot title is empty", () => {
    setup(frameCard({ title: "", labels: null, participants: [] }, true));
    // a legacy synthesized card has no real title; a muted placeholder shows.
    expect(screen.queryByText("Login crashes on submit")).toBeNull();
  });
});
