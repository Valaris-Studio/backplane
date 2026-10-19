// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { ContextLink } from "@/components/shared/ContextLink";
import { act, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { SessionTranscript } from "../components/SessionTranscript";
import { contentPage, makeContent, makeSession } from "./fixtures";
import { contentWindow, contentWindowResponse, selectedMetadata } from "./window-fixtures";

const slug = "acme";
const session = makeSession({ id: "filter-retention", capture_levels: ["rich"] });
const origin = `/${slug}/sessions/${session.id}`;
const sharedNote = `/${slug}/boards/shared-board/notes?note=shared-note`;
const contentsPath = `/api/workspaces/${slug}/sessions/${session.id}/contents`;

function serveWindows() {
  const rows = Array.from({ length: 260 }, (_, index) => makeContent({
    id: `record-${index + 1}`, session_id: session.id,
    channel: index === 150 ? "native_record" : "reply",
    source: { kind: "claude_transcript", order: index + 1 },
    occurred_at: new Date(Date.UTC(2026, 9, 18, 12, 0, index)).toISOString(),
    preview: { text: `Retained evidence ${index + 1}`, truncated: false },
  }));
  const pages = [contentPage(rows.slice(0, 100)), contentPage(rows.slice(100, 200)), contentPage(rows.slice(200))];
  const windows: URLSearchParams[] = [];
  const bodies: string[] = [];
  server.use(
    http.get(`${contentsPath}/window`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      windows.push(params);
      return contentWindowResponse(pages, params);
    }),
    http.post(`${contentsPath}/metadata`, async ({ request }) => {
      const payload = await request.json() as { content_ids: string[] };
      return HttpResponse.json(selectedMetadata(rows, payload.content_ids));
    }),
    http.get(`${contentsPath}/:id/body`, ({ params }) => {
      bodies.push(String(params.id));
      return HttpResponse.json({});
    }),
  );
  const middleCursor = contentWindow(pages, new URLSearchParams({ mode: "anchor", anchor_id: "record-152" })).window_cursor;
  return { windows, bodies, middleCursor };
}

describe("reader filter retention through local URL replacement and route unmount", () => {
  it.each(["jump to loaded record", "clear linked record", "no local URL replacement"] as const)(
    "retains Everything, the bounded window and selection after %s then shared work and Back",
    async (action) => {
      const state = serveWindows();
      const initialHash = action === "clear linked record" ? "#content-record-152" : "";
      const { router, client } = renderBrowserNavigationRouter([
        { path: origin, element: <main>
          <SessionTranscript slug={slug} session={session} />
          <ContextLink id="reader-related-note" to={sharedNote}>Open related note</ContextLink>
        </main> },
        { path: `/${slug}/boards/shared-board/notes`, element: <main><h1>Shared note</h1></main> },
      ], origin + initialHash);
      const user = userEvent.setup();
      try {
        await screen.findByText(action === "clear linked record" ? "Retained evidence 152" : "Retained evidence 260");
        const filterEntryKey = router.state.location.key;
        await user.click(screen.getByRole("button", { name: "Everything" }));
        await user.click(screen.getByRole("button", { name: "Beginning" }));
        await screen.findByText("Retained evidence 1");
        await user.click(screen.getByRole("button", { name: "Later records" }));
        await screen.findByText("Retained evidence 152");
        if (action === "jump to loaded record") {
          await user.selectOptions(screen.getByRole("combobox", { name: "Jump to loaded content" }), "record-152");
          await waitFor(() => expect(router.state.location.hash).toBe("#content-record-152"));
        }
        if (action === "no local URL replacement") expect(router.state.location.key).toBe(filterEntryKey);
        else expect(router.state.location.key).not.toBe(filterEntryKey);
        const returnEntry = router.state.location;
        const selected = () => within(document.getElementById("content-record-152")!).getByRole("checkbox");
        await user.click(selected());
        expect(selected()).toBeChecked();
        expect(screen.getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByText("Retained evidence 151")).toBeVisible();
        await waitFor(() => expect(client.isFetching()).toBe(0));
        const beforeReturn = state.windows.length;

        const link = screen.getByRole("link", { name: "Open related note" });
        expect(link).toHaveAttribute("href", sharedNote);
        await user.click(link);
        await screen.findByRole("heading", { name: "Shared note" });
        expect(screen.queryByRole("heading", { name: "Transcript" })).not.toBeInTheDocument();
        await act(async () => { await router.navigate(-1); });
        await waitFor(() => expect(router.state.location).toMatchObject({
          key: returnEntry.key, pathname: returnEntry.pathname, hash: returnEntry.hash,
        }));
        await screen.findByText("Retained evidence 152");
        await waitFor(() => expect(client.isFetching()).toBe(0));

        expect(router.state.historyAction).toBe("POP");
        expect(screen.getByText("Retained evidence 101")).toBeVisible();
        expect(screen.getByText("Retained evidence 200")).toBeVisible();
        expect(screen.queryByText("Retained evidence 260")).not.toBeInTheDocument();
        expect(selected()).toBeChecked();
        expect(state.windows.slice(beforeReturn).some((params) => params.get("mode") === "refresh" && params.get("cursor") === state.middleCursor)).toBe(true);
        expect(state.bodies).toEqual([]);
        expect(screen.getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByText("Retained evidence 151")).toBeVisible();
      } finally { client.clear(); }
    },
  );

  it("restores each same-session entry's own filter on Back and Forward without remounting the reader", async () => {
    const state = serveWindows();
    const { router, client } = renderBrowserNavigationRouter([
      { path: origin, element: <main>
        <SessionTranscript slug={slug} session={session} />
        <ContextLink id="second-reader-entry" to={`${origin}?reading=second#content-record-152`}>Open another view of this session</ContextLink>
      </main> },
    ], `${origin}#content-record-152`);
    const user = userEvent.setup();
    try {
      await screen.findByText("Retained evidence 152");
      const readerHeading = screen.getByRole("heading", { name: "Transcript" });
      const firstKey = router.state.location.key;
      await user.click(screen.getByRole("button", { name: "Everything" }));
      expect(screen.getByText("Retained evidence 151")).toBeVisible();
      await user.click(screen.getByRole("link", { name: "Open another view of this session" }));
      expect(router.state.historyAction).toBe("PUSH");
      const secondKey = router.state.location.key;
      expect(secondKey).not.toBe(firstKey);
      expect(screen.getByRole("heading", { name: "Transcript" })).toBe(readerHeading);
      expect(screen.getByRole("button", { name: "Conversation" })).toHaveAttribute("aria-pressed", "true");
      // Commit a distinct choice in the second entry, rather than relying only
      // on its default, then prove neither POP overwrites the other entry.
      await user.click(screen.getByRole("button", { name: "Everything" }));
      await user.click(screen.getByRole("button", { name: "Conversation" }));

      await act(async () => { await router.navigate(-1); });
      await waitFor(() => expect(router.state.location.key).toBe(firstKey));
      expect(router.state.historyAction).toBe("POP");
      expect(screen.getByRole("heading", { name: "Transcript" })).toBe(readerHeading);
      expect(screen.getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Retained evidence 151")).toBeVisible();

      await act(async () => { await router.navigate(1); });
      await waitFor(() => expect(router.state.location.key).toBe(secondKey));
      expect(router.state.historyAction).toBe("POP");
      expect(screen.getByRole("heading", { name: "Transcript" })).toBe(readerHeading);
      expect(screen.getByRole("button", { name: "Conversation" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByText("Retained evidence 151")).not.toBeInTheDocument();
      expect(state.bodies).toEqual([]);
    } finally { client.clear(); }
  });
});
