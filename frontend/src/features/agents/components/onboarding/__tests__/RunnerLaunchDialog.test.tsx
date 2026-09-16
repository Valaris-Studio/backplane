// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerLaunchDialog } from "../RunnerLaunchDialog";

beforeAll(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = vi.fn(() => "blob:x");
    window.URL.revokeObjectURL = vi.fn();
  }
});

const SLUG = "dlg-ws";

function mockBackend() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json([
        { id: "b1", slug: "b1", name: "Board One", description: "", workspace_id: "w", columns: [] },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/b1/runner-config`, () =>
      HttpResponse.json({
        runner_yaml: "y:1",
        mcp_config_json: "{}",
        prerequisites: ["Go 1.22"],
      }),
    ),
  );
}

describe("RunnerLaunchDialog", () => {
  it("renders the panel with the runner name in the title when open", async () => {
    mockBackend();
    renderWithProviders(
      <RunnerLaunchDialog
        slug={SLUG}
        agentId="ag-1"
        agentName="frogger"
        open
        onOpenChange={() => {}}
      />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    // Title carries the runner name; the panel's launch command mounts inside.
    // The accessible name proves both that the dialog opened and that it is
    // this runner's dialog, in one query.
    await screen.findByRole("dialog", { name: /launch frogger/i });
    expect(await screen.findByTestId("launch-command")).toHaveTextContent(
      /runner-frogger\.yaml/,
    );
  });

  it("does not render the panel when closed", () => {
    mockBackend();
    renderWithProviders(
      <RunnerLaunchDialog
        slug={SLUG}
        agentId="ag-1"
        agentName="frogger"
        open={false}
        onOpenChange={() => {}}
      />,
      { routerProps: { initialEntries: [`/${SLUG}/runner/runners/ag-1`] } },
    );

    expect(screen.queryByTestId("launch-command")).not.toBeInTheDocument();
  });
});
