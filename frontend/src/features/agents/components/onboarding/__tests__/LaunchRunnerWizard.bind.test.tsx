// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { LaunchRunnerWizard } from "../LaunchRunnerWizard";

// Audit r2 finding 1 (card 79f2236a): the bind step used to treat "Next with
// zero roles" as a silent skip — no team membership — handing out a runner
// that exits fatal with "platform returned no pipeline_config". The contract
// now: Next ALWAYS binds (zero selected roles → roles: [], the scheduler's
// all-roles semantics) and Skip states the unbound consequence out loud.

const SLUG = "wiz-ws";

const TEAM = {
  id: "t1",
  slug: "default-runners",
  name: "Default runners",
  description: "",
  workspace_id: "w",
  board_id: null,
  created_by_id: "u1",
  is_active: true,
  members: [],
  created_at: "2026-08-03T00:00:00Z",
  updated_at: "2026-08-03T00:00:00Z",
};

function setupHandlers(capture: {
  memberBodies: unknown[];
  teamCreates: number;
}) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3, card_cooldown_hours: 1, commit_message_template: "",
        pr_description_template: "", version: 1,
        pipeline_config: { version: 1, stages: [], scheduling: { priority_order: [], mode: "priority" } },
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json([{ id: "b1", slug: "board-1", name: "Board 1", description: "", workspace_id: "w", columns: [] }]),
    ),
    http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
    // Reactivation shape (null key) skips the key ceremony straight to bind.
    http.post("/api/agents", () =>
      HttpResponse.json({ id: "ag1", name: "frogger", agent_type: "coding", is_active: true, raw_api_key: null }),
    ),
    http.post(`/api/workspaces/${SLUG}/teams`, () => {
      capture.teamCreates += 1;
      return HttpResponse.json(TEAM);
    }),
    http.post(`/api/workspaces/${SLUG}/teams/t1/members`, async ({ request }) => {
      capture.memberBodies.push(await request.json());
      return HttpResponse.json(TEAM);
    }),
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

describe("LaunchRunnerWizard bind step semantics", () => {
  it("Next with zero roles selected binds the runner to a team with ALL roles (roles: [])", async () => {
    const capture = { memberBodies: [] as unknown[], teamCreates: 0 };
    setupHandlers(capture);
    await renderAtBindStep();

    await waitFor(() => expect(screen.getByTestId("wizard-next")).toBeEnabled());
    fireEvent.click(screen.getByTestId("wizard-next"));

    await waitFor(() =>
      expect(screen.getByTestId("wizard-step-config")).toBeInTheDocument(),
    );
    expect(capture.teamCreates).toBe(1);
    expect(capture.memberBodies).toEqual([{ agent_id: "ag1", roles: [] }]);
  });

  it("shows the all-roles hint while zero roles are selected", async () => {
    const capture = { memberBodies: [] as unknown[], teamCreates: 0 };
    setupHandlers(capture);
    await renderAtBindStep();

    expect(screen.getByTestId("wizard-bind-all-roles-hint")).toHaveTextContent(
      /every pipeline role/i,
    );
  });

  it("Skip creates no binding and its consequence is stated on the step", async () => {
    const capture = { memberBodies: [] as unknown[], teamCreates: 0 };
    setupHandlers(capture);
    await renderAtBindStep();

    expect(screen.getByTestId("wizard-skip-warning")).toHaveTextContent(
      /won't start/i,
    );

    fireEvent.click(screen.getByTestId("wizard-skip"));
    await waitFor(() =>
      expect(screen.getByTestId("wizard-step-config")).toBeInTheDocument(),
    );
    expect(capture.teamCreates).toBe(0);
    expect(capture.memberBodies).toEqual([]);
  });
});
