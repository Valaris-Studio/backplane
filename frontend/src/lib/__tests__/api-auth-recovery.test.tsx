// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, stubReducedMotion } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { api } from "../api";
import { ResourceList } from "@/features/resources/components/ResourceList";
import { redirectToLogin, setLoginAvailable } from "@/features/auth/redirect-to-login";

vi.mock("@/features/auth/redirect-to-login", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  redirectToLogin: vi.fn(),
}));
vi.mock("@/features/resources/api/use-resources", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useResources: () => ({ data: [{ id: "r1", name: "notes.txt", resource_type: "file", gcs_path: "test/notes.txt", metadata: { tags: [] }, updated_at: "2026-09-10T00:00:00Z" }], isLoading: false }),
  useTags: () => ({ data: [] }),
}));

beforeEach(() => { setLoginAvailable(true); vi.mocked(redirectToLogin).mockClear(); stubReducedMotion(true); });
afterEach(() => setLoginAvailable(false));

describe("API auth/authorization recovery", () => {
  it("keeps resource permission failures in context and allows retry with local login enabled", async () => {
    let forbidden = true;
    server.use(
      http.get("/api/workspaces/acme/resources/r1/download-url", () => forbidden
        ? HttpResponse.json({ detail: "Permission denied", error_code: "forbidden" }, { status: 403 })
        : HttpResponse.json({ download_url: "/recovered-resource" })),
      http.get("/recovered-resource", () => HttpResponse.text("Recovered resource")),
    );
    renderWithProviders(<ResourceList slug="acme" />);
    const user = userEvent.setup();
    await user.click(screen.getByText("notes.txt"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/notes.txt/);
    expect(redirectToLogin).not.toHaveBeenCalled();
    forbidden = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered resource")).toBeInTheDocument();
  });

  it.each(["authentication_required", "session_invalid", "session_user_not_found"])("redirects real session rejection %s", async (error_code) => {
    server.use(http.get("/api/me", () => HttpResponse.json({ detail: "Session rejected", error_code }, { status: 403 })));
    await expect(api.get("/me")).rejects.toMatchObject({ status: 403, errorCode: error_code });
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });

  it.each(["forbidden", "unknown_permission", undefined])("does not treat authorization code %s as a lost session", async (error_code) => {
    server.use(http.get("/api/me", () => HttpResponse.json({ detail: "Denied", error_code }, { status: 403 })));
    await expect(api.get("/me")).rejects.toMatchObject({ status: 403 });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it("still redirects 401 authentication failures", async () => {
    server.use(http.get("/api/me", () => HttpResponse.json({ error_code: "invalid_credentials" }, { status: 401 })));
    await expect(api.get("/me")).rejects.toMatchObject({ status: 401 });
    expect(redirectToLogin).toHaveBeenCalledOnce();
  });
});
