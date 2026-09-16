// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { SetupPage } from "../SetupPage";
import { api } from "@/lib/api";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

function mockSetupStatus(needsSetup: boolean) {
  vi.spyOn(api, "get").mockResolvedValue({
    data: { needs_setup: needsSetup },
  } as never);
}

function renderSetupRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/" element={<div>app-home</div>} />
    </Routes>,
    { routerProps: { initialEntries: ["/setup"] } },
  );
}

async function fillForm(email: string, password: string, confirm: string) {
  await userEvent.type(screen.getByLabelText(/email/i), email);
  await userEvent.type(screen.getByLabelText(/^password$/i), password);
  await userEvent.type(screen.getByLabelText(/confirm password/i), confirm);
}

const GOOD_PASSWORD = "correct horse battery staple";

describe("SetupPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the form when the instance needs setup", async () => {
    mockSetupStatus(true);
    renderSetupRoute();

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
  });

  it("leaves the setup route when the instance is already configured", async () => {
    mockSetupStatus(false);
    renderSetupRoute();

    expect(await screen.findByText("app-home")).toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it("blocks submission when the confirmation does not match", async () => {
    mockSetupStatus(true);
    const post = vi.spyOn(api, "post");
    renderSetupRoute();

    await screen.findByLabelText(/email/i);
    await fillForm("admin@example.com", GOOD_PASSWORD, "something else");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("submits and navigates into the app on success", async () => {
    mockSetupStatus(true);
    const post = vi.spyOn(api, "post").mockResolvedValue({
      data: { id: "u1", email: "admin@example.com" },
    } as never);
    renderSetupRoute();

    await screen.findByLabelText(/email/i);
    await fillForm("admin@example.com", GOOD_PASSWORD, GOOD_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/auth/setup", {
        email: "admin@example.com",
        password: GOOD_PASSWORD,
      });
    });
    expect(await screen.findByText("app-home")).toBeInTheDocument();
  });

  it("shows an error instead of a blank screen when the server rejects", async () => {
    mockSetupStatus(true);
    vi.spyOn(api, "post").mockRejectedValue(new Error("boom"));
    renderSetupRoute();

    await screen.findByLabelText(/email/i);
    await fillForm("admin@example.com", GOOD_PASSWORD, GOOD_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("app-home")).not.toBeInTheDocument();
  });
});
