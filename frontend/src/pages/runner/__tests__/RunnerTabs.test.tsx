// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { RunnerTeamsTab } from "../RunnerTeamsTab";
import { RunnerRunnersTab } from "../RunnerRunnersTab";

// The thin tab wrappers reuse existing slug-driven feature components
// (TeamPanel / AgentTable). We mock only the data-fetch hooks to an empty
// state — preserving every other export (mutation hooks the children import) —
// and assert the wrapper renders its component without throwing.
vi.mock("@/features/agents/hooks/useTeams", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useTeams: () => ({ data: [], isLoading: false, isError: false }),
  };
});
vi.mock("@/features/agents/hooks/useAgentMetrics", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useAgentMetrics: () => ({ data: [], isLoading: false }),
  };
});

describe("Runner console tab wrappers", () => {
  it("RunnerTeamsTab renders the teams panel for the workspace", () => {
    renderWithProviders(<RunnerTeamsTab slug="acme" />);
    // TeamPanel header + empty-state copy.
    expect(screen.getByText("No teams created yet")).toBeInTheDocument();
  });

  it("RunnerRunnersTab renders the runners list for the workspace", () => {
    renderWithProviders(<RunnerRunnersTab slug="acme" />);
    // AgentTable empty-state copy.
    expect(screen.getByText("No runners registered yet")).toBeInTheDocument();
  });
});
