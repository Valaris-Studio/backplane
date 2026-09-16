// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import { KanbanCard } from "../KanbanCard";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
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

// The active-state link uses useParams; route-shape the test so it resolves.
function renderKanban(card: Card, initialEntry = "/acme/boards/b-1") {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/*" element={<KanbanCard card={card} boardId="b1" onClick={vi.fn()} />} />
    </Routes>,
    { routerProps: { initialEntries: [initialEntry] } },
  );
}

describe("KanbanCard — agent-presence state", () => {
  it("renders no robot when agent_presence is 'none'", () => {
    const { container } = renderKanban(makeCard({ agent_presence: "none" }));
    expect(container.querySelector(".lucide-bot")).toBeNull();
  });

  it("renders no robot when agent_presence is missing", () => {
    const { container } = renderKanban(makeCard());
    expect(container.querySelector(".lucide-bot")).toBeNull();
  });

  it("renders a muted robot with the eligible tooltip when 'eligible'", async () => {
    const user = userEvent.setup();
    const { container } = renderKanban(
      makeCard({ agent_presence: "eligible" }),
    );

    const bot = container.querySelector(".lucide-bot");
    expect(bot).not.toBeNull();
    expect(bot?.classList.contains("animate-pulse")).toBe(false);
    expect(bot?.getAttribute("class")).toMatch(/text-muted-foreground/);

    await user.hover(bot!.closest('[role="button"]') as Element);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/runner could work this card/i);
  });

  it("renders a touched-variant robot with relative-time tooltip when 'touched'", async () => {
    const user = userEvent.setup();
    const when = "2026-04-10T09:30:00Z";
    const { container } = renderKanban(
      makeCard({ agent_presence: "touched", last_agent_activity_at: when }),
    );

    const bot = container.querySelector(".lucide-bot");
    expect(bot).not.toBeNull();
    expect(bot?.classList.contains("animate-pulse")).toBe(false);

    await user.hover(bot!.closest('[role="button"]') as Element);
    const tooltip = await screen.findByRole("tooltip");
    // The rendered `when` is locale-dependent — just check a stable token.
    expect(tooltip.textContent).toMatch(/last worked/i);
    expect(tooltip.textContent).toMatch(/2026/);
  });

  it("renders a distinct paused badge (not pulsing, not 'active') when 'suspended'", async () => {
    // A budget-suspended card is parked mid-implementation. It must read as
    // PAUSED at a glance — never the pulsing "working" robot, and visually
    // distinct from a plain touched/eligible robot so the operator doesn't
    // have to decode it.
    const user = userEvent.setup();
    const { container } = renderKanban(
      makeCard({ agent_presence: "suspended", labels: ["budget-suspended"] }),
    );

    const bot = container.querySelector(".lucide-bot");
    expect(bot).not.toBeNull();
    expect(bot?.classList.contains("animate-pulse")).toBe(false);
    expect(bot?.getAttribute("class")).not.toMatch(/text-primary\b/);

    await user.hover(bot!.closest('[role="button"]') as Element);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/suspend/i);
  });

  it("does NOT highlight the card body as active for a 'suspended' card", () => {
    const { container } = renderKanban(
      makeCard({ agent_presence: "suspended", labels: ["budget-suspended"] }),
    );
    const root = container.querySelector("[data-card-root]");
    expect(root?.getAttribute("data-agent-active")).not.toBe("true");
  });

  it("renders a pulsing primary robot with active tooltip when 'active'", async () => {
    const user = userEvent.setup();
    const { container } = renderKanban(
      makeCard({ agent_presence: "active", active_execution_id: "exec-42" }),
    );

    const bot = container.querySelector(".lucide-bot");
    expect(bot).not.toBeNull();
    expect(bot?.classList.contains("animate-pulse")).toBe(true);
    expect(bot?.getAttribute("class")).toMatch(/text-primary/);

    await user.hover(bot!.closest('[role="button"]') as Element);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/runner is executing a pipeline stage against this card/i);
  });

  it("highlights the card body itself when a runner is actively working it", () => {
    // The robot icon alone is easy to miss in a dense column; the card the
    // runner is working RIGHT NOW must stand out at a glance.
    const { container } = renderKanban(
      makeCard({ agent_presence: "active", active_execution_id: "exec-42" }),
    );
    const root = container.querySelector("[data-card-root]");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-agent-active")).toBe("true");
  });

  it("does NOT highlight the card body for a merely picked-up (touched/eligible) card", () => {
    const { container } = renderKanban(
      makeCard({ agent_presence: "touched", last_agent_activity_at: "2026-04-10T09:30:00Z" }),
    );
    const root = container.querySelector("[data-card-root]");
    expect(root?.getAttribute("data-agent-active")).not.toBe("true");
  });

  it("links the active robot to the execution detail route when active_execution_id is present", () => {
    const { container } = renderKanban(
      makeCard({ agent_presence: "active", active_execution_id: "exec-42" }),
    );

    const link = container.querySelector("a[href]");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/acme/runner/executions/exec-42");
  });

  it("falls back to the runners page when active but active_execution_id is missing", () => {
    const { container } = renderKanban(
      makeCard({ agent_presence: "active", active_execution_id: null }),
    );

    const link = container.querySelector("a[href]");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/acme/runner/overview");
  });
});
