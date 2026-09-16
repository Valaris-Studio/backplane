// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { useNavigate } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  within,
  userEvent,
} from "@/test/test-utils";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// Mobile layout: single stacked pane with a back affordance.
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => false,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { McpToolReference } from "@/pages/documentation/mcp-reference";
import type { ToolDoc } from "@/pages/documentation/mcp-reference/data";

const FIXTURE_TOOLS: ToolDoc[] = [
  {
    name: "alpha_search",
    category: "search",
    kind: "read",
    description: "Find cards fast by text or filters",
    params: [],
    examplePrompt: "Search the board for login bugs",
    related: ["beta_create"],
  },
  {
    name: "beta_create",
    category: "cards",
    kind: "write",
    description: "Create a card in a column",
    params: [],
    examplePrompt: "Create a card for the login bug",
  },
];

// Simulates the browser/OS back gesture — MemoryRouter ignores window.history.
function HistoryPopProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      history-pop-probe
    </button>
  );
}

function renderMobile(entry = "/test-ws/documentation/mcp-tool-catalog") {
  return renderWithProviders(
    <>
      <McpToolReference tools={FIXTURE_TOOLS} prompts={[]} resources={[]} />
      <HistoryPopProbe />
    </>,
    {
      routerProps: {
        initialEntries: [entry],
      },
    },
  );
}

function nav() {
  return screen.getByRole("navigation", { name: /mcp reference/i });
}

describe("McpToolReference mobile fallback", () => {
  it("shows the nav list first, then detail with a back affordance", async () => {
    const user = userEvent.setup();
    renderMobile();

    const sidebar = screen.getByRole("navigation", { name: /mcp reference/i });
    expect(screen.queryByTestId("mcp-detail")).not.toBeInTheDocument();

    await user.click(
      within(sidebar).getByRole("button", { name: "alpha_search" }),
    );

    const detail = screen.getByTestId("mcp-detail");
    expect(
      within(detail).getByText("mcp__valaris__alpha_search"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to list/i }));
    expect(
      screen.getByRole("navigation", { name: /mcp reference/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-detail")).not.toBeInTheDocument();
  });
});

describe("McpToolReference mobile history", () => {
  it("pushes a history entry when entering a selection so browser back returns to the list", async () => {
    const user = userEvent.setup();
    renderMobile();

    await user.click(within(nav()).getByRole("button", { name: "alpha_search" }));
    expect(screen.getByTestId("mcp-detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "history-pop-probe" }));

    expect(
      screen.getByRole("navigation", { name: /mcp reference/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-detail")).not.toBeInTheDocument();
  });

  it("replaces the entry on selection-to-selection switches so back skips intermediate tools", async () => {
    const user = userEvent.setup();
    renderMobile();

    await user.click(within(nav()).getByRole("button", { name: "alpha_search" }));
    await user.click(
      within(screen.getByTestId("mcp-detail")).getByRole("button", {
        name: "beta_create",
      }),
    );
    expect(
      within(screen.getByTestId("mcp-detail")).getByText(
        "mcp__valaris__beta_create",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "history-pop-probe" }));

    expect(screen.queryByTestId("mcp-detail")).not.toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: /mcp reference/i }),
    ).toBeInTheDocument();
  });
});

describe("McpToolReference mobile focus management", () => {
  it("moves focus to the detail pane on user selection", async () => {
    const user = userEvent.setup();
    renderMobile();

    await user.click(within(nav()).getByRole("button", { name: "alpha_search" }));

    expect(screen.getByTestId("mcp-detail")).toHaveFocus();
  });

  it("restores focus to the originating nav button on back", async () => {
    const user = userEvent.setup();
    renderMobile();

    await user.click(within(nav()).getByRole("button", { name: "alpha_search" }));
    await user.click(screen.getByRole("button", { name: /back to list/i }));

    expect(
      within(nav()).getByRole("button", { name: "alpha_search" }),
    ).toHaveFocus();
  });

  it("falls back to the search input when the last selection is filtered out of the nav", async () => {
    const user = userEvent.setup();
    renderMobile();

    await user.type(screen.getByRole("searchbox"), "alpha");
    await user.click(within(nav()).getByRole("button", { name: "alpha_search" }));
    // The related-tool chip selects a tool the "alpha" search hides from the nav.
    await user.click(
      within(screen.getByTestId("mcp-detail")).getByRole("button", {
        name: "beta_create",
      }),
    );
    await user.click(screen.getByRole("button", { name: /back to list/i }));

    expect(screen.getByRole("searchbox")).toHaveFocus();
  });

  it("does not steal focus when a deep link opens the detail pane", () => {
    renderMobile("/test-ws/documentation/mcp-tool-catalog#tool-alpha_search");

    expect(screen.getByTestId("mcp-detail")).toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });
});
