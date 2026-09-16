// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { BudgetPanel } from "../BudgetPanel";
import type { BudgetStatus } from "../../api/agents";

describe("BudgetPanel", () => {
  it("displays budget status with progress bar", async () => {
    const status: BudgetStatus = {
      budget_usd: 100,
      spent_usd: 30,
      remaining_usd: 70,
      percentage_used: 30,
      is_exceeded: false,
    };
    server.use(
      http.get("/api/agents/agent-1/budget-status", () =>
        HttpResponse.json(status),
      ),
    );

    renderWithProviders(<BudgetPanel agentId="agent-1" slug="test-ws" />);

    await waitFor(() => {
      expect(screen.getByText("$30.00 / $100.00")).toBeInTheDocument();
    });

    expect(screen.getByText("$70.00")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows no budget badge when budget is null", async () => {
    const status: BudgetStatus = {
      budget_usd: null,
      spent_usd: 5,
      remaining_usd: null,
      percentage_used: null,
      is_exceeded: false,
    };
    server.use(
      http.get("/api/agents/agent-2/budget-status", () =>
        HttpResponse.json(status),
      ),
    );

    renderWithProviders(<BudgetPanel agentId="agent-2" slug="test-ws" />);

    await waitFor(() => {
      expect(screen.getByText("No budget set")).toBeInTheDocument();
    });

    // No progress bar when budget is null
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows exceeded badge when budget is exceeded", async () => {
    const status: BudgetStatus = {
      budget_usd: 10,
      spent_usd: 15,
      remaining_usd: 0,
      percentage_used: 150,
      is_exceeded: true,
    };
    server.use(
      http.get("/api/agents/agent-3/budget-status", () =>
        HttpResponse.json(status),
      ),
    );

    renderWithProviders(<BudgetPanel agentId="agent-3" slug="test-ws" />);

    await waitFor(() => {
      expect(screen.getByText("Budget exceeded")).toBeInTheDocument();
    });
  });

  it("renders the budget.usage RichTooltip summary on the title", async () => {
    const status: BudgetStatus = {
      budget_usd: 100,
      spent_usd: 30,
      remaining_usd: 70,
      percentage_used: 30,
      is_exceeded: false,
    };
    server.use(
      http.get("/api/agents/agent-usage/budget-status", () =>
        HttpResponse.json(status),
      ),
    );

    renderWithProviders(<BudgetPanel agentId="agent-usage" slug="ws" />);

    const titleTrigger = await screen.findByText("Budget Status");
    await userEvent.hover(titleTrigger.parentElement!);

    await waitFor(() => {
      expect(
        screen.getByText(/Cumulative USD this runner has spent/i),
      ).toBeInTheDocument();
    });
  });

  it("opens budget.exceeded modal when the exceeded chip is clicked", async () => {
    const status: BudgetStatus = {
      budget_usd: 10,
      spent_usd: 15,
      remaining_usd: 0,
      percentage_used: 150,
      is_exceeded: true,
    };
    server.use(
      http.get("/api/agents/agent-exceeded/budget-status", () =>
        HttpResponse.json(status),
      ),
    );

    renderWithProviders(<BudgetPanel agentId="agent-exceeded" slug="ws" />);

    const exceededBadge = await screen.findByText("Budget exceeded");
    await userEvent.click(exceededBadge.parentElement!);

    await waitFor(() => {
      expect(screen.getByTestId("rt-backdrop")).toBeInTheDocument();
    });
    expect(
      screen.getAllByText(/Budget exceeded means new claims refuse/i).length,
    ).toBeGreaterThan(0);
  });

  it("shows skeleton while loading", () => {
    // Don't set up any MSW handler so it stays loading
    server.use(
      http.get("/api/agents/agent-4/budget-status", () => {
        return new Promise(() => {}); // Never resolves
      }),
    );

    renderWithProviders(<BudgetPanel agentId="agent-4" slug="test-ws" />);

    // Should not crash and should show loading state
    expect(screen.queryByText("Budget Status")).not.toBeInTheDocument();
  });
});
