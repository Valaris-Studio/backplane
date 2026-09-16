// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { LaunchRunnerWizard } from "../LaunchRunnerWizard";

beforeAll(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = vi.fn(() => "blob:x");
    window.URL.revokeObjectURL = vi.fn();
  }
});

const SLUG = "wiz-ws";
const RAW_KEY = "vlr_test_secret_123";

function setupHandlers() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3, card_cooldown_hours: 1, commit_message_template: "",
        pr_description_template: "", version: 1,
        pipeline_config: {
          version: 1,
          stages: [
            { role: "implementer", discover: { strategy: "", column_type: "active", column_type_exclude: "", filters: {} }, claim: { participant_role: "hero", execution_action: "implement_card" }, git: { action: "create_branch", branch_prefix: "", create_pr: true, force_push_on_rework: true }, llm: { enabled: true, stage: "implement", tools: [], inject_directives: true, approval_enabled: true }, sensors: [], lifecycle: [{ name: "discover", kind: "discover" }] },
          ],
          scheduling: { priority_order: ["implementer"], mode: "priority" },
        },
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json([{ id: "b1", slug: "board-1", name: "Board 1", description: "", workspace_id: "w", columns: [] }]),
    ),
    http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
    http.post("/api/agents", () =>
      HttpResponse.json({
        id: "ag1", name: "frogger", agent_type: "coding", is_active: true,
        raw_api_key: RAW_KEY,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/b1/runner-config`, () =>
      HttpResponse.json({ runner_yaml: "yaml:1", mcp_config_json: "{}", prerequisites: ["Go 1.22"] }),
    ),
  );
}

async function driveToLaunchStep() {
  renderWithProviders(
    <LaunchRunnerWizard slug={SLUG} open onOpenChange={() => {}} />,
    { routerProps: { initialEntries: [`/${SLUG}/runner/pipeline`] } },
  );

  fireEvent.change(screen.getByTestId("wizard-runner-name"), { target: { value: "frogger" } });
  fireEvent.click(screen.getByTestId("wizard-create"));
  await waitFor(() => expect(screen.getByTestId("wizard-api-key")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("wizard-next"));
  await waitFor(() => expect(screen.getByTestId("wizard-step-bind")).toBeInTheDocument());
  // Skip, not Next: Next now binds (team + member mutations) and this test
  // isn't about binding.
  fireEvent.click(screen.getByTestId("wizard-skip"));
  await waitFor(() => expect(screen.getByTestId("wizard-step-config")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("wizard-next"));
  await waitFor(() => expect(screen.getByTestId("wizard-step-launch")).toBeInTheDocument());
}

// Security regression: the one-time raw API key must never be interpolated into
// the copyable launch command — commands get pasted into shells, terminal
// scrollback, and shell history. The command must reference the env var
// placeholder ($VALARIS_API_KEY) instead of the literal vlr_ secret.
describe("LaunchRunnerWizard launch command key leak", () => {
  it("never interpolates the raw vlr_ api key into the launch command", async () => {
    setupHandlers();
    await driveToLaunchStep();

    const command = screen.getByTestId("wizard-launch-command").textContent ?? "";
    expect(command).not.toMatch(/vlr_/);
    expect(command).toContain("$VALARIS_API_KEY");
  });
});
