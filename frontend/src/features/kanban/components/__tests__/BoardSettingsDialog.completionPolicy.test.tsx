// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { BoardSettingsDialog } from "../BoardSettingsDialog";
import type { Board } from "@/types/kanban";
vi.mock("@/hooks/useWorkspaceAdmin", () => ({ useWorkspaceAdmin: () => ({ isAdmin: true, role: "admin", isLoading: false }) }));
const url = "/api/workspaces/acme/boards/board-1";
const resolution = (policy: unknown) => ({ override: policy, workspace_policy: null, effective_policy: policy, origin: policy ? "board" : "legacy", policy_hash: null, capabilities: {}, incompatibilities: [], changes: [] });
function renderSettings() {
  renderWithProviders(<Routes><Route path="/:slug/boards/:boardId" element={<BoardSettingsDialog open board={{ id: "board-1", name: "Board", description: "", tags: [] } as unknown as Board} onOpenChange={() => {}} />} /></Routes>, { routerProps: { initialEntries: ["/acme/boards/board-1"] } });
}
describe("board settings completion policy", () => {
  it("previews the selected policy before save and persists it through the dedicated route", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const policies: unknown[] = [];
    server.use(
      http.get(`${url}/completion/policy`, () => HttpResponse.json(resolution(null))),
      http.post(`${url}/completion/policy/preview`, async ({ request }) => { const { policy } = await request.json() as { policy: unknown }; if (policy) await pending; return HttpResponse.json(resolution(policy)); }),
      http.put(`${url}/completion/policy`, async ({ request }) => { const { policy } = await request.json() as { policy: unknown }; policies.push(policy); return HttpResponse.json(resolution(policy)); }),
      http.patch(url, () => HttpResponse.json({ id: "board-1", name: "Board" })),
    );
    renderSettings();
    const agent = await screen.findByRole("button", { name: "Agent-managed" });
    await userEvent.setup().click(agent);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(policies).toHaveLength(0);
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(policies).toEqual([expect.objectContaining({ landing_actor: "agent", landing_methods: ["merge_queue"] })]));
  });
});
