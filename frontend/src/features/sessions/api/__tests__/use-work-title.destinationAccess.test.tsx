// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider, useRouteError } from "react-router-dom";
import { render } from "@testing-library/react";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { BoardView } from "@/features/kanban/components/BoardView";
import { WorkChip, type WorkChipRef } from "../../components/WorkChip";
import { api } from "@/lib/api";
import { cardKeys } from "@/lib/query-keys";
import { shouldRetry } from "@/lib/should-retry";
import i18n from "@/i18n/config";
import type { BoardDetail, Card } from "@/types/kanban";

// Both canonical-key readers and their route lifetimes are real. HTTP responses
// alone populate the cache; production retry/freshness keeps the denial window.
const SLUG = "acme";
const BOARD = "board-1";
const CARD = "card-target";
const SESSION_PATH = `/${SLUG}/sessions/session-1`;
const BOARD_PATH = `/${SLUG}/boards/${BOARD}/kanban?card=${CARD}`;
const API_BOARD = `/api/workspaces/${SLUG}/boards/${BOARD}`;
const DETAIL_PATH = `/workspaces/${SLUG}/boards/${BOARD}/cards/${CARD}`;
const PRIVATE_TITLE = "Private exact destination title";
const PRIVATE_BODY = "Private full card body absent from the board summary";
const timestamp = "2026-10-19T10:00:00Z";
const card: Card = {
  id: CARD, title: PRIVATE_TITLE,
  description: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: PRIVATE_BODY }] }] }),
  card_type: "task", priority: "medium", position: 1024, column_id: "column-1",
  participants: [], due_date: null, status: "todo", labels: null,
  created_at: timestamp, updated_at: timestamp,
};
const work: WorkChipRef = {
  entity_type: "card", entity_id: CARD, board_id: BOARD, workspace_id: "workspace-1",
  relation: "consulted", provenance: "exact",
};
const socket = { status: "connected" as const, subscribe: () => () => {} };
const detailKey = cardKeys.detail(SLUG, BOARD, CARD);

function Ownership() {
  return <WebSocketContext.Provider value={socket}><NavigationGuardProvider>
    <ReturnNavigationProvider ownerId="user-me"><HandoffDraftProvider ownerId="user-me">
      <Outlet />
    </HandoffDraftProvider></ReturnNavigationProvider>
  </NavigationGuardProvider></WebSocketContext.Provider>;
}

function RouteFailure({ errors }: { errors: string[] }) {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : String(error);
  useEffect(() => { errors.push(message); }, [errors, message]);
  // React Router's real error boundary captures the crash; the assertion still
  // requires the ordinary work-unavailable state, never this diagnostic output.
  return <p role="alert" data-testid="destination-route-error">{message}</p>;
}

function mount() {
  const state = {
    status: 200, details: [] as number[], unexpected: [] as string[], errors: [] as string[],
    signals: [] as { readonly aborted?: boolean }[],
    beforeReturn: null as null | { status: string; fetchStatus: string; failureCount: number; nullData: boolean },
  };
  const board: BoardDetail = {
    id: BOARD, slug: "work", name: "Destination board", description: "", tags: [], workspace_id: "workspace-1",
    created_at: timestamp, updated_at: timestamp,
    columns: [{ id: "column-1", board_id: BOARD, name: "Current work", column_type: "active", position: 1024,
      cards: [{ ...card, description: "Board summary only" }], created_at: timestamp, updated_at: timestamp }],
  };
  const get = (path: string, value: Parameters<typeof HttpResponse.json>[0]) =>
    http.get(path, () => HttpResponse.json(value));
  server.use(
    http.get(`/api${DETAIL_PATH}`, () => {
      state.details.push(state.status);
      return state.status === 200 ? HttpResponse.json(card)
        : HttpResponse.json({ detail: state.status === 403 ? "Card unavailable" : "Temporary outage" }, { status: state.status });
    }),
    get(API_BOARD, board),
    get(`${API_BOARD}/cards/${CARD}/dependencies`, { depends_on: [], blocks: [] }),
    get(`${API_BOARD}/notes`, []),
    get("/api/workspaces", [{ id: "workspace-1", slug: SLUG, name: "Acme" }]),
    get("/api/me", { id: "user-me", email: "fixture@example.invalid", display_name: "Fixture operator" }),
    get("/api/auth/modes", { password_enabled: true, oidc_enabled: false, companion_enabled: false }),
    get(`/api/workspaces/${SLUG}/members`, []),
    get(`/api/workspaces/${SLUG}/config`, { pipeline_config: null }),
    get(`/api/workspaces/${SLUG}/metrics/agents`, { agents: [] }),
    get(`/api/workspaces/${SLUG}/executions`, []),
    get(`/api/workspaces/${SLUG}/executions/skipped-card-ids`, []),
    get(`${API_BOARD}/loop/status`, { state: "off", enabled: false, bound_agent_count: 0, alive_agent_count: 0 }),
    get(`${API_BOARD}/completion/policy`, { effective_policy: { evidence_only: { enabled: false } } }),
    get(`${API_BOARD}/completion/cards/${CARD}`, { completion_mode: "source", candidate: null, attempts: [] }),
    http.all("/api/*", ({ request }) => {
      state.unexpected.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
      return HttpResponse.json({ detail: "Unexpected fixture endpoint" }, { status: 503 });
    }),
  );
  const interceptor = api.interceptors.request.use((config) => {
    if (config.url === DETAIL_PATH && config.signal) state.signals.push(config.signal);
    return config;
  });
  // These are main.tsx's production query defaults, not the retry:false test
  // helper. No retryDelay, timer, timeout or cached-data override is installed.
  const client = new QueryClient({ defaultOptions: { queries: {
    staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: false,
  } } });
  const router = createMemoryRouter([{
    element: <Ownership />, errorElement: <RouteFailure errors={state.errors} />, children: [
      { path: SESSION_PATH, element: <><h1>Captured work</h1><WorkChip slug={SLUG} work={work} /></> },
      { path: "/:slug/boards/:boardId/kanban", element: <BoardView /> },
    ],
  }], { initialEntries: [SESSION_PATH] });
  const view = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  return { state, client, router, view, interceptor, refresh: undefined as Promise<void> | undefined };
}

type Fixture = ReturnType<typeof mount>;
async function openAuthorizedCard(fixture: Fixture) {
  const link = await screen.findByRole("link", { name: new RegExp(PRIVATE_TITLE) });
  expect(link).toHaveAttribute("href", BOARD_PATH);
  await userEvent.setup().click(link);
  const title = await screen.findByRole("textbox", { name: i18n.t("cards.titleLabel") });
  await waitFor(() => expect(title).toHaveValue(PRIVATE_TITLE));
  await screen.findByText(PRIVATE_BODY, { exact: true });
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.state.details).toEqual([200]);
  expect(fixture.state.unexpected).toEqual([]);
}
function refresh(fixture: Fixture, status: number) {
  fixture.state.status = status;
  act(() => { fixture.refresh = fixture.client.refetchQueries({ queryKey: detailKey, exact: true }); });
}
async function returnToWork(fixture: Fixture) {
  const query = fixture.client.getQueryState<Card | null>(detailKey);
  fixture.state.beforeReturn = query ? {
    status: query.status, fetchStatus: query.fetchStatus,
    failureCount: query.fetchFailureCount, nullData: query.data === null,
  } : null;
  await act(async () => { await fixture.router.navigate(-1); });
  expect(fixture.router.state.location.pathname).toBe(SESSION_PATH);
}
async function finish(name: string, fixture: Fixture) {
  try {
    fixture.view.unmount();
    fixture.router.dispose();
    await fixture.client.cancelQueries();
    await fixture.refresh;
  } finally {
    console.info("A05_SHARED_CARD_CACHE_RECEIPT", JSON.stringify({
      name, details: fixture.state.details, beforeReturn: fixture.state.beforeReturn,
      routeErrors: fixture.state.errors, abortedSignals: fixture.state.signals.map((signal) => signal.aborted),
      unexpected: fixture.state.unexpected,
    }));
    api.interceptors.request.eject(fixture.interceptor);
    fixture.client.clear();
  }
}

beforeEach(async () => { await i18n.changeLanguage("en"); stubReducedMotion(true); });
afterEach(() => stubReducedMotion(false));

describe("canonical card destination cache across session return", () => {
  it("returns an authorized 200 card to its real session work-title consumer", async () => {
    const fixture = mount();
    try {
      await openAuthorizedCard(fixture);
      refresh(fixture, 200);
      await act(async () => { await fixture.refresh; });
      await returnToWork(fixture);
      expect(await screen.findByRole("link", { name: new RegExp(PRIVATE_TITLE) })).toHaveAttribute("href", BOARD_PATH);
      expect(screen.queryByTestId("destination-route-error")).not.toBeInTheDocument();
      expect(fixture.state.errors).toEqual([]);
      expect(fixture.state.details).toEqual([200, 200]);
      expect(fixture.state.unexpected).toEqual([]);
    } finally { await finish("authorized 200 control", fixture); }
  });

  it("returns during a real 403 retry without crashing or reviving the private title", async () => {
    const fixture = mount();
    try {
      await openAuthorizedCard(fixture);
      refresh(fixture, 403);
      await screen.findByText(i18n.t("cards.deepLink.unavailable"), { exact: true });
      // Establish the actual automatic-retry interval before navigating. This
      // neither sets the cache nor fabricates a hook-only lifetime transition.
      expect(fixture.client.getQueryState(detailKey)?.fetchStatus).toBe("fetching");
      expect(fixture.client.getQueryState(detailKey)?.fetchFailureCount).toBe(1);
      expect(fixture.state.details).toEqual([200, 403]);
      expect(fixture.state.signals.at(-1)?.aborted).toBe(false);
      await returnToWork(fixture);
      await screen.findByText(i18n.t("sessions.work.unavailable"), { exact: true });
      expect(screen.queryByTestId("destination-route-error")).not.toBeInTheDocument();
      expect(screen.queryByText(PRIVATE_TITLE, { exact: true })).not.toBeInTheDocument();
      expect(screen.queryByText(PRIVATE_BODY, { exact: true })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: new RegExp(PRIVATE_TITLE) })).not.toBeInTheDocument();
      expect(fixture.state.errors).toEqual([]);
      expect(fixture.state.unexpected).toEqual([]);
    } finally { await finish("403 retry and real route return", fixture); }
  });

  it("keeps a transient 503 distinct from denied access when returning to session work", async () => {
    const fixture = mount();
    try {
      await openAuthorizedCard(fixture);
      refresh(fixture, 503);
      await act(async () => { await fixture.refresh; });
      await screen.findByText(i18n.t("cards.deepLink.loadError"), { exact: true });
      await returnToWork(fixture);
      await screen.findByText(i18n.t("sessions.work.loadError"), { exact: true });
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      expect(screen.queryByTestId("destination-route-error")).not.toBeInTheDocument();
      expect(screen.queryByText(PRIVATE_TITLE, { exact: true })).not.toBeInTheDocument();
      expect(screen.queryByText(PRIVATE_BODY, { exact: true })).not.toBeInTheDocument();
      expect(screen.queryByText(i18n.t("sessions.work.unavailable"), { exact: true })).not.toBeInTheDocument();
      expect(fixture.state.errors).toEqual([]);
      expect(fixture.state.unexpected).toEqual([]);
    } finally { await finish("transient 503 control", fixture); }
  });
});
