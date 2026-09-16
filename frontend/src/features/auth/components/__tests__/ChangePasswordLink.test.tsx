// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { ChangePasswordLink } from "../ChangePasswordLink";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

function mockModes(passwordEnabled: boolean) {
  vi.spyOn(api, "get").mockResolvedValue({
    data: {
      oidc_enabled: false,
      password_enabled: passwordEnabled,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    },
  } as never);
}

const CURRENT = "my old passphrase!";
const NEXT = "my brand new passphrase";

async function openDialogAndFill(current: string, next: string, confirm: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: /change password/i }),
  );
  await userEvent.type(screen.getByLabelText(/current password/i), current);
  await userEvent.type(screen.getByLabelText(/^new password$/i), next);
  await userEvent.type(screen.getByLabelText(/confirm password/i), confirm);
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
}

describe("ChangePasswordLink", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when password login is not enabled", async () => {
    mockModes(false);
    const { container } = renderWithProviders(<ChangePasswordLink />);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /change password/i }),
      ).not.toBeInTheDocument();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("blocks submission when the confirmation does not match", async () => {
    mockModes(true);
    const post = vi.spyOn(api, "post");
    renderWithProviders(<ChangePasswordLink />);

    await openDialogAndFill(CURRENT, NEXT, "something else");

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("submits current and new password and closes on success", async () => {
    mockModes(true);
    const post = vi
      .spyOn(api, "post")
      .mockResolvedValue({ data: undefined } as never);
    renderWithProviders(<ChangePasswordLink />);

    await openDialogAndFill(CURRENT, NEXT, NEXT);

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/auth/change-password", {
        current_password: CURRENT,
        new_password: NEXT,
      });
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
    });
  });

  it("shows a specific error when the current password is wrong", async () => {
    mockModes(true);
    vi.spyOn(api, "post").mockRejectedValue(
      new ApiError("Current password is incorrect", 400, {
        detail: "Current password is incorrect",
      }),
    );
    renderWithProviders(<ChangePasswordLink />);

    await openDialogAndFill("wrong old one", NEXT, NEXT);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /current password is incorrect/i,
    );
    expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
  });
});
