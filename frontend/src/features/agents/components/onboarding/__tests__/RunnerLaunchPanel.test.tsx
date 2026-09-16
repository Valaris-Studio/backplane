// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerLaunchPanel } from "../RunnerLaunchPanel";
import { RUNNER_RELEASE } from "@/lib/runner-release";

beforeAll(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = vi.fn(() => "blob:x");
    window.URL.revokeObjectURL = vi.fn();
  }
});

const SLUG = "launch-ws";

function board(id: string, name: string) {
  return { id, slug: id, name, description: "", workspace_id: "w", columns: [] };
}

function mockBoards(boards: ReturnType<typeof board>[]) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json(boards)),
  );
}

function mockRunnerConfig(boardId: string) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/boards/${boardId}/runner-config`, () =>
      HttpResponse.json({
        runner_yaml: "valaris:\n  workspace_slug: launch-ws\n",
        mcp_config_json: "{}",
        prerequisites: ["Go 1.22 on PATH", "GitHub auth: run gh auth login"],
      }),
    ),
  );
}

describe("RunnerLaunchPanel", () => {
  it("renders prerequisites and both config downloads for the selected board", async () => {
    mockBoards([board("b1", "Board One")]);
    mockRunnerConfig("b1");

    renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    await waitFor(() =>
      expect(screen.getByText(/Go 1\.22 on PATH/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId("download-agent-config")).toBeInTheDocument();
    expect(screen.getByTestId("download-mcp-config")).toBeInTheDocument();
  });

  it("shows a launch command with the api-key placeholder and the runner-named yaml", async () => {
    mockBoards([board("b1", "Board One")]);
    mockRunnerConfig("b1");

    renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    const command = await screen.findByTestId("launch-command");
    // Existing runner → raw key is NOT re-shown; the command uses the env
    // placeholder and the runner-named config file.
    expect(command).toHaveTextContent(/\$VALARIS_API_KEY/);
    expect(command).toHaveTextContent(/runner-frogger\.yaml/);
  });

  it("teaches the interactive wizard path alongside the headless command", async () => {
    mockBoards([board("b1", "Board One")]);
    mockRunnerConfig("b1");

    renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    const interactive = await screen.findByTestId("launch-command-interactive");
    // The bare binary launches the TUI setup wizard; no -config flag.
    expect(interactive).toHaveTextContent("./backplane-runner");
    expect(interactive).not.toHaveTextContent(/-config/);
    expect(screen.getByTestId("launch-command")).toHaveTextContent(/-config runner-frogger\.yaml/);
  });

  it("never claims the wizard auto-discovers the runner-named bundle files", async () => {
    mockBoards([board("b1", "Board One")]);
    mockRunnerConfig("b1");

    const { container } = renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    await screen.findByTestId("launch-command-interactive");
    // The wizard's discovery only ever matches `runner.yaml` / `mcp-config.json`,
    // never the export bundle's runner-<name>.yaml — copy must not imply otherwise.
    const interactiveBlock = container.querySelector(
      "[data-testid='launch-interactive-block']",
    );
    expect(interactiveBlock?.textContent ?? "").not.toMatch(/runner-frogger\.yaml/);
    expect(interactiveBlock?.textContent ?? "").not.toMatch(/mcp-config-/);
  });

  it("shows the api-key rotation note (key revealed once at creation)", async () => {
    mockBoards([board("b1", "Board One")]);
    mockRunnerConfig("b1");

    renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    await waitFor(() =>
      expect(screen.getByText(/rotate/i)).toBeInTheDocument(),
    );
  });

  it("hides the board picker when there is only one board", async () => {
    mockBoards([board("b1", "Board One")]);
    mockRunnerConfig("b1");

    renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    await screen.findByTestId("launch-command");
    expect(screen.queryByTestId("launch-board-picker")).not.toBeInTheDocument();
  });

  it("requests runner-scoped config (agent_id) so create/bind prereqs drop out", async () => {
    mockBoards([board("b1", "Board One")]);
    let requestedAgentId: string | null = null;
    server.use(
      http.get(`/api/workspaces/${SLUG}/boards/b1/runner-config`, ({ request }) => {
        requestedAgentId = new URL(request.url).searchParams.get("agent_id");
        return HttpResponse.json({
          runner_yaml: "valaris:\n",
          mcp_config_json: "{}",
          prerequisites: ["GitHub auth: run gh auth login"],
        });
      }),
    );

    renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    // Wait for the prereq (which comes from the config RESPONSE) — the launch
    // command renders from the agent name alone, before the fetch lands.
    await waitFor(() =>
      expect(screen.getByText(/gh auth login/)).toBeInTheDocument(),
    );
    expect(requestedAgentId).toBe("ag-1");
  });

  it("shows the board picker when there is more than one board", async () => {
    mockBoards([board("b1", "Board One"), board("b2", "Board Two")]);
    mockRunnerConfig("b1");

    renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    await waitFor(() =>
      expect(screen.getByTestId("launch-board-picker")).toBeInTheDocument(),
    );
  });
});

describe("RunnerLaunchPanel get-the-runner block", () => {
  it("offers the pinned release downloads above the config files", async () => {
    mockBoards([board("b1", "Board One")]);
    mockRunnerConfig("b1");

    renderWithProviders(
      <RunnerLaunchPanel slug={SLUG} agentId="ag-1" agentName="frogger" />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    const block = await screen.findByTestId("get-runner-block");
    expect(
      within(block).getByTestId("get-runner-link-backplane-runner-darwin-arm64"),
    ).toHaveAttribute(
      "href",
      `${RUNNER_RELEASE.baseUrl}/v${RUNNER_RELEASE.version}/backplane-runner-darwin-arm64`,
    );
    expect(
      within(block).getByTestId("get-runner-link-backplane-runner-windows-arm64.exe").getAttribute("href"),
    ).toMatch(/\.exe$/);
    expect(within(block).getByTestId("get-runner-checksums")).toHaveAttribute(
      "href",
      `${RUNNER_RELEASE.baseUrl}/v${RUNNER_RELEASE.version}/SHA256SUMS`,
    );
  });
});
