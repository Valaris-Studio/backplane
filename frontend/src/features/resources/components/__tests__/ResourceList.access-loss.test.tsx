// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JsonBodyType } from "msw";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { server, http, HttpResponse } from "@/test/msw-server";
import { resourceKeys } from "@/lib/query-keys";
import { WebSocketContext, type WebSocketContextValue } from "@/providers/WebSocketProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import type { ResourceDetail } from "@/types/resource";
import { ResourceList } from "../ResourceList";

const slug = "acme";
const boardId = "board-access-loss";
const fileId = "file-private";
const folderId = "folder-private";
const fileName = "Restricted evidence.txt";
const fileLinkName = `${fileName} file`;
const folderName = "Restricted folder";
const bodyText = "Previously authorized synthetic evidence";
const path = `/acme/boards/${boardId}/resources`;
const apiBase = `/api/workspaces/acme/boards/${boardId}/resources`;
const bodyPath = "/a06-access-loss-body";
const signedUrl = `${bodyPath}?signature=synthetic-existing-grant`;
type Kind = "list" | "tags" | "file" | "folder" | "sign" | "body";
type Receipt = { kind: Kind; phase: string; url: string; status?: number; completed: boolean };
type Hold = "first-detail" | "body" | "renew-sign";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function resource(id: string, name: string, parentId: string | null, folder = false): ResourceDetail {
  return {
    id, name, parent_id: parentId, workspace_id: "workspace-acme", board_id: boardId,
    resource_type: folder ? "folder" : "file", gcs_path: folder ? null : `workspace-acme/${id}/${name}`,
    mime_type: folder ? null : "text/plain", size_bytes: folder ? null : bodyText.length,
    uploaded_by: "user-me", metadata: { tags: [] }, description: null,
    created_at: "2026-10-19T03:00:00Z", updated_at: "2026-10-19T03:00:00Z",
    ancestors: [], ancestors_complete: true,
  };
}

function mount(context: TestContext, options: { nested?: boolean; exact?: boolean; hold?: Hold; bodyStatus?: number } = {}) {
  const folder = resource(folderId, folderName, null, true);
  const file = resource(fileId, fileName, options.nested ? folderId : null);
  if (options.nested) {
    const { id, name, resource_type, workspace_id, board_id } = folder;
    file.ancestors = [{ id, name, resource_type, workspace_id, board_id }];
  }
  const status: Record<Kind, number> = { list: 200, tags: 200, file: 200, folder: 200, sign: 200, body: options.bodyStatus ?? 200 };
  const held = deferred();
  const receipts: Receipt[] = [];
  const responses: Array<{ path: string; status: number }> = [];
  const unexpected: string[] = [];
  const cacheAdditionsAfterDenial: unknown[] = [];
  const subscribers = new Map<string, Set<(event: WebSocketEvent) => void>>();
  let phase = "initial-authorized";
  let denialDelivered = false;
  let fileRequests = 0;
  let signRequests = 0;
  const socket: WebSocketContextValue = {
    status: "connected",
    subscribe: (pattern, callback) => {
      const callbacks = subscribers.get(pattern) ?? new Set();
      callbacks.add(callback); subscribers.set(pattern, callbacks);
      return () => { callbacks.delete(callback); };
    },
  };
  const start = (kind: Kind, request: Request): Receipt => {
    const receipt: Receipt = { kind, phase, url: new URL(request.url).pathname + new URL(request.url).search, completed: false };
    receipts.push(receipt);
    return receipt;
  };
  const respond = (receipt: Receipt, code: number, data: JsonBodyType) => {
    receipt.status = code; receipt.completed = true;
    return HttpResponse.json(code === 200 ? data : { detail: "Synthetic resource response" }, { status: code });
  };
  const onResponse = ({ request, response }: { request: Request; response: Response }) => {
    const pathname = new URL(request.url).pathname;
    responses.push({ path: pathname, status: response.status });
    if (pathname === `${apiBase}/${fileId}` && [403, 404].includes(response.status)) denialDelivered = true;
  };
  server.events.on("response:mocked", onResponse);
  server.use(
    http.get(apiBase, ({ request }) => {
      const params = new URL(request.url).searchParams;
      // Exact-link cases deliberately resolve a file outside the filtered list.
      const rows = params.has("q") ? [] : options.nested && params.get("parent_id") !== folderId ? [folder] : [file];
      return respond(start("list", request), status.list, rows);
    }),
    http.get(`${apiBase}/tags`, ({ request }) => respond(start("tags", request), status.tags, [])),
    http.get(`${apiBase}/${folderId}`, ({ request }) => respond(start("folder", request), status.folder, folder)),
    http.get(`${apiBase}/${fileId}`, async ({ request }) => {
      const receipt = start("file", request);
      fileRequests += 1;
      // Model an authorization decision not yet completed, not a stale 200.
      if (options.hold === "first-detail" && fileRequests === 1) await held.promise;
      return respond(receipt, status.file, file);
    }),
    http.get(`${apiBase}/${fileId}/download-url`, async ({ request }) => {
      const receipt = start("sign", request);
      const authorizedAtStart = status.sign;
      signRequests += 1;
      if (options.hold === "renew-sign" && signRequests === 2) await held.promise;
      // The held answer was authorized before revocation; new requests are denied.
      return respond(receipt, authorizedAtStart, { download_url: signedUrl });
    }),
    http.get(bodyPath, async ({ request }) => {
      const receipt = start("body", request);
      const authorizedAtStart = status.body;
      if (options.hold === "body") await held.promise;
      receipt.status = authorizedAtStart; receipt.completed = true;
      return HttpResponse.text(authorizedAtStart === 200 ? bodyText : "Synthetic body unavailable", { status: authorizedAtStart });
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected access-loss fixture request" }, { status: 500 });
    }),
  );
  const query = new URLSearchParams();
  if (options.nested) query.set("folder", folderId);
  if (options.exact) { query.set("resource", fileId); query.set("q", "outside-this-filter"); }
  const rendered = renderBrowserNavigationRouter([
    { path, element: <WebSocketContext.Provider value={socket}><ResourceList slug={slug} boardId={boardId} /></WebSocketContext.Provider> },
  ], `${path}?${query}`);
  const isPrivateQuery = (key: readonly unknown[]) =>
    (key[0] === resourceKeys.downloadUrl(slug, boardId, fileId)[0] && key[3] === fileId) ||
    ((key[0] === resourceKeys.previewText(fileId, "")[0] || key[0] === resourceKeys.previewBinary(fileId, "")[0]) && key[1] === fileId);
  const unsubscribeCache = rendered.client.getQueryCache().subscribe((event) => {
    if (denialDelivered && event.type === "added" && isPrivateQuery(event.query.queryKey)) {
      cacheAdditionsAfterDenial.push([...event.query.queryKey]);
    }
  });
  context.onTestFinished(async () => {
    console.info("A06_RESOURCE_ACCESS_LOSS", JSON.stringify({
      test: context.task.name, phase, receipts, responses, cacheAdditionsAfterDenial, unexpected,
    }));
    rendered.unmount(); rendered.router.dispose();
    await rendered.client.cancelQueries();
    held.resolve(); rendered.client.clear(); unsubscribeCache();
    server.events.removeListener("response:mocked", onResponse);
    expect(unexpected, "all resource traffic must have an explicit fixture").toEqual([]);
  });
  return {
    ...rendered, status, receipts, responses, cacheAdditionsAfterDenial,
    view: within(rendered.container),
    phase: (next: string) => { context.signal.throwIfAborted(); phase = next; },
    release: held.resolve,
    privateQueries: () => rendered.client.getQueryCache().findAll().filter((query) => isPrivateQuery(query.queryKey)),
    counts: (kind: Kind) => receipts.filter((request) => request.kind === kind),
    deny: (code: 403 | 404) => { for (const kind of Object.keys(status) as Kind[]) status[kind] = code; },
    emit: () => {
      const event = "activity.resource.updated";
      const frame: WebSocketEvent = { event, timestamp: "2026-10-19T03:01:00Z", event_id: `refresh-${receipts.length}`, payload: { entity_id: fileId, workspace_id: "workspace-acme", board_id: boardId } };
      for (const [pattern, callbacks] of subscribers) {
        if (pattern === event || (pattern.endsWith(".*") && event.startsWith(pattern.slice(0, -1)))) {
          for (const callback of callbacks) callback(frame);
        }
      }
    },
  };
}

type Fixture = ReturnType<typeof mount>;

beforeEach(() => { stubReducedMotion(true); localStorage.setItem("resource-view-mode", "list"); });
afterEach(() => { stubReducedMotion(false); localStorage.removeItem("resource-view-mode"); });

async function settled(fixture: Fixture, context: TestContext) {
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  // Observe the committed real Query notification turn before negative assertions.
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  context.signal.throwIfAborted();
}

async function refresh(fixture: Fixture, context: TestContext, kind: Kind, code: number) {
  context.signal.throwIfAborted();
  const before = fixture.counts(kind).length;
  act(() => { fixture.emit(); });
  await waitFor(() => expect(fixture.counts(kind).slice(before).some((request) =>
    request.completed && request.status === code,
  )).toBe(true));
  await settled(fixture, context);
  for (const request of fixture.counts(kind).slice(before)) {
    expect(request).toMatchObject({ status: code, completed: true });
  }
}

function expectPhaseOutcomes(fixture: Fixture, kind: Kind, expected: Array<[string, number]>) {
  const phases = new Map<string, Receipt[]>();
  for (const request of fixture.counts(kind)) {
    const requests = phases.get(request.phase) ?? [];
    requests.push(request); phases.set(request.phase, requests);
  }
  expect([...phases].map(([phase, requests]) => ({
    phase, statuses: [...new Set(requests.map((request) => request.status))],
    completed: requests.every((request) => request.completed),
  }))).toEqual(expected.map(([phase, status]) => ({ phase, statuses: [status], completed: true })));
}

async function unavailable() {
  const dialog = await screen.findByRole("dialog", { name: "Resource unavailable" });
  expect(within(dialog).getByRole("alert")).toHaveTextContent("This resource is unavailable.");
  expect(within(dialog).queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  expect(screen.queryByText(bodyText)).not.toBeInTheDocument();
  return dialog;
}

function remainsPrivate(fixture: Fixture) {
  expect(screen.queryByRole("dialog", { name: fileName })).not.toBeInTheDocument();
  expect(screen.queryByText(bodyText)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  expect(fixture.privateQueries()).toHaveLength(0);
  expect(fixture.cacheAdditionsAfterDenial).toEqual([]);
}

it("does not revive an exact preview's cached label, body or Download after 403 then a 503 Retry", async (context) => {
  const fixture = mount(context, { exact: true });
  expect(await screen.findByText(bodyText)).toBeVisible();
  await settled(fixture, context);
  expect(fixture.counts("file").map((request) => request.status)).toEqual([200]);
  expect(fixture.counts("sign")).toHaveLength(1);
  expect(fixture.counts("body")).toHaveLength(1);
  fixture.phase("confirmed-denial"); fixture.deny(403);
  await refresh(fixture, context, "file", 403);
  const dialog = await unavailable();
  expect(fixture.privateQueries()).toHaveLength(0);
  fixture.phase("retry-is-transient-not-reauthorization"); fixture.status.file = 503;
  await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fixture.counts("file").some((request) =>
    request.phase === "retry-is-transient-not-reauthorization" && request.completed && request.status === 503,
  )).toBe(true));
  await settled(fixture, context);
  expectPhaseOutcomes(fixture, "file", [["initial-authorized", 200], ["confirmed-denial", 403], ["retry-is-transient-not-reauthorization", 503]]);
  remainsPrivate(fixture);
  expect(fixture.counts("sign")).toHaveLength(1);
  expect(fixture.counts("body")).toHaveLength(1);
});

it("does not reuse a selected row after its first exact detail returns 404 and Retry returns 503", async (context) => {
  const fixture = mount(context, { hold: "first-detail" });
  const row = await fixture.view.findByRole("link", { name: fileLinkName });
  context.signal.throwIfAborted();
  await userEvent.click(row);
  expect(await screen.findByText(bodyText)).toBeVisible();
  expect(fixture.counts("file")).toHaveLength(1);
  expect(fixture.counts("file")[0]?.completed).toBe(false);
  expect(fixture.client.getQueryData(resourceKeys.detail(slug, boardId, fileId))).toBeUndefined();
  fixture.phase("selected-row-denied-before-detail-success"); fixture.deny(404);
  act(() => { fixture.emit(); });
  await waitFor(() => expect(fixture.counts("list").at(-1)?.status).toBe(404));
  fixture.release();
  const dialog = await unavailable();
  await settled(fixture, context);
  expect(fixture.view.queryByRole("link", { name: fileLinkName })).not.toBeInTheDocument();
  expect(fixture.counts("file").map((request) => request.status)).toEqual([404]);
  fixture.phase("selected-row-transient-retry"); fixture.status.file = 503;
  await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fixture.counts("file").map((request) => request.status)).toEqual([404, 503]));
  await settled(fixture, context);
  remainsPrivate(fixture);
  expect(fixture.counts("body")).toHaveLength(1);
});

it("keeps known-denied list rows hidden when the next list refresh is only 503", async (context) => {
  const fixture = mount(context);
  expect(await fixture.view.findByRole("link", { name: fileLinkName })).toBeVisible();
  await settled(fixture, context);
  fixture.phase("list-denied"); fixture.deny(403);
  await refresh(fixture, context, "list", 403);
  const problem = fixture.view.getByText("These resources are unavailable. You may no longer have access to them.");
  expect(problem).toBeVisible();
  expect(problem.closest('[role="status"]')).toBeInTheDocument();
  expect(fixture.view.queryByRole("link", { name: fileLinkName })).not.toBeInTheDocument();
  fixture.phase("list-transient-after-denial"); fixture.status.list = 503;
  await refresh(fixture, context, "list", 503);
  expectPhaseOutcomes(fixture, "list", [["initial-authorized", 200], ["list-denied", 403], ["list-transient-after-denial", 503]]);
  expect(fixture.view.queryByRole("link", { name: fileLinkName })).not.toBeInTheDocument();
  expect(fixture.view.queryByText(fileName)).not.toBeInTheDocument();
  expect(fixture.counts("sign")).toHaveLength(0);
  expect(fixture.counts("body")).toHaveLength(0);
});

it("keeps a denied folder's trail and child metadata hidden after folder and list 503 responses", async (context) => {
  const fixture = mount(context, { nested: true });
  expect(await fixture.view.findByRole("link", { name: fileLinkName })).toBeVisible();
  const trail = () => within(fixture.view.getByRole("navigation", { name: "Folder path" }));
  expect(await trail().findByRole("button", { name: folderName })).toBeVisible();
  await settled(fixture, context);
  fixture.phase("folder-and-list-denied"); fixture.deny(404);
  await refresh(fixture, context, "folder", 404);
  expect(trail().queryByRole("button", { name: folderName })).not.toBeInTheDocument();
  expect(fixture.view.queryByRole("link", { name: fileLinkName })).not.toBeInTheDocument();
  fixture.phase("folder-and-list-transient-after-denial"); fixture.status.folder = 503; fixture.status.list = 503;
  await refresh(fixture, context, "folder", 503);
  for (const kind of ["folder", "list"] as const) {
    expectPhaseOutcomes(fixture, kind, [["initial-authorized", 200], ["folder-and-list-denied", 404], ["folder-and-list-transient-after-denial", 503]]);
  }
  expect(trail().queryByRole("button", { name: folderName })).not.toBeInTheDocument();
  expect(fixture.view.queryByRole("link", { name: fileLinkName })).not.toBeInTheDocument();
  expect(fixture.counts("sign")).toHaveLength(0);
  expect(fixture.counts("body")).toHaveLength(0);
});

it("retains authorized cached detail, folder and list metadata during a transient-only 503 refresh", async (context) => {
  const fixture = mount(context, { nested: true });
  await userEvent.click(await fixture.view.findByRole("link", { name: fileLinkName }));
  expect(await screen.findByText(bodyText)).toBeVisible();
  await settled(fixture, context);
  fixture.phase("transient-only-control");
  fixture.status.file = 503; fixture.status.folder = 503; fixture.status.list = 503;
  await refresh(fixture, context, "file", 503);
  for (const kind of ["file", "folder", "list"] as const) {
    expectPhaseOutcomes(fixture, kind, [["initial-authorized", 200], ["transient-only-control", 503]]);
  }
  expect(screen.getByRole("dialog", { name: fileName })).toBeVisible();
  expect(screen.getByText(bodyText)).toBeVisible();
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Download" })).toBeVisible();
  expect(within(fixture.view.getByRole("navigation", { name: "Folder path" })).getByRole("button", { name: folderName })).toBeVisible();
  expect(fixture.view.getByRole("link", { name: fileLinkName })).toBeVisible();
  expect(fixture.counts("sign")).toHaveLength(1);
  expect(fixture.counts("body")).toHaveLength(1);
});

it("does not cache or display a pre-denial body response that finishes after definitive detail loss", async (context) => {
  const fixture = mount(context, { exact: true, hold: "body" });
  await waitFor(() => expect(fixture.counts("body")).toHaveLength(1));
  expect(fixture.counts("body")[0]?.completed).toBe(false);
  expect(fixture.privateQueries().some((query) => query.state.fetchStatus === "fetching")).toBe(true);
  fixture.phase("denied-while-body-held"); fixture.deny(403);
  await refresh(fixture, context, "file", 403);
  await unavailable();
  await waitFor(() => expect(fixture.privateQueries()).toHaveLength(0));
  fixture.phase("release-pre-denial-body"); fixture.release();
  await waitFor(() => expect(fixture.responses.some((response) => response.path === bodyPath && response.status === 200)).toBe(true));
  await settled(fixture, context);
  remainsPrivate(fixture);
  expect(fixture.counts("sign")).toHaveLength(1);
  expect(fixture.counts("body")).toHaveLength(1);
});

it("does not restart a body query from a URL-renewal continuation after definitive detail loss", async (context) => {
  const fixture = mount(context, { exact: true, hold: "renew-sign", bodyStatus: 503 });
  const previewAlert = await screen.findByRole("alert");
  expect(previewAlert).toHaveTextContent(fileName);
  await settled(fixture, context);
  expect(fixture.counts("body").map((request) => request.status)).toEqual([503]);
  fixture.phase("authorized-renewal-held");
  await userEvent.click(within(previewAlert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fixture.counts("sign")).toHaveLength(2));
  expect(fixture.counts("sign")[1]?.completed).toBe(false);
  fixture.phase("denied-during-renewal"); fixture.deny(403);
  act(() => { fixture.emit(); });
  await unavailable();
  fixture.phase("release-pre-denial-signing-answer"); fixture.release();
  await waitFor(() => expect(fixture.responses.filter((response) => response.path === `${apiBase}/${fileId}/download-url` && response.status === 200)).toHaveLength(2));
  await settled(fixture, context);
  remainsPrivate(fixture);
  expect(fixture.counts("body").map((request) => request.status)).toEqual([503]);
  expect(fixture.counts("sign")).toHaveLength(2);
});
