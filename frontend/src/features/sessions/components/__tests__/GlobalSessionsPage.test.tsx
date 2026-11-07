// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onlineManager } from "@tanstack/react-query";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { act, createTestQueryClient, renderWithProviders, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { stubAuthModes } from "../../__tests__/fixtures";
import { GlobalSessionsPage } from "../GlobalSessionsPage";

const workspaces = [{ id: "ws-acme", slug: "acme", name: "Acme Platform" }, { id: "ws-orbit", slug: "orbit", name: "Orbit Tools" }];

function session(index: number) {
  const workspace = workspaces[index % 2]!;
  return {
    id: `root-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug, workspace_name: workspace.name,
    board_id: null, board_name: null, parent_session_id: null, harness: "custom_agent", harness_display_name: "Custom agent",
    title: `${index >= 50 ? "needle" : "work"} ${index}`, repository: null, branch: null, status: "ended", display_state: "ended",
    started_at: "2025-01-01T10:00:00Z", last_event_at: "2025-01-01T12:00:00Z", ended_at: "2025-01-01T12:00:00Z",
    ended_reason: "session_end_event", idle_since: null, event_count: 3, activity_event_count: 2, coverage: "activity",
    capture_gaps: 0, capture_levels: ["standard"], child_count: 0, link_count: 0, link_preview: [],
  };
}

const clients: ReturnType<typeof createTestQueryClient>[] = [];
const releases: Array<() => void> = [];
const requests: URL[] = [];
function recordRequest({ request }: { request: Request }) { requests.push(new URL(request.url)); }

beforeEach(() => {
  requests.length = 0;
  stubReducedMotion(true);
  stubAuthModes(true);
  server.events.on("request:start", recordRequest);
  server.use(http.get("/api/workspaces", () => HttpResponse.json(workspaces)));
});

describe("Global owner-session retry focus", () => {
  it("keeps the same neutral retry while an initially denied account reauthorizes", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    let attempts = 0;
    server.use(
      http.get("/api/me", async () => {
        if (++attempts === 2) await held;
        return attempts < 3 ? HttpResponse.json({ detail: "Private account detail" }, { status: 403 })
          : HttpResponse.json({ id: "user-me", name: "Me", email: "me@example.test", avatar_url: null });
      }),
      http.get("/api/me/sessions", () => HttpResponse.json({ items: [session(0)], next_cursor: null })),
    );
    const view = renderGlobal("?q=remote-inbox");
    const user = userEvent.setup();
    try {
      const retry = await screen.findByRole("button", { name: "Try again" });
      const alert = screen.getByRole("alert");
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(attempts).toBe(2));
      expect(screen.getByRole("alert")).toBe(alert);
      expect(alert).toHaveTextContent("Your sessions are unavailable");
      expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
      expect(retry).toBeEnabled();
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toHaveAttribute("aria-disabled", "true");
      expect(retry).toHaveFocus();
      await user.keyboard("{Enter} ");
      expect(attempts).toBe(2);
      release();
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
      expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
      expect(retry).toHaveFocus();
      await user.keyboard(" ");
      await screen.findByRole("link", { name: "work 0" });
      expect(screen.getByRole("heading", { name: "All your sessions" })).toHaveFocus();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Private account detail")).not.toBeInTheDocument();
      expect(attempts).toBe(3);
    } finally {
      release();
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
    }
  });

  it("keeps neutral denial and a focusable busy retry while offline and during its held request", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    let attempts = 0;
    server.use(http.get("/api/me/sessions", async () => {
      if (++attempts > 1) await held;
      return HttpResponse.json({ detail: "Private authorization detail" }, { status: 403 });
    }));
    const view = renderGlobal("?q=remote-inbox");
    const user = userEvent.setup();
    try {
      const retry = await screen.findByRole("button", { name: "Try again" });
      act(() => onlineManager.setOnline(false));
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(view.client.getQueryCache().getAll()
        .some((query) => query.state.fetchStatus === "paused")).toBe(true));
      expect(screen.getByRole("alert")).toHaveTextContent("Your sessions are unavailable");
      expect(screen.queryByText("Private authorization detail")).not.toBeInTheDocument();
      expect(retry).toHaveFocus();
      expect(retry).toBeEnabled();
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter} ");
      expect(attempts).toBe(1);

      act(() => onlineManager.setOnline(true));
      await waitFor(() => expect(attempts).toBe(2));
      expect(retry).toHaveFocus();
      expect(retry).toBeEnabled();
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("alert")).toHaveTextContent("Your sessions are unavailable");
      await user.keyboard("{Enter} ");
      expect(attempts).toBe(2);
      release();
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
      expect(screen.getByRole("button", { name: "Try again" })).toBe(retry);
      expect(retry).toHaveFocus();
      expect(retry).not.toHaveAttribute("aria-busy", "true");
      expect(retry).not.toHaveAttribute("aria-disabled", "true");
      expect(attempts).toBe(2);
    } finally {
      release();
      act(() => onlineManager.setOnline(true));
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
    }
  });

  it.each([false, true])("restores authorized results after a denied refresh without losing the reader's focus (left retry=%s)", async (leftRetry) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    let attempts = 0;
    server.use(http.get("/api/me/sessions", async () => {
      attempts += 1;
      if (attempts === 2) return HttpResponse.json({ detail: "Private authorization detail" }, { status: 403 });
      if (attempts > 2) await held;
      return HttpResponse.json({ items: [{ ...session(0), title: "remote-inbox private capture" }], next_cursor: null });
    }));
    const view = renderGlobal("?q=remote-inbox");
    const user = userEvent.setup();
    try {
      await screen.findByRole("link", { name: "remote-inbox private capture" });
      await act(async () => { await view.client.invalidateQueries(); });
      const retry = await screen.findByRole("button", { name: "Try again" });
      expect(screen.queryByRole("link", { name: "remote-inbox private capture" })).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Your sessions are unavailable");
      expect(screen.queryByText("Private authorization detail")).not.toBeInTheDocument();
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(attempts).toBe(3));
      expect(screen.queryByRole("link", { name: "remote-inbox private capture" })).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Your sessions are unavailable");
      const search = screen.getByRole("textbox", { name: /search sessions/i });
      if (leftRetry) await user.click(search);
      release();
      await screen.findByRole("link", { name: "remote-inbox private capture" });
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      expect(leftRetry ? search : screen.getByRole("heading", { name: "All your sessions" })).toHaveFocus();
      expect(search).toHaveValue("remote-inbox");
      expect(attempts).toBe(3);
    } finally {
      release();
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
    }
  });
});

afterEach(() => {
  releases.splice(0).forEach((release) => release());
  server.events.removeListener("request:start", recordRequest);
  clients.splice(0).forEach((client) => client.clear());
  stubReducedMotion(false);
  window.localStorage.clear();
});

function RouteControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output aria-label="Current discovery URL">{location.pathname + location.search}</output>
    <button onClick={() => navigate("/-/sessions?q=new")}>Open new query</button>
  </>;
}

function renderGlobal(search = "") {
  const client = createTestQueryClient();
  clients.push(client);
  const view = renderWithProviders(<Routes><Route path="/-/sessions" element={<><GlobalSessionsPage /><RouteControls /></>} /></Routes>, {
    queryClient: client, routerProps: { initialEntries: [`/-/sessions${search}`] },
  });
  return { ...view, client };
}

function listRequests() { return requests.filter((request) => request.pathname === "/api/me/sessions"); }
function sessionLinks() { return screen.getAllByRole("link").filter((link) => /\/(acme|orbit)\/sessions\/root-/.test(link.getAttribute("href") ?? "")); }

function serveRetainedSessions() {
  const retained = Array.from({ length: 52 }, (_, index) => session(index));
  server.use(http.get("/api/me/sessions", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const query = params.get("q") ?? "";
    const matching = retained.filter((row) => row.title.includes(query));
    const offset = params.get("cursor") === "next-page" ? 40 : 0;
    return HttpResponse.json({ items: matching.slice(offset, offset + 40), next_cursor: matching.length > offset + 40 ? "next-page" : null });
  }));
}

describe("Global owner-session discovery", () => {
  it("pages one all-workspace root list and opens each item's current workspace without a private origin query", async () => {
    serveRetainedSessions();
    renderGlobal();
    await screen.findByRole("link", { name: "work 39" });
    expect(new Set(sessionLinks().map((link) => link.getAttribute("href"))).size).toBe(40);
    expect(screen.queryByRole("link", { name: "needle 51" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    expect(await screen.findByRole("link", { name: "needle 51" })).toHaveAttribute("href", "/orbit/sessions/root-51");
    expect(screen.getByRole("link", { name: "needle 50" })).toHaveAttribute("href", "/acme/sessions/root-50");
    expect(new Set(sessionLinks().map((link) => link.getAttribute("href"))).size).toBe(52);
    expect(listRequests()).toHaveLength(2);
    for (const request of listRequests()) {
      expect(request.searchParams.get("limit")).toBe("40");
      expect(request.searchParams.get("root_only")).toBe("true");
      expect(request.searchParams.has("workspace_id")).toBe(false);
      expect(request.searchParams.has("since")).toBe(false);
      expect([null, "recent"]).toContain(request.searchParams.get("sort"));
    }
    expect(listRequests()[1]!.searchParams.get("cursor")).toBe("next-page");
    expect(requests.filter((request) => /\/workspaces\/[^/]+\/sessions/.test(request.pathname))).toEqual([]);
  });

  it("searches retained rows beyond the unloaded first page, persists its global filter on direct reload and keeps shared session URLs clean", async () => {
    serveRetainedSessions();
    const view = renderGlobal();
    await screen.findByRole("link", { name: "work 39" });
    await userEvent.type(screen.getByRole("textbox", { name: /search sessions/i }), "needle");
    await screen.findByRole("link", { name: "needle 51" });
    await waitFor(() => expect(screen.queryByRole("link", { name: "work 0" })).not.toBeInTheDocument());
    const discoveryURL = screen.getByLabelText("Current discovery URL").textContent!;
    expect(discoveryURL.startsWith("/-/sessions?")).toBe(true);
    expect(new URL(discoveryURL, "https://example.test").searchParams.get("q")).toBe("needle");
    expect(sessionLinks().map((link) => link.getAttribute("href"))).toEqual(["/acme/sessions/root-50", "/orbit/sessions/root-51"]);
    const filtered = listRequests().filter((request) => request.searchParams.get("q") === "needle");
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((request) => !request.searchParams.has("cursor") && !request.searchParams.has("workspace_id") && !request.searchParams.has("since"))).toBe(true);

    view.unmount();
    renderGlobal(discoveryURL.slice("/-/sessions".length));
    await screen.findByRole("link", { name: "needle 51" });
    expect(screen.getByRole("textbox", { name: /search sessions/i })).toHaveValue("needle");
    expect(screen.queryByRole("link", { name: "work 0" })).not.toBeInTheDocument();
    expect(listRequests().at(-1)!.searchParams.get("q")).toBe("needle");
  });

  it("does not replace a new filter's results with a late old HTTP response", async () => {
    let releaseOld!: () => void;
    const held = new Promise<void>((resolve) => { releaseOld = resolve; });
    releases.push(releaseOld);
    let oldCompleted = false;
    server.use(http.get("/api/me/sessions", async ({ request }) => {
      const query = new URL(request.url).searchParams.get("q");
      if (query === "old") {
        await held;
        oldCompleted = true;
        return HttpResponse.json({ items: [{ ...session(0), title: "old response" }], next_cursor: null });
      }
      return HttpResponse.json({ items: [{ ...session(1), title: "new response" }], next_cursor: null });
    }));
    const view = renderGlobal("?q=old");
    await waitFor(() => expect(listRequests().some((request) => request.searchParams.get("q") === "old")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Open new query" }));
    await screen.findByRole("link", { name: "new response" });
    await act(async () => { releaseOld(); });
    await waitFor(() => expect(oldCompleted).toBe(true));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(screen.getByRole("link", { name: "new response" })).toHaveAttribute("href", "/orbit/sessions/root-1");
    expect(screen.queryByRole("link", { name: "old response" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Current discovery URL")).toHaveTextContent("/-/sessions?q=new");
  });

  it("holds the focused reading order when a real background HTTP refresh arrives and offers deliberate refresh", async () => {
    let newestFirst = false;
    server.use(http.get("/api/me/sessions", () => HttpResponse.json({ items: newestFirst ? [session(1), session(0)] : [session(0), session(1)], next_cursor: null })));
    const view = renderGlobal();
    const focused = await screen.findByRole("link", { name: "work 0" });
    act(() => focused.focus());
    expect(focused).toHaveFocus();
    const originalOrder = sessionLinks().map((link) => link.getAttribute("href"));
    newestFirst = true;
    // Public Query invalidation supplies a durable metadata response. This is
    // a reading-order test, not a claim to exercise the polling scheduler.
    await act(async () => { await view.client.invalidateQueries(); });
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(sessionLinks().map((link) => link.getAttribute("href"))).toEqual(originalOrder);
    expect(focused).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: /refresh|new sessions|update list|show latest/i }));
    await waitFor(() => expect(sessionLinks().map((link) => link.getAttribute("href"))).toEqual(["/orbit/sessions/root-1", "/acme/sessions/root-0"]));
  });
});
