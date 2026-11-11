// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { act, screen, stubReducedMotion, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { WebSocketContext, type WebSocketContextValue } from "@/providers/WebSocketProvider";
import type { Resource, ResourceDetail } from "@/types/resource";
import { ResourceList } from "../ResourceList";

const WORKSPACE = "890ec735-e58c-45f9-8d8e-c3c812c2a0e4";
const BOARD = "d9b2d698-9326-49cf-a0e3-746246117e5a";
const FOLDER = "e95acc0e-796a-40a7-b0d5-f271244d869b";
const FILE = "b70d395d-d731-4114-a6e7-00892a21e7c4";
const PATH = `/acme/boards/${BOARD}/resources`;
const API = `/api/workspaces/acme/boards/${BOARD}/resources`;
const BODY = `/a06-identity-body/${FILE}?signature=synthetic-only`;
const MALFORMED = "not-a-resource-uuid";
const TRAVERSAL = "../../../../../auth/oidc/logout";
const socket: WebSocketContextValue = { status: "connected", subscribe: () => () => {} };

function resource(id: string, name: string, folder: boolean): Resource {
  return {
    id, name, workspace_id: WORKSPACE, board_id: BOARD,
    parent_id: folder ? null : FOLDER, resource_type: folder ? "folder" : "file",
    gcs_path: folder ? null : `${WORKSPACE}/${id}/${name}`,
    mime_type: folder ? null : "text/plain", size_bytes: folder ? null : 22,
    uploaded_by: "c8e51690-1b6b-4642-8f74-f3becf69da7b", metadata: { tags: [] },
    description: null, created_at: "2026-10-19T03:00:00Z", updated_at: "2026-10-19T03:00:00Z",
  };
}
const folder = resource(FOLDER, "Exact UUID folder", true);
const file = resource(FILE, "Exact UUID file.txt", false);
const folderDetail: ResourceDetail = { ...folder, ancestors: [], ancestors_complete: true };
const fileDetail: ResourceDetail = {
  ...file, ancestors_complete: true, ancestors: [{
    id: FOLDER, name: folder.name, resource_type: "folder", workspace_id: WORKSPACE, board_id: BOARD,
  }],
};

type Receipt = { method: string; path: string; search: string; kind: string; status: number; returnedId?: string };
type DestinationParam = "resource" | "folder";

function mount(context: TestContext, parameter: DestinationParam, identity: string) {
  const receipts: Receipt[] = [];
  const unexpected: string[] = [];
  // One exhaustive handler prevents passthrough even when URL normalization
  // escapes the resource namespace. No actual auth endpoint is invoked.
  server.use(http.all("*", ({ request }) => {
    const url = new URL(request.url);
    const receive = (kind: string, status: number, returnedId?: string) => {
      receipts.push({ method: request.method, path: url.pathname, search: url.search, kind, status, returnedId });
    };
    if (request.method === "GET" && url.origin === window.location.origin) {
      if (url.pathname === API) {
        const parent = url.searchParams.get("parent_id");
        if (parent === null || parent.toLowerCase() === FOLDER) {
          receive("list", 200);
          return HttpResponse.json(parent === null ? [folder] : [file]);
        }
        if ([MALFORMED, TRAVERSAL].includes(parent)) {
          // Mirrors the router's UUID parent_id validation, not a client-side
          // validator. Safe query-parameter rejection remains an allowed fix.
          receive("invalid-parent", 422);
          return HttpResponse.json({ detail: "Invalid resource parent identity" }, { status: 422 });
        }
      }
      if (url.pathname === `${API}/tags` && !url.search) {
        receive("tags", 200);
        return HttpResponse.json([]);
      }
      const validPathIds = [FILE, FILE.toUpperCase(), FOLDER, FOLDER.toUpperCase()];
      const requestedId = validPathIds.find((id) => url.pathname === `${API}/${id}`);
      if (requestedId && !url.search) {
        const detail = requestedId.toLowerCase() === FILE ? fileDetail : folderDetail;
        // UUID-typed backend input accepts either case; UUID JSON is canonical.
        receive("detail", 200, detail.id);
        return HttpResponse.json(detail);
      }
      // An unreserved opaque identity may reach the server's normal 422.
      // Encoded separators/traversal must never leave the client: accepting
      // their encoded spelling here would hide decoding at a real proxy hop.
      if (url.pathname === `${API}/${MALFORMED}` && !url.search) {
        receive("invalid-detail", 422);
        return HttpResponse.json({ detail: "Invalid resource identity" }, { status: 422 });
      }
      if (url.pathname === `${API}/${FILE}/download-url` && !url.search) {
        receive("sign", 200, FILE);
        return HttpResponse.json({ download_url: BODY });
      }
      if (url.pathname + url.search === BODY) {
        receive("body", 200, FILE);
        return HttpResponse.text("Exact UUID body content");
      }
    }
    const blocked = `${request.method} ${url.origin}${url.pathname}${url.search}`;
    unexpected.push(blocked);
    receive("blocked-unexpected", 404);
    return HttpResponse.json({ detail: "Blocked by strict synthetic allowlist" }, { status: 404 });
  }));

  const query = new URLSearchParams({ [parameter]: identity });
  const rendered = renderBrowserNavigationRouter([
    { path: PATH, element: <WebSocketContext.Provider value={socket}><ResourceList slug="acme" boardId={BOARD} /></WebSocketContext.Provider> },
  ], `${PATH}?${query}`);
  context.onTestFinished(async () => {
    console.info("A06_DESTINATION_IDENTITY", JSON.stringify({ parameter, identity, receipts, unexpected, location: rendered.router.state.location }));
    rendered.unmount(); rendered.router.dispose();
    await rendered.client.cancelQueries(); rendered.client.clear();
  });
  return { ...rendered, receipts, unexpected, ui: within(rendered.container) };
}

type Fixture = ReturnType<typeof mount>;
async function settled(fixture: Fixture) {
  await waitFor(() => expect(fixture.receipts.some((receipt) => receipt.kind === "list" || receipt.kind === "invalid-parent")).toBe(true));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => { stubReducedMotion(true); localStorage.setItem("resource-view-mode", "list"); });
afterEach(() => { localStorage.removeItem("resource-view-mode"); stubReducedMotion(false); });

it.for([
  { parameter: "resource", identity: MALFORMED },
  { parameter: "folder", identity: MALFORMED },
  { parameter: "resource", identity: TRAVERSAL },
  { parameter: "folder", identity: TRAVERSAL },
] as const)("confines $parameter=$identity to resource identity handling", async ({ parameter, identity }, context) => {
  const fixture = mount(context, parameter, identity);
  await settled(fixture);
  context.signal.throwIfAborted();
  // Keep the visible-state oracle observable after the first forbidden-path
  // receipt; a soft request assertion still makes the entire case fail.
  expect.soft(fixture.unexpected).toEqual([]);
  const allowedKinds = identity === MALFORMED
    ? ["list", "tags", "invalid-parent", "invalid-detail"]
    : ["list", "tags", "invalid-parent"];
  expect.soft(fixture.receipts.filter((receipt) => !allowedKinds.includes(receipt.kind))).toEqual([]);
  const unavailable = parameter === "resource"
    ? /^This resource is unavailable\./
    : /^This folder is unavailable\./;
  expect(await screen.findByText(unavailable)).toBeVisible();
  context.signal.throwIfAborted();
  expect(fixture.receipts.filter((receipt) => ["detail", "sign", "body"].includes(receipt.kind))).toEqual([]);
  expect(screen.queryByRole("dialog", { name: file.name })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  expect(screen.queryByText("Exact UUID body content")).not.toBeInTheDocument();
  expect(fixture.router.state.location.pathname).toBe(PATH);
});

it.for([
  { label: "slash subroute", identity: `${FILE}/download-url` },
  { label: "backslash separator", identity: `${FILE}\\download-url` },
  { label: "percent-encoded separator", identity: `${FILE}%2Fdownload-url` },
] as const)("rejects a $label locally before any unsafe detail, signing or body request", async ({ identity }, context) => {
  const fixture = mount(context, "resource", identity);
  await settled(fixture);
  context.signal.throwIfAborted();
  // Prove the legitimate collection surface mounted, while no unsafe identity
  // was sent even in an encoded path. This fixture does not emulate nginx.
  expect(fixture.receipts.some((receipt) => receipt.kind === "list" && receipt.status === 200)).toBe(true);
  expect.soft(fixture.receipts.filter((receipt) => !["list", "tags"].includes(receipt.kind))).toEqual([]);
  expect.soft(fixture.unexpected).toEqual([]);
  expect(await screen.findByText(/^This resource is unavailable\./)).toBeVisible();
  context.signal.throwIfAborted();
  expect(fixture.receipts.filter((receipt) => ["detail", "sign", "body"].includes(receipt.kind))).toEqual([]);
  expect(screen.queryByRole("dialog", { name: file.name })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  expect(screen.queryByText("Exact UUID body content")).not.toBeInTheDocument();
  expect(fixture.router.state.location.pathname).toBe(PATH);
});

it.for(["canonical", "uppercase"] as const)("opens the exact %s UUID file from canonical backend metadata", async (casing, context) => {
  const identity = casing === "uppercase" ? FILE.toUpperCase() : FILE;
  const fixture = mount(context, "resource", identity);
  expect(await screen.findByText("Exact UUID body content")).toBeVisible();
  await settled(fixture);
  context.signal.throwIfAborted();
  const preview = screen.getByRole("dialog", { name: file.name });
  expect(preview).toBeVisible();
  expect(within(preview).getByRole("button", { name: "Download" })).toBeVisible();
  expect(fixture.receipts.filter((receipt) => receipt.kind === "detail").some((receipt) => receipt.returnedId === FILE)).toBe(true);
  expect(fixture.receipts.filter((receipt) => receipt.kind === "sign").map((receipt) => receipt.returnedId)).toEqual([FILE]);
  expect(fixture.receipts.filter((receipt) => receipt.kind === "body").map((receipt) => receipt.returnedId)).toEqual([FILE]);
  expect(new URLSearchParams(fixture.router.state.location.search).get("resource")?.toLowerCase()).toBe(FILE);
  expect(new URLSearchParams(fixture.router.state.location.search).get("folder")?.toLowerCase()).toBe(FOLDER);
  expect(fixture.unexpected).toEqual([]);
});

it.for(["canonical", "uppercase"] as const)("opens the exact %s UUID folder without preview requests", async (casing, context) => {
  const identity = casing === "uppercase" ? FOLDER.toUpperCase() : FOLDER;
  const fixture = mount(context, "folder", identity);
  await fixture.ui.findByRole("link", { name: new RegExp(file.name.replaceAll(".", "\\.")) });
  const path = fixture.ui.getByRole("navigation", { name: "Folder path" });
  expect(await within(path).findByRole("button", { name: folder.name })).toBeVisible();
  await settled(fixture);
  context.signal.throwIfAborted();
  expect(fixture.receipts.filter((receipt) => receipt.kind === "detail").some((receipt) => receipt.returnedId === FOLDER)).toBe(true);
  expect(fixture.receipts.filter((receipt) => ["sign", "body"].includes(receipt.kind))).toEqual([]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(new URLSearchParams(fixture.router.state.location.search).get("folder")?.toLowerCase()).toBe(FOLDER);
  expect(fixture.unexpected).toEqual([]);
});
