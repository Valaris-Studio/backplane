// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import i18n from "@/i18n/config";
import { ReturnLink } from "@/components/shared/ContextLink";
import { WorkspaceHistoryPage } from "@/pages/WorkspaceHistoryPage";
import { http, HttpResponse, server } from "@/test/msw-server";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import type { Activity } from "@/types/activity";

const BOARD = "41000000-0000-4000-8000-000000000001";
type WireActivity = Omit<Activity, "entity_type"> & { entity_type: string };

function activity(id: string, overrides: Partial<WireActivity> = {}): WireActivity {
  return {
    id, workspace_id: "workspace-acme", board_id: BOARD,
    actor_id: "user-me", actor_name: "Owner", actor_email: "owner@example.test",
    agent_id: null, entity_type: "card", entity_id: "card-41", action: "updated",
    summary: "updated card Summary-only current card", entity_title: null,
    via_api_key: null, created_at: "2026-10-18T12:00:00Z", ...overrides,
  };
}

const current = [
  { item: activity("current-card"), href: `/acme/boards/${BOARD}/kanban?card=card-41` },
  { item: activity("board-note", { entity_type: "note", entity_id: "note-41", summary: "updated note Board evidence" }),
    href: `/acme/boards/${BOARD}/notes?note=note-41` },
  { item: activity("workspace-note", { entity_type: "note", entity_id: "note-42", board_id: null, summary: "updated note Workspace evidence" }),
    href: "/acme/notes?note=note-42" },
  { item: activity("board-resource", { entity_type: "resource", entity_id: "resource-outside-loaded-folder", action: "uploaded", summary: "uploaded resource Nested evidence.pdf" }),
    href: `/acme/boards/${BOARD}/resources?resource=resource-outside-loaded-folder` },
  { item: activity("workspace-resource", { entity_type: "resource", entity_id: "resource-workspace", board_id: null, action: "uploaded", summary: "uploaded resource Workspace evidence.pdf" }),
    href: "/acme/resources?resource=resource-workspace" },
];

const requests: URL[] = [];
const unexpected: string[] = [];
const views: ReturnType<typeof renderBrowserNavigationRouter>[] = [];

beforeEach(() => {
  requests.length = 0;
  unexpected.length = 0;
  stubReducedMotion(true);
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
    view.router.dispose();
    view.client.clear();
  }
  stubReducedMotion(false);
});

function Destination() {
  const location = useLocation();
  return <main>
    <h1>Activity target</h1>
    <output data-testid="target-location">{location.pathname + location.search}</output>
    <ReturnLink to="/acme/history" returnLabel="Return to history">History</ReturnLink>
  </main>;
}

function renderHistory(items: WireActivity[]) {
  server.use(
    http.get("/api/workspaces/acme/history", ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const search = url.searchParams.get("search")?.toLowerCase();
      return HttpResponse.json(items.filter((item) => !search || item.summary.toLowerCase().includes(search)));
    }),
    http.all("/api/*", ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      unexpected.push(`${request.method} ${url.pathname}${url.search}`);
      return HttpResponse.json({ detail: "Unexpected activity fixture request" }, { status: 418 });
    }),
  );
  const view = renderBrowserNavigationRouter([
    { path: "/:slug/history", element: <WorkspaceHistoryPage /> },
    { path: "/:slug/boards/:boardId/kanban", element: <Destination /> },
    { path: "/:slug/boards/:boardId/notes", element: <Destination /> },
    { path: "/:slug/boards/:boardId/resources", element: <Destination /> },
    { path: "/:slug/notes", element: <Destination /> },
    { path: "/:slug/resources", element: <Destination /> },
  ], "/acme/history");
  views.push(view);
  return view;
}

function activityRow(summary: string) {
  const row = screen.getByText(summary, { exact: false }).closest<HTMLElement>("[data-stagger-item]");
  if (!row) throw new Error(`Missing activity row: ${summary}`);
  return row;
}

function exactLinks(summary: string, href: string) {
  const links = within(activityRow(summary)).getAllByRole("link");
  for (const link of links) {
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAccessibleName();
    expect(link).toBeVisible();
  }
  return links[0]!;
}

async function summaryReadsOnly(view: ReturnType<typeof renderBrowserNavigationRouter>) {
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.pathname).toBe("/api/workspaces/acme/history");
    expect(request.searchParams.get("summary")).toBe("true");
    expect(request.searchParams.get("limit")).toBe("50");
  }
  expect(unexpected).toEqual([]);
}

describe("ActivityTimeline exact destinations", () => {
  it("uses authorized summary identities for card, note and resource anchors without needing titles or a loaded resource list", async () => {
    const view = renderHistory(current.map(({ item }) => item));
    await screen.findByText(current[0]!.item.summary, { exact: false });
    await summaryReadsOnly(view);
    // No resource page/cache or entity detail is supplied to this history view.
    for (const { item, href } of current) exactLinks(item.summary, href);
  });

  it("keeps explicit deletions, unsupported types and unbuildable identities readable without a misleading live link", async () => {
    const items = [
      activity("missing-card-board", { board_id: null, entity_title: "Card without board", summary: "updated card Missing board context" }),
      activity("unknown-entity", { entity_type: "future_entity", entity_title: "Future evidence", summary: "updated future entity Preserved summary" }),
      activity("deleted-card", { action: "deleted", entity_title: "Former card", summary: "deleted card Former card" }),
      activity("deleted-note", { entity_type: "note", action: "deleted", entity_title: "Former note", summary: "deleted note Former note" }),
      activity("deleted-resource", { entity_type: "resource", action: "deleted", summary: "deleted resource Former evidence.pdf" }),
      activity("missing-resource-id", { entity_type: "resource", entity_id: "", summary: "uploaded resource Missing identity.pdf" }),
    ];
    const view = renderHistory(items);
    await screen.findByText(items[0]!.summary, { exact: false });
    for (const item of items) {
      const row = activityRow(item.summary);
      expect(row).toHaveTextContent(item.summary);
      expect(row).toBeVisible();
      expect(within(row).queryAllByRole("link")).toEqual([]);
    }
    await summaryReadsOnly(view);
  });

  it("returns to the same searched history and keyboard origin through the real ContextLink reference", async () => {
    const note = activity("return-note", {
      entity_type: "note", entity_id: "note-return", entity_title: "Kept note",
      summary: "updated note Kept note",
    });
    const view = renderHistory([current[0]!.item, note]);
    const user = userEvent.setup();
    await screen.findByText(note.summary, { exact: false });
    const originalKey = view.router.state.location.key;
    const search = screen.getByPlaceholderText(i18n.t("activity.searchPlaceholder"));
    await user.click(search);
    await user.paste("Kept note");
    await waitFor(() => expect(requests.some((url) => url.searchParams.get("search") === "Kept note")).toBe(true));
    await waitFor(() => expect(screen.queryByText(current[0]!.item.summary, { exact: false })).not.toBeInTheDocument());
    const href = `/acme/boards/${BOARD}/notes?note=note-return`;
    const link = exactLinks(note.summary, href);
    for (let tabs = 0; tabs < 20 && document.activeElement !== link; tabs++) await user.tab();
    expect(link).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Activity target" })).toBeVisible();
    expect(screen.getByTestId("target-location")).toHaveTextContent(href);
    expect(view.router.state.location.state).toEqual({ bpReturn: { v: 1, originKey: expect.any(String), originIdx: 0 } });
    expect(JSON.stringify({ href: window.location.href, history: window.history.state })).not.toContain("Kept note");
    await user.click(screen.getByRole("link", { name: "Return to history" }));
    await waitFor(() => expect(view.router.state.location.key).toBe(originalKey));
    expect(await screen.findByPlaceholderText(i18n.t("activity.searchPlaceholder"))).toHaveValue("Kept note");
    await screen.findByText(note.summary, { exact: false });
    expect(screen.queryByText(current[0]!.item.summary, { exact: false })).not.toBeInTheDocument();
    await waitFor(() => expect(exactLinks(note.summary, href)).toHaveFocus());
    await summaryReadsOnly(view);
    expect(requests.at(-1)!.searchParams.get("search")).toBe("Kept note");
  });
});


describe("History pending-search retention regressions", () => {
  it("retains raw search when a visible activity is followed before its debounce and Return restores the entry", async () => {
    const needle = "Pending history needle";
    const note = activity("pending-search-note", { entity_type: "note", entity_id: "pending-note",
      summary: `updated note ${needle}` });
    const view = renderHistory([current[0]!.item, note]);
    await screen.findByText(note.summary, { exact: false });
    await summaryReadsOnly(view);
    const originKey = view.router.state.location.key;
    const input = screen.getByPlaceholderText(i18n.t("activity.searchPlaceholder"));
    const href = `/acme/boards/${BOARD}/notes?note=pending-note`;
    const link = exactLinks(note.summary, href);
    const started = performance.now();
    // These real DOM events run in one event-loop turn: the existing link is
    // followed before the newly scheduled 300 ms timer can be delivered.
    // No fake clock, internal state seed or delayed click hides that ordering.
    fireEvent.change(input, { target: { value: needle } });
    expect(input).toHaveValue(needle);
    fireEvent.click(link);
    const departureElapsedMs = performance.now() - started;
    expect(await screen.findByRole("heading", { name: "Activity target" })).toBeVisible();
    expect(requests.filter((url) => url.searchParams.get("search") === needle)).toEqual([]);
    console.info("A04 pending-search departure ordering", { departureElapsedMs, submittedPendingRequests: 0 });
    expect(view.router.state.location.state).toEqual({ bpReturn: { v: 1, originKey: expect.any(String), originIdx: 0 } });
    expect(JSON.stringify({ href: window.location.href, history: window.history.state })).not.toContain(needle);
    await userEvent.click(screen.getByRole("link", { name: "Return to history" }));
    await waitFor(() => expect(view.router.state.location.key).toBe(originKey));
    expect(await screen.findByPlaceholderText(i18n.t("activity.searchPlaceholder"))).toHaveValue(needle);
    await waitFor(() => expect(requests.some((url) => url.searchParams.get("search") === needle)).toBe(true));
    await screen.findByText(note.summary, { exact: false });
    await summaryReadsOnly(view);
    expect(requests.at(-1)!.searchParams.get("search")).toBe(needle);
  });

  it("composes pending search with newer type and action choices instead of replacing them from an old debounce closure", async () => {
    const needle = "Combined history needle";
    const note = activity("combined-filters-note", { entity_type: "note", entity_id: "combined-note",
      action: "updated", summary: `updated note ${needle}` });
    const items = [current[0]!.item, note];
    const view = renderHistory(items);
    // This case also models the real endpoint's type/action intersection;
    // the original three destination cases and their fixture remain unchanged.
    server.use(http.get("/api/workspaces/acme/history", ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const search = url.searchParams.get("search")?.toLowerCase();
      const type = url.searchParams.get("entity_type");
      const action = url.searchParams.get("action");
      return HttpResponse.json(items.filter((item) =>
        (!search || item.summary.toLowerCase().includes(search)) &&
        (!type || item.entity_type === type) && (!action || item.action === action)));
    }));
    await screen.findByText(note.summary, { exact: false });
    await summaryReadsOnly(view);
    const input = screen.getByPlaceholderText(i18n.t("activity.searchPlaceholder"));
    const started = performance.now();
    // Synchronous discrete DOM interactions make both select commits happen
    // before the search timer is delivered, without changing its 300 ms delay.
    fireEvent.change(input, { target: { value: needle } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("activity.allTypes") }));
    fireEvent.click(screen.getByRole("option", { name: i18n.t("activity.entityTypes.note") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("activity.allActions") }));
    fireEvent.click(screen.getByRole("option", { name: i18n.t("activity.actions.updated") }));
    const selectionElapsedMs = performance.now() - started;
    expect(screen.getByRole("button", { name: i18n.t("activity.entityTypes.note") })).toBeVisible();
    expect(screen.getByRole("button", { name: i18n.t("activity.actions.updated") })).toBeVisible();
    expect(requests.some((url) => url.searchParams.get("search") === needle)).toBe(false);
    console.info("A04 pending-search filter ordering", { selectionElapsedMs, submittedPendingRequests: 0 });
    await waitFor(() => expect(requests.some((url) => url.searchParams.get("search") === needle)).toBe(true));
    await summaryReadsOnly(view);
    const submitted = requests.filter((url) => url.searchParams.get("search") === needle);
    expect(submitted.length).toBeGreaterThan(0);
    for (const url of submitted) {
      expect(url.searchParams.get("entity_type")).toBe("note");
      expect(url.searchParams.get("action")).toBe("updated");
    }
    expect(screen.getByRole("button", { name: i18n.t("activity.entityTypes.note") })).toBeVisible();
    expect(screen.getByRole("button", { name: i18n.t("activity.actions.updated") })).toBeVisible();
    const originKey = view.router.state.location.key;
    const href = `/acme/boards/${BOARD}/notes?note=combined-note`;
    await userEvent.click(exactLinks(note.summary, href));
    await screen.findByRole("heading", { name: "Activity target" });
    expect(JSON.stringify({ href: window.location.href, history: window.history.state })).not.toContain(needle);
    await userEvent.click(screen.getByRole("link", { name: "Return to history" }));
    await waitFor(() => expect(view.router.state.location.key).toBe(originKey));
    expect(await screen.findByPlaceholderText(i18n.t("activity.searchPlaceholder"))).toHaveValue(needle);
    expect(screen.getByRole("button", { name: i18n.t("activity.entityTypes.note") })).toBeVisible();
    expect(screen.getByRole("button", { name: i18n.t("activity.actions.updated") })).toBeVisible();
    await summaryReadsOnly(view);
  });
});
