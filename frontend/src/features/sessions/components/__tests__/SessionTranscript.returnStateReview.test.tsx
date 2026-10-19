// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { ContextLink, ReturnLink } from "@/components/shared/ContextLink";
import { screen, userEvent, waitFor } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { contentPage, makeContent, makeSession } from "../../__tests__/fixtures";
import { contentWindowResponse } from "../../__tests__/window-fixtures";
import { SessionTranscript } from "../SessionTranscript";

const origin = "/acme/boards/board-1/notes?sort=updated&filter=handoff&note=note-17";
const destination = "/acme/sessions/session-17";
const session = makeSession({ id: "session-17", capture_levels: ["rich"] });
const records = [1, 2].map((order) => makeContent({
  id: `record-${order}`, session_id: session.id, source: { kind: "claude_transcript", order },
  preview: { text: `Captured evidence ${order}`, truncated: false },
}));

describe("SessionTranscript local hash navigation preserves its upstream return", () => {
  it.each(["jump to a loaded record", "leave the linked record"])("can %s and return to the original selected note", async (action) => {
    const bodyReads: string[] = [];
    server.use(
      http.get("/api/workspaces/acme/sessions/session-17/contents/window", ({ request }) =>
        contentWindowResponse([contentPage(records)], new URL(request.url).searchParams)),
      http.get("/api/workspaces/acme/sessions/session-17/contents/:id/body", ({ params }) => {
        bodyReads.push(String(params.id)); return HttpResponse.json({});
      }),
    );
    const target = destination + (action === "leave the linked record" ? "#content-record-1" : "");
    const { router, client } = renderBrowserNavigationRouter([
      { path: "/acme/boards/board-1/notes", element: <ContextLink id="selected-note-evidence" to={target}>Read note evidence</ContextLink> },
      { path: destination, element: <main>
        <ReturnLink to="/acme/sessions" returnLabel="Return to selected note">My sessions</ReturnLink>
        <SessionTranscript slug="acme" session={session} />
      </main> },
      { path: "/acme/sessions", element: <h1>Workspace sessions</h1> },
    ], origin);
    const originKey = router.state.location.key;
    const user = userEvent.setup();
    try {
      await user.click(screen.getByRole("link", { name: "Read note evidence" }));
      await screen.findByText("Captured evidence 2");
      const returnState = router.state.location.state;
      expect(returnState).toEqual({ bpReturn: { v: 1, originKey, originIdx: 0 } });
      expect(screen.getByRole("link", { name: "Return to selected note" })).toHaveAttribute("href", origin);
      if (action === "jump to a loaded record") {
        await user.selectOptions(screen.getByRole("combobox", { name: "Jump to loaded content" }), "record-2");
        await waitFor(() => expect(router.state.location.hash).toBe("#content-record-2"));
      } else {
        await user.click(screen.getByRole("button", { name: "Latest" }));
        await waitFor(() => expect(router.state.location.hash).toBe(""));
      }
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect(router.state.historyAction).toBe("REPLACE");
      expect(router.state.location.state).toEqual(returnState);
      expect(window.history.state.idx).toBe(1);
      await user.click(screen.getByRole("link", { name: "Return to selected note" }));
      await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(origin));
      expect(router.state.location.key).toBe(originKey);
      expect(router.state.historyAction).toBe("POP");
      await waitFor(() => expect(screen.getByRole("link", { name: "Read note evidence" })).toHaveFocus());
      expect(bodyReads).toEqual([]);
    } finally { client.clear(); }
  });
});
