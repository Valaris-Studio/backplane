// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { ThemeProvider } from "@/hooks/use-theme";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import i18n from "@/i18n/config";
import type { BoardDetail, Card } from "@/types/kanban";
import type { LinkedSessionList } from "@/types/agent-session";
import { BoardView } from "../BoardView";

const boardId = "return-board", cardA = "return-card-a", cardB = "return-card-b";
const route = `/acme/boards/${boardId}/kanban`;
const href = (id: string) => `${route}?card=${id}&sort=priority`;
const api = `/api/workspaces/acme/boards/${boardId}`;
const timestamp = "2026-10-19T10:00:00Z";
const socket = { status: "connected" as const, subscribe: () => () => {} };
const documentFor = (other: string) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
  { type: "text", text: `Open related ${other === cardA ? "A" : "B"}`, marks: [{ type: "link", attrs: { href: href(other), target: null } }] },
] }] });
const makeCard = (id: string, other: string): Card => ({ id, title: `Saved ${id}`, description: documentFor(other),
  column_id: "return-column", card_type: "task", priority: "medium", position: id === cardA ? 1024 : 2048,
  participants: [], due_date: null, status: "ready", labels: [], created_at: timestamp, updated_at: timestamp });
const cards = [makeCard(cardA, cardB), makeCard(cardB, cardA)];
const empty: LinkedSessionList = { items: [], summary: { session_count: 0, first_seen_at: null, last_seen_at: null,
  total_duration_seconds: 0, wall_duration_seconds: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
  cache_creation_tokens: 0, reasoning_tokens: 0, cost_usd: null, cost_reported_usd: null, cost_estimated_usd: null,
  cost_source: null, cost_basis: null, cost_complete: false } };
const sectionTitle = () => i18n.t("sessions.linked.cardTitle");
const observations = new Map<Element, IntersectionObserverCallback>();
const originalWindowObserver = window.IntersectionObserver, originalGlobalObserver = globalThis.IntersectionObserver;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const rectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const rectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const hitTestDescriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
class OffscreenObserver {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) { observations.set(target, this.report); }
  unobserve(target: Element) { observations.delete(target); }
  disconnect() { for (const [target, report] of observations) if (report === this.report) observations.delete(target); }
  takeRecords() { return []; }
}
function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
}
const views: { unmount: () => void; router: ReturnType<typeof createBrowserRouter>; client: QueryClient }[] = [];
beforeEach(async () => {
  await i18n.changeLanguage("en"); stubReducedMotion(true); observations.clear();
  // jsdom has no layout. Only a real requested heading scroll reports its
  // existing sentinel as visible; no private hook state or list is injected.
  window.IntersectionObserver = OffscreenObserver as unknown as typeof IntersectionObserver;
  globalThis.IntersectionObserver = OffscreenObserver as unknown as typeof IntersectionObserver;
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value(this: Element) {
    for (const [target, report] of [...observations]) if (target.contains(this) || this.contains(target)) {
      report([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  } });
  // jsdom has no hit-testing geometry; ProseMirror supports a null hit.
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
  const rect = { top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, width: 0, height: 0, toJSON: () => ({}) };
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true,
    value: () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) });
});
afterEach(() => {
  for (const view of views.splice(0)) { view.unmount(); view.router.dispose(); view.client.clear(); }
  observations.clear(); window.IntersectionObserver = originalWindowObserver; globalThis.IntersectionObserver = originalGlobalObserver;
  restore(Element.prototype, "scrollIntoView", scrollDescriptor); restore(Range.prototype, "getBoundingClientRect", rectDescriptor);
  restore(Range.prototype, "getClientRects", rectsDescriptor);
  restore(document, "elementFromPoint", hitTestDescriptor); stubReducedMotion(false);
});

function mount(statusA: number) {
  const state = { related: [] as { id: string; status: number }[], details: [] as string[], unexpected: [] as string[],
    writes: [] as string[], bodies: [] as string[], notes: [] as string[] };
  const board: BoardDetail = { id: boardId, slug: "return", name: "Return board", workspace_id: "ws-1", description: "", tags: [],
    created_at: timestamp, updated_at: timestamp, columns: [{ id: "return-column", board_id: boardId, name: "Active", column_type: "active",
      position: 1024, cards: cards.map((card) => ({ ...card, description: "Summary only" })), created_at: timestamp, updated_at: timestamp }] };
  const get = (path: string, value: Parameters<typeof HttpResponse.json>[0]) => http.get(path, () => HttpResponse.json(value));
  server.use(
    get(api, board),
    http.get(`${api}/cards/:cardId`, ({ params }) => {
      const id = String(params.cardId), card = cards.find((item) => item.id === id); state.details.push(id);
      return card ? HttpResponse.json(card) : HttpResponse.json({ detail: "Missing synthetic card" }, { status: 404 });
    }),
    http.get(`${api}/cards/:cardId/dependencies`, () => HttpResponse.json({ depends_on: [], blocks: [] })),
    http.get(`${api}/cards/:cardId/sessions`, ({ params }) => {
      const id = String(params.cardId), status = id === cardA ? statusA : 200;
      state.related.push({ id, status });
      return status === 200 ? HttpResponse.json(empty) : HttpResponse.json({ detail: "Synthetic current related-session denial", error_code: "forbidden" }, { status });
    }),
    http.get(`${api}/notes`, ({ request }) => {
      const url = new URL(request.url); state.notes.push(url.search);
      if (![cardA, cardB].includes(url.searchParams.get("card_id") ?? "")) state.unexpected.push(`Unscoped notes ${url.search}`);
      return HttpResponse.json([]);
    }),
    get("/api/workspaces", [{ id: "ws-1", slug: "acme", name: "Acme" }]),
    get("/api/workspaces/acme/members", [{ user_id: "user-me", name: "Me", email: "me@example.com", role: "owner" }]),
    get("/api/workspaces/acme/config", { pipeline_config: null }),
    get("/api/workspaces/acme/metrics/agents", { agents: [] }),
    get("/api/workspaces/acme/executions", []),
    get("/api/workspaces/acme/executions/skipped-card-ids", []),
    get(`${api}/loop/status`, { state: "off", enabled: false, bound_agent_count: 0, alive_agent_count: 0 }),
    get(`${api}/completion/policy`, { effective_policy: { evidence_only: { enabled: false } } }),
    http.get(`${api}/completion/cards/:cardId`, () => HttpResponse.json({ completion_mode: "source", candidate: null, attempts: [] })),
    get("/api/me/companion/installations", []),
    http.all("/api/*", ({ request }) => {
      const path = new URL(request.url).pathname;
      state.unexpected.push(`${request.method} ${path}`);
      if (request.method !== "GET") state.writes.push(`${request.method} ${path}`);
      if (/\/contents(?:\/|$)|\/calls(?:\/|$)/.test(path)) state.bodies.push(path);
      return HttpResponse.json({ detail: "Outside the in-place card-return fixture" }, { status: 418 });
    }),
  );
  stubAuthModes(true);
  // Normal browser GC retains authorized A detail while B is viewed. The
  // general test helper uses gcTime0, which introduces extra child unmounts
  // and cannot stand in for this real warm-detail navigation boundary.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  window.history.replaceState({ idx: 0, key: "card-origin", usr: null }, "", href(cardA));
  const router = createBrowserRouter([{ element: <NavigationGuardProvider><ReturnNavigationProvider ownerId="user-me">
    <HandoffDraftProvider ownerId="user-me"><Outlet /></HandoffDraftProvider></ReturnNavigationProvider></NavigationGuardProvider>,
    children: [{ path: "/:slug/boards/:boardId/kanban", element: <WebSocketContext.Provider value={socket}><BoardView /></WebSocketContext.Provider> }] }]);
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  const view = { ...rendered, router, client }; views.push(view);
  return { ...view, state };
}
async function settled(view: ReturnType<typeof mount>) {
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  expect(view.state.unexpected).toEqual([]); expect(view.state.writes).toEqual([]); expect(view.state.bodies).toEqual([]);
}
async function ready(view: ReturnType<typeof mount>, id: string) {
  await waitFor(() => expect(screen.getByRole("textbox", { name: i18n.t("cards.titleLabel") })).toHaveValue(`Saved ${id}`));
  await settled(view);
  expect(view.state.details).toContain(id);
  expect(window.location.pathname + window.location.search).toBe(href(id));
  expect(screen.getByRole("button", { name: i18n.t("common.save") })).toBeDisabled();
}
async function requestSection(view: ReturnType<typeof mount>, id: string, denied = false) {
  await userEvent.click(screen.getByRole("button", { name: sectionTitle() }));
  const section = await screen.findByRole("region", { name: sectionTitle() });
  await waitFor(() => expect(within(section).getByRole("heading", { name: sectionTitle() })).toHaveFocus());
  await within(section).findByText(i18n.t(denied ? "sessions.discovery.accessLost" : "sessions.linked.noneCard"), { exact: true });
  await settled(view); expect(view.state.related.some((request) => request.id === id)).toBe(true);
  return section;
}
async function follow(view: ReturnType<typeof mount>, id: string) {
  const label = `Open related ${id === cardA ? "A" : "B"}`;
  const link = await screen.findByRole("link", { name: label });
  expect(link).toHaveAttribute("href", href(id));
  await userEvent.click(link); await ready(view, id);
  expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
}

describe("Requested related-session explanations belong to the exact card and history entry", () => {
  it.each([200, 403])("restores A's explicitly requested HTTP%s explanation after requesting B in the same mounted sheet", async (status) => {
    const view = mount(status); await ready(view, cardA);
    expect(view.state.related).toEqual([]);
    await requestSection(view, cardA, status === 403);
    const originKey = view.router.state.location.key;
    const sheet = screen.getByRole("dialog", { name: i18n.t("cards.editTitle") });
    await follow(view, cardB);
    console.info("A04_CARD_SWITCH", JSON.stringify({ sheetNodeSurvived: screen.getByRole("dialog", { name: i18n.t("cards.editTitle") }) === sheet }));
    // A's explicit request must not display B's otherwise quiet empty answer.
    expect(screen.queryByRole("region", { name: sectionTitle() })).not.toBeInTheDocument();
    const bSection = await requestSection(view, cardB);
    const sentinel = bSection.parentElement;
    act(() => window.history.back());
    await waitFor(() => expect(view.router.state.location.key).toBe(originKey));
    await ready(view, cardA);
    // Observational only: a correct repair may remount the section. Do not
    // prescribe a keying/reset implementation as the acceptance oracle.
    console.info("A04_CARD_SECTION_RETURN", JSON.stringify({ status, sectionSentinelSurvived: sentinel?.isConnected,
      currentCard: new URLSearchParams(window.location.search).get("card"), requests: view.state.related }));
    const restored = await screen.findByRole("region", { name: sectionTitle() });
    expect(within(restored).getByText(i18n.t(status === 403 ? "sessions.discovery.accessLost" : "sessions.linked.noneCard"), { exact: true })).toBeVisible();
    expect(screen.getAllByRole("region", { name: sectionTitle() })).toHaveLength(1);
    await settled(view);
  });

  it("does not seed a fresh A history entry from its old request, while Back still restores B's requested entry", async () => {
    const view = mount(200); await ready(view, cardA);
    await requestSection(view, cardA);
    const originalAKey = view.router.state.location.key;
    await follow(view, cardB);
    expect(screen.queryByRole("region", { name: sectionTitle() })).not.toBeInTheDocument();
    await requestSection(view, cardB);
    const requestedBKey = view.router.state.location.key;
    await follow(view, cardA);
    expect(view.router.state.location.key).not.toBe(originalAKey);
    expect(view.router.state.location.key).not.toBe(requestedBKey);
    expect(screen.queryByRole("region", { name: sectionTitle() })).not.toBeInTheDocument();
    const navigation = JSON.stringify({ history: window.history.state, local: { ...localStorage }, session: { ...sessionStorage } });
    expect(navigation).not.toContain("linked-sessions-opening");
    expect(navigation).not.toContain(`Saved ${cardA}`); expect(navigation).not.toContain(`Saved ${cardB}`);
    act(() => window.history.back());
    await waitFor(() => expect(view.router.state.location.key).toBe(requestedBKey));
    await ready(view, cardB);
    const restored = await screen.findByRole("region", { name: sectionTitle() });
    expect(within(restored).getByText(i18n.t("sessions.linked.noneCard"), { exact: true })).toBeVisible();
    await settled(view);
  });
});
