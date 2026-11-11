// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { cleanup } from "@testing-library/react";
import { useParams } from "react-router-dom";
import { utils, write } from "xlsx";
import { act, screen, stubReducedMotion, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { findLiteralText } from "@/test/literal-text-queries";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { resourceKeys } from "@/lib/query-keys";
import { ResourceList } from "@/features/resources/components/ResourceList";
import type { ResourceDetail } from "@/types/resource";
import { WorkspaceLayout } from "../WorkspaceLayout";

const PRIVATE_SLUG = "resource-revocation";
const SIBLING_SLUG = "resource-still-authorized";
const VIEWER = { id: "resource-viewer", name: "Resource viewer", email: "resource@example.test", avatar_url: null };
const PRIVATE_TEXT = "Previously authorized private fixture bytes";
const SIBLING_TEXT = "Still authorized sibling fixture bytes";
type Family = "text" | "binary";
type Signal = "authority close" | "member removal";

class ServerSocket {
  static instances: ServerSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public url: string) { ServerSocket.instances.push(this); }
  send() {}
  open() { this.readyState = ServerSocket.OPEN; this.onopen?.(); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
  removeViewer() {
    this.onmessage?.({ data: JSON.stringify({
      event: "activity.member.removed_member", event_id: "resource-viewer-removed", timestamp: "2026-10-23T20:00:00Z",
      payload: { entity_type: "member", entity_id: VIEWER.id, action: "removed_member", board_id: null,
        changes: { affected_user_id: VIEWER.id } },
    }) } as MessageEvent);
  }
}

function ResourceRoute() {
  const { slug } = useParams();
  return <ResourceList slug={slug!} />;
}

function resource(slug: string, family: Family): ResourceDetail {
  return {
    id: `${slug}-file`, workspace_id: `${slug}-workspace`, board_id: null, parent_id: null,
    resource_type: "file", name: `${slug}.${family === "text" ? "txt" : "xlsx"}`,
    description: null, gcs_path: `${slug}/synthetic`,
    mime_type: family === "text" ? "text/plain" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: 64, uploaded_by: VIEWER.id, metadata: { tags: [] },
    created_at: "2026-10-23T01:00:00Z", updated_at: "2026-10-23T01:00:00Z", ancestors: [], ancestors_complete: true,
  };
}

function spreadsheet(value: string): ArrayBuffer {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([["Evidence"], [value]]), "Fixture");
  return write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

function mount(context: TestContext, family: Family, holdPrivateBody = false) {
  const resources = [resource(PRIVATE_SLUG, family), resource(SIBLING_SLUG, family)];
  const workspaces = resources.map((file, index) => ({
    id: file.workspace_id, slug: index === 0 ? PRIVATE_SLUG : SIBLING_SLUG,
    name: index === 0 ? "Restricted workspace" : "Sibling workspace", description: "", role: "member", created_at: file.created_at,
  }));
  const bodyUrl = (id: string) => `/workspace-resource-body/${id}?grant=synthetic`;
  const previewKey = family === "text" ? resourceKeys.previewText : resourceKeys.previewBinary;
  const bodies = [PRIVATE_TEXT, SIBLING_TEXT];
  const binaries = family === "binary" ? bodies.map(spreadsheet) : [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const state = { authorized: true, bodyRequests: [] as string[], deliveredBodies: [] as string[], unexpected: [] as string[], writes: [] as string[] };
  const onResponse = ({ request }: { request: Request }) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/workspace-resource-body/")) state.deliveredBodies.push(path);
  };
  server.events.on("response:mocked", onResponse);
  server.use(
    http.get("/workspace-resource-body/:id", async ({ params }) => {
      const index = resources.findIndex((file) => file.id === params.id);
      expect(index).toBeGreaterThanOrEqual(0);
      state.bodyRequests.push(resources[index]!.id);
      if (index === 0 && holdPrivateBody) await held;
      return family === "text" ? HttpResponse.text(bodies[index]!) :
        new HttpResponse(binaries[index], { headers: { "Content-Type": resources[index]!.mime_type! } });
    }),
    http.all("/api/*", ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") {
        state.writes.push(`${request.method} ${path}`);
        return HttpResponse.json({ detail: "Unexpected mutation" }, { status: 400 });
      }
      if (path === "/api/me") return HttpResponse.json(VIEWER);
      if (path === "/api/auth/modes") return HttpResponse.json({ companion_enabled: false, password_enabled: false, oidc_enabled: false, dev_mode: true });
      if (path === "/api/auth/setup-status") return HttpResponse.json({ needs_setup: false });
      if (path === "/api/notifications") return HttpResponse.json([]);
      if (path === "/api/notifications/unread-count") return HttpResponse.json({ count: 0 });
      if (path === "/api/workspaces") return HttpResponse.json(workspaces.filter((_, index) => index !== 0 || state.authorized));
      for (const [index, workspace] of workspaces.entries()) {
        const base = `/api/workspaces/${workspace.slug}`;
        if (path !== base && !path.startsWith(`${base}/`)) continue;
        if (index === 0 && !state.authorized) return HttpResponse.json({ detail: "Workspace unavailable" }, { status: 403 });
        const file = resources[index]!;
        if (path === base) return HttpResponse.json(workspace);
        if (path === `${base}/resources`) return HttpResponse.json([file]);
        if (path === `${base}/resources/tags`) return HttpResponse.json([]);
        if (path === `${base}/resources/${file.id}`) return HttpResponse.json(file);
        if (path === `${base}/resources/${file.id}/download-url`) return HttpResponse.json({ download_url: bodyUrl(file.id) });
        if (path === `${base}/members`) return HttpResponse.json([{ user_id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, role: "member" }]);
        if (path.endsWith("/unread-count")) return HttpResponse.json({ count: 0 });
        if (path.endsWith("/notifications") || path.endsWith("/approvals") || path.endsWith("/boards")) return HttpResponse.json([]);
        if (path.endsWith("/sessions")) return HttpResponse.json({ items: [], next_cursor: null });
        if (path.endsWith("/config/completion-context-impact")) return HttpResponse.json({ attempts: [] });
      }
      state.unexpected.push(path);
      return HttpResponse.json({ detail: "Unspecified fixture endpoint" }, { status: 500 });
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/:slug", element: <WebSocketProvider><WorkspaceLayout /></WebSocketProvider>, children: [
      { path: "resources", element: <ResourceRoute /> },
    ] },
  ], { initialEntries: [`/${SIBLING_SLUG}/resources?resource=${resources[1]!.id}`] });
  // Restore production's five-minute retention instead of the shared test client's gcTime: 0.
  rendered.client.setQueryDefaults(["file-preview"], { gcTime: 5 * 60 * 1000 });
  rendered.client.setQueryDefaults(["file-preview-binary"], { gcTime: 5 * 60 * 1000 });
  const privateQueries = () => rendered.client.getQueryCache().findAll().filter(({ queryKey }) =>
    (queryKey[0] === "file-preview" || queryKey[0] === "file-preview-binary") && queryKey[1] === resources[0]!.id,
  );
  context.onTestFinished(async () => {
    rendered.unmount(); rendered.router.dispose();
    await rendered.client.cancelQueries();
    release(); rendered.client.clear();
    server.events.removeListener("response:mocked", onResponse);
    expect(state.unexpected).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  return {
    ...rendered, state, release, privateQueries,
    privateResource: resources[0]!, siblingResource: resources[1]!,
    privateKey: previewKey(resources[0]!.id, bodyUrl(resources[0]!.id)),
    siblingKey: previewKey(resources[1]!.id, bodyUrl(resources[1]!.id)),
    privateRoute: `/${PRIVATE_SLUG}/resources?resource=${resources[0]!.id}`,
  };
}

type Fixture = ReturnType<typeof mount>;

async function openPrivate(fixture: Fixture) {
  expect(await findLiteralText(SIBLING_TEXT)).toBeVisible();
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  const siblingBytes = fixture.client.getQueryData(fixture.siblingKey);
  expect(siblingBytes).toBeDefined();
  await act(async () => { await fixture.router.navigate(fixture.privateRoute); });
  await waitFor(() => expect(ServerSocket.instances.at(-1)?.url).toContain(PRIVATE_SLUG));
  const socket = ServerSocket.instances.at(-1)!;
  act(() => socket.open());
  return { socket, siblingBytes };
}

async function settled(fixture: Fixture) {
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  ServerSocket.instances = [];
  vi.stubGlobal("WebSocket", ServerSocket);
  stubReducedMotion(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  stubReducedMotion(false);
});

it.for<{ family: Family; signal: Signal }>([
  { family: "text", signal: "authority close" }, { family: "text", signal: "member removal" },
  { family: "binary", signal: "authority close" }, { family: "binary", signal: "member removal" },
])("erases fetched $family preview bytes on $signal while preserving the sibling workspace", async ({ family, signal }, context) => {
  const fixture = mount(context, family);
  const { socket, siblingBytes } = await openPrivate(fixture);
  expect(await findLiteralText(PRIVATE_TEXT)).toBeVisible();
  await settled(fixture);
  expect(fixture.client.getQueryData(fixture.privateKey)).toBeDefined();
  expect(fixture.state.bodyRequests).toEqual([fixture.siblingResource.id, fixture.privateResource.id]);
  fixture.state.authorized = false;
  act(() => signal === "authority close" ? socket.close(4002) : socket.removeViewer());
  expect(await findLiteralText("Workspace not found")).toBeVisible();
  await settled(fixture);
  expect(screen.queryByText(PRIVATE_TEXT)).not.toBeInTheDocument();
  expect(fixture.client.getQueryData(resourceKeys.detail(PRIVATE_SLUG, undefined, fixture.privateResource.id))).toBeUndefined();
  expect(fixture.client.getQueryData(resourceKeys.downloadUrl(PRIVATE_SLUG, undefined, fixture.privateResource.id))).toBeUndefined();
  expect(fixture.client.getQueryData(fixture.siblingKey)).toBe(siblingBytes);
  expect(fixture.privateQueries()).toHaveLength(0);
});

it.for<Family>(["text", "binary"])("does not restore %s preview bytes from a response admitted before revocation", async (family, context) => {
  const fixture = mount(context, family, true);
  const { socket, siblingBytes } = await openPrivate(fixture);
  await waitFor(() => expect(fixture.state.bodyRequests).toContain(fixture.privateResource.id));
  expect(fixture.client.getQueryState(fixture.privateKey)?.fetchStatus).toBe("fetching");
  fixture.state.authorized = false;
  act(() => socket.close(4002));
  expect(await findLiteralText("Workspace not found")).toBeVisible();
  await act(async () => fixture.release());
  await waitFor(() => expect(fixture.state.deliveredBodies).toContain(`/workspace-resource-body/${fixture.privateResource.id}`));
  await settled(fixture);
  expect(screen.queryByText(PRIVATE_TEXT)).not.toBeInTheDocument();
  expect(fixture.client.getQueryData(fixture.siblingKey)).toBe(siblingBytes);
  expect(fixture.privateQueries()).toHaveLength(0);
});
