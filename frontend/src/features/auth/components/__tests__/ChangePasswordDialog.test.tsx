// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ChangePasswordDialog } from "../ChangePasswordDialog";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

const ADA = {
  id: "u1",
  email: "ada@valaris.dev",
  name: "Ada Lovelace",
  avatar_url: null,
};

describe("ChangePasswordDialog", () => {
  beforeEach(() => {
    server.use(http.get("/api/me", () => HttpResponse.json(ADA)));
  });

  it("renders a hidden username field with the authenticated user's email for password managers", async () => {
    renderWithProviders(<ChangePasswordDialog open onOpenChange={() => {}} />);

    await screen.findByLabelText(/current password/i);

    // Password managers need a username field alongside new-password inputs
    // to associate the credential update with the right account.
    await waitFor(() => {
      const username = document.querySelector('input[autocomplete="username"]');
      expect(username).not.toBeNull();
      expect(username).toHaveValue(ADA.email);
    });
  });
});
