// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { webcrypto } from "node:crypto";
import { fireEvent, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { ContextLink } from "@/components/shared/ContextLink";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { ThemeProvider } from "@/hooks/use-theme";
import i18n from "@/i18n/config";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { http, HttpResponse, server } from "@/test/msw-server";
import { createTestQueryClient, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { BOARD, API_BASE, SLUG, TIMELINE_PATH, TARGET_SEQ, TARGET_TITLE, TARGET_SUMMARY, CARD_ID, SEARCH_MATCH } from "../../__tests__/continuity-fixtures";
import { card, generation, historyEvent, overview, readyWindow, sequence } from "../../__tests__/history-fixtures";
import { VIEW_MODE_STORAGE_KEY } from "../../hooks/use-view-mode";
import type { HistoryGeneration } from "../../types";
import { TimelineSimulator } from "../TimelineSimulator";

const MOMENT_URL = `${TIMELINE_PATH}?at=${TARGET_SEQ}`;
const OWNER_A = "reload-owner-a";
const OWNER_B = "reload-owner-b";
const PRIVATE_FLAG = "Private in-memory timeline flag";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Context = { signal: AbortSignal };
type Entry = { href: string; state: unknown };
type Post = { viewer: string; requestId: string; generationId: string; status: number; state: unknown; ownerResolved: boolean };
type Read = { path: string; search: string; generationId?: string; status: number };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function capturedEntry(): Entry {
  return { href: window.location.pathname + window.location.search + window.location.hash, state: structuredClone(window.history.state) };
}

function userState(state: unknown): unknown {
  return state !== null && typeof state === "object" && "usr" in state ? state.usr : undefined;
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(stringLeaves);
}

function reference(entry: Entry): string {
  // Ignore the existing return envelope: its own opaque key is unrelated to
  // the timeline reference. Do not prescribe the new product field name.
  const state = userState(entry.state);
  const timelineState = state !== null && typeof state === "object"
    ? Object.fromEntries(Object.entries(state).filter(([key]) => key !== "bpReturn"))
    : state;
  const tokens = stringLeaves(timelineState).filter((value) => UUID.test(value));
  expect(tokens, "one opaque timeline reference must survive in the actual browser entry").toHaveLength(1);
  return tokens[0]!;
}

function serveHistory() {
  let viewer = OWNER_A;
  let ownerStatus = 200;
  let ownerResolved = false;
  let meGate: ReturnType<typeof deferred> | null = null;
  let nextPostGate: ReturnType<typeof deferred> | null = null;
  let serial = 0;
  const posts: Post[] = [];
  const reads: Read[] = [];
  const unexpected: string[] = [];
  // The actual service's unique key is board + request_id, NOT viewer + request_id.
  const requests = new Map<string, HistoryGeneration>();
  const expired = new Set<string>();
  const gates = new Set<ReturnType<typeof deferred>>();
  const created: { requestId: string; generationId: string; viewer: string }[] = [];
  const read = (request: Request, status: number, generationId?: string) => {
    const url = new URL(request.url); reads.push({ path: url.pathname, search: url.search, status, generationId });
  };
  const failure = (status: number) => HttpResponse.json({ detail: status === 410 ? "Historical generation expired" : "Access unavailable", error_code: status === 410 ? "timeline_generation_expired" : "forbidden" }, { status });
  const getGeneration = (request: Request, id: string) => {
    const exists = [...requests.values()].some((item) => item.id === id);
    const status = !exists ? 404 : expired.has(id) ? 410 : 200;
    read(request, status, id);
    return status === 200 ? null : failure(status);
  };
  server.use(
    http.get("/api/me", async ({ request }) => {
      const gate = meGate; const status = ownerStatus; const account = viewer;
      read(request, status);
      if (gate) await gate.promise;
      ownerResolved = status === 200;
      return status === 200 ? HttpResponse.json({ id: account, name: account, email: `${account}@example.test`, avatar_url: null }) : failure(status);
    }),
    http.post(`${API_BASE}/generations`, async ({ request }) => {
      const state = structuredClone(window.history.state);
      const resolvedAtArrival = ownerResolved;
      const account = viewer;
      const gate = nextPostGate; nextPostGate = null;
      const body = await request.json() as { request_id: string };
      if (!UUID.test(body.request_id)) { unexpected.push("Generation request_id is not a UUID"); return failure(422); }
      let item = requests.get(body.request_id);
      const status = item ? expired.has(item.id) ? 410 : 200 : 201;
      if (!item) {
        serial += 1;
        item = generation(`00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`);
        requests.set(body.request_id, item);
        created.push({ requestId: body.request_id, generationId: item.id, viewer: account });
      }
      posts.push({ viewer: account, requestId: body.request_id, generationId: item.id, status, state, ownerResolved: resolvedAtArrival });
      // Persist the server result before holding the response: an interrupted
      // client must reuse the same committed idempotency identity on reload.
      if (gate) await gate.promise;
      return status === 410 ? failure(status) : HttpResponse.json(item, { status });
    }),
    http.get(`${API_BASE}/generations/:id/overview`, ({ request, params }) => {
      const id = String(params.id); return getGeneration(request, id) ?? HttpResponse.json(overview(id));
    }),
    http.get(`${API_BASE}/generations/:id/window`, ({ request, params }) => {
      const id = String(params.id); const error = getGeneration(request, id); if (error) return error;
      const search = new URL(request.url).searchParams;
      const at = search.get("at_seq");
      const offset = at ? Number(BigInt(at) - BigInt(sequence(0))) : 9998;
      const result = readyWindow(offset, id);
      result.anchor.state.cards = [card({ id: CARD_ID, title: "Before exact event" })];
      result.events = result.events.map((event) => event.seq === TARGET_SEQ ? historyEvent(450, {
        entity_type: "card", entity_id: CARD_ID, entity_title: TARGET_TITLE, summary: TARGET_SUMMARY,
        before_state: card({ id: CARD_ID, title: "Before exact event" }), after_state: card({ id: CARD_ID, title: TARGET_TITLE }),
      }) : event);
      return HttpResponse.json(result);
    }),
    http.get(`${API_BASE}/generations/:id/search`, ({ request, params }) => {
      const id = String(params.id); return getGeneration(request, id) ?? HttpResponse.json({ generation_id: id, scope: "generation",
        matches: [{ id: "reload-target", seq: TARGET_SEQ, created_at: "2026-10-08T12:00:00Z", summary: SEARCH_MATCH }], next_cursor: null });
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      read(request, 418); return HttpResponse.json({ detail: "Unexpected reload-fixture request" }, { status: 418 });
    }),
  );
  return {
    posts, reads, unexpected, created,
    setViewer(next: string) { viewer = next; ownerResolved = false; },
    denyOwner() { ownerStatus = 401; ownerResolved = false; },
    holdOwner() { ownerResolved = false; meGate = deferred(); gates.add(meGate); return meGate; },
    holdNextPost() { nextPostGate = deferred(); gates.add(nextPostGate); return nextPostGate; },
    expire(id: string) { expired.add(id); },
    releaseAll() { for (const gate of gates) gate.release(); },
  };
}

type Fixture = ReturnType<typeof serveHistory>;
const fixtures: Fixture[] = [];
const mounted = new Set<{ dispose: () => void }>();
function fixture() { const result = serveHistory(); fixtures.push(result); return result; }

function OwnerLayout() {
  const me = useCurrentUser();
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={me.data?.id ?? null}><HandoffDraftProvider ownerId={me.data?.id ?? null}>
    <output aria-label="Viewer query status">{me.status}</output><Outlet />
  </HandoffDraftProvider></ReturnNavigationProvider></NavigationGuardProvider>;
}

function mountDocument(context: Context, entry?: Entry, fromRelated = false) {
  // Only this test's browser-document boundary writes history directly. On
  // reload the entire state below is captured from the actual previous router.
  window.history.replaceState(entry?.state ?? { idx: 0, key: "reload-origin", usr: null }, "", entry?.href ?? (fromRelated ? "/reload-related-work" : MOMENT_URL));
  const client = createTestQueryClient();
  const router = createBrowserRouter([{
    element: <OwnerLayout />,
    children: [
      { path: "/reload-related-work", element: <main><h1>Related work</h1><ContextLink id="timeline-origin" to={MOMENT_URL}>Open timeline</ContextLink></main> },
      { path: TIMELINE_PATH, element: <main><h1>Board timeline</h1><TimelineSimulator slug={SLUG} boardId={BOARD} /></main> },
    ],
  }]);
  const view = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  let disposed = false;
  const result = { ...view, client, router, dispose() {
    if (disposed) return;
    disposed = true; view.unmount(); router.dispose(); client.clear(); mounted.delete(result);
  } };
  mounted.add(result); onTestFinished(result.dispose);
  context.signal.throwIfAborted();
  return result;
}

type Mounted = ReturnType<typeof mountDocument>;
async function settled(view: Mounted, context: Context) {
  await waitFor(() => expect(view.client.isFetching()).toBe(0)); context.signal.throwIfAborted();
}
async function ready(view: Mounted, context: Context) {
  await within(view.container).findByRole("slider", { name: "Timeline position" }); context.signal.throwIfAborted();
  await settled(view, context);
}
async function initialMoment(view: Mounted, context: Context) {
  await ready(view, context);
  // Existing search already selects this real event. This setup avoids making
  // every reload test fail first on the separately covered initial-URL bug.
  const user = userEvent.setup();
  fireEvent.change(within(view.container).getByRole("searchbox", { name: /search (all|entire) history/i }), { target: { value: "reload exact moment" } });
  await user.click(within(view.container).getByRole("button", { name: "Search" })); context.signal.throwIfAborted();
  await user.click(await within(view.container).findByRole("button", { name: new RegExp(SEARCH_MATCH) })); context.signal.throwIfAborted();
  await exactMoment(view, context);
}
async function exactMoment(view: Mounted, context: Context) {
  await ready(view, context);
  await waitFor(() => expect(within(view.container).getByRole("slider", { name: "Timeline position" })).toHaveAttribute("aria-valuetext", expect.stringContaining(TARGET_SUMMARY))); context.signal.throwIfAborted();
  expect(within(screen.getByTestId("replay-board")).getByText(TARGET_TITLE)).toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.get("at")).toBe(TARGET_SEQ);
}
function exactWindow(history: Fixture, since: number, id: string) {
  expect(history.reads.slice(since).some((read) => {
    const search = new URLSearchParams(read.search);
    return read.generationId === id && read.path.endsWith("/window") && search.get("at_seq") === TARGET_SEQ && search.get("exact") === "true";
  })).toBe(true);
}
function privateHistory(entry: Entry, history: Fixture) {
  const state = JSON.stringify(userState(entry.state));
  expect(state).toBeDefined();
  for (const value of [OWNER_A, OWNER_B, PRIVATE_FLAG, TARGET_TITLE, TARGET_SUMMARY, TARGET_SEQ, "reload exact moment", ...history.posts.flatMap((post) => [post.requestId, post.generationId])]) {
    expect(state).not.toContain(value);
    if (value !== TARGET_SEQ) expect(entry.href).not.toContain(value);
  }
  expect([...new URL(entry.href, window.location.origin).searchParams.keys()]).toEqual(["at"]);
}
function persistedBeforePost(post: Post) {
  const nonce = reference({ href: MOMENT_URL, state: post.state });
  expect(nonce).not.toBe(post.requestId);
  expect(nonce).not.toBe(post.generationId);
  expect(post.ownerResolved).toBe(true);
}
function noReplay(view: Mounted) {
  expect(within(view.container).queryByRole("slider", { name: "Timeline position" })).not.toBeInTheDocument();
  const board = within(view.container).queryByTestId("replay-board"); if (board) expect(board).not.toBeVisible();
}

const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
beforeAll(() => {
  // jsdom supplies randomUUID but no SubtleCrypto. Use the real Node Web Crypto
  // implementation, not predetermined digest/identity results.
  if (!globalThis.crypto.subtle) Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
});
afterAll(() => {
  if (originalSubtle) Object.defineProperty(globalThis.crypto, "subtle", originalSubtle);
  else Reflect.deleteProperty(globalThis.crypto, "subtle");
});
beforeEach(async () => { await i18n.changeLanguage("en"); stubReducedMotion(true); localStorage.removeItem(VIEW_MODE_STORAGE_KEY); });
afterEach(() => {
  for (const view of [...mounted]) view.dispose();
  for (const history of fixtures) history.releaseAll();
  console.info("A05_RELOAD_RECEIPT", JSON.stringify(fixtures.splice(0).map(({ posts, reads, created, unexpected }) => ({ posts, reads, created, unexpected }))));
  stubReducedMotion(false); localStorage.removeItem(VIEW_MODE_STORAGE_KEY);
});

describe("timeline browser-entry reload continuity", () => {
  it("reuses the same viewer generation and exact moment across a cold reload, then preserves an explicit refresh", async (context) => {
    const history = fixture(); const user = userEvent.setup();
    const first = mountDocument(context, undefined, true);
    await screen.findByText("success"); context.signal.throwIfAborted();
    await user.click(screen.getByRole("link", { name: "Open timeline" })); context.signal.throwIfAborted();
    await initialMoment(first, context);
    fireEvent.change(screen.getByRole("searchbox", { name: /this window/i }), { target: { value: PRIVATE_FLAG } });
    const original = history.posts[0]!; const entry = capturedEntry();
    expect(userState(entry.state)).toHaveProperty("bpReturn");
    first.dispose();
    const since = history.reads.length;
    const reloaded = mountDocument(context, entry);
    await ready(reloaded, context);
    expect(history.posts).toHaveLength(2);
    expect(history.posts[1]).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 200 });
    await exactMoment(reloaded, context); exactWindow(history, since, original.generationId);
    expect(screen.getByRole("searchbox", { name: /this window/i })).toHaveValue("");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(userState(capturedEntry().state)).toMatchObject({ bpReturn: (userState(entry.state) as { bpReturn: unknown }).bpReturn });
    const originalReference = reference(entry);
    expect(reference(capturedEntry())).toBe(originalReference);
    await user.click(within(reloaded.container).getByRole("button", { name: "Refresh history" })); context.signal.throwIfAborted();
    await exactMoment(reloaded, context);
    const refreshed = history.posts.at(-1)!; const refreshedEntry = capturedEntry();
    expect(refreshed.requestId).not.toBe(original.requestId);
    expect(reference(refreshedEntry)).not.toBe(originalReference);
    reloaded.dispose();
    const again = mountDocument(context, refreshedEntry);
    await exactMoment(again, context);
    expect(history.posts.at(-1)).toMatchObject({ requestId: refreshed.requestId, generationId: refreshed.generationId, status: 200 });
    expect(history.created).toHaveLength(2);
    history.posts.forEach(persistedBeforePost); privateHistory(capturedEntry(), history);
    expect(history.unexpected).toEqual([]);
  });

  it("binds the captured entry to the current account without destroying the original account's reload continuity", async (context) => {
    const history = fixture();
    const first = mountDocument(context); await initialMoment(first, context);
    const original = history.posts[0]!; const entry = capturedEntry(); first.dispose();
    history.setViewer(OWNER_B); const gate = history.holdNextPost();
    const readStart = history.reads.length;
    const second = mountDocument(context, entry);
    await waitFor(() => expect(history.posts).toHaveLength(2)); context.signal.throwIfAborted();
    noReplay(second);
    const other = history.posts[1]!;
    expect(other.requestId).not.toBe(original.requestId);
    expect(other.generationId).not.toBe(original.generationId);
    gate.release(); await ready(second, context);
    expect(history.reads.slice(readStart).every((read) => read.generationId !== original.generationId)).toBe(true);
    expect(userState(capturedEntry().state)).toEqual(userState(entry.state));
    second.dispose(); history.setViewer(OWNER_A);
    const returning = mountDocument(context, entry); await ready(returning, context);
    expect(history.posts.at(-1)).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 200 });
    await exactMoment(returning, context);
    expect(history.created).toHaveLength(2);
    history.posts.forEach(persistedBeforePost); privateHistory(capturedEntry(), history);
    expect(history.unexpected).toEqual([]);
  });

  it("waits for the real current-user response and dispatches no generation when that response denies access", async (context) => {
    const history = fixture(); const gate = history.holdOwner();
    const pending = mountDocument(context); const user = userEvent.setup();
    await waitFor(() => expect(history.reads.some((read) => read.path === "/api/me")).toBe(true)); context.signal.throwIfAborted();
    expect(screen.getByLabelText("Viewer query status")).toHaveTextContent("pending");
    await user.click(screen.getByRole("heading", { name: "Board timeline" })); context.signal.throwIfAborted();
    expect.soft(history.posts).toHaveLength(0);
    gate.release(); await ready(pending, context);
    expect(history.posts).toHaveLength(1);
    expect.soft(history.posts[0]!.ownerResolved).toBe(true);
    pending.dispose(); history.denyOwner();
    const beforeDenial = history.posts.length;
    const denied = mountDocument(context);
    await waitFor(() => expect(screen.getByLabelText("Viewer query status")).toHaveTextContent("error")); context.signal.throwIfAborted();
    await settled(denied, context);
    expect(history.posts).toHaveLength(beforeDenial);
    noReplay(denied);
    expect(within(denied.container).queryByRole("button", { name: /rebuild.*moment/i })).not.toBeInTheDocument();
    expect(within(denied.container).getByTestId("timeline-error").textContent?.trim()).toBeTruthy();
    expect(history.unexpected).toEqual([]);
  });

  it("keeps a 410 sticky across reload until deliberate Rebuild this moment rotates the reference", async (context) => {
    const history = fixture(); const user = userEvent.setup();
    const first = mountDocument(context); await initialMoment(first, context);
    const original = history.posts[0]!; const entry = capturedEntry(); first.dispose(); history.expire(original.generationId);
    const expired = mountDocument(context, entry);
    await waitFor(() => expect(history.posts).toHaveLength(2)); context.signal.throwIfAborted();
    await settled(expired, context);
    expect(history.posts[1]).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 410 });
    noReplay(expired); expect(history.created).toHaveLength(1);
    const error = within(expired.container).getByTestId("timeline-error");
    expect(error).toHaveTextContent(/expired/i);
    const unchanged = capturedEntry(); expect(reference(unchanged)).toBe(reference(entry)); expired.dispose();
    const stillExpired = mountDocument(context, unchanged); await settled(stillExpired, context);
    await within(stillExpired.container).findByTestId("timeline-error"); context.signal.throwIfAborted();
    expect(history.posts.at(-1)).toMatchObject({ requestId: original.requestId, status: 410 });
    expect(history.created).toHaveLength(1);
    await user.click(within(stillExpired.container).getByRole("button", { name: /rebuild this moment/i })); context.signal.throwIfAborted();
    await exactMoment(stillExpired, context);
    const rebuilt = history.posts.at(-1)!; const rebuiltEntry = capturedEntry();
    expect(rebuilt.requestId).not.toBe(original.requestId);
    expect(reference(rebuiltEntry)).not.toBe(reference(entry));
    stillExpired.dispose();
    const reloaded = mountDocument(context, rebuiltEntry); await exactMoment(reloaded, context);
    expect(history.posts.at(-1)).toMatchObject({ requestId: rebuilt.requestId, generationId: rebuilt.generationId, status: 200 });
    expect(history.created).toHaveLength(2);
    history.posts.forEach(persistedBeforePost); privateHistory(capturedEntry(), history);
    expect(history.unexpected).toEqual([]);
  });

  it("gives a copied URL a fresh identity and replaces a malformed captured token without writing private metadata", async (context) => {
    const history = fixture();
    const first = mountDocument(context); await initialMoment(first, context);
    const original = history.posts[0]!; const entry = capturedEntry(); const nonce = reference(entry); first.dispose();
    const copied = mountDocument(context, { href: entry.href, state: null }); await ready(copied, context);
    expect(history.posts.at(-1)!.requestId).not.toBe(original.requestId);
    const copiedEntry = capturedEntry(); expect(reference(copiedEntry)).not.toBe(nonce); copied.dispose();
    // Corrupt only the token the running component actually persisted. This
    // never fabricates a valid product token or guesses its storage field name.
    const malformed = { href: entry.href, state: JSON.parse(JSON.stringify(entry.state).replace(nonce, "malformed/" + "x".repeat(4096))) as unknown };
    const repaired = mountDocument(context, malformed); await ready(repaired, context);
    expect(history.posts.at(-1)!.requestId).not.toBe(original.requestId);
    const repairedEntry = capturedEntry(); expect(reference(repairedEntry)).not.toBe(nonce);
    expect(JSON.stringify(repairedEntry.state)).not.toContain("malformed/");
    await exactMoment(repaired, context);
    history.posts.forEach(persistedBeforePost); privateHistory(repairedEntry, history);
    expect(history.unexpected).toEqual([]);
  });

  it("reuses the already persisted request when reloading before a generation response arrives", async (context) => {
    const history = fixture(); const held = history.holdNextPost();
    const first = mountDocument(context);
    await waitFor(() => expect(history.posts).toHaveLength(1)); context.signal.throwIfAborted();
    const interrupted = history.posts[0]!; const entry = capturedEntry();
    noReplay(first); first.dispose();
    const reloaded = mountDocument(context, entry); await ready(reloaded, context);
    expect(history.posts).toHaveLength(2);
    expect(history.posts[1]).toMatchObject({ requestId: interrupted.requestId, generationId: interrupted.generationId, status: 200 });
    expect(history.created).toHaveLength(1);
    persistedBeforePost(interrupted);
    expect(reference(entry)).toBe(reference(capturedEntry()));
    held.release(); await exactMoment(reloaded, context);
    expect(history.posts).toHaveLength(2);
    privateHistory(capturedEntry(), history); expect(history.unexpected).toEqual([]);
  });
});
