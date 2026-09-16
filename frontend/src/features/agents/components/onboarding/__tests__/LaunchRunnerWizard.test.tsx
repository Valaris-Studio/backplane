// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { LaunchRunnerWizard } from "../LaunchRunnerWizard";
import { RUNNER_RELEASE } from "@/lib/runner-release";

beforeAll(() => {
  // clipboard + URL for copy/download affordances
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = vi.fn(() => "blob:x");
    window.URL.revokeObjectURL = vi.fn();
  }
});

const SLUG = "wiz-ws";

function baseHandlers(extra: Parameters<typeof server.use> = []) {
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
    ...extra,
  );
}

function renderWizard() {
  return renderWithProviders(
    <LaunchRunnerWizard slug={SLUG} open onOpenChange={() => {}} />,
    { routerProps: { initialEntries: [`/${SLUG}/runner/pipeline`] } },
  );
}

describe("LaunchRunnerWizard", () => {
  it("step 1 creates a runner and reveals its api key (shown once)", async () => {
    baseHandlers([
      http.post("/api/agents", () =>
        HttpResponse.json({
          id: "ag1", name: "frogger", agent_type: "coding", is_active: true,
          raw_api_key: "vlr_secret_key_123",
        }),
      ),
    ]);
    renderWizard();

    fireEvent.change(screen.getByTestId("wizard-runner-name"), {
      target: { value: "frogger" },
    });
    fireEvent.click(screen.getByTestId("wizard-create"));

    // key revealed after creation
    await waitFor(() =>
      expect(screen.getByText(/vlr_secret_key_123/)).toBeInTheDocument(),
    );
  });

  it("reactivation (null key) skips the key ceremony and advances", async () => {
    baseHandlers([
      http.post("/api/agents", () =>
        HttpResponse.json({
          id: "ag1", name: "frogger", agent_type: "coding", is_active: true,
          raw_api_key: null,
        }),
      ),
    ]);
    renderWizard();
    fireEvent.change(screen.getByTestId("wizard-runner-name"), {
      target: { value: "frogger" },
    });
    fireEvent.click(screen.getByTestId("wizard-create"));

    // No key block; the flow moves on to the bind step.
    await waitFor(() =>
      expect(screen.getByTestId("wizard-step-bind")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/vlr_/)).not.toBeInTheDocument();
  });

  it("shows the copyable launch command on the launch step", async () => {
    baseHandlers([
      http.post("/api/agents", () =>
        HttpResponse.json({ id: "ag1", name: "frogger", agent_type: "coding", is_active: true, raw_api_key: "vlr_k" }),
      ),
      http.get(`/api/workspaces/${SLUG}/boards/b1/runner-config`, () =>
        HttpResponse.json({ runner_yaml: "yaml:1", mcp_config_json: "{}", prerequisites: ["Go 1.22"] }),
      ),
    ]);
    renderWizard();
    fireEvent.change(screen.getByTestId("wizard-runner-name"), { target: { value: "frogger" } });
    fireEvent.click(screen.getByTestId("wizard-create"));
    // key revealed (raw_api_key present) → save-your-key panel, then continue.
    await waitFor(() => expect(screen.getByTestId("wizard-api-key")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("wizard-next"));
    await waitFor(() => expect(screen.getByTestId("wizard-step-bind")).toBeInTheDocument());

    // advance bind → config → launch. Skip, not Next: Next now BINDS (zero
    // roles → all-roles team membership) and this test isn't about binding.
    fireEvent.click(screen.getByTestId("wizard-skip"));
    await waitFor(() => expect(screen.getByTestId("wizard-step-config")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("wizard-next"));
    await waitFor(() => expect(screen.getByTestId("wizard-step-launch")).toBeInTheDocument());

    expect(
      screen.getByText(/VALARIS_API_KEY=\$VALARIS_API_KEY \.\/backplane-runner/),
    ).toBeInTheDocument();

    // Both launch paths are taught: the bare binary drops into the TUI setup
    // wizard, the -config form is the headless one for servers and CI.
    const interactive = screen.getByTestId("wizard-launch-command-interactive");
    expect(interactive).toHaveTextContent("./backplane-runner");
    expect(interactive).not.toHaveTextContent(/-config/);
    expect(screen.getByTestId("wizard-launch-command")).toHaveTextContent(
      /-config runner-frogger\.yaml/,
    );

    // When the runner doesn't come up, the first move is the read-only
    // preflight — not guessing at credentials or config.
    expect(screen.getByTestId("wizard-doctor-hint")).toHaveTextContent("-doctor");
  });
});

describe("LaunchRunnerWizard get-the-runner block", () => {
  it("offers the pinned release downloads before the launch commands", async () => {
    baseHandlers([
      http.post("/api/agents", () =>
        HttpResponse.json({ id: "ag1", name: "frogger", agent_type: "coding", is_active: true, raw_api_key: "vlr_k" }),
      ),
      http.get(`/api/workspaces/${SLUG}/boards/b1/runner-config`, () =>
        HttpResponse.json({ runner_yaml: "yaml:1", mcp_config_json: "{}", prerequisites: ["Go 1.22"] }),
      ),
    ]);
    renderWizard();
    fireEvent.change(screen.getByTestId("wizard-runner-name"), { target: { value: "frogger" } });
    fireEvent.click(screen.getByTestId("wizard-create"));
    await waitFor(() => expect(screen.getByTestId("wizard-api-key")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("wizard-next"));
    await waitFor(() => expect(screen.getByTestId("wizard-step-bind")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("wizard-skip"));
    await waitFor(() => expect(screen.getByTestId("wizard-step-config")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("wizard-next"));
    await waitFor(() => expect(screen.getByTestId("wizard-step-launch")).toBeInTheDocument());

    const block = screen.getByTestId("get-runner-block");
    // "Get the binary" is step zero — it must precede the secure-load block.
    const secureLoad = screen.getByTestId("wizard-secure-load");
    expect(block.compareDocumentPosition(secureLoad) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(
      within(block).getByTestId("get-runner-link-backplane-runner-darwin-arm64"),
    ).toHaveAttribute(
      "href",
      `${RUNNER_RELEASE.baseUrl}/v${RUNNER_RELEASE.version}/backplane-runner-darwin-arm64`,
    );
    expect(
      within(block).getByTestId("get-runner-link-backplane-runner-windows-amd64.exe").getAttribute("href"),
    ).toMatch(/\.exe$/);
    expect(within(block).getByTestId("get-runner-checksums")).toHaveAttribute(
      "href",
      `${RUNNER_RELEASE.baseUrl}/v${RUNNER_RELEASE.version}/SHA256SUMS`,
    );
  });
});
