// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import i18n from "@/i18n/config";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { LaunchRunnerWizard } from "../LaunchRunnerWizard";

// Card 2dbd252b (B): the bind step binds the runner to `teams[0]` (or creates
// a default team) without ever saying which BOARD that team serves. A team's
// `board_id` is either one board or null (= every board in the workspace),
// and the runner picks up work accordingly — so the step must state the scope
// before Next commits it. Pinned under data-testid "wizard-bind-scope".

const SLUG = "wiz-ws";
const SCOPE_TESTID = "wizard-bind-scope";

const BOARDS = [
  { id: "b1", slug: "board-1", name: "Board 1", description: "", workspace_id: "w", columns: [] },
  { id: "b2", slug: "board-2", name: "Ops board", description: "", workspace_id: "w", columns: [] },
];

function team(boardId: string | null) {
  return {
    id: "t1",
    slug: "field-runners",
    name: "Field runners",
    description: "",
    workspace_id: "w",
    board_id: boardId,
    created_by_id: "u1",
    is_active: true,
    members: [],
    created_at: "2026-08-03T00:00:00Z",
    updated_at: "2026-08-03T00:00:00Z",
  };
}

type Team = ReturnType<typeof team>;

function setupHandlers(teams: Team[] | Promise<Team[]>) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3, card_cooldown_hours: 1, commit_message_template: "",
        pr_description_template: "", version: 1,
        pipeline_config: { version: 1, stages: [], scheduling: { priority_order: [], mode: "priority" } },
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json(BOARDS)),
    http.get(`/api/workspaces/${SLUG}/teams`, async () =>
      HttpResponse.json(await teams),
    ),
    http.post("/api/agents", () =>
      HttpResponse.json({ id: "ag1", name: "frogger", agent_type: "coding", is_active: true, raw_api_key: null }),
    ),
  );
}

async function renderAtBindStep() {
  renderWithProviders(
    <LaunchRunnerWizard slug={SLUG} open onOpenChange={() => {}} />,
    { routerProps: { initialEntries: [`/${SLUG}/runner/pipeline`] } },
  );
  fireEvent.change(screen.getByTestId("wizard-runner-name"), {
    target: { value: "frogger" },
  });
  fireEvent.click(screen.getByTestId("wizard-create"));
  await waitFor(() =>
    expect(screen.getByTestId("wizard-step-bind")).toBeInTheDocument(),
  );
}

async function expectScopeLine(key: string, params: Record<string, string>) {
  const scope = await screen.findByTestId(SCOPE_TESTID);
  // Board and team names arrive from two separate queries, so the line may
  // render before either resolves.
  await waitFor(() => expect(scope).toHaveTextContent(i18n.t(key, params)));
  // A missing key renders as its own name, which the line above would match.
  expect(i18n.exists(key), `${key} missing from en`).toBe(true);
}

describe("LaunchRunnerWizard bind step names the board the runner will serve", () => {
  it("names the team's board when the existing team is scoped to one", async () => {
    // The second board on purpose: a line that always shows boards[0] (the
    // config step's default) would pass with the first.
    setupHandlers([team("b2")]);
    await renderAtBindStep();

    await expectScopeLine("runner.launchWizard.bindScopeBoard", {
      team: "Field runners",
      board: "Ops board",
    });
    expect(screen.getByTestId(SCOPE_TESTID)).not.toHaveTextContent("Board 1");
  });

  it("says every board in the workspace when the existing team has no board", async () => {
    setupHandlers([team(null)]);
    await renderAtBindStep();

    await expectScopeLine("runner.launchWizard.bindScopeWorkspace", {
      team: "Field runners",
    });
  });

  it("announces the default team it will create when the workspace has none", async () => {
    setupHandlers([]);
    await renderAtBindStep();

    await expectScopeLine("runner.launchWizard.bindScopeNewTeam", {
      team: i18n.t("runner.launchWizard.defaultTeamName"),
    });
  });

  it("withholds the scope line until the teams query has answered", async () => {
    // Which line to show depends on the answer: naming a board, or a team to
    // create, before /teams resolves would be a guess the operator could act
    // on with Next.
    let release: (teams: Team[]) => void = () => {};
    setupHandlers(new Promise<Team[]>((resolve) => (release = resolve)));
    await renderAtBindStep();

    expect(screen.queryByTestId(SCOPE_TESTID)).not.toBeInTheDocument();

    release([team("b2")]);
    await expectScopeLine("runner.launchWizard.bindScopeBoard", {
      team: "Field runners",
      board: "Ops board",
    });
  });
});
