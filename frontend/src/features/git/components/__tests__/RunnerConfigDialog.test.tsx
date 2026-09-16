// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerConfigDialog } from "../RunnerConfigDialog";

const SLUG = "acme";
const BOARD = "board-1";

function mockRunnerConfig(body: {
  runner_yaml?: string;
  mcp_config_json?: string;
  prerequisites?: string[];
}) {
  server.use(
    http.get(
      `/api/workspaces/${SLUG}/boards/${BOARD}/runner-config`,
      () =>
        HttpResponse.json({
          runner_yaml: "valaris:\n  workspace_slug: acme\n",
          mcp_config_json: '{"mcpServers":{}}',
          prerequisites: ["Agent key: export VALARIS_API_KEY"],
          ...body,
        }),
    ),
  );
}

describe("RunnerConfigDialog", () => {
  it("renders the host-prerequisites checklist from the backend", async () => {
    mockRunnerConfig({
      prerequisites: [
        "Agent key: export VALARIS_API_KEY before launch",
        "Team binding: the agent must belong to a team",
        "GitHub auth: run gh auth login",
      ],
    });

    renderWithProviders(
      <RunnerConfigDialog open onOpenChange={() => {}} slug={SLUG} boardId={BOARD} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/export VALARIS_API_KEY/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/team binding/i)).toBeInTheDocument();
    expect(screen.getByText(/gh auth login/i)).toBeInTheDocument();
  });

  it("offers both config files for download", async () => {
    mockRunnerConfig({});
    renderWithProviders(
      <RunnerConfigDialog open onOpenChange={() => {}} slug={SLUG} boardId={BOARD} />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /runner\.yaml/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /mcp-config\.json/i }),
    ).toBeInTheDocument();
  });

  it("does not fetch until the dialog is open", async () => {
    let hits = 0;
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/boards/${BOARD}/runner-config`,
        () => {
          hits += 1;
          return HttpResponse.json({
            runner_yaml: "",
            mcp_config_json: "",
            prerequisites: [],
          });
        },
      ),
    );

    renderWithProviders(
      <RunnerConfigDialog
        open={false}
        onOpenChange={() => {}}
        slug={SLUG}
        boardId={BOARD}
      />,
    );

    // Give any erroneous fetch a tick to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(hits).toBe(0);
  });
});
