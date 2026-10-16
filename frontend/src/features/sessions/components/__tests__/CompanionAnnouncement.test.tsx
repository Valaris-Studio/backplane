// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { CompanionInstallation } from "@/types/agent-session";
import { SLUG, stubAuthModes } from "../../__tests__/fixtures";
import { COMPANION_ANNOUNCEMENT_SEEN_KEY, CompanionAnnouncement } from "../CompanionAnnouncement";

function serveDevices(devices: Partial<CompanionInstallation>[]) {
  server.use(http.get("/api/me/companion/installations", () => HttpResponse.json(devices)));
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderOnDashboard(boardCount: number | undefined) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug"
        element={
          <>
            <CompanionAnnouncement boardCount={boardCount} />
            <LocationProbe />
          </>
        }
      />
      <Route path="/:slug/documentation/:section" element={<LocationProbe />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}`] } },
  );
}

async function settle() {
  // Give auth modes and devices a chance to answer before asserting absence.
  await waitFor(() => expect(screen.getByTestId("location")).toBeInTheDocument());
  await new Promise((resolve) => setTimeout(resolve, 50));
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("Companion announcement", () => {
  it("introduces Companion once to someone in an established workspace who has not paired a computer", async () => {
    stubAuthModes(true);
    serveDevices([]);
    renderOnDashboard(3);

    const dialog = await screen.findByRole("dialog", { name: "Meet Companion" });
    // The way to get Companion is in the dialog itself, not another page away.
    expect(within(dialog).getByTestId("get-companion")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("link", { name: "Setup guide" }));

    expect(screen.getByTestId("location")).toHaveTextContent(`/${SLUG}/documentation/capturing-sessions-with-companion`);
    expect(window.localStorage.getItem(COMPANION_ANNOUNCEMENT_SEEN_KEY)).toBe("1");
  });

  it("marks itself seen when the download is taken from it", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    stubAuthModes(true);
    serveDevices([]);
    renderOnDashboard(3);

    const dialog = await screen.findByRole("dialog", { name: "Meet Companion" });
    const download = within(dialog).getByRole("link", { name: "Download for macOS" });
    // jsdom cannot follow a file download; the click handler is what matters.
    download.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(download);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(COMPANION_ANNOUNCEMENT_SEEN_KEY)).toBe("1");
  });

  it("can be dismissed and stays dismissed", async () => {
    stubAuthModes(true);
    serveDevices([]);
    const first = renderOnDashboard(3);

    await screen.findByRole("dialog", { name: "Meet Companion" });
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("location")).toHaveTextContent(`/${SLUG}`);
    first.unmount();

    renderOnDashboard(3);
    await settle();
    expect(screen.queryByRole("dialog", { name: "Meet Companion" })).not.toBeInTheDocument();
  });

  it("stays quiet where this Backplane does not accept Companion sessions", async () => {
    stubAuthModes(false);
    serveDevices([]);
    renderOnDashboard(3);
    await settle();
    expect(screen.queryByRole("dialog", { name: "Meet Companion" })).not.toBeInTheDocument();
  });

  it("stays quiet for someone who already paired a computer", async () => {
    stubAuthModes(true);
    serveDevices([{ installation_id: "mac", name: "Mac", revoked_at: null }]);
    renderOnDashboard(3);
    await settle();
    expect(screen.queryByRole("dialog", { name: "Meet Companion" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(COMPANION_ANNOUNCEMENT_SEEN_KEY)).toBeNull();
  });

  it.each([
    ["a brand-new workspace, which gets the welcome instead", 0],
    ["a workspace whose summary has not loaded", undefined],
  ])("stays quiet in %s", async (_, boardCount) => {
    stubAuthModes(true);
    serveDevices([]);
    renderOnDashboard(boardCount);
    await settle();
    expect(screen.queryByRole("dialog", { name: "Meet Companion" })).not.toBeInTheDocument();
  });
});
