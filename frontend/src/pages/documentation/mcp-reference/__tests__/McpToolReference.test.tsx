// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  within,
  userEvent,
} from "@/test/test-utils";
import { toast } from "sonner";

// gsap-driven opacity/visibility zeroes accessible names in jsdom; force the
// reduced-motion short-circuit like DocumentationPage.test.tsx does.
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// Desktop layout: both panes render side by side.
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { McpToolReference } from "@/pages/documentation/mcp-reference";
import { DocumentationSection } from "@/pages/documentation";
import { TOOL_DOCS } from "@/pages/documentation/mcp-reference/data";
import type {
  PromptDoc,
  ResourceDoc,
  ToolDoc,
} from "@/pages/documentation/mcp-reference/data";

const FIXTURE_TOOLS: ToolDoc[] = [
  {
    name: "alpha_search",
    category: "search",
    kind: "read",
    description: "Find cards fast by text or filters",
    params: [
      { name: "q", required: true, description: "Text to match against titles" },
      { name: "limit", required: false, description: "Max results to return" },
    ],
    examplePrompt: "Search the board for login bugs",
    related: ["beta_create"],
  },
  {
    name: "beta_create",
    category: "cards",
    kind: "write",
    description: "Create a card in a column",
    params: [
      { name: "card_title", required: true, description: "Title of the new card" },
    ],
    gotchas: ["Idempotent on title — retries return the existing card"],
    examplePrompt: "Create a card for the login bug",
  },
  {
    name: "gamma_context",
    category: "context",
    kind: "composite",
    description: "Full project briefing in one call",
    params: [],
    examplePrompt: "Brief me on the project",
  },
  {
    name: "delta_delete",
    category: "boards",
    kind: "write",
    description: "Delete a board permanently",
    params: [
      { name: "board_id", required: true, description: "Board to delete" },
    ],
    danger: "Deletes every column and card on the board. No undo.",
    examplePrompt: "Delete the sandbox board",
  },
];

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
    ],
    examplePrompt: "Run the standup for the platform board",
  },
];

const FIXTURE_RESOURCES: ResourceDoc[] = [
  {
    uri: "valaris://workspaces",
    description: "List of reachable workspaces",
  },
];

function renderExplorer(entry = "/test-ws/documentation/mcp-tool-catalog") {
  return renderWithProviders(
    <McpToolReference
      tools={FIXTURE_TOOLS}
      prompts={FIXTURE_PROMPTS}
      resources={FIXTURE_RESOURCES}
    />,
    { routerProps: { initialEntries: [entry] } },
  );
}

function nav() {
  return screen.getByRole("navigation", { name: /mcp reference/i });
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("McpToolReference navigation pane", () => {
  it("renders groups and categories with per-category counts from fixtures", () => {
    renderExplorer();

    const sidebar = nav();
    expect(within(sidebar).getByText("Start here")).toBeInTheDocument();
    expect(within(sidebar).getByText("Work management")).toBeInTheDocument();
    // No fixture tool lives in this group → hidden entirely.
    expect(within(sidebar).queryByText("Collaboration")).not.toBeInTheDocument();

    expect(within(sidebar).getByTestId("mcp-cat-cards")).toHaveTextContent("Cards");
    expect(within(sidebar).getByTestId("mcp-cat-cards")).toHaveTextContent("1");
    expect(within(sidebar).getByTestId("mcp-cat-search")).toHaveTextContent("1");

    // Every fixture tool is listed.
    for (const tool of FIXTURE_TOOLS) {
      expect(
        within(sidebar).getByRole("button", { name: tool.name }),
      ).toBeInTheDocument();
    }
  });

  it("renders the Prompts and MCP Resources nav groups", () => {
    renderExplorer();

    const sidebar = nav();
    expect(within(sidebar).getByText("Prompts")).toBeInTheDocument();
    expect(within(sidebar).getByText("MCP Resources")).toBeInTheDocument();
    expect(
      within(sidebar).getByRole("button", { name: "standup" }),
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByRole("button", { name: "valaris://workspaces" }),
    ).toBeInTheDocument();
  });

  it("filters tools by search text", async () => {
    const user = userEvent.setup();
    renderExplorer();

    await user.type(screen.getByRole("searchbox"), "briefing");

    const sidebar = nav();
    expect(
      within(sidebar).getByRole("button", { name: "gamma_context" }),
    ).toBeInTheDocument();
    expect(
      within(sidebar).queryByRole("button", { name: "alpha_search" }),
    ).not.toBeInTheDocument();
  });

  it("matches search against the category title", async () => {
    const user = userEvent.setup();
    renderExplorer();

    await user.type(screen.getByRole("searchbox"), "Project Context");

    const sidebar = nav();
    expect(
      within(sidebar).getByRole("button", { name: "gamma_context" }),
    ).toBeInTheDocument();
    expect(
      within(sidebar).queryByRole("button", { name: "beta_create" }),
    ).not.toBeInTheDocument();
  });

  it("focuses the search input on '/'", async () => {
    const user = userEvent.setup();
    renderExplorer();

    await user.keyboard("/");
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });

  it("filters tools by kind chips", async () => {
    const user = userEvent.setup();
    renderExplorer();

    await user.click(screen.getByRole("button", { name: "Write" }));

    const sidebar = nav();
    expect(
      within(sidebar).getByRole("button", { name: "beta_create" }),
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByRole("button", { name: "delta_delete" }),
    ).toBeInTheDocument();
    expect(
      within(sidebar).queryByRole("button", { name: "alpha_search" }),
    ).not.toBeInTheDocument();
    expect(
      within(sidebar).queryByRole("button", { name: "gamma_context" }),
    ).not.toBeInTheDocument();
  });

  it("shows a no-matches empty state whose clear button resets search AND kind filter", async () => {
    const user = userEvent.setup();
    renderExplorer();

    // "briefing" alone would match gamma_context (composite); the Write chip
    // hides it — only clearing BOTH restores results.
    await user.click(screen.getByRole("button", { name: "Write" }));
    await user.type(screen.getByRole("searchbox"), "briefing");

    const sidebar = nav();
    expect(within(sidebar).getByText(/no matches/i)).toBeInTheDocument();

    // Desktop placeholder flips from "select a tool" to a no-matches message.
    expect(
      screen.queryByText(/select a tool from the list/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();

    await user.click(
      within(sidebar).getByRole("button", { name: /clear search and filters/i }),
    );

    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(nav()).getByRole("button", { name: "gamma_context" }),
    ).toBeInTheDocument();
  });
});

describe("McpToolReference inside DocumentationSection", () => {
  it("survives selecting a resource whose hash percent-encodes the uri", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route
          path="/:slug/documentation/:sectionSlug"
          element={<DocumentationSection />}
        />
      </Routes>,
      {
        routerProps: {
          initialEntries: ["/test-ws/documentation/mcp-tool-catalog"],
        },
      },
    );

    // Hash becomes '#resource-valaris%3A%2F%2Fworkspaces' — the parent
    // anchor-scroll effect used to crash the whole tree via querySelector.
    await user.click(
      within(nav()).getByRole("button", { name: "valaris://workspaces" }),
    );

    expect(screen.getByTestId("mcp-detail")).toBeInTheDocument();
    expect(nav()).toBeInTheDocument();
  });
});

describe("McpToolReference detail pane", () => {
  it("shows tool detail on selection and marks the nav entry aria-current", async () => {
    const user = userEvent.setup();
    renderExplorer();

    const navButton = within(nav()).getByRole("button", { name: "beta_create" });
    await user.click(navButton);

    expect(navButton).toHaveAttribute("aria-current", "true");

    const detail = screen.getByTestId("mcp-detail");
    expect(within(detail).getByText("mcp__valaris__beta_create")).toBeInTheDocument();
    expect(
      within(detail).getByText("Create a card in a column"),
    ).toBeInTheDocument();
    // Params grid.
    expect(within(detail).getByText("card_title")).toBeInTheDocument();
    expect(within(detail).getByText("Title of the new card")).toBeInTheDocument();
    // Gotchas.
    expect(
      within(detail).getByText(/idempotent on title/i),
    ).toBeInTheDocument();
    // Example prompt terminal block.
    expect(
      within(detail).getByText("Create a card for the login bug"),
    ).toBeInTheDocument();
  });

  it("copies the full tool id and toasts", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderExplorer();

    await user.click(within(nav()).getByRole("button", { name: "beta_create" }));
    await user.click(screen.getByRole("button", { name: /copy tool id/i }));

    expect(writeText).toHaveBeenCalledWith("mcp__valaris__beta_create");
    expect(toast.success).toHaveBeenCalled();
  });

  it("copies the example prompt", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderExplorer();

    await user.click(within(nav()).getByRole("button", { name: "beta_create" }));
    await user.click(
      screen.getByRole("button", { name: /copy example prompt/i }),
    );

    expect(writeText).toHaveBeenCalledWith("Create a card for the login bug");
  });

  it("preselects from a '#tool-<name>' hash and renders DangerZone for danger tools", () => {
    renderExplorer("/test-ws/documentation/mcp-tool-catalog#tool-delta_delete");

    const detail = screen.getByTestId("mcp-detail");
    expect(within(detail).getByText("mcp__valaris__delta_delete")).toBeInTheDocument();
    expect(
      within(detail).getByText(/deletes every column and card on the board/i),
    ).toBeInTheDocument();
  });

  it("switches selection through related-tool links", async () => {
    const user = userEvent.setup();
    renderExplorer();

    await user.click(within(nav()).getByRole("button", { name: "alpha_search" }));

    const detail = screen.getByTestId("mcp-detail");
    await user.click(within(detail).getByRole("button", { name: "beta_create" }));

    expect(
      within(screen.getByTestId("mcp-detail")).getByText(
        "mcp__valaris__beta_create",
      ),
    ).toBeInTheDocument();
    expect(
      within(nav()).getByRole("button", { name: "beta_create" }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("shows prompt detail with a role badge and example prompt copy", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderExplorer();

    await user.click(within(nav()).getByRole("button", { name: "standup" }));

    const detail = screen.getByTestId("mcp-detail");
    expect(within(detail).getByText("Secretary")).toBeInTheDocument();
    expect(within(detail).getByText("workspace_slug")).toBeInTheDocument();

    await user.click(
      within(detail).getByRole("button", { name: /copy example prompt/i }),
    );
    expect(writeText).toHaveBeenCalledWith(
      "Run the standup for the platform board",
    );
  });

  it("shows resource detail with uri and description", async () => {
    const user = userEvent.setup();
    renderExplorer();

    await user.click(
      within(nav()).getByRole("button", { name: "valaris://workspaces" }),
    );

    const detail = screen.getByTestId("mcp-detail");
    expect(
      within(detail).getByText("List of reachable workspaces"),
    ).toBeInTheDocument();
  });
});

describe("McpToolReference real data smoke", () => {
  // Data files are filled by a concurrent authoring stage; skip until the
  // registry has content instead of asserting counts that will drift.
  it.skipIf(TOOL_DOCS.length === 0)(
    "renders get_project_context from the real registry",
    async () => {
      const user = userEvent.setup();
      renderWithProviders(<McpToolReference />, {
        routerProps: {
          initialEntries: ["/test-ws/documentation/mcp-tool-catalog"],
        },
      });

      await user.click(
        within(nav()).getByRole("button", { name: "get_project_context" }),
      );
      expect(
        within(screen.getByTestId("mcp-detail")).getByText(
          "mcp__valaris__get_project_context",
        ),
      ).toBeInTheDocument();
    },
  );
});
