// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { sessionKeys } from "@/lib/query-keys";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import type { CallFilter, SessionCallPage } from "@/types/agent-session";
import { SLUG, callPage, contentPage, makeCall, makeContent, makeSession } from "../../__tests__/fixtures";
import { useRefreshSessionEvidence } from "../use-session-evidence";
import { useSession, useSessionCalls, useSessionLinks } from "../use-sessions";
import { useContentBodyPages, useSessionContents } from "../use-session-contents";

const SESSION_ID = "session-refresh-variants";
const ROOT = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}`;
const TITLE = "Withdrawn timing relationship";
const CONTENT = makeContent({ id: "already-opened-body", session_id: SESSION_ID, sha256: "captured-body-digest" });
const clients: QueryClient[] = [];

afterEach(() => { clients.splice(0).forEach((client) => client.clear()); });

// The reader metadata and an explicitly opened body are both observed.
// Refresh may update loaded metadata pages but must not fetch that body again.
function EvidenceReader() {
  const [filter, setFilter] = useState<CallFilter>("all");
  useSession(SLUG, SESSION_ID, true);
  useSessionLinks(SLUG, SESSION_ID, true);
  useWorkspaces();
  const contents = useSessionContents(SLUG, SESSION_ID);
  useContentBodyPages(SLUG, SESSION_ID, CONTENT, [0]);
  const calls = useSessionCalls(SLUG, SESSION_ID, filter, true);
  const evidence = useRefreshSessionEvidence(SLUG, SESSION_ID);
  return <>
    <button onClick={() => setFilter("all")}>Show all calls</button>
    <button onClick={() => setFilter("failures")}>Show failures</button>
    <button onClick={() => void calls.fetchNextPage()} disabled={calls.isFetching || !calls.hasNextPage}>Load earlier calls</button>
    <button onClick={() => void contents.fetchNextPage()} disabled={contents.isFetching || !contents.hasNextPage}>Load more captured metadata</button>
    <output aria-label="Captured previews">{contents.data?.pages.flatMap((page) => page.items.map((item) => item.preview?.text)).join(", ")}</output>
    <button onClick={() => void evidence.refresh()} disabled={evidence.refreshing}>Refresh evidence</button>
    <output aria-label="Recorded work references">{calls.data?.pages.flatMap((page) => page.items.flatMap((item) => item.work_refs.map((ref) => ref.title))).join(", ")}</output>
  </>;
}

function serve() {
  const state = { retracted: false, requests: [] as { path: string; filter: string | null; cursor: string | null }[] };
  const record = (request: Request) => {
    const url = new URL(request.url);
    state.requests.push({ path: url.pathname, filter: url.searchParams.get("filter"), cursor: url.searchParams.get("cursor") });
  };
  server.use(
    http.get(ROOT, ({ request }) => { record(request); return HttpResponse.json(makeSession({ id: SESSION_ID })); }),
    http.get(`${ROOT}/links`, ({ request }) => {
      record(request);
      return HttpResponse.json({ items: state.retracted ? [] : [{
        entity_type: "card", entity_id: "card-1", workspace_id: "ws-1", board_id: "board-1",
        relation: "changed", provenance: "correlated", invocation_count: 2,
        first_seen_at: CONTENT.occurred_at, last_seen_at: CONTENT.occurred_at,
      }] });
    }),
    http.get("/api/workspaces", ({ request }) => { record(request); return HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }]); }),
    http.get(`${ROOT}/calls`, ({ request }) => {
      record(request);
      const params = new URL(request.url).searchParams;
      const filter = params.get("filter")!;
      const older = params.has("cursor");
      const item = makeCall({
        key: `${filter}-${older ? "older" : "newest"}`,
        work_refs: state.retracted ? [] : [{ entity_type: "card", entity_id: "card-1", workspace_id: "ws-1", board_id: "board-1", relation: "changed", provenance: "correlated", title: TITLE }],
      });
      return HttpResponse.json(callPage([item], [], older ? `not-loaded-${filter}` : `older-${filter}`));
    }),
    http.get(`${ROOT}/contents`, ({ request }) => {
      record(request);
      const older = new URL(request.url).searchParams.has("cursor");
      return HttpResponse.json(contentPage([{ ...CONTENT, id: older ? "older-content" : CONTENT.id,
        preview: { text: `${state.retracted ? "CURRENT" : "PREVIOUS"}_${older ? "OLDER" : "FIRST"}_PREVIEW`, truncated: false },
      }], older ? "not-loaded-content" : "older-content"));
    }),
    http.get(`${ROOT}/contents/${CONTENT.id}/body`, ({ request }) => { record(request); return HttpResponse.json({ content_id: CONTENT.id, text: "Private captured body", offset: 0, next_offset: null, total_bytes: 21 }); }),
  );
  return state;
}

describe("Explicit evidence refresh across retained timeline filters", () => {
  it.each(["all", "failures"] as const)("withdraws stale work refs from active %s and the other retained filter while refreshing loaded metadata without scanning or rereading bodies", async (activeFilter) => {
    const state = serve();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } } });
    clients.push(client);
    const user = userEvent.setup();
    renderWithProviders(<EvidenceReader />, { queryClient: client });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await user.click(screen.getByRole("button", { name: "Load earlier calls" }));
    await waitFor(() => expect(client.getQueryData<InfiniteData<SessionCallPage>>(sessionKeys.calls(SLUG, SESSION_ID, "all"))?.pages).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Show failures" }));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await user.click(screen.getByRole("button", { name: "Load earlier calls" }));
    await waitFor(() => expect(client.getQueryData<InfiniteData<SessionCallPage>>(sessionKeys.calls(SLUG, SESSION_ID, "failures"))?.pages).toHaveLength(2));
    if (activeFilter === "all") await user.click(screen.getByRole("button", { name: "Show all calls" }));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.getByLabelText("Recorded work references")).toHaveTextContent(TITLE);
    await user.click(screen.getByRole("button", { name: "Load more captured metadata" }));
    await waitFor(() => expect(screen.getByLabelText("Captured previews")).toHaveTextContent("PREVIOUS_OLDER_PREVIEW"));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const before = state.requests.length;
    state.retracted = true;

    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));
    await waitFor(() => expect(state.requests.slice(before).some(({ path }) => path === `${ROOT}/links`)).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh evidence" })).toBeEnabled());

    expect(screen.getByLabelText("Recorded work references")).not.toHaveTextContent(TITLE);
    for (const filter of ["all", "failures"] as const) {
      const cached = client.getQueryData<InfiniteData<SessionCallPage>>(sessionKeys.calls(SLUG, SESSION_ID, filter));
      expect(cached?.pageParams).toEqual([null, `older-${filter}`]);
      expect(cached?.pages.flatMap((page) => page.items.flatMap((item) => item.work_refs))).toEqual([]);
    }
    const refreshed = state.requests.slice(before);
    expect(refreshed.filter(({ path }) => path === `${ROOT}/calls`).map(({ filter, cursor }) => `${filter}:${cursor ?? "newest"}`).sort()).toEqual([
      "all:newest", "all:older-all", "failures:newest", "failures:older-failures",
    ]);
    expect(client.getQueryState(sessionKeys.calls(SLUG, SESSION_ID, "work"))).toBeUndefined();
    expect(refreshed.some(({ cursor }) => cursor?.startsWith("not-loaded-"))).toBe(false);
    expect(refreshed.filter(({ path }) => path.includes("/contents")).map(({ path, cursor }) => ({ path, cursor }))).toEqual([
      { path: `${ROOT}/contents`, cursor: null }, { path: `${ROOT}/contents`, cursor: "older-content" },
    ]);
    expect(refreshed[0]?.path).toBe(ROOT);
    expect(screen.getByLabelText("Captured previews")).toHaveTextContent("CURRENT_FIRST_PREVIEW");
    expect(screen.getByLabelText("Captured previews")).toHaveTextContent("CURRENT_OLDER_PREVIEW");
    expect(screen.getByLabelText("Captured previews")).not.toHaveTextContent("PREVIOUS_");
  });
});
