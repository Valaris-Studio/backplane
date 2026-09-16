// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";

// TDD spec for the member role control (card 0ba5769d). Assertions pin the
// en copy the implementer must add:
//   members.roleChanged        → "Role updated"
//   members.roleChangeFailed   → "Could not change the role. Please try again."
//   members.selfDemoteTitle    → "Change your own role?"
//   members.selfDemoteConfirm  → "You are lowering your own access in this
//                                 workspace. You may not be able to restore
//                                 it yourself."
//   a11y.members.changeRole    → "Change workspace member role"
//   errors.owner_role_owner_only → "Only an owner may manage the owner role."
//   errors.last_owner          → "A workspace cannot lose its last owner."
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
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
const ADMIN: WorkspaceMember = {
  user_id: "u-admin",
  email: "admin@valaris.dev",
  name: "Ada Admin",
  role: "admin",
  joined_at: "2026-02-01T00:00:00Z",
};
const MEMBER: WorkspaceMember = {
  user_id: "u-member",
  email: "member@valaris.dev",
  name: "Mel Member",
  role: "member",
  joined_at: "2026-03-01T00:00:00Z",
};
const VIEWER: WorkspaceMember = {
  user_id: "u-viewer",
  email: "viewer@valaris.dev",
  name: "Vic Viewer",
  role: "viewer",
  joined_at: "2026-04-01T00:00:00Z",
};
const MEMBERS = [OWNER, ADMIN, MEMBER, VIEWER];

const CHANGE_ROLE_NAME = /change workspace member role/i;

// useWorkspaceAdmin resolves the viewer's role by cross-referencing /me
// against the member list, so BOTH endpoints must be handled.
function setupHandlers(actingAs: WorkspaceMember) {
  let current = [...MEMBERS];
  const patches: Array<{ userId: string; body: { role: WorkspaceRole } }> = [];
  server.use(
    http.get("/api/me", () =>
      HttpResponse.json({
        id: actingAs.user_id,
        email: actingAs.email,
        name: actingAs.name,
        avatar_url: null,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json(current),
    ),
    http.patch(
      `/api/workspaces/${SLUG}/members/:userId`,
      async ({ params, request }) => {
        const body = (await request.json()) as { role: WorkspaceRole };
        const userId = params.userId as string;
        patches.push({ userId, body });
        current = current.map((m) =>
          m.user_id === userId ? { ...m, role: body.role } : m,
        );
        return HttpResponse.json(current.find((m) => m.user_id === userId));
      },
    ),
  );
  return { patches };
}

async function memberRow(name: string) {
  const label = await screen.findByText(name);
  const row = label.closest("[data-stagger-item]") as HTMLElement | null;
  expect(row).not.toBeNull();
  return within(row as HTMLElement);
}

async function openRoleSelect(
  user: ReturnType<typeof userEvent.setup>,
  rowName: string,
) {
  const row = await memberRow(rowName);
  await user.click(row.getByRole("button", { name: CHANGE_ROLE_NAME }));
  // Document-wide, not row-scoped: the listbox portals to <body>. Only one
  // can be open at a time, so the query stays unambiguous.
  return { row, listbox: screen.getByRole("listbox") };
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("MemberList role control visibility", () => {
  it("shows a role select with the owner option for an owner viewer", async () => {
    setupHandlers(OWNER);
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    const { listbox } = await openRoleSelect(user, "Mel Member");
    const options = within(listbox)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(
      expect.arrayContaining(["owner", "admin", "member", "viewer"]),
    );
  });

  it("hides the owner option from an admin viewer", async () => {
    setupHandlers(ADMIN);
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    const { listbox } = await openRoleSelect(user, "Mel Member");
    expect(
      within(listbox).queryByRole("option", { name: "owner" }),
    ).not.toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: "admin" }),
    ).toBeInTheDocument();
  });

  it("shows no role control to an admin viewer on an owner row", async () => {
    // Any owner-involving change is owner-only server-side; the UI must not
    // offer a control that can only end in a 403.
    setupHandlers(ADMIN);
    renderWithProviders(<MemberList slug={SLUG} />);

    // Positive control first: the admin DOES get the select on a member row,
    // so the owner-row absence below is gating, not a missing feature.
    const regularRow = await memberRow("Mel Member");
    expect(
      regularRow.getByRole("button", { name: CHANGE_ROLE_NAME }),
    ).toBeInTheDocument();

    const ownerRow = await memberRow("Olive Owner");
    expect(
      ownerRow.queryByRole("button", { name: CHANGE_ROLE_NAME }),
    ).not.toBeInTheDocument();
    // The read-only pill remains.
    expect(ownerRow.getByText("owner", { selector: "span" })).toBeInTheDocument();
  });

  // Behavior-preservation guard: green BEFORE implementation by design — the
  // non-admin view must stay exactly the pill DOM that exists today.
  it("shows only the read-only pill to a non-admin viewer", async () => {
    setupHandlers(MEMBER);
    renderWithProviders(<MemberList slug={SLUG} />);

    await memberRow("Olive Owner");
    expect(
      screen.queryAllByRole("button", { name: CHANGE_ROLE_NAME }),
    ).toHaveLength(0);
    const viewerRow = await memberRow("Vic Viewer");
    expect(
      viewerRow.getByText("viewer", { selector: "span" }),
    ).toBeInTheDocument();
  });
});

describe("MemberList role change", () => {
  it("sends no request when the same role is selected", async () => {
    const { patches } = setupHandlers(OWNER);
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    const { listbox } = await openRoleSelect(user, "Mel Member");
    await user.click(within(listbox).getByRole("option", { name: "member" }));

    // Let any (wrong) mutation settle before asserting nothing fired.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("PATCHes the new role, refetches the list, and toasts success", async () => {
    const { patches } = setupHandlers(OWNER);
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    const { listbox } = await openRoleSelect(user, "Mel Member");
    await user.click(within(listbox).getByRole("option", { name: "admin" }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      userId: "u-member",
      body: { role: "admin" },
    });

    // Invalidation refetches; MSW now serves Mel as admin.
    const row = await memberRow("Mel Member");
    await waitFor(() =>
      expect(row.getByText("admin", { selector: "span" })).toBeInTheDocument(),
    );
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/role updated/i),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("MemberList role change errors", () => {
  async function changeRoleTo(
    user: ReturnType<typeof userEvent.setup>,
    rowName: string,
    role: string,
  ) {
    const { listbox } = await openRoleSelect(user, rowName);
    await user.click(within(listbox).getByRole("option", { name: role }));
  }

  it("shows the owner-only message on a 403 with error_code owner_role_owner_only", async () => {
    setupHandlers(OWNER);
    server.use(
      http.patch(`/api/workspaces/${SLUG}/members/:userId`, () =>
        HttpResponse.json(
          {
            detail: "Only an owner may manage the owner role",
            error_code: "owner_role_owner_only",
          },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    await changeRoleTo(user, "Mel Member", "admin");

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/only an owner/i),
      ),
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/could not change the role/i),
    );
  });

  it("shows the last-owner message on a 403 with error_code last_owner", async () => {
    setupHandlers(OWNER);
    server.use(
      http.patch(`/api/workspaces/${SLUG}/members/:userId`, () =>
        HttpResponse.json(
          {
            detail: "Cannot demote the last owner of a workspace",
            error_code: "last_owner",
          },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    await changeRoleTo(user, "Mel Member", "admin");

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/last owner/i),
      ),
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringMatching(/could not change the role/i),
    );
  });

  it("falls back to the generic failure message on other errors", async () => {
    setupHandlers(OWNER);
    server.use(
      http.patch(`/api/workspaces/${SLUG}/members/:userId`, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    await changeRoleTo(user, "Mel Member", "admin");

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/could not change the role/i),
      ),
    );
  });
});

describe("MemberList self-demotion confirmation", () => {
  async function openOwnRoleSelectAsAdmin(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    const { listbox } = await openRoleSelect(user, "Ada Admin");
    await user.click(within(listbox).getByRole("option", { name: "member" }));
  }

  it("asks for confirmation before demoting yourself and proceeds on confirm", async () => {
    const { patches } = setupHandlers(ADMIN);
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    await openOwnRoleSelectAsAdmin(user);

    const dialog = await screen.findByRole("dialog", {
      name: /change your own role/i,
    });
    expect(patches).toHaveLength(0);
    expect(
      within(dialog).getByText(/lowering your own access/i),
    ).toBeInTheDocument();

    const confirm = within(dialog)
      .getAllByRole("button")
      .find((b) => !/cancel|close/i.test(b.textContent ?? ""));
    expect(confirm).toBeDefined();
    await user.click(confirm as HTMLElement);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      userId: "u-admin",
      body: { role: "member" },
    });
  });

  it("aborts the change when the confirmation is cancelled", async () => {
    const { patches } = setupHandlers(ADMIN);
    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    await openOwnRoleSelectAsAdmin(user);

    const dialog = await screen.findByRole("dialog", {
      name: /change your own role/i,
    });
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches).toHaveLength(0);
    expect(
      screen.queryByRole("dialog", { name: /change your own role/i }),
    ).not.toBeInTheDocument();
  });
});
