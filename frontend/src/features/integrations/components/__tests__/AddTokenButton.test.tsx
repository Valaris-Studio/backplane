// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AddTokenButton } from "../AddTokenButton";

const CONFIG_STATUS_PATH = "/api/integrations/config-status";

describe("AddTokenButton", () => {
  it("is enabled and fires onClick when token storage is configured", async () => {
    server.use(
      http.get(CONFIG_STATUS_PATH, () =>
        HttpResponse.json({
          github_oauth_configured: true,
          token_storage_configured: true,
        }),
      ),
    );
    const onClick = vi.fn();

    renderWithProviders(<AddTokenButton onClick={onClick} />);

    const button = await screen.findByRole("button", { name: /add token/i });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });

  it("is disabled with an operator-pointing tooltip when INTEGRATIONS_TOKEN_KEY is unset", async () => {
    // Same gate as ConnectGitHubButton: clicking would 503 server-side, and
    // the person seeing it cannot fix a platform env var — the tooltip has to
    // route them to whoever operates the deployment.
    server.use(
      http.get(CONFIG_STATUS_PATH, () =>
        HttpResponse.json({
          github_oauth_configured: false,
          token_storage_configured: false,
        }),
      ),
    );

    renderWithProviders(<AddTokenButton onClick={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add token/i })).toBeDisabled();
    });

    const wrapper = screen
      .getByRole("button", { name: /add token/i })
      .closest("span");
    expect(wrapper).not.toBeNull();
    fireEvent.mouseEnter(wrapper!.parentElement!);
    expect(
      await screen.findByText(/INTEGRATIONS_TOKEN_KEY/),
    ).toBeInTheDocument();
  });

  it("respects the disabled prop independently of configuration", async () => {
    server.use(
      http.get(CONFIG_STATUS_PATH, () =>
        HttpResponse.json({
          github_oauth_configured: true,
          token_storage_configured: true,
        }),
      ),
    );

    renderWithProviders(<AddTokenButton onClick={() => {}} disabled />);

    const button = await screen.findByRole("button", { name: /add token/i });
    expect(button).toBeDisabled();
  });
});
