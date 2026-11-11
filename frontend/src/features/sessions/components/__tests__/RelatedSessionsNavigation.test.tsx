// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/config";
import { cleanup, fireEvent } from "@testing-library/react";
import { Link } from "react-router-dom";
import { act, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { cardKeys } from "@/lib/query-keys";
import type { LinkedSessionList, SessionWorkLink } from "@/types/agent-session";
import { callPage, contentPage, makeCall, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { contentWindowResponse } from "../../__tests__/window-fixtures";
import { CardSessionsSection } from "../LinkedSessionsSection";
import { SessionDetailPage } from "../SessionDetailPage";

const SLUG = "acme";
const SESSION_SLUG = "research";
const BOARD = "review-board";
const CARD = "private-work-identity";
const TITLE = "Authorized work title";
const SESSION_TITLE = "Synthetic related session";
const SESSION_ID = "related-session";
const ORIGIN = `/${SLUG}/boards/${BOARD}/kanban?card=${CARD}&priority=high`;
const DESTINATION = `/${SESSION_SLUG}/sessions/${SESSION_ID}`;
const BASE = `/api/workspaces/${SESSION_SLUG}/sessions/${SESSION_ID}`;
const CARD_PATH = `/api/workspaces/${SLUG}/boards/${BOARD}/cards/${CARD}`;
const clients: Array<ReturnType<typeof renderBrowserNavigationRouter>["client"]> = [];
const requests: URL[] = [];
const unhandled: string[] = [];
function recordRequest({ request }: { request: Request }) { requests.push(new URL(request.url)); }
function recordUnhandled({ request }: { request: Request }) { unhandled.push(`${request.method} ${new URL(request.url).pathname}`); }

class VisibleObserver {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.report([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const originalWindowObserver = window.IntersectionObserver;
const originalGlobalObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  requests.length = 0;
  unhandled.length = 0;
  server.events.on("request:start", recordRequest);
  server.events.on("request:unhandled", recordUnhandled);
  window.IntersectionObserver = VisibleObserver as unknown as typeof IntersectionObserver;
  globalThis.IntersectionObserver = VisibleObserver as unknown as typeof IntersectionObserver;
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...matchMedia(query), matches: query === "(min-width: 1280px)" || query === "(prefers-reduced-motion: reduce)",
  }));
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  window.IntersectionObserver = originalWindowObserver;
  globalThis.IntersectionObserver = originalGlobalObserver;
  server.events.removeListener("request:start", recordRequest);
  server.events.removeListener("request:unhandled", recordUnhandled);
  expect(unhandled).toEqual([]);
  expect(requests.filter((url) => /\/contents\/[^/]+\/(body|download)$/.test(url.pathname))).toEqual([]);
});

function setup(relations: SessionWorkLink["relation"][] = ["consulted", "changed"]) {
  stubAuthModes(true);
  const session = makeSession({ id: SESSION_ID, workspace_id: "ws-research", title: SESSION_TITLE });
  const state = { targetStatus: 200, targetReads: 0, sessionReads: 0, bodyReads: 0, callFilters: [] as string[] };
  const links: SessionWorkLink[] = relations.map((relation) => ({
    workspace_id: "ws-acme", entity_type: "card", entity_id: CARD, board_id: BOARD,
    relation, provenance: relation === "consulted" ? "correlated" : "exact",
    first_seen_at: session.started_at, last_seen_at: session.last_event_at, invocation_count: 1,
  }));
  const list: LinkedSessionList = {
    items: [{ session, relations, provenance: "exact", first_seen_at: session.started_at, last_seen_at: session.last_event_at }],
    summary: {
      session_count: 1, first_seen_at: session.started_at, last_seen_at: session.last_event_at,
      total_duration_seconds: 60, wall_duration_seconds: 60, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_usd: null,
      cost_reported_usd: null, cost_estimated_usd: null, cost_source: null, cost_basis: null, cost_complete: false,
    },
  };
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([
      { id: "ws-acme", slug: SLUG, name: "Acme" }, { id: "ws-research", slug: SESSION_SLUG, name: "Research" },
    ])),
    http.get("/api/me/companion/installations", () => HttpResponse.json([])),
    http.get(`${CARD_PATH}/sessions`, () => HttpResponse.json(list)),
    http.get(CARD_PATH, () => {
      state.targetReads++;
      return state.targetStatus === 200 ? HttpResponse.json({ id: CARD, board_id: BOARD, title: TITLE })
        : HttpResponse.json({ detail: "Unavailable" }, { status: state.targetStatus });
    }),
    http.get(BASE, () => { state.sessionReads++; return HttpResponse.json(session); }),
    http.get(`${BASE}/links`, () => HttpResponse.json({ items: links })),
    http.get(`${BASE}/calls`, ({ request }) => {
      state.callFilters.push(new URL(request.url).searchParams.get("filter") ?? "all");
      return HttpResponse.json(callPage([
        ...links.map((link) => makeCall({ key: link.relation, name: link.relation === "changed" ? "Edit" : "Read", args_preview: `${link.relation}-only-evidence`, work_refs: [{ ...link, title: TITLE }] })),
        makeCall({ key: "same-id-other-workspace", name: "Read", args_preview: "wrong-workspace-evidence", work_refs: [{ ...links[0]!, workspace_id: "ws-research", title: "Other workspace work" }] }),
      ], []));
    }),
    http.get(`${BASE}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`${BASE}/usage`, () => HttpResponse.json({ items: [], price_table_version: "synthetic" })),
    http.get(`${BASE}/rhythm`, () => HttpResponse.json({ start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get(`${BASE}/contents/window`, ({ request }) => contentWindowResponse([contentPage([])], new URL(request.url).searchParams)),
    http.get(`/api/workspaces/${SESSION_SLUG}/boards`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([{ id: BOARD, name: "Origin board" }])),
    http.get(`${BASE}/contents/:contentId/body`, () => { state.bodyReads++; return HttpResponse.json({ detail: "Not requested by this journey" }, { status: 500 }); }),
    // The ordinary timeline can show this other-workspace call; it must never
    // become evidence for the origin simply because its entity id matches.
    http.get(`/api/workspaces/${SESSION_SLUG}/boards/${BOARD}/cards/${CARD}`, () => HttpResponse.json({ id: CARD, board_id: BOARD, title: "Other workspace work" })),
  );
  return { state };
}

function mount(initialPath = ORIGIN) {
  const view = renderBrowserNavigationRouter([
    { path: `/${SLUG}/boards/${BOARD}/kanban`, element: <main><h1>Origin work</h1>
      <CardSessionsSection slug={SLUG} boardId={BOARD} cardId={CARD} />
      <Link to={DESTINATION}>Ordinary session link</Link>
    </main> },
    { path: "/:slug/sessions/:sessionId", element: <main><SessionDetailPage /></main> },
  ], initialPath);
  clients.push(view.client);
  return view;
}

function assertPrivateFreeDestination() {
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(DESTINATION);
  const state = window.history.state?.usr;
  expect(Object.keys(state ?? {})).toEqual(["bpReturn"]);
  expect(Object.keys(state.bpReturn).sort()).toEqual(["originIdx", "originKey", "v"]);
  expect(state.bpReturn).toMatchObject({ v: 1, originIdx: 0, originKey: expect.any(String) });
  const serialized = JSON.stringify({ history: window.history.state, local: { ...localStorage }, session: { ...sessionStorage } });
  for (const privateValue of [CARD, TITLE, "changed-only-evidence", "consulted-only-evidence", "priority=high"]) expect(serialized).not.toContain(privateValue);
}

async function openRelated() {
  const row = await screen.findByRole("link", { name: SESSION_TITLE });
  expect(row).toHaveAttribute("href", DESTINATION);
  row.focus();
  await userEvent.click(row);
  await screen.findByRole("heading", { level: 1, name: SESSION_TITLE });
}

describe("Related-session navigation through the real reader", () => {
  it.each([
    { relations: ["consulted", "changed"] as SessionWorkLink["relation"][], expected: "changed", badge: "Changed" },
    { relations: ["consulted"] as SessionWorkLink["relation"][], expected: "consulted", badge: "Consulted" },
  ])("selects $expected evidence from the origin's workspace without merging relationships", async ({ relations, expected, badge }) => {
    const { state } = setup(relations);
    mount();
    await openRelated();
    const evidence = await screen.findByRole("region", { name: `Evidence for ${TITLE}` });
    expect(within(evidence).getByText(badge)).toBeVisible();
    expect(await within(evidence).findByText(`${expected}-only-evidence`)).toBeVisible();
    expect(within(evidence).queryByText("wrong-workspace-evidence")).not.toBeInTheDocument();
    if (expected === "changed") expect(within(evidence).queryByText("consulted-only-evidence")).not.toBeInTheDocument();
    else expect(within(evidence).getByText("Matched by timing")).toBeVisible();
    await waitFor(() => expect(within(evidence).getByRole("heading")).toHaveFocus());
    expect(state.callFilters).toContain("work");
    assertPrivateFreeDestination();
    expect(state.bodyReads).toBe(0);
  });

  it("uses current work authorization and never displays captured calls after the origin card is denied", async () => {
    const { state } = setup();
    const { client } = mount();
    await openRelated();
    const evidence = await screen.findByRole("region", { name: `Evidence for ${TITLE}` });
    await within(evidence).findByText("changed-only-evidence");
    state.targetStatus = 403;
    await act(async () => { await client.refetchQueries({ queryKey: cardKeys.detail(SLUG, BOARD, CARD), exact: true }); });
    const unavailable = await screen.findByRole("region", { name: "Work evidence" });
    expect(within(unavailable).queryByText("changed-only-evidence")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: `Evidence for ${TITLE}` })).not.toBeInTheDocument();
    expect(within(unavailable).getByText(/unavailable/i)).toBeVisible();
    expect(state.bodyReads).toBe(0);
  });

  it("returns to the exact row, retains selection on Forward, and remembers an explicit clear", async () => {
    setup();
    const { router } = mount();
    await openRelated();
    await screen.findByRole("region", { name: `Evidence for ${TITLE}` });
    assertPrivateFreeDestination();
    await userEvent.click(screen.getByRole("link", { name: "Return to previous view" }));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe(ORIGIN));
    const restored = await screen.findByRole("link", { name: SESSION_TITLE });
    await waitFor(() => expect(restored).toHaveFocus());
    await act(async () => { await router.navigate(1); });
    await screen.findByRole("region", { name: `Evidence for ${TITLE}` });
    await userEvent.click(screen.getByRole("button", { name: "Return to timeline" }));
    expect(screen.queryByRole("region", { name: `Evidence for ${TITLE}` })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Return to previous view" }));
    await screen.findByRole("link", { name: SESSION_TITLE });
    await act(async () => { await router.navigate(1); });
    await screen.findByRole("heading", { level: 1, name: SESSION_TITLE });
    expect(screen.queryByRole("button", { name: "Return to timeline" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("sessions.timeline.filters.all") })).toHaveAttribute("aria-pressed", "true");
  });

  it("a later ordinary link does not inherit the preceding related-work handoff", async () => {
    setup();
    mount();
    await openRelated();
    await screen.findByRole("region", { name: `Evidence for ${TITLE}` });
    await userEvent.click(screen.getByRole("link", { name: "Return to previous view" }));
    await screen.findByRole("link", { name: SESSION_TITLE });
    await userEvent.click(screen.getByRole("link", { name: "Ordinary session link" }));
    await screen.findByRole("heading", { level: 1, name: SESSION_TITLE });
    expect(screen.queryByRole("button", { name: "Return to timeline" })).not.toBeInTheDocument();
    expect(window.history.state.usr).toBeNull();
  });

  it("a copied canonical URL starts normally, without a private inspection or return origin", async () => {
    setup();
    const first = mount();
    const copiedHref = (await screen.findByRole("link", { name: SESSION_TITLE })).getAttribute("href")!;
    expect(copiedHref).toBe(DESTINATION);
    first.unmount();
    first.router.dispose();
    first.client.clear();
    mount(copiedHref);
    await screen.findByRole("heading", { level: 1, name: SESSION_TITLE });
    expect(screen.queryByRole("button", { name: "Return to timeline" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Return to previous view" })).not.toBeInTheDocument();
    expect(window.history.state.usr).toBeNull();
  });

  it("a modifier click neither navigates this tab nor seeds the subsequent ordinary link", async () => {
    const { state } = setup();
    mount();
    const row = await screen.findByRole("link", { name: SESSION_TITLE });
    const key = window.history.state.key;
    // Suppress only jsdom's unsupported new-tab default, after React handles it.
    const preventBrowserDefault = (event: MouseEvent) => { if (event.ctrlKey) event.preventDefault(); };
    document.addEventListener("click", preventBrowserDefault);
    try { fireEvent.click(row, { ctrlKey: true, button: 0 }); }
    finally { document.removeEventListener("click", preventBrowserDefault); }
    expect(window.history.state.key).toBe(key);
    expect(window.location.pathname + window.location.search).toBe(ORIGIN);
    expect(state.sessionReads).toBe(0);
    await userEvent.click(screen.getByRole("link", { name: "Ordinary session link" }));
    await screen.findByRole("heading", { level: 1, name: SESSION_TITLE });
    expect(screen.queryByRole("button", { name: "Return to timeline" })).not.toBeInTheDocument();
    expect(window.history.state.usr).toBeNull();
  });
});
