// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { App } from "@/App";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { WebSocketContext, type WebSocketContextValue } from "@/providers/WebSocketProvider";
import { boardKeys } from "@/lib/query-keys";
import { api } from "@/lib/api";
import { resourceItemDomId } from "../../hooks/use-resource-destination";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { ResourceDetail } from "@/types/resource";

const boardPath = (board: string) => `/acme/boards/${board}/resources`;
const fileName = "Board A retained evidence.txt";
const fileBody = "Authorized synthetic body from Board A.";
const stamp = "2026-10-19T05:11:00Z";
type Receipt = { path: string; search: string; kind: string; board?: string; id?: string; completed: boolean; aborted: boolean; status?: number };
type QueryTransportReceipt = { path: string; signalPresent: boolean; aborted: boolean };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function resource(id: string, name: string, board: string, folder = false): ResourceDetail {
  return {
    id, name, workspace_id: "workspace-acme", board_id: board, parent_id: null,
    resource_type: folder ? "folder" : "file", gcs_path: folder ? null : `workspace-acme/${id}/${name}`,
    mime_type: folder ? null : "text/plain", size_bytes: folder ? null : fileBody.length,
    uploaded_by: "user-me", metadata: { tags: [] }, description: null,
    created_at: stamp, updated_at: stamp, ancestors: [], ancestors_complete: true,
  };
}

function mount(context: TestContext, initialBoard: "board-a" | "board-b") {
  const rows = new Map([
    resource("a-file", fileName, "board-a"),
    resource("a-folder", "Board A folder", "board-a", true),
    resource("b-file", "Board B current evidence.txt", "board-b"),
  ].map((row) => [row.id, row]));
  const boardList = gate();
  const folderList = gate();
  const exactFile = gate();
  const receipts: Receipt[] = [];
  const unexpected: string[] = [];
  const queryTransport: QueryTransportReceipt[] = [];
  const removeSignalListeners: Array<() => void> = [];
  // Axios uses XHR here. MSW's XHR -> Fetch Request conversion omits the
  // signal, so observe the real Query/Axios signal without altering transport.
  const interceptor = api.interceptors.request.use((config) => {
    const path = config.url ?? "";
    if (/^\/workspaces\/acme\/boards\/board-[ab]\/resources$/.test(path)) {
      const signal = config.signal;
      const receipt = { path, signalPresent: signal !== undefined, aborted: signal?.aborted === true };
      queryTransport.push(receipt);
      const onAbort = () => { receipt.aborted = true; };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      removeSignalListeners.push(() => { signal?.removeEventListener?.("abort", onAbort); });
    }
    return config;
  });
  let closed = false;
  const socket: WebSocketContextValue = { status: "connected", subscribe: () => () => {} };
  // Match main.tsx retention/freshness. gcTime: 0 would erase B's board on
  // departure and make BoardLayout unmount the very observer being tested.
  const client = new QueryClient({ defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  } });
  async function hold(request: Request, receipt: Receipt, barrier: ReturnType<typeof gate>) {
    await new Promise<void>((resolve) => {
      const done = () => { request.signal.removeEventListener("abort", done); resolve(); };
      if (request.signal.aborted || closed) done();
      else {
        request.signal.addEventListener("abort", done, { once: true });
        void barrier.promise.then(done);
      }
    });
    receipt.aborted = request.signal.aborted || closed;
    return !receipt.aborted;
  }
  server.use(http.all("*", async ({ request }) => {
    const url = new URL(request.url);
    const receipt: Receipt = { path: url.pathname, search: url.search, kind: "shell", completed: false, aborted: false };
    receipts.push(receipt);
    const json = (value: Parameters<typeof HttpResponse.json>[0], status = 200) => {
      receipt.status = status; receipt.completed = true;
      return HttpResponse.json(value, { status });
    };
    if (request.method === "GET") {
      switch (url.pathname) {
        case "/api/auth/modes": return json({ oidc_enabled: false, password_enabled: false, dev_mode: false, login_path: "/login", logout_path: "/logout", companion_enabled: false });
        case "/api/auth/setup-status": return json({ needs_setup: false });
        case "/api/me": return json({ id: "user-me", email: "viewer@example.test", name: "Viewer", avatar_url: null });
        case "/api/me/api-keys": return json([]);
        case "/api/notifications": return json([]);
        case "/api/notifications/unread-count": return json({ count: 0 });
        case "/api/workspaces/acme": return json({ id: "workspace-acme", slug: "acme", name: "Acme", created_by: "user-me", created_at: stamp, updated_at: stamp });
        case "/api/workspaces/acme/members": return json([{ user_id: "user-me", email: "viewer@example.test", name: "Viewer", role: "member" }]);
        case "/api/workspaces/acme/approvals": return json([]);
        case "/api/workspaces/acme/executions": return json([]);
        case "/api/workspaces/acme/config": return json({ enforce_done_merge_gate: false });
      }
      const boardMatch = /^\/api\/workspaces\/acme\/boards\/(board-a|board-b)(.*)$/.exec(url.pathname);
      if (boardMatch) {
        const board = boardMatch[1]!;
        const tail = boardMatch[2]!;
        receipt.board = board;
        if (!tail) return json({ id: board, slug: board, name: board === "board-a" ? "Board A" : "Board B", description: "", tags: [], workspace_id: "workspace-acme", columns: [], loop_configured: false, created_at: stamp, updated_at: stamp });
        if (tail === "/health") return json({ health_score: 100, total_cards: 0, stale_cards: [], overdue_cards: [], unassigned_cards: [], velocity_7d: 0, velocity_30d: 0, agent_efficiency_score: null });
        if (tail === "/loop/status") return json({ state: "off", enabled: false, disabled_reason: null, actionable: false, has_inflight_iteration: false, last_iteration_at: null, last_iteration_status: null, bound_agent_count: 0, alive_agent_count: 0, spent_usd: 0, budget_usd: null });
        if (tail === "/resources/tags") return json([]);
        if (tail === "/resources") {
          receipt.kind = "list";
          if (board === "board-b" && !await hold(request, receipt, boardList)) return new HttpResponse(null, { status: 499 });
          if (url.searchParams.get("parent_id") === "a-folder" && !await hold(request, receipt, folderList)) return new HttpResponse(null, { status: 499 });
          return json([...rows.values()].filter((row) => row.board_id === board && row.parent_id === (url.searchParams.get("parent_id") || null)));
        }
        const resourceMatch = /^\/resources\/([^/]+)(\/download-url)?$/.exec(tail);
        if (resourceMatch) {
          const id = resourceMatch[1]!;
          receipt.id = id;
          const row = rows.get(id);
          if (resourceMatch[2]) {
            receipt.kind = "sign";
            // Exact board authorization remains enforced. A wrong-scope request
            // is itself the UI defect; this fixture never grants its body.
            if (!row || row.board_id !== board) return json({ detail: "Resource unavailable" }, 404);
            return json({ download_url: `/a06-scope-body/${id}?signature=synthetic`, content_url: `/api/workspaces/acme/boards/${board}/resources/${id}/content` });
          }
          receipt.kind = "detail";
          if (id === "a-file" && !await hold(request, receipt, exactFile)) return new HttpResponse(null, { status: 499 });
          return row?.board_id === board ? json(row) : json({ detail: "Resource unavailable" }, 404);
        }
      }
      if (url.pathname === "/a06-scope-body/a-file" || url.pathname === "/a06-scope-body/b-file") {
        receipt.kind = "body"; receipt.id = url.pathname.split("/").at(-1); receipt.completed = true; receipt.status = 200;
        return HttpResponse.text(receipt.id === "a-file" ? fileBody : "Authorized synthetic body from Board B.");
      }
    }
    unexpected.push(`${request.method} ${url.pathname}`);
    return json({ detail: "Unexpected fixture request" }, 500);
  }));
  window.history.replaceState({ idx: 0, key: "scope-origin", usr: null }, "", boardPath(initialBoard));
  const router = createBrowserRouter([{ path: "*", element:
    <WebSocketContext.Provider value={socket}>
      <NavigationGuardProvider><ReturnNavigationProvider ownerId="user-me"><HandoffDraftProvider ownerId="user-me">
        <App />
      </HandoffDraftProvider></ReturnNavigationProvider></NavigationGuardProvider>
    </WebSocketContext.Provider>,
  }]);
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  context.onTestFinished(async () => {
    closed = true;
    rendered.unmount(); router.dispose();
    await client.cancelQueries();
    api.interceptors.request.eject(interceptor);
    removeSignalListeners.forEach((remove) => remove());
    boardList.release(); folderList.release(); exactFile.release(); client.clear();
    console.info("A06_SCOPE_PLACEHOLDER", JSON.stringify({ location: window.location.pathname + window.location.search, receipts, queryTransport, unexpectedCount: unexpected.length, unexpectedDistinct: [...new Set(unexpected)] }));
  });
  return { client, router, receipts, queryTransport, unexpected, releaseBoard: boardList.release, releaseFolder: folderList.release, releaseDetail: exactFile.release };
}

beforeEach(() => { stubReducedMotion(true); localStorage.setItem("resource-view-mode", "list"); });
afterEach(() => { localStorage.removeItem("resource-view-mode"); stubReducedMotion(false); });

it("does not reuse Board A as an authorized file seed on native Back to a warm Board B whose list is pending", async (context) => {
  const fixture = mount(context, "board-b");
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: /^Board B(?:\s|$)/ });
  context.signal.throwIfAborted();
  await waitFor(() => expect(fixture.receipts.some((r) => r.kind === "list" && r.board === "board-b")).toBe(true));
  context.signal.throwIfAborted();
  // Setup visits a real App route through the data router, not a prop-rerender
  // or a fake navigation component. The causal return below uses native POP.
  await act(async () => { await fixture.router.navigate(boardPath("board-a")); });
  context.signal.throwIfAborted();
  const aLink = await screen.findByRole("link", { name: `${fileName} file` });
  context.signal.throwIfAborted();
  expect(aLink).toHaveAttribute("href", `${boardPath("board-a")}?resource=a-file`);
  expect(fixture.client.getQueryData(boardKeys.detail("acme", "board-b"))).toMatchObject({ id: "board-b" });
  await waitFor(() => expect(fixture.queryTransport.find((r) => r.path === "/workspaces/acme/boards/board-b/resources"))
    .toMatchObject({ signalPresent: true, aborted: true }));
  expect(fixture.receipts.find((r) => r.kind === "list" && r.board === "board-b"))
    .toMatchObject({ completed: false, aborted: false });
  context.signal.throwIfAborted();
  act(() => { window.history.back(); });
  await waitFor(() => {
    expect(fixture.router.state.location.pathname).toBe(boardPath("board-b"));
    expect(fixture.receipts.filter((r) => r.kind === "list" && r.board === "board-b").length).toBeGreaterThanOrEqual(2);
  });
  context.signal.throwIfAborted();
  expect(fixture.receipts.filter((r) => r.board === "board-b" && r.path.endsWith("/board-b"))).toHaveLength(1);
  expect(fixture.receipts.filter((r) => r.kind === "list" && r.board === "board-b").every((r) => !r.completed)).toBe(true);
  const priorScopeLink = document.getElementById(resourceItemDomId("a-file"));
  // A repaired implementation may omit old-scope placeholders entirely. If it
  // keeps one visible, activating it must still await this scope's authority.
  if (priorScopeLink) {
    await user.click(priorScopeLink);
    context.signal.throwIfAborted();
    await waitFor(() => expect(fixture.receipts.some((r) => r.kind === "detail" && r.board === "board-b" && r.id === "a-file")).toBe(true));
    context.signal.throwIfAborted();
  }
  expect.soft(screen.queryByRole("heading", { name: fileName })).not.toBeInTheDocument();
  expect.soft(fixture.receipts.filter((r) => r.kind === "sign" && r.board === "board-b" && r.id === "a-file")).toEqual([]);
  expect.soft(fixture.receipts.filter((r) => r.kind === "body" && r.id === "a-file")).toEqual([]);
  await act(async () => { fixture.releaseBoard(); fixture.releaseDetail(); });
  context.signal.throwIfAborted();
  await waitFor(() => expect(fixture.receipts.some((r) => r.kind === "list" && r.board === "board-b" && r.completed && r.status === 200)).toBe(true));
  context.signal.throwIfAborted();
  expect(fixture.unexpected).toEqual([]);
});

it("keeps a same-board file usable from a folder placeholder while exact detail and the new folder listing are pending", async (context) => {
  const fixture = mount(context, "board-a");
  const user = userEvent.setup();
  const originalFile = await screen.findByRole("link", { name: `${fileName} file` });
  context.signal.throwIfAborted();
  expect(originalFile).toHaveAttribute("href", `${boardPath("board-a")}?resource=a-file`);
  await user.click(screen.getByRole("link", { name: "Board A folder folder" }));
  context.signal.throwIfAborted();
  await waitFor(() => {
    expect(new URLSearchParams(fixture.router.state.location.search).get("folder")).toBe("a-folder");
    expect(fixture.receipts.some((r) => r.kind === "list" && r.search.includes("parent_id=a-folder") && !r.completed)).toBe(true);
  });
  context.signal.throwIfAborted();
  await user.click(screen.getByRole("link", { name: `${fileName} file` }));
  context.signal.throwIfAborted();
  const preview = await screen.findByRole("dialog", { name: fileName });
  context.signal.throwIfAborted();
  expect(await within(preview).findByText(fileBody, { exact: true })).toBeVisible();
  context.signal.throwIfAborted();
  expect(fixture.receipts.filter((r) => r.kind === "sign")).toMatchObject([{ board: "board-a", id: "a-file", status: 200 }]);
  expect(fixture.receipts.filter((r) => r.kind === "body")).toMatchObject([{ id: "a-file", status: 200 }]);
  expect(fixture.receipts.some((r) => r.kind === "detail" && r.id === "a-file" && !r.completed)).toBe(true);
  expect(fixture.receipts.filter((r) => r.kind === "list" && r.search.includes("parent_id=a-folder")).every((r) => !r.completed)).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});
