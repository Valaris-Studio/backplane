// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { ColumnType } from "@/types/kanban";
import { ColumnHeader } from "../ColumnHeader";

const SLUG = "acme";
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;

function makeWorkspaceConfig(enforceDoneMergeGate: boolean) {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    pipeline_config: null,
    version: 1,
    enforce_done_merge_gate: enforceDoneMergeGate,
  };
}

// Resolves once the workspace-config response has actually been served — an
// absence assertion before that only proves "not rendered yet", which every
// implementation passes.
let configServed: Promise<void>;

function setup({
  workspaceEnforces,
  doneGateOverride,
  columnType = "done",
}: {
  workspaceEnforces: boolean;
  doneGateOverride: boolean | null;
  columnType?: ColumnType;
}) {
  let markServed!: () => void;
  configServed = new Promise<void>((resolve) => {
    markServed = resolve;
  });
  server.use(
    http.get(CONFIG_URL, () => {
      markServed();
      return HttpResponse.json(makeWorkspaceConfig(workspaceEnforces));
    }),
  );
  return renderWithProviders(
    <ColumnHeader
      name="Done"
      columnType={columnType}
      cardCount={0}
      slug={SLUG}
      doneGateOverride={doneGateOverride}
      onRename={vi.fn()}
      onTypeChange={vi.fn()}
      onDelete={vi.fn()}
      sortMode="position"
      onSortChange={vi.fn()}
    />,
  );
}

async function expectNoBadgeOnceConfigSettles() {
  await configServed;
  // The handler firing only means the response left MSW — React Query still
  // needs a tick to commit it. Without this the assertion races ahead of the
  // render that would have shown the badge.
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(
    screen.queryByTestId("column-done-gate-indicator"),
  ).not.toBeInTheDocument();
}

// The board's own enforce_done_merge_gate override wins outright over the
// workspace flag — mirroring the backend's resolution order. Only `null`
// (inherit) falls through to the workspace default.
describe("ColumnHeader — board done-gate override", () => {
  it("hides the badge when the board overrides the gate OFF, even with the workspace flag ON", async () => {
    setup({ workspaceEnforces: true, doneGateOverride: false });

    await expectNoBadgeOnceConfigSettles();
  });

  it("shows the badge when the board overrides the gate ON, even with the workspace flag OFF", async () => {
    setup({ workspaceEnforces: false, doneGateOverride: true });

    expect(
      await screen.findByTestId("column-done-gate-indicator"),
    ).toBeInTheDocument();
  });

  it("inherits the workspace flag when the override is null", async () => {
    setup({ workspaceEnforces: true, doneGateOverride: null });

    expect(
      await screen.findByTestId("column-done-gate-indicator"),
    ).toBeInTheDocument();
  });

  it("inherits an OFF workspace flag when the override is null", async () => {
    setup({ workspaceEnforces: false, doneGateOverride: null });

    await expectNoBadgeOnceConfigSettles();
  });

  it("never shows the badge on a non-done column, even with the override ON", async () => {
    setup({
      workspaceEnforces: true,
      doneGateOverride: true,
      columnType: "backlog",
    });

    await expectNoBadgeOnceConfigSettles();
  });
});
