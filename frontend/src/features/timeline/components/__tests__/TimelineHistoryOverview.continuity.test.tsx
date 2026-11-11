// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { webcrypto } from "node:crypto";
import { fireEvent, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { ThemeProvider } from "@/hooks/use-theme";
import i18n from "@/i18n/config";
import { timelineKeys } from "@/lib/query-keys";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { act, createTestQueryClient, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { API_BASE, BOARD, CARD_ID, installContinuityHistory, SLUG, TARGET_SEQ, TARGET_SUMMARY, TIMELINE_PATH } from "../../__tests__/continuity-fixtures";
import { sequence } from "../../__tests__/history-fixtures";
import { VIEW_MODE_STORAGE_KEY } from "../../hooks/use-view-mode";
import { TimelineSimulator } from "../TimelineSimulator";

const MOMENT = `${TIMELINE_PATH}?at=${TARGET_SEQ}`;
const CURRENT_CARD = `/${SLUG}/boards/${BOARD}/kanban?card=${CARD_ID}`;
const DATE = "2026-10-06";
const QUERY = "private incident investigation";
const UNSENT = "private next investigation draft";
const PAGE_TWO = "private-search-page-two";
const RESULT = "Private investigation result 59";
const RESULT_SCROLL_TOP = 216;
type Context = { signal: AbortSignal };
type Entry = { href: string; state: unknown };
type SearchRead = { viewer: string; generationId: string; q: string | null; cursor: string | null };

function installOverviewHistory() {
  const history = installContinuityHistory();
  const searchReads: SearchRead[] = [];
  server.use(http.get(`${API_BASE}/generations/:id/search`, ({ request, params }) => {
    const query = new URL(request.url).searchParams;
    const generationId = String(params.id);
    const q = query.get("q");
    const cursor = query.get("cursor");
    searchReads.push({ viewer: history.viewer, generationId, q, cursor });
    if (!history.created.some((entry) => entry.generation.id === generationId) || q !== QUERY || (cursor !== null && cursor !== PAGE_TWO) || query.get("limit") !== "50") {
      history.unexpected.push(`Unexpected overview search: ${request.url}`);
      return HttpResponse.json({ detail: "Unexpected search fixture request" }, { status: 418 });
    }
    const secondPage = cursor === PAGE_TWO;
    return HttpResponse.json({ generation_id: generationId, scope: "generation",
      matches: Array.from({ length: 50 }, (_, index) => ({
        id: `overview-match-${(secondPage ? 50 : 0) + index + 1}`,
        seq: sequence((secondPage ? 442 : 300) + index),
        created_at: "2026-10-08T12:00:00Z",
        summary: `Private investigation result ${(secondPage ? 50 : 0) + index + 1}`,
      })),
      next_cursor: secondPage ? null : PAGE_TWO,
    });
  }));
  return Object.assign(history, { searchReads });
}

type Fixture = ReturnType<typeof installOverviewHistory>;
const fixtures: Fixture[] = [];
const mounted = new Set<{ dispose: () => void }>();
const entries: Entry[] = [];
function fixture() { const value = installOverviewHistory(); fixtures.push(value); return value; }
function captureEntry(): Entry {
  return { href: window.location.pathname + window.location.search + window.location.hash, state: structuredClone(window.history.state) };
}

function OwnerLayout({ history }: { history: Fixture }) {
  const me = useCurrentUser();
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={me.data?.id ?? null}><HandoffDraftProvider ownerId={me.data?.id ?? null}>
    <output aria-label="Current viewer">{me.data?.id ?? "pending"}</output>
    <button type="button" onClick={() => { history.setViewer("viewer-b"); void me.refetch(); }}>Change fixture account</button>
    <Outlet />
  </HandoffDraftProvider></ReturnNavigationProvider></NavigationGuardProvider>;
}

function mountDocument(context: Context, history: Fixture, entry?: Entry) {
  // A cold-document fixture carries only the real prior browser entry, never
  // provider state or Query data. Native Back below keeps the mounted providers.
  window.history.replaceState(entry?.state ?? { idx: 0, key: "overview-origin", usr: null }, "", entry?.href ?? MOMENT);
  const client = createTestQueryClient();
  const router = createBrowserRouter([{
    element: <OwnerLayout history={history} />,
    children: [
      { path: TIMELINE_PATH, element: <main><h1>Board timeline</h1><TimelineSimulator slug={SLUG} boardId={BOARD} /></main> },
      { path: `/${SLUG}/boards/${BOARD}/kanban`, element: <main><h1>Current card destination</h1></main> },
    ],
  }]);
  const unsubscribe = router.subscribe(() => { entries.push(captureEntry()); });
  const view = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  let disposed = false;
  const result = { ...view, router, client, dispose() {
    if (disposed) return;
    disposed = true; view.unmount(); unsubscribe(); router.dispose(); client.clear(); mounted.delete(result);
  } };
  mounted.add(result); onTestFinished(result.dispose);
  context.signal.throwIfAborted();
  return result;
}
type Mounted = ReturnType<typeof mountDocument>;

async function ready(view: Mounted, context: Context) {
  await within(view.container).findByRole("slider", { name: "Timeline position" }); context.signal.throwIfAborted();
  await waitFor(() => expect(within(view.container).getByRole("slider", { name: "Timeline position" })).toHaveAttribute("aria-valuetext", expect.stringContaining(TARGET_SUMMARY)));
  context.signal.throwIfAborted();
  await waitFor(() => expect(view.client.isFetching()).toBe(0)); context.signal.throwIfAborted();
}
function overview(view: Mounted) { return within(view.container).getByRole("region", { name: "History overview" }); }
function results(view: Mounted) { return within(overview(view)).getByLabelText("History search results"); }

async function setDateAndPeriod(view: Mounted, user: ReturnType<typeof userEvent.setup>, context: Context) {
  const controls = within(overview(view));
  // Date inputs expose their ISO value through the native change event.
  fireEvent.change(controls.getByLabelText("Date (UTC)"), { target: { value: DATE } });
  await user.selectOptions(controls.getByRole("combobox", { name: "Period" }), "week"); context.signal.throwIfAborted();
  expect(controls.getByLabelText("Date (UTC)")).toHaveValue(DATE);
  expect(controls.getByRole("combobox", { name: "Period" })).toHaveValue("week");
  expect(controls.getByRole("group", { name: "Selected period detail" })).toBeInTheDocument();
}

async function submitAndReadSecondPage(view: Mounted, history: Fixture, user: ReturnType<typeof userEvent.setup>, context: Context) {
  const input = within(overview(view)).getByRole("searchbox", { name: "Search all history" });
  await user.click(input); context.signal.throwIfAborted();
  await user.paste(QUERY); context.signal.throwIfAborted();
  await user.click(within(overview(view)).getByRole("button", { name: "Search" })); context.signal.throwIfAborted();
  await within(overview(view)).findByText("Private investigation result 1"); context.signal.throwIfAborted();
  await user.click(within(results(view)).getByRole("button", { name: "More results" })); context.signal.throwIfAborted();
  await within(overview(view)).findByText(RESULT); context.signal.throwIfAborted();
  expect(history.searchReads.map(({ q, cursor }) => ({ q, cursor }))).toEqual([{ q: QUERY, cursor: null }, { q: QUERY, cursor: PAGE_TWO }]);
  expect(within(results(view)).queryByText("Private investigation result 1")).not.toBeInTheDocument();
  // The second page contains the exact event already addressed by this entry.
  // Selecting it exercises the actual search-result-to-window API seam.
  await user.click(within(results(view)).getByRole("button", { name: new RegExp(`${RESULT}$`) })); context.signal.throwIfAborted();
  await ready(view, context);
  await user.clear(input); context.signal.throwIfAborted();
  await user.paste(UNSENT); context.signal.throwIfAborted();
  expect(input).toHaveValue(UNSENT);
  expect(history.searchReads).toHaveLength(2);
  const list = results(view);
  list.scrollTop = RESULT_SCROLL_TOP;
  fireEvent.scroll(list);
  expect(list.scrollTop).toBe(RESULT_SCROLL_TOP);
  expect(within(list).getByText(RESULT)).toBeInTheDocument();
}

async function openCurrentCard(view: Mounted, user: ReturnType<typeof userEvent.setup>, context: Context) {
  await user.click(within(screen.getByTestId("step-panel")).getByRole("button", { name: "Details" })); context.signal.throwIfAborted();
  const details = screen.getByRole("region", { name: "Event details" });
  const link = within(details).getByRole("link", { name: /current.*card|card.*current/i });
  expect(link).toHaveAttribute("href", CURRENT_CARD);
  await user.click(link); context.signal.throwIfAborted();
  await screen.findByRole("heading", { name: "Current card destination" }); context.signal.throwIfAborted();
  expect(window.location.pathname + window.location.search).toBe(CURRENT_CARD);
  // Use ordinary inactive Query GC; no test cache deletion masks restoration.
  await waitFor(() => expect(view.client.getQueryCache().findAll({ queryKey: timelineKeys.history(SLUG, BOARD) })).toHaveLength(0));
  context.signal.throwIfAborted();
}
async function back(view: Mounted, context: Context) {
  act(() => window.history.back());
  await ready(view, context);
}
function privacy(history: Fixture) {
  const current = captureEntry();
  const persisted = JSON.stringify({ entries: [...entries, current], local: { ...localStorage }, session: { ...sessionStorage } });
  for (const privateValue of [QUERY, UNSENT, PAGE_TWO, RESULT, DATE]) expect(persisted).not.toContain(privateValue);
  for (const entry of [...entries, current]) {
    const url = new URL(entry.href, window.location.origin);
    expect([...url.searchParams.keys()]).toEqual(url.pathname === TIMELINE_PATH ? ["at"] : ["card"]);
    expect(url.hash).toBe("");
  }
  expect(history.unexpected).toEqual([]);
  expect(history.requests.filter((request) => request.path !== "/api/me" && !request.path.includes("/timeline/"))).toEqual([]);
}
function emptyOverview(view: Mounted) {
  const controls = within(overview(view));
  expect(controls.getByLabelText("Date (UTC)")).toHaveValue("");
  expect(controls.getByRole("combobox", { name: "Period" })).toHaveValue("all");
  expect(controls.getByRole("searchbox", { name: "Search all history" })).toHaveValue("");
  expect(controls.queryByLabelText("History search results")).not.toBeInTheDocument();
  expect(controls.queryByRole("button", { name: "Close search" })).not.toBeInTheDocument();
}

const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
beforeAll(() => {
  if (!globalThis.crypto.subtle) Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
});
afterAll(() => {
  if (originalSubtle) Object.defineProperty(globalThis.crypto, "subtle", originalSubtle);
  else Reflect.deleteProperty(globalThis.crypto, "subtle");
});
beforeEach(async () => { await i18n.changeLanguage("en"); stubReducedMotion(true); localStorage.removeItem(VIEW_MODE_STORAGE_KEY); });
afterEach(() => {
  for (const view of [...mounted]) view.dispose();
  console.info("A05_OVERVIEW_CONTINUITY_RECEIPT", JSON.stringify({ entries: entries.splice(0), fixtures: fixtures.splice(0).map((history) => ({ requests: history.requests, searches: history.searchReads, unexpected: history.unexpected })) }));
  stubReducedMotion(false); localStorage.removeItem(VIEW_MODE_STORAGE_KEY);
});

describe("timeline overview continuity across current-work navigation", () => {
  it("returns to the same date and period after opening the selected event's current card", async (context) => {
    const history = fixture(); const view = mountDocument(context, history); const user = userEvent.setup();
    await ready(view, context);
    await setDateAndPeriod(view, user, context);
    const generationId = history.created[0]!.generation.id;
    await openCurrentCard(view, user, context);
    privacy(history);
    await back(view, context);
    expect(history.created.map((entry) => entry.generation.id)).toEqual([generationId]);
    expect(within(overview(view)).getByLabelText("Date (UTC)")).toHaveValue(DATE);
    expect(within(overview(view)).getByRole("combobox", { name: "Period" })).toHaveValue("week");
    expect(within(overview(view)).getByRole("group", { name: "Selected period detail" })).toBeInTheDocument();
    privacy(history);
  });

  it("restores the submitted search's second page and reading position independently of unsent query text", async (context) => {
    const history = fixture(); const view = mountDocument(context, history); const user = userEvent.setup();
    await ready(view, context);
    await submitAndReadSecondPage(view, history, user, context);
    const generationId = history.created[0]!.generation.id;
    await openCurrentCard(view, user, context);
    privacy(history);
    const beforeReturn = history.searchReads.length;
    await back(view, context);
    expect(within(overview(view)).getByRole("searchbox", { name: "Search all history" })).toHaveValue(UNSENT);
    await within(overview(view)).findByText(RESULT); context.signal.throwIfAborted();
    await waitFor(() => expect(results(view).scrollTop).toBe(RESULT_SCROLL_TOP)); context.signal.throwIfAborted();
    expect(within(results(view)).queryByText("Private investigation result 1")).not.toBeInTheDocument();
    expect(history.searchReads.slice(beforeReturn)).toEqual([{ viewer: "viewer-a", generationId, q: QUERY, cursor: PAGE_TWO }]);
    expect(history.created.map((entry) => entry.generation.id)).toEqual([generationId]);
    privacy(history);
  });

  it("drops overview memory on a cold router/cache/provider remount while restoring the entry's exact moment", async (context) => {
    const history = fixture(); const view = mountDocument(context, history); const user = userEvent.setup();
    await ready(view, context);
    await setDateAndPeriod(view, user, context);
    await submitAndReadSecondPage(view, history, user, context);
    const entry = captureEntry(); const generationId = history.created[0]!.generation.id;
    privacy(history); view.dispose();
    const reloaded = mountDocument(context, history, entry);
    await ready(reloaded, context);
    emptyOverview(reloaded);
    expect(history.searchReads).toHaveLength(2);
    expect(history.created.map((item) => item.generation.id)).toEqual([generationId]);
    expect(window.location.pathname + window.location.search).toBe(MOMENT);
    privacy(history);
  });

  it("does not restore another owner's overview or dispatch their search after an actual identity change and Back", async (context) => {
    const history = fixture(); const view = mountDocument(context, history); const user = userEvent.setup();
    await ready(view, context);
    await setDateAndPeriod(view, user, context);
    await submitAndReadSecondPage(view, history, user, context);
    const generationId = history.created[0]!.generation.id;
    await openCurrentCard(view, user, context);
    await user.click(screen.getByRole("button", { name: "Change fixture account" })); context.signal.throwIfAborted();
    await waitFor(() => expect(screen.getByLabelText("Current viewer")).toHaveTextContent("viewer-b")); context.signal.throwIfAborted();
    await back(view, context);
    emptyOverview(view);
    expect(history.searchReads).toHaveLength(2);
    expect(history.created.at(-1)?.viewer).toBe("viewer-b");
    expect(history.created.at(-1)?.generation.id).not.toBe(generationId);
    expect(window.location.pathname + window.location.search).toBe(MOMENT);
    privacy(history);
  });
});
