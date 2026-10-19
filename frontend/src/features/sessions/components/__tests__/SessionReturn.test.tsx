// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";
import { ContextLink } from "@/components/shared/ContextLink";
import { act, screen, userEvent, waitFor } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { stubAuthModes } from "../../__tests__/fixtures";
import { SessionDetailPage } from "../SessionDetailPage";

const origin = "/acme/boards/board-1/notes?sort=updated&filter=handoff&note=note-17";
const destination = "/acme/sessions/session-17";

function mount(initialEntries = [origin]) {
  return renderBrowserNavigationRouter([
    { path: "/acme/boards/board-1/notes", element: <ContextLink id="note-17-evidence" to={destination}>Read selected note evidence</ContextLink> },
    { path: "/:slug/sessions/:sessionId", element: <SessionDetailPage /> },
    { path: "/acme/sessions", element: <h1>Workspace sessions</h1> },
  ], initialEntries[0]!);
}

beforeEach(() => stubAuthModes(false));

describe("SessionDetailPage return through the real router", () => {
  it("returns to the exact origin entry with its filters, selection and focused source link", async () => {
    const { router } = mount();
    const originKey = router.state.location.key;
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Read selected note evidence" }));
    await screen.findByRole("heading", { name: "Session capture is off here" });

    await user.click(screen.getByRole("link", { name: /My sessions|Return to/ }));

    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(origin));
    expect(router.state.location.key).toBe(originKey);
    expect(router.state.historyAction).toBe("POP");
    const source = screen.getByRole("link", { name: "Read selected note evidence" });
    expect(source).toBeVisible();
    expect(source).toHaveFocus();
    await act(async () => { await router.navigate(1); });
    await waitFor(() => expect(router.state.location.pathname).toBe(destination));
  });

  it("retains a canonical same-workspace fallback for a cold direct visit", async () => {
    const { router } = mount([destination]);
    await screen.findByRole("heading", { name: "Session capture is off here" });
    const back = screen.getByRole("link", { name: /My sessions|Return to/ });
    expect(back).toHaveAttribute("href", "/acme/sessions");
    await userEvent.click(back);
    expect(router.state.location.pathname).toBe("/acme/sessions");
  });
});
