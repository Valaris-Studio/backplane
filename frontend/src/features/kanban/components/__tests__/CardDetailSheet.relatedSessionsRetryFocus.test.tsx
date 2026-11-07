// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSearchParams } from "react-router-dom";
import i18n from "@/i18n/config";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { makeSession, stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import type { LinkedSessionList } from "@/types/agent-session";
import type { Card, Column } from "@/types/kanban";
import { CardDetailSheet } from "../CardDetailSheet";

const SLUG = "acme";
const BOARD = "card-related-board";
const CARD_ID = "card-related-entry";
const SESSION_ID = "card-related-session";
const SESSION_TITLE = "Synthetic card evidence session";
const ORIGIN = `/${SLUG}/boards/${BOARD}/kanban?card=${CARD_ID}&sort=priority`;
const BOARD_API = `/api/workspaces/${SLUG}/boards/${BOARD}`;
const CARD_API = `${BOARD_API}/cards/${CARD_ID}`;
const LIST_PATH = `${CARD_API}/sessions`;
const AT = "2026-10-18T16:00:00Z";
const BODY = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved card body" }] }] });
const CARD: Card = {
  id: CARD_ID, column_id: "card-related-column", title: "Saved card title", description: BODY,
  card_type: "task", priority: "medium", position: 1024, participants: [], due_date: null,
  status: "ready", labels: [], created_at: AT, updated_at: AT,
};
const COLUMNS: Column[] = [{
  id: CARD.column_id, board_id: BOARD, name: "Active", column_type: "active", position: 1024,
  cards: [CARD], created_at: AT, updated_at: AT,
}];
const views: ReturnType<typeof renderBrowserNavigationRouter>[] = [];
const releases: (() => void)[] = [];
const requests: { method: string; url: URL }[] = [];
const unexpected: string[] = [];
const observers = new Map<Element, IntersectionObserverCallback>();
const originalWindowObserver = window.IntersectionObserver;
const originalGlobalObserver = globalThis.IntersectionObserver;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const rectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const rectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

class OffscreenObserver {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) { observers.set(target, this.report); }
  unobserve(target: Element) { observers.delete(target); }
  disconnect() { for (const [target, report] of observers) if (report === this.report) observers.delete(target); }
  takeRecords() { return []; }
}

// In this tree only the related-sessions sentinel observes intersection, so
// this is the person scrolling that section into view.
function revealObserved() {
  for (const [target, report] of [...observers]) report([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
}

function recordRequest({ request }: { request: Request }) {
  requests.push({ method: request.method, url: new URL(request.url) });
}

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  requests.length = 0;
  unexpected.length = 0;
  observers.clear();
  stubReducedMotion(true);
  server.events.on("request:start", recordRequest);
  // The existing setup properties are writable but non-configurable.
  window.IntersectionObserver = OffscreenObserver as unknown as typeof IntersectionObserver;
  globalThis.IntersectionObserver = OffscreenObserver as unknown as typeof IntersectionObserver;
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value(this: Element) {
    // jsdom has no viewport: only the explicitly scrolled section is revealed.
    for (const [target, report] of [...observers]) {
      if (target.contains(this) || this.contains(target)) {
        report([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    }
  } });
  const rect = { top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, width: 0, height: 0, toJSON: () => ({}) };
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) });
});

afterEach(() => {
  for (const view of views.splice(0)) { view.unmount(); view.router.dispose(); view.client.clear(); }
  releases.splice(0).forEach((release) => release());
  observers.clear();
  server.events.removeListener("request:start", recordRequest);
  window.IntersectionObserver = originalWindowObserver;
  globalThis.IntersectionObserver = originalGlobalObserver;
  restore(Element.prototype, "scrollIntoView", scrollDescriptor);
  restore(Range.prototype, "getBoundingClientRect", rectDescriptor);
  restore(Range.prototype, "getClientRects", rectsDescriptor);
  stubReducedMotion(false);
  expect(unexpected).toEqual([]);
  expect(requests.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(requests.filter(({ url }) => /\/contents(?:\/|$)|\/calls(?:\/|$)/.test(url.pathname))).toEqual([]);
});

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

function setup() {
  const session = makeSession({ id: SESSION_ID, title: SESSION_TITLE, board_id: BOARD });
  const list: LinkedSessionList = {
    items: [{ session, relations: ["changed"], provenance: "exact", first_seen_at: session.started_at, last_seen_at: session.last_event_at }],
    summary: {
      session_count: 1, first_seen_at: session.started_at, last_seen_at: session.last_event_at,
      total_duration_seconds: 60, wall_duration_seconds: 60, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_usd: null,
      cost_reported_usd: null, cost_estimated_usd: null, cost_source: null, cost_basis: null, cost_complete: false,
    },
  };
  const state = { list, listStatus: 200, listReads: 0, activeListReads: 0, deviceReads: 0, listGate: null as Promise<void> | null };
  function rejected(request: Request) {
    const url = new URL(request.url);
    unexpected.push(`${request.method} ${url.pathname}${url.search}`);
    return HttpResponse.json({ detail: "Unexpected card metadata fixture request" }, { status: 418 });
  }
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
    http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json([{ user_id: "user-me", name: "Me", email: "me@example.com", role: "owner" }])),
    http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json({ pipeline_config: null })),
    http.get(`/api/workspaces/${SLUG}/executions`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      return query.get("card_id") === CARD_ID && query.get("summary") === "true" ? HttpResponse.json([]) : rejected(request);
    }),
    http.get(`${BOARD_API}/notes`, ({ request }) => new URL(request.url).searchParams.get("card_id") === CARD_ID ? HttpResponse.json([]) : rejected(request)),
    http.get(`${BOARD_API}/completion/policy`, () => HttpResponse.json({ effective_policy: null })),
    http.get(`${CARD_API}/dependencies`, () => HttpResponse.json({ depends_on: [], blocks: [] })),
    http.get("/api/me/companion/installations", () => { state.deviceReads++; return HttpResponse.json([]); }),
    http.get(LIST_PATH, async () => {
      state.listReads++;
      state.activeListReads++;
      try {
        await state.listGate;
        return state.listStatus === 200 ? HttpResponse.json(state.list) : HttpResponse.json({ detail: "Unavailable" }, { status: state.listStatus });
      } finally { state.activeListReads--; }
    }),
    http.all("/api/*", ({ request }) => rejected(request)),
  );
  stubAuthModes(true);
  function EditorRoute() {
    const [params, setParams] = useSearchParams();
    // A05 owns obtaining this full card; this fixture starts at its editor seam.
    return <main><h1>Card metadata origin</h1><CardDetailSheet card={CARD} columns={COLUMNS}
      slug={SLUG} boardId={BOARD} open={params.get("card") === CARD_ID} isDetailLoaded
      onOpenChange={(open) => { if (!open) setParams((current) => { current.delete("card"); return current; }); }} /></main>;
  }
  const view = renderBrowserNavigationRouter([{ path: `/${SLUG}/boards/${BOARD}/kanban`, element: <EditorRoute /> }], ORIGIN);
  views.push(view);
  return { ...view, state };
}

type View = ReturnType<typeof setup>;
type User = ReturnType<typeof userEvent.setup>;

const sectionTitle = () => i18n.t("sessions.linked.cardTitle");
const loadError = () => i18n.t("sessions.linked.loadError");
const retryLabel = () => i18n.t("sessions.loadError.retry");
const accessLost = () => i18n.t("sessions.discovery.accessLost");

async function ready(view: View) {
  await screen.findByRole("textbox", { name: i18n.t("cards.titleLabel") });
  await waitFor(() => { expect(document.querySelector(".tiptap-editor")).toHaveTextContent("Saved card body"); });
  await waitFor(() => { expect(view.client.isFetching()).toBe(0); });
  expect(screen.getByRole("button", { name: i18n.t("common.save") })).toBeDisabled();
  expect(view.state.listReads).toBe(0);
  expect(view.state.deviceReads).toBe(0);
}

function expectNoNavigation(view: View, location: View["router"]["state"]["location"], history: string) {
  expect(view.router.state.location).toEqual(location);
  expect(JSON.stringify(window.history.state)).toBe(history);
  expect(window.location.pathname + window.location.search).toBe(ORIGIN);
  expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
}

async function settle({ client, state }: View) {
  await waitFor(() => {
    expect(state.activeListReads).toBe(0);
    expect(client.isFetching()).toBe(0);
  });
}

// Release every held read, then drain HTTP and Query before RTL unmounts (#445).
async function drain(view: View) {
  releases.splice(0).forEach((release) => release());
  await settle(view);
}

async function tabTo(user: User, target: HTMLElement, { shift = false }: { shift?: boolean } = {}) {
  for (let step = 0; step < 64 && document.activeElement !== target; step += 1) await user.tab({ shift });
  expect(target).toHaveFocus();
}

// Pre-behaviour readiness: the honest retryable error with an idle Retry.
async function retryableError(section: HTMLElement) {
  await waitFor(() => { expect(within(section).getByText(loadError())).toBeVisible(); });
  expect(within(section).queryByText(accessLost())).not.toBeInTheDocument();
  const retry = within(section).getByRole("button", { name: retryLabel() });
  expect(retry).toBeEnabled();
  expect(retry).not.toHaveAttribute("aria-busy", "true");
  expect(retry).not.toHaveAttribute("aria-disabled", "true");
  return retry;
}

// Readiness only: wait for the render the held retry produces. The unrepaired
// section disconnects Retry (or the whole section when not requested); a
// repair marks the same node busy. Judging focus before this render would
// pass on the pre-click node.
async function heldRetryRendered(retry: HTMLElement) {
  await waitFor(() => {
    expect(!retry.isConnected || retry.hasAttribute("disabled") || retry.getAttribute("aria-busy") === "true").toBe(true);
  });
}

function expectHeldRetry(section: HTMLElement, retry: HTMLElement) {
  expect.soft(section.isConnected, "the section stays mounted while the retry is held").toBe(true);
  expect.soft(retry.isConnected && section.contains(retry), "the same Retry node stays in the section").toBe(true);
  expect.soft(section.isConnected && within(section).queryByText(loadError()) !== null, "the error row stays while the retry is held").toBe(true);
  expect.soft(retry).toHaveFocus();
  expect.soft(retry).toHaveAttribute("aria-busy", "true");
  expect.soft(retry).toHaveAttribute("aria-disabled", "true");
  expect.soft(retry).not.toBeDisabled();
}

async function expectRetryAfterRepeat(section: HTMLElement, retry: HTMLElement) {
  await waitFor(() => {
    const current = within(section).getByRole("button", { name: retryLabel() });
    expect(within(section).getByText(loadError())).toBeVisible();
    expect(current).not.toHaveAttribute("aria-busy", "true");
    expect(current).not.toHaveAttribute("aria-disabled", "true");
    expect(current).toBeEnabled();
  });
  const current = within(section).getByRole("button", { name: retryLabel() });
  expect.soft(current, "a repeated failure keeps the same Retry node").toBe(retry);
  expect.soft(retry).toHaveFocus();
  expect(within(section).queryByText(accessLost())).not.toBeInTheDocument();
  return current;
}

function expectListReads(view: View, count: number) {
  expect(view.state.listReads).toBe(count);
  expect(requests.filter(({ url }) => url.pathname === LIST_PATH).map(({ method }) => method)).toEqual(Array.from({ length: count }, () => "GET"));
}

describe("Related card sessions: an explicit keyboard Retry keeps its focus", () => {
  it("requested 503 first load: the held Retry stays focused and busy, survives a repeated 503, then recovers", async () => {
    const view = setup();
    view.state.listStatus = 503;
    const user = userEvent.setup();
    try {
      await ready(view);
      const location = view.router.state.location;
      const history = JSON.stringify(window.history.state);
      const jump = await screen.findByRole("button", { name: sectionTitle() });
      jump.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => { expect(view.state.listReads).toBe(1); });
      const section = await screen.findByRole("region", { name: sectionTitle() });
      await waitFor(() => { expect(within(section).getByRole("heading", { name: sectionTitle() })).toHaveFocus(); });
      await settle(view);
      const retry = await retryableError(section);
      await tabTo(user, retry);

      const held = gate();
      view.state.listGate = held.promise;
      await user.keyboard("{Enter}");
      await waitFor(() => { expect(view.state.listReads).toBe(2); });
      await heldRetryRendered(retry);
      expectHeldRetry(section, retry);
      await user.keyboard("{Enter} ");
      expect(view.state.listReads).toBe(2);

      await act(async () => { held.release(); });
      await settle(view);
      expect(view.state.listReads).toBe(2);
      const settled = await expectRetryAfterRepeat(section, retry);

      view.state.listStatus = 200;
      // Focus after success is outside this contract. Driver focus only lets the
      // unrepaired source reach its recovery leg; the focus oracle already ran.
      settled.focus();
      await user.keyboard("{Enter}");
      expect(await within(section).findByRole("link", { name: SESSION_TITLE })).toHaveAttribute("href", `/${SLUG}/sessions/${SESSION_ID}`);
      await settle(view);
      expect(within(section).queryByText(loadError())).not.toBeInTheDocument();
      expect(within(section).queryByRole("button", { name: retryLabel() })).not.toBeInTheDocument();
      expectListReads(view, 3);
      expectNoNavigation(view, location, history);
    } finally {
      await drain(view);
    }
  });

  it("non-requested 429: the shown section stays mounted and its Tab-reached Retry keeps focus while held", async () => {
    const view = setup();
    view.state.listStatus = 429;
    const user = userEvent.setup();
    try {
      await ready(view);
      const location = view.router.state.location;
      const history = JSON.stringify(window.history.state);
      await waitFor(() => { expect(observers.size).toBeGreaterThan(0); });
      await act(async () => { revealObserved(); });
      await waitFor(() => { expect(view.state.listReads).toBe(1); });
      await settle(view);
      const section = await screen.findByRole("region", { name: sectionTitle() });
      expect(within(section).getByRole("heading", { name: sectionTitle() })).not.toHaveFocus();
      expect(view.state.deviceReads).toBe(1);
      const retry = await retryableError(section);
      // The section sits just above the footer: walk back from the sheet's start.
      await tabTo(user, retry, { shift: true });

      const held = gate();
      view.state.listGate = held.promise;
      await user.keyboard("{Enter}");
      await waitFor(() => { expect(view.state.listReads).toBe(2); });
      await heldRetryRendered(retry);
      expect.soft(screen.queryByRole("region", { name: sectionTitle() }), "the shown section stays while its retry is held").toBe(section);
      expectHeldRetry(section, retry);
      await user.keyboard("{Enter} ");
      expect(view.state.listReads).toBe(2);

      await act(async () => { held.release(); });
      await settle(view);
      expect(view.state.listReads).toBe(2);
      const settledSection = await screen.findByRole("region", { name: sectionTitle() });
      expect.soft(settledSection, "a repeated 429 keeps the same section").toBe(section);
      await expectRetryAfterRepeat(settledSection, retry);
      expectListReads(view, 2);
      expectNoNavigation(view, location, history);
    } finally {
      await drain(view);
    }
  });
});
