// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ConnectGitHubButton } from "../ConnectGitHubButton";

const CONFIG_STATUS_PATH = "/api/integrations/config-status";

describe("ConnectGitHubButton", () => {
  it("is enabled when github OAuth is configured", async () => {
    server.use(
      http.get(CONFIG_STATUS_PATH, () =>
        HttpResponse.json({ github_oauth_configured: true }),
      ),
    );

    renderWithProviders(<ConnectGitHubButton slug="acme" />);

    const button = await screen.findByRole("button", { name: /connect github/i });
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("is disabled and shows the not-configured tooltip when OAuth env vars are missing", async () => {
    server.use(
      http.get(CONFIG_STATUS_PATH, () =>
        HttpResponse.json({ github_oauth_configured: false }),
      ),
    );

    renderWithProviders(<ConnectGitHubButton slug="acme" />);

    // The component re-renders once the config-status query resolves,
    // wrapping the button in a Tooltip and disabling it. Re-query each tick
    // so we observe the post-resolve state, not the initial-mount state.
    await waitFor(() => {
      const button = screen.getByRole("button", { name: /connect github/i });
      expect(button).toBeDisabled();
    });

    // Tooltip content is only mounted on hover (the local Tooltip primitive
    // toggles via onMouseEnter), so simulate the hover to assert the
    // not-configured copy actually surfaces to the user.
    const wrapper = screen
      .getByRole("button", { name: /connect github/i })
      .closest("span");
    expect(wrapper).not.toBeNull();
    fireEvent.mouseEnter(wrapper!.parentElement!);
    expect(
      await screen.findByText(/not configured by platform admin/i),
    ).toBeInTheDocument();
  });

  it("respects the disabled prop independently of OAuth configured state", async () => {
    server.use(
      http.get(CONFIG_STATUS_PATH, () =>
        HttpResponse.json({ github_oauth_configured: true }),
      ),
    );

    renderWithProviders(<ConnectGitHubButton slug="acme" disabled />);

    const button = await screen.findByRole("button", { name: /connect github/i });
    expect(button).toBeDisabled();
  });
});
