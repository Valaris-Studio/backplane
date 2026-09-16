// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card } from "@/types/kanban";

const copyTextToClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text),
}));

import { KanbanCard } from "../KanbanCard";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-9",
    title: "Build the thing",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function renderCard(card: Card) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/kanban"
        element={<KanbanCard card={card} boardId="board-1" onClick={vi.fn()} />}
      />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
  );
}

beforeEach(() => {
  copyTextToClipboard.mockReset();
  copyTextToClipboard.mockResolvedValue(true);
});

describe("KanbanCard kebab menu — Copy link (regression: missing /kanban + unencoded id)", () => {
  it("copies the exact absolute board-tab URL via the shared clipboard helper", async () => {
    const user = userEvent.setup();
    renderCard(makeCard({ id: "card 9/x" }));

    await user.click(screen.getByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText(/copy link/i));

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/acme/boards/board-1/kanban?card=${encodeURIComponent("card 9/x")}`,
    );
  });

  it("shows link-copied confirmation only after the clipboard write resolves true", async () => {
    const user = userEvent.setup();
    renderCard(makeCard());
    await user.click(screen.getByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText(/copy link/i));
    expect(await screen.findByText(/link copied/i)).toBeInTheDocument();
  });

  it("shows no link-copied confirmation when the clipboard write resolves false", async () => {
    copyTextToClipboard.mockResolvedValue(false);
    const user = userEvent.setup();
    renderCard(makeCard());
    await user.click(screen.getByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText(/copy link/i));
    expect(screen.queryByText(/link copied/i)).not.toBeInTheDocument();
  });
});

describe("KanbanCard kebab menu — Copy ID", () => {
  it("copies the bare full card UUID, unencoded", async () => {
    const user = userEvent.setup();
    renderCard(makeCard({ id: "11111111-2222-3333-4444-555555555555" }));

    await user.click(screen.getByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText(/copy id/i));

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("shows id-copied confirmation distinct from link-copied", async () => {
    const user = userEvent.setup();
    renderCard(makeCard());
    await user.click(screen.getByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText(/copy id/i));
    expect(await screen.findByText(/id copied/i)).toBeInTheDocument();
    expect(screen.queryByText(/link copied/i)).not.toBeInTheDocument();
  });
});
