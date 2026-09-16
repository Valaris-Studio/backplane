// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, within } from "@/test/test-utils";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

import { ReferenceMcpPromptCatalog } from "@/pages/documentation/sections/reference-mcp-prompt-catalog";
import type { PromptDoc } from "@/pages/documentation/mcp-reference/data";

const FIXTURE_PROMPTS: PromptDoc[] = [
  {
    name: "standup",
    role: "secretary",
    description: "Daily standup note for a board",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "Workspace to report on",
      },
      { name: "board_id", required: true, description: "Board to report on" },
    ],
    examplePrompt: "Run the standup",
  },
  {
    name: "plan_work",
    role: "architect",
    description: "Decompose an objective into backlog cards",
    params: [
      { name: "objective", required: true, description: "What to build" },
    ],
    examplePrompt: "Plan the auth epic",
  },
];

describe("ReferenceMcpPromptCatalog", () => {
  it("renders a data-driven row per prompt with role and params", () => {
    renderWithProviders(
      <ReferenceMcpPromptCatalog prompts={FIXTURE_PROMPTS} />,
    );

    // Scope to the table: prose/callouts also mention prompt names.
    const table = screen.getByRole("table");
    expect(within(table).getByText("standup")).toBeInTheDocument();
    expect(within(table).getByText("Secretary")).toBeInTheDocument();
    expect(
      within(table).getByText("Daily standup note for a board"),
    ).toBeInTheDocument();
    expect(within(table).getByText(/workspace_slug/)).toBeInTheDocument();

    expect(within(table).getByText("plan_work")).toBeInTheDocument();
    expect(within(table).getByText("Architect")).toBeInTheDocument();
  });

  it("derives the prompt count instead of hardcoding it", () => {
    renderWithProviders(
      <ReferenceMcpPromptCatalog prompts={FIXTURE_PROMPTS} />,
    );

    expect(screen.getByText(/2 prompts/)).toBeInTheDocument();
  });
});
