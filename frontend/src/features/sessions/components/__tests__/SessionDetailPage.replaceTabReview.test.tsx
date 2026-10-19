// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { ContextLink } from "@/components/shared/ContextLink";
import { act, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { SessionDetailPage } from "../SessionDetailPage";
import { callPage, contentPage, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { contentWindow, contentWindowResponse, selectedMetadata } from "../../__tests__/window-fixtures";

const slug = "acme";
const session = makeSession({ id: "tab-retention", title: "Reader tab review", capture_levels: ["rich"] });
const origin = `/${slug}/sessions/${session.id}`;
const sharedNote = `/${slug}/boards/shared-board/notes?note=shared-note`;
const apiPath = `/api/workspaces/${slug}/sessions/${session.id}`;

function mount() {
  stubAuthModes(true);
  const rows = Array.from({ length: 220 }, (_, index) => makeContent({
    id: `record-${index + 1}`, session_id: session.id, source: { kind: "claude_transcript", order: index + 1 },
    occurred_at: new Date(Date.UTC(2026, 9, 18, 12, 0, index)).toISOString(),
    preview: { text: `Tab evidence ${index + 1}`, truncated: false },
  }));
  const pages = [contentPage(rows.slice(0, 100)), contentPage(rows.slice(100, 200)), contentPage(rows.slice(200))];
  const windows: URLSearchParams[] = [];
  const bodies: string[] = [];
  server.use(
    http.get(`/api/workspaces/${slug}/boards`, () => HttpResponse.json([])),
    http.get(apiPath, () => HttpResponse.json(session)),
    http.get(`${apiPath}/calls`, () => HttpResponse.json(callPage([], []))),
    http.get(`${apiPath}/usage`, () => HttpResponse.json({ items: [], price_table_version: "synthetic" })),
    http.get(`${apiPath}/links`, () => HttpResponse.json({ items: [] })),
    http.get(`${apiPath}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`${apiPath}/rhythm`, () => HttpResponse.json({ start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get(`${apiPath}/contents/window`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      windows.push(params);
      return contentWindowResponse(pages, params);
    }),
    http.post(`${apiPath}/contents/metadata`, async ({ request }) => {
      const payload = await request.json() as { content_ids: string[] };
      return HttpResponse.json(selectedMetadata(rows, payload.content_ids));
    }),
    http.get(`${apiPath}/contents/:id/body`, ({ params }) => {
      bodies.push(String(params.id));
      return HttpResponse.json({});
    }),
  );
  const rendered = renderBrowserNavigationRouter([
    { path: "/:slug/sessions/:sessionId", element: <main>
      <SessionDetailPage />
      <ContextLink id="tab-related-note" to={sharedNote}>Open related note</ContextLink>
      <ContextLink id="tab-second-entry" to={`${origin}?reading=second#content-record-152`}>Open another reader entry</ContextLink>
    </main> },
    { path: `/${slug}/boards/shared-board/notes`, element: <main><h1>Shared note</h1></main> },
  ], `${origin}#content-record-152`);
  const beginningCursor = contentWindow(pages, new URLSearchParams({ mode: "beginning" })).window_cursor;
  return { ...rendered, windows, bodies, beginningCursor };
}

function sessionTabs(container: HTMLElement) {
  return within(within(container).getByRole("tablist", { name: "Session sections" }));
}

function expectTranscriptVisible(container: HTMLElement) {
  const tab = sessionTabs(container).getByRole("tab", { name: "Transcript" });
  expect(tab).toHaveAttribute("aria-selected", "true");
  const panel = document.getElementById(tab.getAttribute("aria-controls")!);
  expect(panel).not.toHaveAttribute("hidden");
  expect(panel).toBeVisible();
}

describe("full session page tab across browser entry replacement", () => {
  it("retains Transcript after Beginning clears the content hash with REPLACE, then departure and Back", async (context) => {
    const { router, client, container, unmount, windows, bodies, beginningCursor } = mount();
    context.onTestFinished(() => { unmount(); client.clear(); });
    const view = within(container);
    const user = userEvent.setup();
    try {
      await view.findByText("Tab evidence 152");
      context.signal.throwIfAborted();
      expectTranscriptVisible(container);
      const originalKey = router.state.location.key;
      const navigation = within(view.getByRole("navigation", { name: "Captured records" }));
      await user.click(navigation.getByRole("button", { name: "Beginning" }));
      context.signal.throwIfAborted();
      await view.findByText("Tab evidence 1");
      context.signal.throwIfAborted();
      expect(router.state.historyAction).toBe("REPLACE");
      expect(router.state.location.hash).toBe("");
      expect(router.state.location.key).not.toBe(originalKey);
      expectTranscriptVisible(container);
      const replacedKey = router.state.location.key;
      await waitFor(() => expect(client.isFetching()).toBe(0));
      context.signal.throwIfAborted();
      const readsBeforeReturn = windows.length;
      await user.click(view.getByRole("link", { name: "Open related note" }));
      context.signal.throwIfAborted();
      await view.findByRole("heading", { name: "Shared note" });
      context.signal.throwIfAborted();
      expect(screen.queryByRole("tab", { name: "Transcript" })).not.toBeInTheDocument();
      await act(async () => { context.signal.throwIfAborted(); await router.navigate(-1); });
      context.signal.throwIfAborted();
      await waitFor(() => sessionTabs(container).getByRole("tab", { name: "Transcript" }));
      context.signal.throwIfAborted();
      expect(router.state.historyAction).toBe("POP");
      expect(router.state.location).toMatchObject({ key: replacedKey, pathname: origin, hash: "" });
      expectTranscriptVisible(container);
      expect(await view.findByText("Tab evidence 1")).toBeVisible();
      context.signal.throwIfAborted();
      expect(view.getByText("Tab evidence 100")).toBeVisible();
      expect(screen.queryByText("Tab evidence 220")).not.toBeInTheDocument();
      expect(windows.slice(readsBeforeReturn).some((params) => params.get("mode") === "refresh" && params.get("cursor") === beginningCursor)).toBe(true);
      expect(bodies).toEqual([]);
    } finally { client.clear(); }
  });

  it("positive control: an unchanged content-hash entry retains Transcript through Back and Forward", async (context) => {
    const { router, client, container, unmount, bodies } = mount();
    context.onTestFinished(() => { unmount(); client.clear(); });
    const view = within(container);
    const user = userEvent.setup();
    try {
      await view.findByText("Tab evidence 152");
      context.signal.throwIfAborted();
      expectTranscriptVisible(container);
      const firstKey = router.state.location.key;
      await user.click(view.getByRole("link", { name: "Open related note" }));
      context.signal.throwIfAborted();
      await view.findByRole("heading", { name: "Shared note" });
      context.signal.throwIfAborted();
      const noteKey = router.state.location.key;
      await act(async () => { context.signal.throwIfAborted(); await router.navigate(-1); });
      context.signal.throwIfAborted();
      await view.findByText("Tab evidence 152");
      context.signal.throwIfAborted();
      expect(router.state.location.key).toBe(firstKey);
      expectTranscriptVisible(container);
      await act(async () => { context.signal.throwIfAborted(); await router.navigate(1); });
      context.signal.throwIfAborted();
      await view.findByRole("heading", { name: "Shared note" });
      context.signal.throwIfAborted();
      expect(router.state.location.key).toBe(noteKey);
      await act(async () => { context.signal.throwIfAborted(); await router.navigate(-1); });
      context.signal.throwIfAborted();
      await view.findByText("Tab evidence 152");
      context.signal.throwIfAborted();
      expectTranscriptVisible(container);
      expect(bodies).toEqual([]);
    } finally { client.clear(); }
  });

  it("keeps distinct same-mounted entry tabs on PUSH, Back and Forward instead of carrying one choice to every key", async (context) => {
    const { router, client, container, unmount, bodies } = mount();
    context.onTestFinished(() => { unmount(); client.clear(); });
    const view = within(container);
    const user = userEvent.setup();
    try {
      await view.findByText("Tab evidence 152");
      context.signal.throwIfAborted();
      const tabs = sessionTabs(container);
      await user.click(tabs.getByRole("tab", { name: "Timeline" }));
      context.signal.throwIfAborted();
      expect(tabs.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
      const firstKey = router.state.location.key;
      const firstTab = tabs.getByRole("tab", { name: "Timeline" });
      await user.click(view.getByRole("link", { name: "Open another reader entry" }));
      context.signal.throwIfAborted();
      expect(router.state.historyAction).toBe("PUSH");
      const secondKey = router.state.location.key;
      expect(secondKey).not.toBe(firstKey);
      expect(tabs.getByRole("tab", { name: "Timeline" })).toBe(firstTab);
      expectTranscriptVisible(container);
      // Save an explicit second-entry choice, not only the content-hash default.
      await user.click(tabs.getByRole("tab", { name: "Timeline" }));
      context.signal.throwIfAborted();
      await user.click(tabs.getByRole("tab", { name: "Transcript" }));
      context.signal.throwIfAborted();
      await act(async () => { context.signal.throwIfAborted(); await router.navigate(-1); });
      context.signal.throwIfAborted();
      await waitFor(() => expect(router.state.location.key).toBe(firstKey));
      context.signal.throwIfAborted();
      expect(tabs.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
      await act(async () => { context.signal.throwIfAborted(); await router.navigate(1); });
      context.signal.throwIfAborted();
      await waitFor(() => expect(router.state.location.key).toBe(secondKey));
      context.signal.throwIfAborted();
      expectTranscriptVisible(container);
      expect(bodies).toEqual([]);
    } finally { client.clear(); }
  });
});
