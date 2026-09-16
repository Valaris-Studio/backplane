// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { RunnerActivityTab } from "../RunnerActivityTab";

// The Activity tab promotes the live execution feed to a first-class surface.
// We mock the data hooks to a resolved-empty state (keeping other exports so the
// reused ExecutionTimeline's mutation-hook imports survive) and assert it renders
// the timeline without throwing.
vi.mock("@/features/agents/hooks/useAgentMetrics", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useAgentMetrics: () => ({ data: [], isLoading: false }),
    useExecutions: () => ({ data: [], isLoading: false }),
  };
});

describe("RunnerActivityTab", () => {
  it("renders the execution timeline for the workspace", () => {
    renderWithProviders(<RunnerActivityTab slug="acme" />, {
      routerProps: { initialEntries: ["/acme/runner/activity"] },
    });
    // ExecutionTimeline renders its "Execution Timeline" title (CardTitle +
    // empty-state both use it, so match all).
    expect(screen.getAllByText("Execution Timeline").length).toBeGreaterThan(0);
  });
});
