// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { isInaccessible } from "@testing-library/react";
import { ContextLink } from "@/components/shared/ContextLink";
import { act, userEvent, waitFor, within } from "@/test/test-utils";
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

// Each button's accessible name can traverse the full jsdom label tree.
// Narrow by text before checking the same role, name and accessibility.
function actionButton(scope: ReturnType<typeof within>, name: string) {
  const button = scope.getByText(name, { selector: "button" });
  expect(button.getAttribute("role")?.split(" ")[0] ?? "button").toBe("button");
  expect(button).toHaveAccessibleName(name);
  expect(isInaccessible(button)).toBe(false);
  return button;
}

describe("reader filter retention through local URL replacement and route unmount", () => {
  it.for(["jump to loaded record", "clear linked record", "no local URL replacement"] as const)(
    "retains Everything, the bounded window and selection after %s then shared work and Back",
    async (action, context) => {
      const state = serveWindows();
      const initialHash = action === "clear linked record" ? "#content-record-152" : "";
      const { router, client, container, unmount } = renderBrowserNavigationRouter([
        { path: origin, element: <main>
          <SessionTranscript slug={slug} session={session} />
          <ContextLink id="reader-related-note" to={sharedNote}>Open related note</ContextLink>
        </main> },
        { path: `/${slug}/boards/shared-board/notes`, element: <main><h1>Shared note</h1></main> },
      ], origin + initialHash);
      // A timed-out test body can resume after the runner has started cleanup.
      context.onTestFinished(() => { unmount(); client.clear(); });
      const view = within(container);
      const user = userEvent.setup();
      try {
        await view.findByText(action === "clear linked record" ? "Retained evidence 152" : "Retained evidence 260");
        context.signal.throwIfAborted();
        let reader = within(view.getByRole("region", { name: "Transcript" }));
        let filters = within(reader.getByRole("group", { name: "Records" }));
        const navigation = within(reader.getByRole("navigation", { name: "Captured records" }));
        const filterEntryKey = router.state.location.key;
        await user.click(actionButton(filters, "Everything"));
        context.signal.throwIfAborted();
        await user.click(actionButton(navigation, "Beginning"));
        context.signal.throwIfAborted();
        await reader.findByText("Retained evidence 1");
        context.signal.throwIfAborted();
        await user.click(actionButton(navigation, "Later records"));
        context.signal.throwIfAborted();
        await reader.findByText("Retained evidence 152");
        context.signal.throwIfAborted();
        if (action === "jump to loaded record") {
          const jumpLabel = reader.getByText("Jump to loaded content", { selector: "label" });
          const jumpField = within(jumpLabel.parentElement!);
          await user.selectOptions(jumpField.getByRole("combobox", { name: "Jump to loaded content" }), "record-152");
          context.signal.throwIfAborted();
          await waitFor(() => expect(router.state.location.hash).toBe("#content-record-152"));
          context.signal.throwIfAborted();
        }
        if (action === "no local URL replacement") expect(router.state.location.key).toBe(filterEntryKey);
        else expect(router.state.location.key).not.toBe(filterEntryKey);
        const returnEntry = router.state.location;
        const selected = () => within(container.querySelector<HTMLElement>("#content-record-152")!).getByRole("checkbox");
        await user.click(selected());
        context.signal.throwIfAborted();
        expect(selected()).toBeChecked();
        expect(actionButton(filters, "Everything")).toHaveAttribute("aria-pressed", "true");
        expect(reader.getByText("Retained evidence 151")).toBeVisible();
        await waitFor(() => expect(client.isFetching()).toBe(0));
        context.signal.throwIfAborted();
        const beforeReturn = state.windows.length;

        const link = view.getByRole("link", { name: "Open related note" });
        expect(link).toHaveAttribute("href", sharedNote);
        await user.click(link);
        context.signal.throwIfAborted();
        await view.findByRole("heading", { name: "Shared note" });
        context.signal.throwIfAborted();
        expect(view.queryByRole("heading", { name: "Transcript" })).not.toBeInTheDocument();
        await act(async () => { context.signal.throwIfAborted(); await router.navigate(-1); });
        context.signal.throwIfAborted();
        await waitFor(() => expect(router.state.location).toMatchObject({
          key: returnEntry.key, pathname: returnEntry.pathname, hash: returnEntry.hash,
        }));
        context.signal.throwIfAborted();
        await view.findByText("Retained evidence 152");
        context.signal.throwIfAborted();
        reader = within(view.getByRole("region", { name: "Transcript" }));
        filters = within(reader.getByRole("group", { name: "Records" }));
        await waitFor(() => expect(client.isFetching()).toBe(0));
        context.signal.throwIfAborted();

        expect(router.state.historyAction).toBe("POP");
        expect(reader.getByText("Retained evidence 101")).toBeVisible();
        expect(reader.getByText("Retained evidence 200")).toBeVisible();
        expect(reader.queryByText("Retained evidence 260")).not.toBeInTheDocument();
        expect(selected()).toBeChecked();
        expect(state.windows.slice(beforeReturn).some((params) => params.get("mode") === "refresh" && params.get("cursor") === state.middleCursor)).toBe(true);
        expect(state.bodies).toEqual([]);
        expect(actionButton(filters, "Everything")).toHaveAttribute("aria-pressed", "true");
        expect(reader.getByText("Retained evidence 151")).toBeVisible();
      } finally { client.clear(); }
    },
  );

  it("restores each same-session entry's own filter on Back and Forward without remounting the reader", async (context) => {
    const state = serveWindows();
    const { router, client, container, unmount } = renderBrowserNavigationRouter([
      { path: origin, element: <main>
        <SessionTranscript slug={slug} session={session} />
        <ContextLink id="second-reader-entry" to={`${origin}?reading=second#content-record-152`}>Open another view of this session</ContextLink>
      </main> },
    ], `${origin}#content-record-152`);
    context.onTestFinished(() => { unmount(); client.clear(); });
    const view = within(container);
    const user = userEvent.setup();
    try {
      await view.findByText("Retained evidence 152");
      context.signal.throwIfAborted();
      const reader = within(view.getByRole("region", { name: "Transcript" }));
      const filters = within(reader.getByRole("group", { name: "Records" }));
      const readerHeading = view.getByRole("heading", { name: "Transcript" });
      const firstKey = router.state.location.key;
      await user.click(actionButton(filters, "Everything"));
      context.signal.throwIfAborted();
      expect(reader.getByText("Retained evidence 151")).toBeVisible();
      await user.click(view.getByRole("link", { name: "Open another view of this session" }));
      context.signal.throwIfAborted();
      expect(router.state.historyAction).toBe("PUSH");
      const secondKey = router.state.location.key;
      expect(secondKey).not.toBe(firstKey);
      expect(view.getByRole("heading", { name: "Transcript" })).toBe(readerHeading);
      expect(actionButton(filters, "Conversation")).toHaveAttribute("aria-pressed", "true");
      // Commit a distinct choice in the second entry, rather than relying only
      // on its default, then prove neither POP overwrites the other entry.
      await user.click(actionButton(filters, "Everything"));
      context.signal.throwIfAborted();
      await user.click(actionButton(filters, "Conversation"));
      context.signal.throwIfAborted();

      await act(async () => { context.signal.throwIfAborted(); await router.navigate(-1); });
      context.signal.throwIfAborted();
      await waitFor(() => expect(router.state.location.key).toBe(firstKey));
      context.signal.throwIfAborted();
      expect(router.state.historyAction).toBe("POP");
      expect(view.getByRole("heading", { name: "Transcript" })).toBe(readerHeading);
      expect(actionButton(filters, "Everything")).toHaveAttribute("aria-pressed", "true");
      expect(reader.getByText("Retained evidence 151")).toBeVisible();

      await act(async () => { context.signal.throwIfAborted(); await router.navigate(1); });
      context.signal.throwIfAborted();
      await waitFor(() => expect(router.state.location.key).toBe(secondKey));
      context.signal.throwIfAborted();
      expect(router.state.historyAction).toBe("POP");
      expect(view.getByRole("heading", { name: "Transcript" })).toBe(readerHeading);
      expect(actionButton(filters, "Conversation")).toHaveAttribute("aria-pressed", "true");
      expect(reader.queryByText("Retained evidence 151")).not.toBeInTheDocument();
      expect(state.bodies).toEqual([]);
    } finally { client.clear(); }
  });
});
