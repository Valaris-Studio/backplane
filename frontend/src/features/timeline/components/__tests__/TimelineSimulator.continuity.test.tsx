// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { webcrypto } from "node:crypto";
import { fireEvent, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ContextLink, ReturnLink } from "@/components/shared/ContextLink";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { ThemeProvider } from "@/hooks/use-theme";
import { buildEntityLink } from "@/lib/entity-link";
import { timelineKeys } from "@/lib/query-keys";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { act, createTestQueryClient, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { VIEW_MODE_STORAGE_KEY } from "../../hooks/use-view-mode";
import {
  BOARD, CARD_ID, installContinuityHistory, OTHER_CARD_ID, OTHER_TITLE, RELATED_PATH,
  SEARCH_MATCH, SLUG, TARGET_SEQ, TARGET_SUMMARY, TARGET_TITLE, TIMELINE_PATH,
  type TargetKind,
} from "../../__tests__/continuity-fixtures";
import { sequence } from "../../__tests__/history-fixtures";
import { TimelineSimulator } from "../TimelineSimulator";

type HistoryFixture = ReturnType<typeof installContinuityHistory>;
type MountedTimeline = ReturnType<typeof mountTimeline>;
const mounted = new Set<{ dispose: () => void }>();
const receipts: HistoryFixture[] = [];
const transitions: Array<{ pathname: string; search: string; key: string }> = [];

function fixture(options: Parameters<typeof installContinuityHistory>[0] = {}) {
  const result = installContinuityHistory(options);
  receipts.push(result);
  return result;
}

function RelatedWork() {
  return <main><h1>Related work</h1><ContextLink id="open-history" to={TIMELINE_PATH}>Open timeline</ContextLink></main>;
}

// Destination rendering is deliberately small: this suite proves timeline
// identity/return behavior, not the already separate card/note/resource readers.
function CurrentDestination() {
  const location = useLocation();
  return <main><h1>Current work destination</h1><output aria-label="Current destination">{location.pathname + location.search}</output>
    <ReturnLink to={TIMELINE_PATH} returnLabel="Return to historical moment">Open timeline</ReturnLink>
  </main>;
}

function mountTimeline(history: HistoryFixture, initialPath = TIMELINE_PATH) {
  window.history.replaceState({ idx: 0, key: "timeline-test-origin", usr: null }, "", initialPath);
  const client = createTestQueryClient();
  const ownerId = history.viewer;
  const router = createBrowserRouter([{
    element: <NavigationGuardProvider><ReturnNavigationProvider ownerId={ownerId}><HandoffDraftProvider ownerId={ownerId}><Outlet /></HandoffDraftProvider></ReturnNavigationProvider></NavigationGuardProvider>,
    children: [
      { path: RELATED_PATH, element: <RelatedWork /> },
      { path: TIMELINE_PATH, element: <main><h1>Board timeline</h1><TimelineSimulator slug={SLUG} boardId={BOARD} /></main> },
      ...["kanban", "notes", "resources"].map((tab) => ({ path: `/${SLUG}/boards/${BOARD}/${tab}`, element: <CurrentDestination /> })),
    ],
  }]);
  const unsubscribe = router.subscribe((state) => {
    const { pathname, search, key } = state.location;
    transitions.push({ pathname, search, key });
  });
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  let disposed = false;
  const result = { ...rendered, client, router, dispose: () => {
    if (disposed) return;
    disposed = true;
    rendered.unmount();
    unsubscribe();
    router.dispose();
    client.clear();
    mounted.delete(result);
  } };
  mounted.add(result);
  return result;
}

async function ready(view: MountedTimeline) {
  await screen.findByRole("slider", { name: "Timeline position" });
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
}

async function selectedExact(view: MountedTimeline) {
  await ready(view);
  await waitFor(() => expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveAttribute("aria-valuetext", expect.stringContaining(TARGET_SUMMARY)));
  expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveValue("0");
  expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveAttribute("max", "2");
}

async function searchJump(history: HistoryFixture, view: MountedTimeline, user: ReturnType<typeof userEvent.setup>) {
  await ready(view);
  const search = screen.getByRole("searchbox", { name: /search (all|entire) history/i });
  fireEvent.change(search, { target: { value: "continuity" } });
  await user.click(screen.getByRole("button", { name: "Search" }));
  await user.click(await screen.findByRole("button", { name: new RegExp(SEARCH_MATCH) }));
  await waitFor(() => expect(history.requests.some((request) => request.path.endsWith("/window") && new URLSearchParams(request.search).get("at_seq") === history.requestedSequence)).toBe(true));
  await waitFor(() => expect(screen.queryByTestId("timeline-loading")).not.toBeInTheDocument());
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
}

async function enterFromRelated(history: HistoryFixture, user: ReturnType<typeof userEvent.setup>) {
  const view = mountTimeline(history, RELATED_PATH);
  await user.click(screen.getByRole("link", { name: "Open timeline" }));
  await searchJump(history, view, user);
  await selectedExact(view);
  return view;
}

async function leaveByBack(view: MountedTimeline) {
  act(() => window.history.back());
  await screen.findByRole("heading", { name: "Related work" });
  // This is the normal test QueryClient's inactive GC, not manual cache
  // deletion. Retained navigation must not depend on still-cached server rows.
  await waitFor(() => expect(view.client.getQueryCache().findAll({ queryKey: timelineKeys.history(SLUG, BOARD) })).toHaveLength(0));
}

function currentAction(container: HTMLElement, kind: TargetKind) {
  return within(container).getByRole("link", { name: new RegExp(`current.*${kind}|${kind}.*current`, "i") });
}

function expectNoCurrentBodyFetches(history: HistoryFixture) {
  expect(history.unexpected).toEqual([]);
  expect(history.requests.filter((request) => !request.path.includes("/timeline/") && request.path !== "/api/me")).toEqual([]);
  expect(history.requests.filter((request) => request.path.endsWith("/live-head"))).toEqual([]);
}

async function unavailable(view: MountedTimeline) {
  // Copy may change across locales. The required semantics are an accessible
  // explanation, deliberate recovery and no substituted replay affordances.
  const alert = await screen.findByRole("alert");
  expect(alert.textContent?.trim().length).toBeGreaterThan(0);
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  expect(screen.queryByRole("slider", { name: "Timeline position" })).not.toBeInTheDocument();
  const step = screen.queryByTestId("step-panel");
  if (step) expect(step).not.toBeVisible();
  expect(screen.queryByRole("link", { name: /current.*(card|note|resource)|(card|note|resource).*current/i })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /refresh|retry|choose.*(event|moment)|return.*history|open.*history/i }).length).toBeGreaterThan(0);
}

const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
beforeAll(() => {
  // jsdom supplies randomUUID but no SubtleCrypto. Keep real browser-facing
  // randomness and use Node's actual Web Crypto digest implementation.
  if (!globalThis.crypto.subtle) Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
});
afterAll(() => {
  if (originalSubtle) Object.defineProperty(globalThis.crypto, "subtle", originalSubtle);
  else Reflect.deleteProperty(globalThis.crypto, "subtle");
});

beforeEach(() => {
  stubReducedMotion(true);
  localStorage.removeItem(VIEW_MODE_STORAGE_KEY);
});

afterEach(() => {
  for (const view of [...mounted]) view.dispose();
  console.info("A05_CONTINUITY_HTTP_RECEIPT", JSON.stringify({
    transitions: transitions.splice(0),
    fixtures: receipts.splice(0).map((history) => ({ requests: history.requests, generations: history.created, unexpected: history.unexpected })),
  }));
  stubReducedMotion(false);
  localStorage.removeItem(VIEW_MODE_STORAGE_KEY);
});

describe("timeline exact destinations and retained navigation", () => {
  it("opens a canonical board-wide sequence beyond the initial window without rounding it", async () => {
    const history = fixture();
    const href = buildEntityLink({ type: "timeline", slug: SLUG, boardId: BOARD, eventSequence: TARGET_SEQ })!.href;
    expect(BigInt(TARGET_SEQ)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const view = mountTimeline(history, href);
    await selectedExact(view);
    expect(history.requests.some((request) => request.path.endsWith("/window") && new URLSearchParams(request.search).get("at_seq") === TARGET_SEQ)).toBe(true);
    expect(within(screen.getByTestId("replay-board")).getByText(TARGET_TITLE)).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("at")).toBe(TARGET_SEQ);
    expectNoCurrentBodyFetches(history);
  });

  it.each(["gap", "after-head"] as const)("does not replace a missing exact %s search target with a neighboring event", async (missing) => {
    const history = fixture({ missing });
    const view = mountTimeline(history);
    const user = userEvent.setup();
    await ready(view);
    expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveAttribute("aria-valuetext", expect.stringContaining("Recorded event 9998"));
    await searchJump(history, view, user);
    await unavailable(view);
    expect(history.created).toHaveLength(1);
    expectNoCurrentBodyFetches(history);
  });

  it.each(["card", "note", "resource"] as const)("offers an exact current %s destination from the selected historical event", async (kind) => {
    const history = fixture({ kind });
    const view = mountTimeline(history);
    const user = userEvent.setup();
    await searchJump(history, view, user);
    await selectedExact(view);
    await user.click(within(screen.getByTestId("step-panel")).getByRole("button", { name: "Details" }));
    const details = screen.getByRole("region", { name: "Event details" });
    const href = buildEntityLink({ type: kind, slug: SLUG, boardId: BOARD, id: history.targetId })!.href;
    expect(currentAction(details, kind)).toHaveAttribute("href", href);
    expectNoCurrentBodyFetches(history);

    if (kind === "card") {
      // A historical sheet's selected card is not necessarily the event's card.
      await user.click(screen.getByRole("button", { name: "Dense" }));
      await user.click(within(screen.getByTestId("replay-board")).getByRole("button", { name: OTHER_TITLE }));
      const sheet = await screen.findByRole("dialog", { name: OTHER_TITLE });
      const otherHref = buildEntityLink({ type: "card", slug: SLUG, boardId: BOARD, id: OTHER_CARD_ID })!.href;
      expect(currentAction(sheet, "card")).toHaveAttribute("href", otherHref);
      expect(otherHref).not.toContain(CARD_ID);
      expectNoCurrentBodyFetches(history);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: OTHER_TITLE })).not.toBeInTheDocument());
    }

    const generationId = history.created[0]!.generation.id;
    await user.click(currentAction(screen.getByRole("region", { name: "Event details" }), kind));
    await screen.findByRole("heading", { name: "Current work destination" });
    expect(screen.getByLabelText("Current destination")).toHaveTextContent(href);
    await user.click(screen.getByRole("link", { name: "Return to historical moment" }));
    await selectedExact(view);
    expect(history.created.map((item) => item.generation.id)).toEqual([generationId]);
    expectNoCurrentBodyFetches(history);
  });

  it("retains the same viewer's generation, earlier window, flags, selected card and focus through native Back/Forward", async () => {
    const history = fixture();
    const user = userEvent.setup();
    const view = await enterFromRelated(history, user);
    const generationId = history.created[0]!.generation.id;
    fireEvent.change(screen.getByRole("searchbox", { name: /this window/i }), { target: { value: "Exact retained" } });
    await user.click(screen.getByRole("button", { name: "Dense" }));
    await user.click(within(screen.getByTestId("replay-board")).getByRole("button", { name: TARGET_TITLE }));
    await screen.findByRole("dialog", { name: TARGET_TITLE });
    await leaveByBack(view);
    const returnStart = history.requests.length;
    act(() => window.history.forward());
    await ready(view);
    expect(history.created.map((item) => item.generation.id)).toEqual([generationId]);
    await selectedExact(view);
    expect(screen.getByRole("searchbox", { name: /this window/i })).toHaveValue("Exact retained");
    expect(screen.getByRole("button", { name: "Dense" })).toHaveAttribute("aria-pressed", "true");
    const restored = await screen.findByRole("dialog", { name: TARGET_TITLE });
    await waitFor(() => expect(restored.contains(document.activeElement)).toBe(true));
    expect(history.requests.slice(returnStart).filter((request) => request.path.endsWith("/window"))).toEqual(expect.arrayContaining([expect.objectContaining({ generationId, search: expect.stringContaining(`at_seq=${TARGET_SEQ}`) })]));
    expectNoCurrentBodyFetches(history);
  });

  it("reports an expired retained generation and creates a new one only after explicit refresh at the same canonical event", async () => {
    const history = fixture();
    const user = userEvent.setup();
    const view = await enterFromRelated(history, user);
    const generationId = history.created[0]!.generation.id;
    await leaveByBack(view);
    history.expire(generationId);
    act(() => window.history.forward());
    await waitFor(() => expect(screen.queryByTestId("timeline-loading")).not.toBeInTheDocument());
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    await screen.findByText(/history view expired/i);
    expect(history.created.map((item) => item.generation.id)).toEqual([generationId]);
    expect(history.requests.some((request) => request.generationId === generationId && request.status === 410)).toBe(true);
    expect(screen.queryByRole("slider", { name: "Timeline position" })).not.toBeInTheDocument();
    const step = screen.queryByTestId("step-panel");
    if (step) expect(step).not.toBeVisible();
    expect(new URL(window.location.href).searchParams.get("at")).toBe(TARGET_SEQ);
    expectNoCurrentBodyFetches(history);
    await user.click(within(screen.getByTestId("timeline-error")).getByRole("button", { name: "Rebuild this moment" }));
    await selectedExact(view);
    expect(history.created).toHaveLength(2);
    expect(history.created[1]!.generation.id).not.toBe(generationId);
    expect(new URL(window.location.href).searchParams.get("at")).toBe(TARGET_SEQ);
    expectNoCurrentBodyFetches(history);
  });

  it("resolves a copied event URL for a second viewer with that viewer's own generation", async () => {
    const history = fixture();
    const user = userEvent.setup();
    const first = mountTimeline(history);
    await searchJump(history, first, user);
    await selectedExact(first);
    const firstGeneration = history.created[0]!;
    const href = buildEntityLink({ type: "timeline", slug: SLUG, boardId: BOARD, eventSequence: TARGET_SEQ })!.href;
    expect([...new URL(href, window.location.origin).searchParams.keys()]).toEqual(["at"]);
    expect(href).not.toContain(firstGeneration.generation.id);
    first.dispose();
    history.setViewer("viewer-b");
    const start = history.requests.length;
    const second = mountTimeline(history, href);
    await selectedExact(second);
    expect(history.created).toHaveLength(2);
    expect(history.created[1]).toMatchObject({ viewer: "viewer-b" });
    expect(history.created[1]!.generation.id).not.toBe(firstGeneration.generation.id);
    expect(history.created[1]!.requestId).not.toBe(firstGeneration.requestId);
    expect(history.requests.slice(start).every((request) => request.generationId !== firstGeneration.generation.id)).toBe(true);
    expect(history.requests.slice(start).some((request) => request.path.endsWith("/window") && new URLSearchParams(request.search).get("at_seq") === TARGET_SEQ)).toBe(true);
    expect(window.history.state.usr?.bpReturn).toBeUndefined();
    expectNoCurrentBodyFetches(history);
  });

  it.each(["not-a-sequence", "9223372036854775808"])("explains invalid ?at=%s without requesting it or displaying today's replay", async (at) => {
    const history = fixture();
    const view = mountTimeline(history, `${TIMELINE_PATH}?at=${at}`);
    await unavailable(view);
    expect(history.requests.some((request) => new URLSearchParams(request.search).get("at_seq") === at)).toBe(false);
    expectNoCurrentBodyFetches(history);
  });

  it("keeps authorization denial distinct from an unavailable event and does not manufacture a new generation", async () => {
    const history = fixture({ denyWindow: true });
    const view = mountTimeline(history, `${TIMELINE_PATH}?at=${sequence(450)}`);
    const error = await screen.findByTestId("timeline-error");
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(within(error).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Timeline position" })).not.toBeInTheDocument();
    const step = screen.queryByTestId("step-panel");
    if (step) expect(step).not.toBeVisible();
    expect(screen.queryByRole("link", { name: /current.*(card|note|resource)/i })).not.toBeInTheDocument();
    expect(history.created).toHaveLength(1);
    expect(history.requests.some((request) => request.path.endsWith("/window") && request.status === 403)).toBe(true);
    expectNoCurrentBodyFetches(history);
  });
});
