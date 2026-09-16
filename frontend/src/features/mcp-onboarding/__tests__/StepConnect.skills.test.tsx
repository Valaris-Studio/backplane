// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, within, userEvent } from "@/test/test-utils";
import i18n from "@/i18n/config";
import serverSurfaceJson from "@/pages/documentation/mcp-reference/data/server-surface.json";
import { McpConnectionWizard } from "../McpConnectionWizard";
import {
  apiKey,
  mockApiKeys,
  mockCreateApiKey,
  mockMe,
  renderWizard,
  stubMatchMedia,
} from "./wizard-harness";

// MCP #3 — "Skills that fit this hand". Below the #2 intent picker, StepConnect
// lists the catalog entries whose declared `toolsets` all fit the hand the
// picked intent loads: interactive → the server's default hand
// (server-surface.json default_toolset.ids, which are GROUP ids — a category
// id such as "cards" fits when its parent group is one of them); loops add
// autonomous operations and everything loads the whole surface. An empty catalog hides
// the block entirely.
//
// Pinned shapes the implementer must match:
//   data-testid="wizard-skills-fit"                the block (absent when empty)
//   i18n key mcpOnboarding.connectSkillsHeading    the block's heading
//   catalog source: useSkillCatalog from @/features/skills/api/use-skills

const catalogState = {
  current: { entries: [] as Array<Record<string, unknown>>, hookCalls: 0 },
};

vi.mock("@/features/skills/api/use-skills", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSkillCatalog: () => {
    catalogState.current.hookCalls += 1;
    return {
      data: { entries: catalogState.current.entries },
      isLoading: false,
      isError: false,
    };
  },
}));

const COMMIT_MESSAGES = {
  catalog_id: "commit-messages",
  catalog_version: 1,
  name: "Commit Messages",
  description: "How to write a commit message agents can act on",
  toolsets: ["cards", "notes"],
};

const RUN_MONITORING = {
  catalog_id: "autonomous-run-monitoring",
  catalog_version: 1,
  name: "Autonomous Run Monitoring",
  description: "Watching a loop from the outside",
  toolsets: ["autonomous-operations"],
};

// Mixed hand: one toolset fits the interactive hand, one does not — the entry
// must NOT be listed for interactive (every declared toolset has to fit).
const APPROVALS_TRIAGE = {
  catalog_id: "approvals-triage",
  catalog_version: 1,
  name: "Approvals Triage",
  description: "Clearing the approvals queue",
  toolsets: ["cards", "approvals"],
};

const COLLABORATION_TRIAGE = {
  catalog_id: "collaboration-triage",
  catalog_version: 1,
  name: "Collaboration Triage",
  description: "Coordinate teams while reviewing approvals",
  toolsets: ["approvals", "teams"],
};

// A payload from an older backend that predates the `toolsets` field: it must
// neither crash the block nor be listed as fitting anything — an undeclared
// hand fits no hand, vacuous `[].every` included.
const UNDECLARED = {
  catalog_id: "undeclared-legacy",
  catalog_version: 1,
  name: "Undeclared Legacy",
  description: "Stored before skills declared a hand",
};

interface FixtureToolset {
  id: string;
  kind: "group" | "category";
  title: string;
  group: string;
}

// Self-check of the fixture assumptions above so a taxonomy change fails here
// with a readable message instead of as a silent list mismatch.
function assertFixtureAssumptions() {
  const surface = serverSurfaceJson as {
    toolsets: FixtureToolset[];
    default_toolset: { ids: string[] };
  };
  const groupIdByTitle = new Map(
    surface.toolsets
      .filter((t) => t.kind === "group")
      .map((t) => [t.title, t.id] as const),
  );
  const parentGroupId = (id: string) => {
    const toolset = surface.toolsets.find((t) => t.id === id);
    expect(toolset, `${id} is not a toolset id in server-surface.json`).toBeDefined();
    return toolset?.kind === "group" ? toolset.id : groupIdByTitle.get(toolset?.group ?? "");
  };
  const defaultIds = surface.default_toolset.ids;
  for (const id of ["cards", "notes"]) {
    expect(defaultIds, `${id} should fit the default hand`).toContain(parentGroupId(id));
  }
  for (const id of ["autonomous-operations", "approvals", "teams"]) {
    expect(defaultIds, `${id} should NOT fit the default hand`).not.toContain(
      parentGroupId(id),
    );
  }
}

function copy(key: string): string {
  const fullKey = `mcpOnboarding.${key}`;
  const value = i18n.t(fullKey);
  expect(value, `${fullKey} is missing from en.json`).not.toBe(fullKey);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The wizard opens from inside a workspace, so a `:slug` route param is
// available to whatever the block uses to address the catalog.
function renderWizardInWorkspace() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/*"
        element={<McpConnectionWizard open onOpenChange={() => {}} />}
      />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/kanban"] } },
  );
}

async function reachConnectStep() {
  const user = userEvent.setup();
  renderWizardInWorkspace();
  await screen.findByTestId("wizard-step-key");
  await user.click(await screen.findByTestId("wizard-pick-key-k1"));
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  expect(catalogState.current.hookCalls).toBe(0);
  await user.click(screen.getByTestId("wizard-advanced-toggle"));
  return user;
}

function fitNames() {
  const block = screen.getByTestId("wizard-skills-fit");
  return [COMMIT_MESSAGES, RUN_MONITORING, APPROVALS_TRIAGE, COLLABORATION_TRIAGE]
    .map((entry) => entry.name)
    .filter((name) => within(block).queryByText(name) !== null);
}

beforeEach(() => {
  stubMatchMedia(true);
  mockMe();
  mockCreateApiKey();
  mockApiKeys([apiKey({ id: "k1" })]);
  catalogState.current.entries = [COMMIT_MESSAGES, RUN_MONITORING, APPROVALS_TRIAGE, COLLABORATION_TRIAGE];
  catalogState.current.hookCalls = 0;
});

afterEach(() => stubMatchMedia(false));

describe("StepConnect — skills that fit the picked hand (MCP #3)", () => {
  it("fixture assumptions hold against server-surface.json", () => {
    assertFixtureAssumptions();
  });

  it("with the interactive intent lists only entries whose every toolset fits the default hand", async () => {
    await reachConnectStep();

    const block = await screen.findByTestId("wizard-skills-fit");
    expect(
      within(block).getByRole("heading", {
        name: new RegExp(escapeRegExp(copy("connectSkillsHeading"))),
      }),
    ).toBeInTheDocument();
    expect(fitNames()).toEqual([COMMIT_MESSAGES.name]);
  });

  it("switching to loops includes both default skills and autonomous categories", async () => {
    const user = await reachConnectStep();
    await screen.findByTestId("wizard-skills-fit");

    await user.click(
      screen.getByRole("radio", {
        name: new RegExp(escapeRegExp(copy("connectIntentRunner"))),
      }),
    );

    expect(fitNames()).toEqual([
      COMMIT_MESSAGES.name,
      RUN_MONITORING.name,
      APPROVALS_TRIAGE.name,
    ]);
  });

  it("switching back to interactive narrows the list again", async () => {
    const user = await reachConnectStep();
    await screen.findByTestId("wizard-skills-fit");

    await user.click(
      screen.getByRole("radio", {
        name: new RegExp(escapeRegExp(copy("connectIntentEverything"))),
      }),
    );
    expect(fitNames()).toEqual([
      COMMIT_MESSAGES.name, RUN_MONITORING.name, APPROVALS_TRIAGE.name, COLLABORATION_TRIAGE.name,
    ]);

    await user.click(
      screen.getByRole("radio", {
        name: new RegExp(escapeRegExp(copy("connectIntentInteractive"))),
      }),
    );
    expect(fitNames()).toEqual([COMMIT_MESSAGES.name]);
  });

  it("hides the block entirely when the catalog is empty", async () => {
    catalogState.current.entries = [];
    await reachConnectStep();

    expect(screen.queryByTestId("wizard-skills-fit")).not.toBeInTheDocument();
    expect(
      screen.queryByText(copy("connectSkillsHeading")),
    ).not.toBeInTheDocument();
  });

  it("hides the block when no entry fits the interactive hand", async () => {
    catalogState.current.entries = [RUN_MONITORING];
    await reachConnectStep();

    expect(screen.queryByTestId("wizard-skills-fit")).not.toBeInTheDocument();
  });

  it("neither crashes on nor lists an entry whose payload has no toolsets field, under any intent", async () => {
    catalogState.current.entries = [COMMIT_MESSAGES, UNDECLARED];
    const user = await reachConnectStep();

    const block = await screen.findByTestId("wizard-skills-fit");
    expect(within(block).getByText(COMMIT_MESSAGES.name)).toBeInTheDocument();
    expect(within(block).queryByText(UNDECLARED.name)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("radio", {
        name: new RegExp(escapeRegExp(copy("connectIntentRunner"))),
      }),
    );
    expect(within(block).getByText(COMMIT_MESSAGES.name)).toBeInTheDocument();
    expect(within(block).queryByText(UNDECLARED.name)).not.toBeInTheDocument();
  });

  it("hides the block when the only entry is undeclared", async () => {
    catalogState.current.entries = [UNDECLARED];
    await reachConnectStep();

    expect(screen.queryByTestId("wizard-skills-fit")).not.toBeInTheDocument();
  });
});

describe("StepConnect — outside a workspace route (MCP #3)", () => {
  it("never asks for the catalog and renders no skills block without a workspace slug", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByTestId("wizard-step-key");
    await user.click(await screen.findByTestId("wizard-pick-key-k1"));
    await user.click(screen.getByTestId("wizard-next"));
    await screen.findByTestId("wizard-step-connect");

    expect(catalogState.current.hookCalls).toBe(0);
    expect(screen.queryByTestId("wizard-skills-fit")).not.toBeInTheDocument();
    expect(screen.queryByText(copy("connectSkillsHeading"))).not.toBeInTheDocument();
  });
});


it("resolves every generated group and category against the selected loop startup groups", async () => {
  const surface = serverSurfaceJson as {
    toolsets: FixtureToolset[];
    default_toolset: { ids: string[] };
  };
  catalogState.current.entries = surface.toolsets.map((toolset) => ({
    catalog_id: `requires-${toolset.id}`,
    catalog_version: 1,
    name: `Requires ${toolset.id}`,
    toolsets: [toolset.id],
  }));
  const user = await reachConnectStep();
  await user.click(screen.getAllByRole("radio")[1]!);

  const selectedGroups = surface.toolsets.filter((toolset) =>
    toolset.kind === "group" &&
    [...surface.default_toolset.ids, "autonomous-operations"].includes(toolset.id),
  );
  const selectedGroupTitles = new Set(selectedGroups.map((toolset) => toolset.title));
  const expected = surface.toolsets
    .filter((toolset) => selectedGroupTitles.has(toolset.group))
    .map((toolset) => `Requires ${toolset.id}`);
  expect(within(screen.getByTestId("wizard-skills-fit")).getAllByRole("link")
    .map((link) => link.textContent)).toEqual(expected);
});
