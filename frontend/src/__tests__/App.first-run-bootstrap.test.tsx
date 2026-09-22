// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { renderWithProviders, screen, act } from "@/test/test-utils";
import { App } from "@/App";
import { api } from "@/lib/api";

// The fresh-instance bug: before the app knows whether it must redirect to
// /setup, the "/" route already mounts WorkspacesPage and AccountMenu, whose
// queries 403 on an empty users table and paint red console errors. While the
// bootstrap answers are undecided, no page query may leave the building.
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
vi.mock("@/hooks/use-reduced-motion", () => ({ useReducedMotion: () => true }));

describe("App first-run bootstrap", () => {
  beforeAll(async () => {
    // Cold module transformation is not part of the bootstrap behavior under test.
    await import("@/pages/documentation");
  });

  it.each(["/documentation", "/documentation/what-backplane-is"])(
    "keeps public docs available on fresh instances: %s",
    async (path) => {
      vi.spyOn(api, "get").mockImplementation(((url: string) => Promise.resolve({
        data: url === "/auth/setup-status" ? { needs_setup: true } : { modes: [] },
      })) as never);
      renderWithProviders(<App />, { routerProps: { initialEntries: [path] } });
      expect(await screen.findByRole("navigation", {
        name: /documentation sections/i,
      })).toBeInTheDocument();
      await act(async () => { await new Promise(r => setTimeout(r, 100)); });
      expect(screen.getByRole("navigation", {
        name: /documentation sections/i,
      })).toBeInTheDocument();
    },
  );
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fires no page queries while setup status is undecided", async () => {
    const requestedUrls: string[] = [];
    vi.spyOn(api, "get").mockImplementation(((url: string) => {
      requestedUrls.push(url);
      if (url === "/auth/setup-status" || url === "/auth/modes") {
        return new Promise(() => {});
      }
      return Promise.resolve({ data: [] });
    }) as never);

    renderWithProviders(<App />, { routerProps: { initialEntries: ["/"] } });

    expect(await screen.findByRole("status")).toBeInTheDocument();
    // Let the lazy route chunks flush — the window where WorkspacesPage and
    // AccountMenu would (wrongly) mount and fan out their queries.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    expect(requestedUrls).not.toContain("/workspaces");
    expect(requestedUrls).not.toContain("/me");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
