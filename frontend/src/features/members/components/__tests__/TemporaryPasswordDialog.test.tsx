// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { TemporaryPasswordDialog } from "../TemporaryPasswordDialog";
import { api } from "@/lib/api";
import type { WorkspaceMember } from "@/types/member";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

const MEMBER: WorkspaceMember = {
  user_id: "11111111-1111-1111-1111-111111111111",
  email: "pat@example.com",
  name: "Pat",
  role: "member",
  joined_at: "2026-07-01T00:00:00Z",
};

describe("TemporaryPasswordDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("generates a temporary password and shows it once", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({
      data: { temporary_password: "generated-secret-16" },
    } as never);

    renderWithProviders(
      <TemporaryPasswordDialog
        slug="acme"
        member={MEMBER}
        onOpenChange={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        `/workspaces/acme/members/${MEMBER.user_id}/temporary-password`,
        {},
      );
    });
    expect(await screen.findByText("generated-secret-16")).toBeInTheDocument();
  });

  it("shows an error instead of a secret when the server rejects", async () => {
    vi.spyOn(api, "post").mockRejectedValue(new Error("forbidden"));

    renderWithProviders(
      <TemporaryPasswordDialog
        slug="acme"
        member={MEMBER}
        onOpenChange={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /generate/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
