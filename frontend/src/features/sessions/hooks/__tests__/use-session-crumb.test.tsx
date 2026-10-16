// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { sessionKeys } from "@/lib/query-keys";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import { makeSession, SLUG } from "../../__tests__/fixtures";
import { useSession, useSessionLinks } from "../../api/use-sessions";
import { useRefreshSessionEvidence } from "../../api/use-session-evidence";
import { useSessionCrumb } from "../use-session-crumb";
import { setPromptsHidden } from "../use-hide-prompts";

const SESSION_ID = "session-breadcrumb-refresh";
const ROOT = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}`;
const TITLE = "Review retry safety";
const clients: QueryClient[] = [];

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  act(() => setPromptsHidden(false));
});

function makeClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } } });
  clients.push(client);
  return client;
}

function SessionBreadcrumb() {
  const [compact, setCompact] = useState(false);
  const title = useSessionCrumb(SLUG, SESSION_ID);
  return <nav aria-label="Breadcrumb" data-compact={compact}>
    <span>{title}</span>
    <button onClick={() => setCompact((previous) => !previous)}>Toggle compact shell</button>
  </nav>;
}

function SessionEvidence() {
  const session = useSession(SLUG, SESSION_ID, true);
  const links = useSessionLinks(SLUG, SESSION_ID, true);
  useWorkspaces();
  const evidence = useRefreshSessionEvidence(SLUG, SESSION_ID);
  return <main>
    {session.isError && <p role="alert">Session refresh failed</p>}
    <h1>{session.data?.title}</h1>
    <output aria-label="Current work relationships">{links.data?.items.length}</output>
    <button disabled={evidence.refreshing} onClick={() => void evidence.refresh()}>Refresh evidence</button>
  </main>;
}

describe("Session breadcrumb shares the authoritative detail cache", () => {
  it("reacts to cached title and presenter changes without fetching session authority itself", async () => {
    let reads = 0;
    server.use(http.get(ROOT, () => {
      reads += 1;
      return HttpResponse.json(makeSession({ id: SESSION_ID, title: TITLE }));
    }));
    const client = makeClient();
    renderWithProviders(<SessionBreadcrumb />, { queryClient: client });
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Session");

    act(() => client.setQueryData(sessionKeys.detail(SLUG, SESSION_ID), makeSession({ id: SESSION_ID, title: TITLE })));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(TITLE));
    act(() => setPromptsHidden(true));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Breadcrumb" })).not.toHaveTextContent(TITLE));

    expect(reads).toBe(0);
    expect(client.getQueryCache().findAll({ queryKey: sessionKeys.detail(SLUG, SESSION_ID), exact: true })).toHaveLength(1);
  });

  it("keeps explicit authority refresh working after a breadcrumb-only layout render", async () => {
    const state = { detailReads: 0, linksReads: 0, retracted: false };
    server.use(
      http.get(ROOT, () => {
        state.detailReads += 1;
        return HttpResponse.json(makeSession({ id: SESSION_ID, title: TITLE }));
      }),
      http.get(`${ROOT}/links`, () => {
        state.linksReads += 1;
        return HttpResponse.json({ items: state.retracted ? [] : [{
          entity_type: "card", entity_id: "card-1", workspace_id: "ws-1", board_id: "board-1",
          relation: "changed", provenance: "correlated", invocation_count: 1,
          first_seen_at: "2026-10-16T14:00:00Z", last_seen_at: "2026-10-16T14:00:00Z",
        }] });
      }),
      http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
    );
    const client = makeClient();
    const user = userEvent.setup();
    renderWithProviders(<><SessionBreadcrumb /><SessionEvidence /></>, { queryClient: client });
    await screen.findByRole("heading", { name: TITLE });
    await waitFor(() => expect(screen.getByLabelText("Current work relationships")).toHaveTextContent("1"));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.detailReads).toBe(1);

    // AppShell can rerender its breadcrumb when its responsive layout changes
    // while the session observer remains mounted with the same cache identity.
    await user.click(screen.getByRole("button", { name: "Toggle compact shell" }));
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveAttribute("data-compact", "true");
    expect(state.detailReads).toBe(1);
    state.retracted = true;
    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh evidence" })).toBeEnabled());

    expect.soft(state.detailReads).toBe(2);
    expect.soft(state.linksReads).toBe(2);
    expect.soft(screen.getByLabelText("Current work relationships")).toHaveTextContent("0");
    expect.soft(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(client.getQueryCache().findAll({ queryKey: sessionKeys.detail(SLUG, SESSION_ID), exact: true })).toHaveLength(1);
  });
});
