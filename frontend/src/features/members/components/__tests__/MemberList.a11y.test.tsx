// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { MemberList } from "../MemberList";
import type { WorkspaceMember } from "@/types/member";

const SLUG = "test-workspace";

const MEMBERS: WorkspaceMember[] = [
  {
    user_id: "u-owner",
    email: "owner@valaris.dev",
    name: "Owner User",
    role: "owner",
    joined_at: "2026-01-01T00:00:00Z",
  },
  {
    user_id: "u-member",
    email: "member@valaris.dev",
    name: "Regular Member",
    role: "member",
    joined_at: "2026-02-01T00:00:00Z",
  },
];

describe("MemberList accessibility", () => {
  it("exposes an accessible name on the remove member button", async () => {
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/members`,
        () => HttpResponse.json(MEMBERS),
      ),
    );

    renderWithProviders(<MemberList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Regular Member")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /remove workspace member/i }),
    ).toBeInTheDocument();
  });

  it("exposes an accessible name on the role select trigger", async () => {
    // The role control only appears for admin/owner viewers, so this suite
    // (unlike the remove-button test) must resolve the viewer via /api/me.
    server.use(
      http.get("/api/me", () =>
        HttpResponse.json({
          id: "u-owner",
          email: "owner@valaris.dev",
          name: "Owner User",
          avatar_url: null,
        }),
      ),
      http.get(
        `/api/workspaces/${SLUG}/members`,
        () => HttpResponse.json(MEMBERS),
      ),
    );

    renderWithProviders(<MemberList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Regular Member")).toBeInTheDocument();
    });

    // a11y.members.changeRole — an icon-less Select trigger still needs a name.
    expect(
      screen.getAllByRole("button", { name: /change workspace member role/i })
        .length,
    ).toBeGreaterThan(0);
  });
});
