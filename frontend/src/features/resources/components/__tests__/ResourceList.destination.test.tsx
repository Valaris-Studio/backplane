// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { server, http, HttpResponse } from "@/test/msw-server";
import { EntityLink } from "@/components/shared/EntityLink";
import { WebSocketContext, type WebSocketContextValue } from "@/providers/WebSocketProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import type { Resource } from "@/types/resource";
import { ResourceList } from "../ResourceList";

type Ancestor = Pick<Resource, "id" | "name" | "resource_type" | "workspace_id" | "board_id">;
type ResourceDetail = Resource & { ancestors: Ancestor[]; ancestors_complete: boolean };
type RequestReceipt = { kind: string; id?: string; search?: string; returnedIds?: string[]; status?: number };
type FixtureCleanup = Pick<ReturnType<typeof renderBrowserNavigationRouter>, "router" | "client" | "unmount"> & {
  release: () => void; receipts: RequestReceipt[]; unexpected: string[];
};
const fixtures: FixtureCleanup[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function row(id: string, name: string, boardId: string | undefined, parentId: string | null = null, folder = false): Resource {
  return {
    id, name, workspace_id: "workspace-acme", board_id: boardId ?? null,
    parent_id: parentId, resource_type: folder ? "folder" : "file",
    gcs_path: folder ? null : `workspace-acme/${id}/${name}`,
    mime_type: folder ? null : "text/plain", size_bytes: folder ? null : 24,
    uploaded_by: "user-me", metadata: { tags: folder ? [] : ["important"] },
    description: null, created_at: "2026-10-19T03:00:00Z", updated_at: "2026-10-19T03:00:00Z",
  };
}

function mount(options: { workspace?: boolean; query?: string; holdId?: string; origin?: boolean } = {}) {
  const boardId = options.workspace ? undefined : "board-1";
  const path = `/acme${boardId ? `/boards/${boardId}` : ""}/resources`;
  const apiBase = `/api/workspaces${path}`;
  const resources = new Map([
    row("folder-a", "Design", boardId, null, true),
    row("folder-b", "Final", boardId, "folder-a", true),
    row("folder-c", "Archive", boardId, null, true),
    row("root-file", "visible.txt", boardId),
    row("target-a", "wanted.txt", boardId, "folder-b"),
    row("target-b", "second.txt", boardId, "folder-c"),
  ].map((resource) => [resource.id, resource]));
  const receipts: RequestReceipt[] = [];
  const unexpected: string[] = [];
  const subscribers = new Map<string, Set<(event: WebSocketEvent) => void>>();
  const held = deferred();
  let heldCompleted = false;
  let scopeStatus = 200;
  let signCount = 0;
  const detailStatus = new Map<string, number>();
  const socket: WebSocketContextValue = {
    status: "connected",
    subscribe: (pattern, callback) => {
      const callbacks = subscribers.get(pattern) ?? new Set();
      callbacks.add(callback); subscribers.set(pattern, callbacks);
      return () => { callbacks.delete(callback); };
    },
  };
  function detail(resource: Resource): ResourceDetail {
    const ancestors: Ancestor[] = [];
    let parent = resource.parent_id ? resources.get(resource.parent_id) : undefined;
    while (parent) {
      const { id, name, resource_type, workspace_id, board_id } = parent;
      ancestors.unshift({ id, name, resource_type, workspace_id, board_id });
      parent = parent.parent_id ? resources.get(parent.parent_id) : undefined;
    }
    return { ...structuredClone(resource), ancestors, ancestors_complete: true };
  }
  server.use(
    http.get(apiBase, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const query = params.get("q");
      let returned = [...resources.values()];
      // Mirror the current whole-folder API; search is across the scope.
      returned = query ? returned.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
        : returned.filter((item) => item.parent_id === (params.get("parent_id") || null));
      if (params.get("resource_type")) returned = returned.filter((item) => item.resource_type === params.get("resource_type"));
      if (params.get("tag")) returned = returned.filter((item) => item.metadata.tags.includes(params.get("tag")!));
      receipts.push({ kind: "list", search: params.toString(), returnedIds: returned.map((item) => item.id), status: scopeStatus });
      return scopeStatus === 200 ? HttpResponse.json(returned) : HttpResponse.json({ detail: "Access lost" }, { status: scopeStatus });
    }),
    http.get(`${apiBase}/tags`, () => HttpResponse.json(["important"])),
    http.get(`${apiBase}/:id/download-url`, ({ params }) => {
      const id = String(params.id);
      const status = scopeStatus === 200 ? detailStatus.get(id) ?? 200 : scopeStatus;
      receipts.push({ kind: "sign", id, status });
      if (status !== 200) return HttpResponse.json({ detail: "Unavailable" }, { status });
      signCount += 1;
      return HttpResponse.json({ download_url: `/a06-body/${id}?signature=synthetic-${signCount}`, content_url: `/api/workspaces/acme/resources/${id}/content` });
    }),
    http.get(`${apiBase}/:id`, async ({ params }) => {
      const id = String(params.id);
      const status = scopeStatus === 200 ? detailStatus.get(id) ?? (resources.has(id) ? 200 : 404) : scopeStatus;
      const snapshot = resources.has(id) ? detail(resources.get(id)!) : null;
      receipts.push({ kind: "detail", id, status });
      if (id === options.holdId) { await held.promise; heldCompleted = true; }
      return status === 200 ? HttpResponse.json(snapshot) : HttpResponse.json({ detail: "Resource unavailable" }, { status });
    }),
    http.get("/a06-body/:id", ({ params }) => {
      const id = String(params.id);
      receipts.push({ kind: "body", id });
      return HttpResponse.text(`Exact authorized body ${id}`);
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 500 });
    }),
  );
  const rendered = renderBrowserNavigationRouter([
    { path, element: <WebSocketContext.Provider value={socket}><ResourceList slug="acme" boardId={boardId} /></WebSocketContext.Provider> },
    { path: "/source", element: <main><h1>Source metadata</h1><EntityLink type="resource" slug="acme" boardId={boardId} id="target-a">Open exact resource</EntityLink></main> },
    { path: "/away", element: <h1>Another view</h1> },
  ], options.origin ? "/source?private-query=source-only#private-selection" : path + (options.query ?? ""));
  const fixture = {
    ...rendered, path, receipts, unexpected, resources, detailStatus,
    release: held.resolve, heldCompleted: () => heldCompleted,
    denyScope: () => { scopeStatus = 403; },
    emit: (id: string, event = "activity.resource.updated") => {
      const frame: WebSocketEvent = { event, timestamp: "2026-10-19T03:01:00Z", event_id: `event-${id}`, payload: { entity_id: id, workspace_id: "workspace-acme", board_id: boardId ?? null } };
      for (const [pattern, callbacks] of subscribers) {
        if (pattern === event || (pattern.endsWith(".*") && event.startsWith(pattern.slice(0, -1)))) {
          for (const callback of callbacks) callback(frame);
        }
      }
    },
  };
  fixtures.push(fixture);
  return fixture;
}

beforeEach(() => { stubReducedMotion(true); localStorage.setItem("resource-view-mode", "list"); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const unexpectedPaths = [...new Set(fixture.unexpected)];
    console.info("A06_RESOURCE_DESTINATION", JSON.stringify({
      location: fixture.router.state.location, receipts: fixture.receipts,
      unexpectedCount: fixture.unexpected.length,
      unexpectedDistinctCount: unexpectedPaths.length,
      unexpectedPaths: unexpectedPaths.slice(0, 12),
    }));
    fixture.release(); fixture.unmount(); fixture.router.dispose();
    await fixture.client.cancelQueries(); fixture.client.clear();
  }
  localStorage.removeItem("resource-view-mode"); stubReducedMotion(false); vi.restoreAllMocks();
});

function resourceAction(name: string): HTMLElement {
  // DndKit's outer draggable has role=button too; select the native action,
  // allowing a normal link if the destination implementation adopts one.
  const action = screen.getByText(name, { exact: true }).closest("a[href], button");
  expect(action).toBeInstanceOf(HTMLElement);
  return action as HTMLElement;
}

async function findResourceAction(name: string) {
  await screen.findByText(name, { exact: true });
  return resourceAction(name);
}

async function closePreview() {
  const dialog = screen.getByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

it("keeps ordinary list labels metadata-only and preserves deliberate preview/download signing", async () => {
  const fixture = mount();
  await findResourceAction("visible.txt");
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.receipts.filter((request) => ["body", "sign"].includes(request.kind))).toEqual([]);
  await userEvent.click(resourceAction("visible.txt"));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  // The first preview loads its real module graph before it can request the body.
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(await screen.findByText("Exact authorized body root-file")).toBeVisible();
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Download" }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith("/a06-body/root-file?signature=synthetic-2", "_blank"));
  expect(fixture.unexpected).toEqual([]);
});

it.each([false, true])("a cold exact link resolves a nested file outside the folder/filter response (workspace: %s)", async (workspace) => {
  const fixture = mount({ workspace, query: "?folder=folder-c&q=visible&resource_type=file&resource=target-a" });
  expect(await screen.findByText("Exact authorized body target-a")).toBeVisible();
  expect(screen.getByRole("dialog", { name: "wanted.txt" })).toBeVisible();
  expect(fixture.receipts.some((request) => request.kind === "detail" && request.id === "target-a")).toBe(true);
  expect(fixture.receipts.filter((request) => request.kind === "list").every((request) => !request.returnedIds!.includes("target-a"))).toBe(true);
  expect(new URLSearchParams(fixture.router.state.location.search).get("folder")).toBe("folder-b");
  expect(fixture.receipts.filter((request) => request.kind === "body").map((request) => request.id)).toEqual(["target-a"]);
  expect(fixture.unexpected).toEqual([]);
});

it("an exact folder link opens its current nested collection without signing or previewing a file", async () => {
  const fixture = mount({ query: "?resource=folder-b&folder=folder-c" });
  expect(await findResourceAction("wanted.txt")).toBeVisible();
  expect(new URLSearchParams(fixture.router.state.location.search).get("folder")).toBe("folder-b");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.receipts.filter((request) => ["body", "sign"].includes(request.kind))).toEqual([]);
  const navigation = screen.getByRole("navigation");
  expect(within(navigation).getByRole("button", { name: "Design" })).toBeVisible();
  expect(within(navigation).getByRole("button", { name: "Final" })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

it("uses canonical shared links without leaking private origin data and reopens the same target after a cold mount", async () => {
  const fixture = mount({ origin: true });
  const link = screen.getByRole("link", { name: "Open exact resource" });
  expect(link).toHaveAttribute("href", `${fixture.path}?resource=target-a`);
  expect(fixture.receipts).toEqual([]);
  await userEvent.click(link);
  expect(await screen.findByText("Exact authorized body target-a")).toBeVisible();
  expect(fixture.router.state.location.search).not.toMatch(/private-query|source-only|private-selection|signature/);
  expect(JSON.stringify(fixture.router.state.location.state)).not.toMatch(/source-only|private-selection/);
  const copied = `${fixture.path}?resource=target-a`;
  fixture.unmount(); fixture.router.dispose(); await fixture.client.cancelQueries(); fixture.client.clear();
  const reloaded = mount({ query: copied.slice(fixture.path.length) });
  expect(await screen.findByRole("dialog", { name: "wanted.txt" })).toBeVisible();
  expect(await screen.findByText("Exact authorized body target-a")).toBeVisible();
  expect(reloaded.receipts.some((request) => request.kind === "detail" && request.id === "target-a")).toBe(true);
  expect(reloaded.unexpected).toEqual([]);
});

it("preserves nested folder, query and filters across preview close, Back, and route remount with focus", async () => {
  const fixture = mount();
  await userEvent.click(await findResourceAction("Design"));
  await userEvent.click(await findResourceAction("Final"));
  await userEvent.type(screen.getByPlaceholderText("Search files..."), "wanted");
  await userEvent.click(screen.getByRole("button", { name: /Type: All/i }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Files" }));
  await userEvent.click(screen.getByRole("button", { name: "Tags" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "important" }));
  await waitFor(() => expect(fixture.receipts.some((request) => request.kind === "list" && request.search?.includes("q=wanted") && request.search.includes("resource_type=file") && request.search.includes("tag=important"))).toBe(true));
  const before = new URLSearchParams(fixture.router.state.location.search);
  expect(before.get("folder")).toBe("folder-b");
  expect(before.get("q")).toBe("wanted");
  const target = resourceAction("wanted.txt");
  await userEvent.click(target);
  expect(await screen.findByText("Exact authorized body target-a")).toBeVisible();
  expect(new URLSearchParams(fixture.router.state.location.search).get("resource")).toBe("target-a");
  await closePreview();
  await waitFor(() => expect(resourceAction("wanted.txt")).toHaveFocus());
  expect(new URLSearchParams(fixture.router.state.location.search).get("resource")).toBeNull();
  expect(screen.getByPlaceholderText("Search files...")).toHaveValue("wanted");
  expect(new URLSearchParams(fixture.router.state.location.search).get("folder")).toBe("folder-b");
  await userEvent.click(resourceAction("wanted.txt"));
  await screen.findByRole("dialog", { name: "wanted.txt" });
  await act(async () => { await fixture.router.navigate(-1); });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const returnSearch = fixture.router.state.location.search;
  act(() => { resourceAction("wanted.txt").focus(); });
  await act(async () => { await fixture.router.navigate("/away"); });
  expect(screen.getByRole("heading", { name: "Another view" })).toBeVisible();
  await act(async () => { await fixture.router.navigate(-1); });
  await findResourceAction("wanted.txt");
  expect(fixture.router.state.location.search).toBe(returnSearch);
  expect(screen.getByPlaceholderText("Search files...")).toHaveValue("wanted");
  expect(screen.getByRole("button", { name: /Type: Files/i })).toBeVisible();
  expect(screen.getByRole("button", { name: /Tags: important/i })).toBeVisible();
  await waitFor(() => expect(resourceAction("wanted.txt")).toHaveFocus());
  expect(fixture.unexpected).toEqual([]);
});

it.each([false, true])("a late detail response cannot replace the new target or a known denial (denied: %s)", async (denied) => {
  const fixture = mount({ query: "?resource=target-a", holdId: "target-a" });
  await waitFor(() => expect(fixture.receipts.some((request) => request.kind === "detail" && request.id === "target-a")).toBe(true));
  expect(fixture.receipts.filter((request) => ["body", "sign"].includes(request.kind))).toEqual([]);
  if (denied) fixture.detailStatus.set("target-b", 403);
  await act(async () => { await fixture.router.navigate(`${fixture.path}?resource=target-b`); });
  if (denied) expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable|access|permission|not found/i);
  else expect(await screen.findByText("Exact authorized body target-b")).toBeVisible();
  fixture.release();
  await waitFor(() => expect(fixture.heldCompleted()).toBe(true));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(screen.queryByText("Exact authorized body target-a")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "wanted.txt" })).not.toBeInTheDocument();
  expect(fixture.receipts.some((request) => ["body", "sign"].includes(request.kind) && request.id === "target-a")).toBe(false);
  if (denied) expect(fixture.receipts.some((request) => ["body", "sign"].includes(request.kind))).toBe(false);
  else expect(screen.getByRole("dialog", { name: "second.txt" })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

it("refreshes the same preview identity after a move and rename using the existing resource event", async () => {
  const fixture = mount({ query: "?resource=target-a" });
  await screen.findByText("Exact authorized body target-a");
  fixture.resources.set("target-a", { ...fixture.resources.get("target-a")!, name: "renamed.txt", parent_id: "folder-c" });
  fixture.resources.set("folder-c", { ...fixture.resources.get("folder-c")!, name: "Renamed archive" });
  act(() => { fixture.emit("target-a"); });
  expect(await screen.findByRole("dialog", { name: "renamed.txt" })).toBeVisible();
  await waitFor(() => expect(new URLSearchParams(fixture.router.state.location.search).get("folder")).toBe("folder-c"));
  expect(new URLSearchParams(fixture.router.state.location.search).get("resource")).toBe("target-a");
  expect(fixture.receipts.filter((request) => request.kind === "detail" && request.id === "target-a").length).toBeGreaterThanOrEqual(2);
  expect(fixture.unexpected).toEqual([]);
});

it.each([403, 404])("removes a formerly available preview when current metadata denies it (%s)", async (status) => {
  const fixture = mount({ query: "?resource=target-a" });
  await screen.findByText("Exact authorized body target-a");
  if (status === 403) fixture.denyScope();
  else { fixture.resources.delete("target-a"); fixture.detailStatus.set("target-a", 404); }
  act(() => { fixture.emit("target-a", "activity.resource.deleted"); });
  expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable|access|permission|not found/i);
  expect(screen.queryByText("Exact authorized body target-a")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  expect(fixture.unexpected).toEqual([]);
});
