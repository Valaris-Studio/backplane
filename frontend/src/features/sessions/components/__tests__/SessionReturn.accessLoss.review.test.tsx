// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLocation, useParams } from "react-router-dom";
import { sessionKeys } from "@/lib/query-keys";
import { isApiError } from "@/lib/api-error";
import { useReturnNavigation, type ReturnReference } from "@/providers/ReturnNavigationProvider";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { SessionDetailPage } from "../SessionDetailPage";

const deniedId = "private-session";
const allowedId = "private-session-extended";
const path = (id: string, entry: string) => `/acme/sessions/${id}?entry=${entry}`;
const windowKey = (id: string) => `session-reader-window:acme/${id}`;
type Navigation = NonNullable<ReturnType<typeof useReturnNavigation>>;
interface RetainedEntry {
  sessionId: string;
  reference: ReturnReference;
  href: string;
  window: { cursor: string; legacy: boolean };
}

function mount() {
  const traffic = { deniedStatus: 200, authority: [] as { id: string; status: number }[], unexpected: [] as string[] };
  const entries: RetainedEntry[] = [];
  let navigation: Navigation;
  stubAuthModes(true);
  server.use(
    http.get("/api/workspaces/acme/boards", () => HttpResponse.json([])),
    http.get("/api/workspaces/acme/sessions/:id", ({ params }) => {
      const id = String(params.id);
      const status = id === deniedId ? traffic.deniedStatus : 200;
      traffic.authority.push({ id, status });
      return status === 200
        ? HttpResponse.json(makeSession({ id, title: `Session ${id}`, coverage: "usage_only", capture_levels: [] }))
        : HttpResponse.json({ detail: "Synthetic session authority response", error_code: "forbidden" }, { status });
    }),
    http.get("/api/workspaces/acme/sessions/:id/links", () => HttpResponse.json({ items: [] })),
    http.get("/api/workspaces/acme/sessions/:id/usage", () => HttpResponse.json({ items: [], price_table_version: "review" })),
    http.get("/api/workspaces/acme/sessions/:id/children", () => HttpResponse.json({ items: [] })),
    http.all("/api/*", ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && ["/api/auth/modes", "/api/me"].includes(path)) return;
      traffic.unexpected.push(`${request.method} ${path}`);
      return HttpResponse.json({ detail: "Unexpected access-loss fixture request" }, { status: 400 });
    }),
  );

  function MemoryProbe() {
    const current = useReturnNavigation();
    const location = useLocation();
    const { sessionId = "" } = useParams();
    if (!current) throw new Error("The real return provider must be mounted");
    navigation = current;
    return <button type="button" onClick={(event) => {
      const window = { cursor: `private-cursor-${location.key}`, legacy: false };
      current.writeView(windowKey(sessionId), window);
      const reference = current.capture(event.currentTarget);
      if (!reference) throw new Error("Real browser history did not yield a return reference");
      entries.push({ sessionId, reference, href: location.pathname + location.search, window });
    }}>Remember current private window</button>;
  }

  const rendered = renderBrowserNavigationRouter([
    { path: "/:slug/sessions/:sessionId", element: <><MemoryProbe /><SessionDetailPage /></> },
  ], path(deniedId, "first"));
  return { ...rendered, traffic, entries, navigation: () => navigation };
}

async function remember() {
  await userEvent.click(screen.getByRole("button", { name: "Remember current private window" }));
}

async function populateHistory(fixture: ReturnType<typeof mount>) {
  await screen.findByRole("heading", { name: `Session ${deniedId}` });
  await remember();
  await act(async () => { await fixture.router.navigate(path(deniedId, "second")); });
  await remember();
  await act(async () => { await fixture.router.navigate(path(allowedId, "authorized-peer")); });
  await screen.findByRole("heading", { name: `Session ${allowedId}` });
  await remember();
  await act(async () => { await fixture.router.navigate(path(deniedId, "current")); });
  await screen.findByRole("heading", { name: `Session ${deniedId}` });
  await remember();
  expect(fixture.entries).toHaveLength(4);
  expect(new Set(fixture.entries.map((entry) => entry.reference.originKey)).size).toBe(4);
  for (const entry of fixture.entries) {
    expect(fixture.navigation().resolve(entry.reference)?.href).toBe(entry.href);
  }
  expect(fixture.navigation().readView(windowKey(deniedId))).toEqual(fixture.entries[3]!.window);
  expect(fixture.traffic.unexpected).toEqual([]);
}

beforeEach(() => stubReducedMotion(true));
afterEach(() => stubReducedMotion(false));

describe("Session-detail authority and all private return entries", () => {
  it.each([403, 404])("purges every entry for the denied session after HTTP %s while retaining an authorized similarly named session", async (status) => {
    const fixture = mount();
    await populateHistory(fixture);
    fixture.traffic.deniedStatus = status;
    await act(async () => {
      await fixture.client.refetchQueries({ queryKey: sessionKeys.detail("acme", deniedId), exact: true });
    });
    await waitFor(() => {
      const error = fixture.client.getQueryState(sessionKeys.detail("acme", deniedId))?.error;
      expect(isApiError(error) && error.status).toBe(status);
    });
    expect(fixture.traffic.authority).toContainEqual({ id: deniedId, status });
    expect(fixture.traffic.unexpected).toEqual([]);
    expect(screen.queryByRole("heading", { name: `Session ${deniedId}` })).not.toBeInTheDocument();
    expect(fixture.navigation().resolve(fixture.entries[2]!.reference)?.href).toBe(path(allowedId, "authorized-peer"));
    // Resolve observes the provider's retained entries without revisiting them:
    // another denial during POP must not be needed to purge an old snapshot.
    for (const entry of fixture.entries.filter((entry) => entry.sessionId === deniedId)) {
      expect.soft(fixture.navigation().resolve(entry.reference), entry.href).toBeNull();
    }
    expect.soft(fixture.navigation().readView(windowKey(deniedId))).toBeUndefined();
  });

  it("retains all private return entries and the current window after a transient HTTP 503", async () => {
    const fixture = mount();
    await populateHistory(fixture);
    fixture.traffic.deniedStatus = 503;
    await act(async () => {
      await fixture.client.refetchQueries({ queryKey: sessionKeys.detail("acme", deniedId), exact: true });
    });
    await waitFor(() => {
      const error = fixture.client.getQueryState(sessionKeys.detail("acme", deniedId))?.error;
      expect(isApiError(error) && error.status).toBe(503);
    });
    expect(fixture.traffic.authority).toContainEqual({ id: deniedId, status: 503 });
    expect(fixture.traffic.unexpected).toEqual([]);
    expect(screen.getByRole("heading", { name: `Session ${deniedId}` })).toBeVisible();
    for (const entry of fixture.entries) {
      expect(fixture.navigation().resolve(entry.reference)?.href).toBe(entry.href);
    }
    expect(fixture.navigation().readView(windowKey(deniedId))).toEqual(fixture.entries[3]!.window);
  });
});
