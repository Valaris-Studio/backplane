// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { RunnerConsoleOverview } from "../RunnerConsoleOverview";

// The console Overview is a CURATED, HEALTH-FIRST at-a-glance view: headline
// metric cards (each linking into its owning tab), pending approvals, and the
// analytics dashboard. It DROPS what the dedicated tabs now own: the inline
// runners table + create CTA (Runners), the team panel (folded into Runners),
// and the full execution feed (Activity tab). We mock the data hooks to a
// resolved-empty state — keeping every other export (children import mutation
// hooks) — so the component renders without a backend.
vi.mock("@/features/agents/hooks/useAgentMetrics", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useAgentMetrics: () => ({ data: [], isLoading: false }),
    useExecutions: () => ({ data: [], isLoading: false }),
    useExecutionAnalytics: () => ({ data: null, isLoading: false }),
  };
});
vi.mock("@/features/approvals/hooks/useApprovals", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useApprovals: () => ({ data: [], isLoading: false }),
  };
});

describe("RunnerConsoleOverview", () => {
  it("renders the headline metric cards and pending approvals", () => {
    renderWithProviders(<RunnerConsoleOverview slug="acme" />, {
      routerProps: { initialEntries: ["/acme/runner/overview"] },
    });

    // Headline metric card label (reused from the legacy dashboard).
    expect(screen.getByText("Total Runners")).toBeInTheDocument();
    // Pending approvals panel still belongs on the overview (empty-state
    // renders the title in both CardTitle + EmptyState, so match all).
    expect(screen.getAllByText("Pending Approvals").length).toBeGreaterThan(0);
  });

  it("does NOT own the full execution feed (that moved to the Activity tab)", () => {
    renderWithProviders(<RunnerConsoleOverview slug="acme" />, {
      routerProps: { initialEntries: ["/acme/runner/overview"] },
    });

    // The full ExecutionTimeline (titled "Execution Timeline") is now the
    // Activity tab's job — the overview must not duplicate it.
    expect(screen.queryByText("Execution Timeline")).not.toBeInTheDocument();
  });

  it("does NOT duplicate the Runners-tab create CTA", () => {
    renderWithProviders(<RunnerConsoleOverview slug="acme" />, {
      routerProps: { initialEntries: ["/acme/runner/overview"] },
    });

    expect(
      screen.queryByText(/create your first runner/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^create runner$/i }),
    ).not.toBeInTheDocument();
  });

  it("does NOT duplicate the Teams-tab panel", () => {
    renderWithProviders(<RunnerConsoleOverview slug="acme" />, {
      routerProps: { initialEntries: ["/acme/runner/overview"] },
    });

    // TeamPanel renders a "Teams" CardTitle — it must not appear here.
    expect(screen.queryByText("Teams")).not.toBeInTheDocument();
  });
});
