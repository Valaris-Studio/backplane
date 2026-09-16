// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";

// Structural contract for member row alignment: rows are flex with
// CONDITIONAL trailing controls (select vs pill, delete button absent on
// owner rows), so the controls drift column-wise from row to row. The fix
// pins two slots on EVERY row:
//   [data-slot="member-role"]    — one fixed-width home for select OR pill
//   [data-slot="member-actions"] — trailing controls, present even when empty
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { MemberList } from "../MemberList";
import type { WorkspaceMember } from "@/types/member";

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
const MEMBERS = [OWNER, ADMIN, MEMBER];

// Acting as ADMIN yields all three row variants at once: the owner row shows
// the read-only pill (owner changes are owner-only), the admin/member rows
// show the role select, and only non-owner rows get a delete button.
function setupHandlers(actingAs: WorkspaceMember) {
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
      HttpResponse.json(MEMBERS),
    ),
  );
}

async function allRows() {
  await screen.findByText("Olive Owner");
  return Array.from(
    document.querySelectorAll("[data-stagger-item]"),
  ) as HTMLElement[];
}

async function rowOf(name: string) {
  const label = await screen.findByText(name);
  const row = label.closest("[data-stagger-item]") as HTMLElement | null;
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function slotIn(row: HTMLElement, slot: string) {
  const el = row.querySelector(`[data-slot="${slot}"]`) as HTMLElement | null;
  expect(el, `row is missing [data-slot="${slot}"]`).not.toBeNull();
  return el as HTMLElement;
}

describe("MemberList row alignment slots", () => {
  it("gives every row a member-role slot sharing one fixed-width class across select and pill rows", async () => {
    setupHandlers(ADMIN);
    renderWithProviders(<MemberList slug={SLUG} />);

    const rows = await allRows();
    expect(rows).toHaveLength(MEMBERS.length);
    const slots = rows.map((row) => slotIn(row, "member-role"));

    // Both control variants live inside the slot: select on the member row,
    // pill on the owner row.
    const memberSlot = slotIn(await rowOf("Mel Member"), "member-role");
    expect(
      within(memberSlot).getByRole("button", {
        name: /change workspace member role/i,
      }),
    ).toBeInTheDocument();
    const ownerSlot = slotIn(await rowOf("Olive Owner"), "member-role");
    expect(
      within(ownerSlot).getByText("owner", { selector: "span" }),
    ).toBeInTheDocument();

    // Identical className on every slot — one shared fixed width, so the
    // controls column lines up regardless of which variant a row renders.
    const classNames = new Set(slots.map((slot) => slot.className));
    expect(classNames.size).toBe(1);
    expect([...classNames][0]).toMatch(/\bw-/);
  });

  it("reserves a member-actions slot on every row, including owner rows without a delete button", async () => {
    setupHandlers(ADMIN);
    renderWithProviders(<MemberList slug={SLUG} />);

    const rows = await allRows();
    expect(rows).toHaveLength(MEMBERS.length);
    rows.forEach((row) => slotIn(row, "member-actions"));

    const ownerActions = slotIn(await rowOf("Olive Owner"), "member-actions");
    expect(
      within(ownerActions).queryByRole("button", {
        name: /remove workspace member/i,
      }),
    ).not.toBeInTheDocument();

    const memberActions = slotIn(await rowOf("Mel Member"), "member-actions");
    expect(
      within(memberActions).getByRole("button", {
        name: /remove workspace member/i,
      }),
    ).toBeInTheDocument();
  });
});
