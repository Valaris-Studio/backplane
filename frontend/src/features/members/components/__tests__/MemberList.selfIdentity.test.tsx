// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import {
  renderWithProviders,
  screen,
  within,
  userEvent,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { MemberList } from "../MemberList";
import type { WorkspaceMember, WorkspaceRole } from "@/types/member";

const SLUG = "test-workspace";

const OWNER: WorkspaceMember = {
  user_id: "u-owner",
  email: "owner@valaris.dev",
  name: "Olive Owner",
  role: "owner",
  joined_at: "2026-01-01T00:00:00Z",
};
const MEMBER: WorkspaceMember = {
  user_id: "u-member",
  email: "member@valaris.dev",
  name: "Mel Member",
  role: "member",
  joined_at: "2026-03-01T00:00:00Z",
};

// The whole point of this file: /me's id matches NO row, so anything keying the
// self-row off that id sees a stranger and skips the confirmation. Only the
// email cross-reference (the same one the role gate uses) finds the owner row.
const ME_ID_MATCHING_NO_ROW = "u-not-in-this-workspace";

function setupHandlers() {
  const patches: Array<{ userId: string; body: { role: WorkspaceRole } }> = [];
  server.use(
    http.get("/api/me", () =>
      HttpResponse.json({
        id: ME_ID_MATCHING_NO_ROW,
        email: OWNER.email,
        name: OWNER.name,
        avatar_url: null,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json([OWNER, MEMBER]),
    ),
    http.patch(
      `/api/workspaces/${SLUG}/members/:userId`,
      async ({ params, request }) => {
        const body = (await request.json()) as { role: WorkspaceRole };
        patches.push({ userId: params.userId as string, body });
        return HttpResponse.json({ ...OWNER, role: body.role });
      },
    ),
  );
  return { patches };
}

describe("MemberList self-row identity", () => {
  it("confirms a self-demotion resolved by email even when /me's id matches no row", async () => {
    const { patches } = setupHandlers();
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    const ownRowLabel = await screen.findByText("Olive Owner");
    const ownRow = within(
      ownRowLabel.closest("[data-stagger-item]") as HTMLElement,
    );
    await user.click(
      ownRow.getByRole("button", { name: /change workspace member role/i }),
    );
    await user.click(
      // Document-wide: the listbox portals to <body>, so it is no longer a
      // descendant of the row that owns it.
      within(screen.getByRole("listbox")).getByRole("option", { name: "admin" }),
    );

    await screen.findByRole("dialog", { name: /change your own role/i });
    expect(patches).toHaveLength(0);
  });
});
