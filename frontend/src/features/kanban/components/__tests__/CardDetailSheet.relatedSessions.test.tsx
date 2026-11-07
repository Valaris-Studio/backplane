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

function setup(companion = true) {
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
  const state = { list, listStatus: 200, listReads: 0, deviceReads: 0, listGate: null as Promise<void> | null };
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
    http.get(`${CARD_API}/sessions`, async () => {
      state.listReads++;
      await state.listGate;
      return state.listStatus === 200 ? HttpResponse.json(state.list) : HttpResponse.json({ detail: "Unavailable" }, { status: state.listStatus });
    }),
    http.all("/api/*", ({ request }) => rejected(request)),
  );
  stubAuthModes(companion);
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

const sectionTitle = () => i18n.t("sessions.linked.cardTitle");
async function ready(view: ReturnType<typeof setup>) {
  await screen.findByRole("textbox", { name: i18n.t("cards.titleLabel") });
  await waitFor(() => expect(document.querySelector(".tiptap-editor")).toHaveTextContent("Saved card body"));
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  expect(screen.getByRole("button", { name: i18n.t("common.save") })).toBeDisabled();
  expect(view.state.listReads).toBe(0);
  expect(view.state.deviceReads).toBe(0);
}

function expectNoNavigation(view: ReturnType<typeof setup>, location: ReturnType<typeof setup>["router"]["state"]["location"], history: string) {
  expect(view.router.state.location).toEqual(location);
  expect(JSON.stringify(window.history.state)).toBe(history);
  expect(window.location.pathname + window.location.search).toBe(ORIGIN);
  expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
}

describe("Card metadata entry into its existing related sessions", () => {
  it("deliberately opens and focuses one lazy section while preserving a dirty card without navigation or writes", async () => {
    const view = setup();
    await ready(view);
    const user = userEvent.setup();
    const title = screen.getByRole("textbox", { name: i18n.t("cards.titleLabel") });
    await user.clear(title);
    await user.paste("Unsaved private card title");
    expect(screen.getByRole("button", { name: i18n.t("common.save") })).toBeEnabled();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(view.state.listReads).toBe(0);
    expect(view.state.deviceReads).toBe(0);
    const location = view.router.state.location;
    const history = JSON.stringify(window.history.state);
    const pending = gate();
    view.state.listGate = pending.promise;
    const jump = await screen.findByRole("button", { name: sectionTitle() });
    expect(screen.getAllByRole("button", { name: sectionTitle() })).toHaveLength(1);
    jump.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(view.state.listReads).toBe(1));
    const section = await screen.findByRole("region", { name: sectionTitle() });
    await waitFor(() => expect(within(section).getByRole("heading", { name: sectionTitle() })).toHaveFocus());
    expect(within(section).getByRole("status")).toBeVisible();
    expectNoNavigation(view, location, history);
    expect(title).toHaveValue("Unsaved private card title");
    await act(async () => { pending.release(); });
    expect(await within(section).findByRole("link", { name: SESSION_TITLE })).toHaveAttribute("href", `/${SLUG}/sessions/${SESSION_ID}`);
    expect(within(section).getByText(i18n.t("sessions.work.changed"), { exact: true })).toBeVisible();
    expect(screen.getAllByRole("region", { name: sectionTitle() })).toHaveLength(1);
    await user.click(jump);
    await waitFor(() => expect(within(section).getByRole("heading", { name: sectionTitle() })).toHaveFocus());
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(view.state.listReads).toBe(1);
    expect(view.state.deviceReads).toBe(1);
    expect(title).toHaveValue("Unsaved private card title");
    expect(title).toBeVisible();
    expect(document.querySelector(".tiptap-editor")).toHaveTextContent("Saved card body");
    const afterJumpUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterJumpUnload);
    expect(afterJumpUnload.defaultPrevented).toBe(true);
    expectNoNavigation(view, location, history);
  });

  it.each(["empty", "denied", "error"] as const)("keeps an explicitly requested %s section visible and focuses its explanation", async (condition) => {
    const view = setup();
    view.state.list = { ...view.state.list, items: [], summary: { ...view.state.list.summary, session_count: 0 } };
    view.state.listStatus = condition === "denied" ? 403 : condition === "error" ? 503 : 200;
    await ready(view);
    const location = view.router.state.location;
    const history = JSON.stringify(window.history.state);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: sectionTitle() }));
    const section = await screen.findByRole("region", { name: sectionTitle() });
    await waitFor(() => expect(view.state.listReads).toBe(1));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    await waitFor(() => expect(within(section).getByRole("heading", { name: sectionTitle() })).toHaveFocus());
    const empty = i18n.t("sessions.linked.noneCard");
    if (condition === "empty") expect(within(section).getByText(empty)).toBeVisible();
    else if (condition === "denied") {
      expect(within(section).getByText(/unavailable|access/i)).toBeVisible();
      expect(within(section).queryByText(empty)).not.toBeInTheDocument();
    } else {
      expect(within(section).getByText(i18n.t("sessions.linked.loadError"))).toBeVisible();
      view.state.listStatus = 200;
      await user.click(within(section).getByRole("button", { name: i18n.t("sessions.loadError.retry") }));
      expect(await within(section).findByText(empty)).toBeVisible();
      expect(view.state.listReads).toBe(2);
    }
    expect(screen.getAllByRole("region", { name: sectionTitle() })).toHaveLength(1);
    expectNoNavigation(view, location, history);
  });

  it("hides the jump and avoids related reads when Companion is disabled without disabling the card editor", async () => {
    const view = setup(false);
    await ready(view);
    expect(screen.queryByRole("button", { name: sectionTitle() })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: sectionTitle() })).not.toBeInTheDocument();
    const user = userEvent.setup();
    const title = screen.getByRole("textbox", { name: i18n.t("cards.titleLabel") });
    await user.clear(title);
    await user.paste("Still editable without Companion");
    expect(title).toHaveValue("Still editable without Companion");
    expect(screen.getByRole("button", { name: i18n.t("common.save") })).toBeEnabled();
    expect(view.state.listReads).toBe(0);
    expect(view.state.deviceReads).toBe(0);
    expect(window.location.pathname + window.location.search).toBe(ORIGIN);
  });
});
