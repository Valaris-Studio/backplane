// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { fireEvent, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextLink, ReturnLink } from "@/components/shared/ContextLink";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider, useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { http, HttpResponse, server } from "@/test/msw-server";
import { act, createTestQueryClient, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { API_BASE, BOARD, installContinuityHistory, RELATED_PATH, SLUG, TIMELINE_PATH } from "../../__tests__/continuity-fixtures";
import { historyEvent, readyWindow, sequence } from "../../__tests__/history-fixtures";
import { VIEW_MODE_STORAGE_KEY } from "../../hooks/use-view-mode";
import { TimelineSimulator } from "../TimelineSimulator";

const WINDOW_SIZE = 200;
const GESTURE_STEPS = 80;
const ORIGIN_INPUT = "Unsubmitted origin reading filter";
const disposers: Array<() => void> = [];
const ledgers: unknown[] = [];

function RelatedWork() {
  const navigation = useReturnNavigation();
  const [filter, setFilter] = useState(() => navigation?.readView<string>("scrub-origin-filter") ?? "");
  useEffect(() => navigation?.writeView("scrub-origin-filter", filter), [navigation, filter]);
  return <main><h1>Related work</h1>
    <label>Reading filter<input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
    <ContextLink id="scrub-origin-link" to={`${TIMELINE_PATH}?at=${sequence(0)}`}>Open timeline</ContextLink>
  </main>;
}

function installLongWindow() {
  const history = installContinuityHistory();
  server.use(http.get(`${API_BASE}/generations/:id/window`, ({ request, params }) => {
    const id = String(params.id), url = new URL(request.url);
    const exists = history.created.some((item) => item.generation.id === id);
    if (!exists) {
      history.unexpected.push("Long window requested without an established generation");
      return HttpResponse.json({ detail: "Generation not found" }, { status: 404 });
    }
    const at = url.searchParams.get("at_seq");
    if (!at || !/^\d+$/.test(at) || BigInt(at) < BigInt(sequence(0)) || BigInt(at) > BigInt(sequence(WINDOW_SIZE - 1))) {
      history.unexpected.push(`Unsupported long-window selector: ${url.search}`);
      return HttpResponse.json({ detail: "Unexpected selector" }, { status: 422 });
    }
    history.requests.push({ viewer: history.viewer, method: request.method, path: url.pathname, search: url.search, generationId: id, status: 200 });
    const window = readyWindow(0, id);
    window.events = Array.from({ length: WINDOW_SIZE }, (_, offset) => historyEvent(offset));
    window.window = { first_seq: sequence(0), last_seq: sequence(WINDOW_SIZE - 1), previous_cursor: null, next_cursor: "after-long-window" };
    return HttpResponse.json(window);
  }));
  return history;
}

async function enter() {
  const history = installLongWindow();
  window.history.replaceState({ idx: 0, key: "scrub-related-origin", usr: null }, "", RELATED_PATH);
  const client = createTestQueryClient();
  const router = createBrowserRouter([{
    element: <NavigationGuardProvider><ReturnNavigationProvider ownerId={history.viewer}>
      <HandoffDraftProvider ownerId={history.viewer}><Outlet /></HandoffDraftProvider>
    </ReturnNavigationProvider></NavigationGuardProvider>,
    children: [
      { path: RELATED_PATH, element: <RelatedWork /> },
      { path: TIMELINE_PATH, element: <main><h1>Board timeline</h1>
        <ReturnLink to={RELATED_PATH} returnLabel="Return to originating work">Related work</ReturnLink>
        <TimelineSimulator slug={SLUG} boardId={BOARD} /></main> },
    ],
  }]);
  const view = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  disposers.push(() => { view.unmount(); router.dispose(); client.clear(); });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Reading filter" }), ORIGIN_INPUT);
  await user.click(screen.getByRole("link", { name: "Open timeline" }));
  const slider = await screen.findByRole("slider", { name: "Timeline position" });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(slider).toHaveAttribute("max", String(WINDOW_SIZE - 1));
  expect(slider).toHaveValue("0");
  expect(new URL(window.location.href).searchParams.get("at")).toBe(sequence(0));
  expect(screen.getByRole("link", { name: "Return to originating work" })).toHaveAttribute("href", RELATED_PATH);
  const reference = structuredClone(window.history.state.usr.bpReturn);
  const replace = vi.spyOn(window.history, "replaceState"); // Passthrough: observe actual router writes.
  const momentWrites = () => replace.mock.calls.flatMap(([, , href]) => {
    if (href === undefined || href === null) return [];
    const url = new URL(String(href), window.location.origin);
    return url.pathname === TIMELINE_PATH && url.searchParams.has("at") ? [url.searchParams.get("at")] : [];
  });
  return { history, user, slider, reference, momentWrites };
}

async function settledAndReturn(run: Awaited<ReturnType<typeof enter>>, finalOffset: number, name: string) {
  await waitFor(() => expect(new URL(window.location.href).searchParams.get("at")).toBe(sequence(finalOffset)));
  expect(run.slider).toHaveValue(String(finalOffset));
  expect(run.slider).toHaveAttribute("aria-valuetext", expect.stringContaining(`Recorded event ${finalOffset}`));
  expect.soft(run.momentWrites(), "One settled gesture commits its final exact moment once").toEqual([sequence(finalOffset)]);
  expect(window.history.state.usr.bpReturn).toEqual(run.reference);
  expect.soft(screen.queryByRole("link", { name: "Return to originating work" }), "Scrubbing must not expire the real captured origin").not.toBeNull();
  const receipt = { name, windowSize: WINDOW_SIZE, finalOffset, writes: run.momentWrites(), reference: run.reference,
    finalOriginPath: null as string | null, requests: run.history.requests, generations: run.history.created,
    unexpected: run.history.unexpected };
  ledgers.push(receipt);
  act(() => window.history.back());
  await screen.findByRole("heading", { name: "Related work" });
  receipt.finalOriginPath = window.location.pathname;
  expect.soft(screen.getByRole("textbox", { name: "Reading filter" })).toHaveValue(ORIGIN_INPUT);
  await waitFor(() => expect(screen.getByRole("link", { name: "Open timeline" })).toHaveFocus());
  expect(run.history.unexpected).toEqual([]);
  expect(run.history.created).toHaveLength(1);
}

beforeEach(() => { stubReducedMotion(true); localStorage.removeItem(VIEW_MODE_STORAGE_KEY); });
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  console.info("A05_SETTLED_SCRUB_RECEIPT", JSON.stringify(ledgers.splice(0)));
  stubReducedMotion(false); localStorage.removeItem(VIEW_MODE_STORAGE_KEY);
});

describe("settled timeline URL commits", () => {
  it("previews an uninterrupted native range gesture without committing each intermediate moment", async () => {
    const run = await enter();
    fireEvent.pointerDown(run.slider, { pointerId: 1, pointerType: "mouse", buttons: 1 });
    // Separate real input changes flush React effects, but this synchronous
    // uninterrupted gesture has no idle period before pointer release.
    for (let value = 1; value <= GESTURE_STEPS; value += 1) fireEvent.change(run.slider, { target: { value: String(value) } });
    expect(run.slider).toHaveValue(String(GESTURE_STEPS));
    expect.soft(run.momentWrites(), "Pointer-held previews must not replace the address bar").toEqual([]);
    fireEvent.pointerUp(run.slider, { pointerId: 1, pointerType: "mouse", buttons: 0 });
    await settledAndReturn(run, GESTURE_STEPS, "pointer-gesture");
  });

  it("settles a held keyboard transport sequence once and preserves its native return origin", async () => {
    const run = await enter();
    // jsdom has no native range-arrow default action. The application's real
    // document keyboard transport does handle these events without a mock.
    for (let index = 0; index < GESTURE_STEPS; index += 1) fireEvent.keyDown(document.body, { key: "ArrowRight", repeat: index > 0 });
    expect(run.slider).toHaveValue(String(GESTURE_STEPS));
    expect.soft(run.momentWrites(), "Held-key previews must not replace the address bar per repeat").toEqual([]);
    fireEvent.keyUp(document.body, { key: "ArrowRight" });
    await settledAndReturn(run, GESTURE_STEPS, "keyboard-repeat");
  });

  it("still commits a single deliberate keyboard step and returns to the retained origin", async () => {
    const run = await enter();
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyUp(document.body, { key: "ArrowRight" });
    await settledAndReturn(run, 1, "single-step-control");
  });
});
