// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { BrowserContext, Download, Page, Route } from "@playwright/test";
import type { Resource, ResourceDetail } from "../../src/types/resource";
import type { BoardDetail } from "../../src/types/kanban";
import { installNavigationFixture, type NavigationFixture } from "./uxc-navigation-fixture";
import { boardId, sha, slug, stamp, type RequestReceipt } from "./session-window-fixture";

export { boardId, slug };
export type ResourceScope = "board" | "workspace";
export const collectionPath = (scope: ResourceScope) => scope === "board"
  ? `/${slug}/boards/${boardId}/resources` : `/${slug}/resources`;
export const resourceApi = (scope: ResourceScope) => `/api/workspaces${collectionPath(scope)}`;
const uuid = (value: number) => `60000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
export const ids = (scope: ResourceScope) => {
  const offset = scope === "board" ? 0 : 10_000;
  return {
    design: uuid(offset + 1), final: uuid(offset + 2), other: uuid(offset + 3), moved: uuid(offset + 4),
    hidden: uuid(offset + 50), alternate: uuid(offset + 60), restricted: uuid(offset + 70),
    report: (index: number) => uuid(offset + 1000 + index),
  };
};
export const reportName = (index: number) => `Report ${String(index).padStart(3, "0")}.txt`;
export const bodyFor = (id: string) => `SYNTHETIC RESOURCE BODY ${id}: exact retained resource bytes, never operator data.`;
const bodyPrefix = "/__a06_synthetic_body/";
const guardedBodyContexts = new WeakSet<BrowserContext>();

function resource(scope: ResourceScope, id: string, name: string, type: "folder" | "file", parent: string | null): Resource {
  return {
    id, workspace_id: "workspace-synthetic", board_id: scope === "board" ? boardId : null,
    parent_id: parent, resource_type: type, name, description: null,
    gcs_path: type === "file" ? `synthetic/${id}` : null,
    mime_type: type === "file" ? (name.endsWith(".bin") ? "application/octet-stream" : "text/plain") : null,
    size_bytes: type === "file" ? Buffer.byteLength(bodyFor(id)) : null,
    uploaded_by: "owner", metadata: { tags: type === "file" && name.startsWith("Report") ? ["review"] : [] },
    created_at: stamp, updated_at: stamp,
  };
}

function seedResources() {
  return new Map((["board", "workspace"] as const).flatMap((scope) => {
    const key = ids(scope);
    return [
      resource(scope, key.design, "Design", "folder", null),
      resource(scope, key.final, "Final", "folder", key.design),
      resource(scope, key.other, "Other", "folder", null),
      resource(scope, key.moved, "Moved destination", "folder", null),
      resource(scope, key.hidden, "Hidden evidence.txt", "file", key.other),
      resource(scope, key.alternate, "Alternate evidence.txt", "file", null),
      resource(scope, key.restricted, "Unsupported archive.bin", "file", null),
      ...Array.from({ length: 64 }, (_, index) => resource(scope, key.report(index), reportName(index), "file", key.final)),
    ].map((item) => [item.id, item] as const);
  }));
}

export interface ResourceReceipt extends RequestReceipt {
  kind: "collection" | "detail" | "tags" | "sign" | "body" | "shell";
  resourceId?: string;
  intentionalError?: boolean;
  navigation?: boolean;
  bodySha256?: string;
  completedAt?: number;
}
interface ConsoleReceipt { text: string; url: string; type: string }
export interface ResourceFixture extends NavigationFixture {
  resources: Map<string, Resource>;
  resourceRequests: ResourceReceipt[];
  detailStatus: Map<string, number>;
  heldDetails: Set<string>;
  pendingDetails: Map<string, (() => void)[]>;
  consoleReceipts: ConsoleReceipt[];
  downloads: { url: string; filename: string }[];
  issuedTickets: Map<string, string>;
  releaseDetail: (id: string) => void;
  releaseResources: () => void;
  emitResource: (id: string) => void;
}

function detail(state: ResourceFixture, item: Resource): ResourceDetail {
  const ancestors: ResourceDetail["ancestors"] = [];
  let parentId = item.parent_id;
  const visited = new Set([item.id]);
  while (parentId) {
    assert(!visited.has(parentId) && ancestors.length < 32, "Fixture ancestry must be finite and bounded");
    visited.add(parentId);
    const parent = state.resources.get(parentId);
    assert(parent && parent.resource_type === "folder" && parent.workspace_id === item.workspace_id && parent.board_id === item.board_id);
    ancestors.unshift({ id: parent.id, name: parent.name, resource_type: parent.resource_type, workspace_id: parent.workspace_id, board_id: parent.board_id });
    parentId = parent.parent_id;
  }
  return { ...structuredClone(item), ancestors, ancestors_complete: true };
}

/** Metadata/body endpoints extend the existing actual-AppShell fixture only. */
export async function installResourceFixture(page: Page, locale = "en"): Promise<ResourceFixture> {
  const inherited = await installNavigationFixture(page, locale);
  const state: ResourceFixture = Object.assign(inherited, {
    resources: seedResources(), resourceRequests: [], detailStatus: new Map<string, number>(),
    heldDetails: new Set<string>(), pendingDetails: new Map<string, (() => void)[]>(),
    consoleReceipts: [], downloads: [], issuedTickets: new Map<string, string>(),
    releaseDetail(id: string) {
      state.heldDetails.delete(id);
      state.pendingDetails.get(id)?.forEach((resolve) => resolve());
      state.pendingDetails.delete(id);
    },
    releaseResources() { [...state.pendingDetails.keys()].forEach((id) => state.releaseDetail(id)); },
    emitResource(id: string) {
      assert(state.socket && state.subscriptions.includes("activity.resource.*"), "Real resource subscription must exist before refresh");
      const frame = { event: "activity.resource.updated", timestamp: stamp,
        event_id: `synthetic-resource-${state.socketLedger.length}`,
        payload: { resource_id: id, entity_id: id, board_id: state.resources.get(id)?.board_id ?? null } };
      state.socketLedger.push({ kind: "event", at: Date.now(), connection: state.socketsOpened, payload: frame });
      state.socket.send(JSON.stringify(frame));
    },
  });
  page.on("console", (message) => state.consoleReceipts.push({ text: message.text(), url: message.location().url, type: message.type() }));
  const recordDownload = (download: Download) => state.downloads.push({ url: download.url(), filename: download.suggestedFilename() });
  page.on("download", recordDownload);
  // window.open(download_url) can associate the download with its new page.
  page.context().on("page", (opened) => opened.on("download", recordDownload));

  async function bodyRoute(route: Route) {
    const request = route.request(), url = new URL(request.url());
    const id = state.issuedTickets.get(url.pathname + url.search);
    const receipt: ResourceReceipt = { path: url.pathname, query: url.search, method: request.method(),
      mode: null, callId: null, cursor: null, startedAt: Date.now(), kind: "body", resourceId: id,
      navigation: request.isNavigationRequest() };
    state.requests.push(receipt); state.resourceRequests.push(receipt); state.inflight += 1;
    try {
      assert.equal(request.method(), "GET");
      assert.equal(url.origin, new URL(page.url()).origin, "Synthetic bytes stay on the current fixture origin");
      assert(!request.headers().authorization && !request.headers().cookie, "No fixture credentials");
      assert(id, "Body reads require a ticket actually issued by this fixture");
      const item = state.resources.get(id);
      assert(item?.gcs_path);
      const status = state.detailStatus.get(id) ?? 200;
      const text = status === 200 ? bodyFor(id) : "Synthetic body unavailable";
      receipt.status = status; receipt.intentionalError = status !== 200;
      receipt.bytes = Buffer.byteLength(text); receipt.bodySha256 = sha(text);
      await route.fulfill({ status, contentType: item.mime_type ?? "application/octet-stream", body: text,
        headers: request.isNavigationRequest() ? { "content-disposition": `attachment; filename="${item.name}"` } : {} });
    } catch (error) {
      state.unexpected.push(`Resource body fixture: ${String(error)}`);
      await route.abort("failed").catch(() => {});
    } finally { receipt.completedAt = Date.now(); state.inflight -= 1; }
  }
  await page.route(`**${bodyPrefix}**`, bodyRoute);
  if (!guardedBodyContexts.has(page.context())) {
    guardedBodyContexts.add(page.context());
    await page.context().route(`**${bodyPrefix}**`, async (route) => {
      state.unexpected.push(`Unissued native body request: ${route.request().url()}`);
      await route.abort("blockedbyclient");
    });
  }
  // A native download popup's FIRST request is only visible to context routes.
  await page.context().route(`**${bodyPrefix}**`, async (route) => {
    const url = new URL(route.request().url());
    return state.issuedTickets.has(url.pathname + url.search) ? bodyRoute(route) : route.fallback();
  });

  const boardPath = `/api/workspaces/${slug}/boards/${boardId}`;
  const shellPaths = new Set([boardPath, `/api/workspaces/${slug}/boards`, `${boardPath}/health`, `${boardPath}/loop/status`,
    `/api/workspaces/${slug}/executions`, `/api/workspaces/${slug}/metrics/agents`, `/api/workspaces/${slug}/config`]);
  const inheritedPaths = new Set(["/api/auth/modes", "/api/auth/setup-status", "/api/me", "/api/workspaces",
    "/api/notifications", "/api/notifications/unread-count",
    `/api/workspaces/${slug}`, `/api/workspaces/${slug}/members`,
    `/api/workspaces/${slug}/sessions/summary`,
    `/api/workspaces/${slug}/notifications`, `/api/workspaces/${slug}/notifications/unread-count`,
    `/api/workspaces/${slug}/approvals`, `/api/workspaces/${slug}/approvals/unread-count`]);
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    if (url.origin !== new URL(page.url()).origin) {
      state.unexpected.push(`External A06 API blocked: ${url.origin}${path}`);
      return route.abort("blockedbyclient");
    }
    const scope = (["board", "workspace"] as const).find((candidate) => path === resourceApi(candidate) || path.startsWith(`${resourceApi(candidate)}/`));
    if (!scope && !shellPaths.has(path)) {
      if (inheritedPaths.has(path)) return route.fallback();
      state.unexpected.push(`Unexpected A06 API: ${request.method()} ${path}${url.search}`);
      return route.fulfill({ status: 500, json: { detail: "Outside the A06 synthetic allowlist" } });
    }
    const suffix = scope ? path.slice(resourceApi(scope).length) : "";
    const resourceId = scope && suffix && suffix !== "/tags" ? suffix.split("/")[1] : undefined;
    const kind = !scope ? "shell" : !suffix ? "collection" : suffix === "/tags" ? "tags" : suffix.endsWith("/download-url") ? "sign" : "detail";
    const receipt: ResourceReceipt = { path, method: request.method(), query: url.search, kind, resourceId,
      mode: null, callId: null, cursor: null, startedAt: Date.now() };
    state.requests.push(receipt); state.resourceRequests.push(receipt); state.inflight += 1;
    try {
      assert.equal(request.method(), "GET", "This browser lane never mutates resource data through the UI");
      assert(!request.headers().authorization && !request.headers().cookie, "No fixture credentials");
      let value: unknown;
      let status = 200;
      if (!scope) {
        const board: BoardDetail = { id: boardId, slug: "synthetic-resource-board", workspace_id: "workspace-synthetic",
          name: "Synthetic resource board", description: "Synthetic navigation evidence", tags: [], is_frozen: false,
          loop_configured: false, columns: [], created_at: stamp, updated_at: stamp };
        if (path === boardPath) value = board;
        else if (path === `/api/workspaces/${slug}/boards`) value = [board];
        else if (path === `${boardPath}/health`) value = { health_score: 100 };
        else if (path === `${boardPath}/loop/status`) value = { state: "off", enabled: false, disabled_reason: null, actionable: false,
          has_inflight_iteration: false, last_iteration_at: null, last_iteration_status: null, bound_agent_count: 0,
          alive_agent_count: 0, spent_usd: 0, budget_usd: null };
        else if (path === `/api/workspaces/${slug}/executions`) value = [];
        else if (path === `/api/workspaces/${slug}/metrics/agents`) value = { agents: [] };
        else value = { pipeline_config: null };
      } else if (kind === "collection") {
        assert([...url.searchParams.keys()].every((key) => ["parent_id", "q", "resource_type", "tag"].includes(key)), "Whole-folder collections have no invented cursor/page API");
        const parent = url.searchParams.get("parent_id");
        const query = url.searchParams.get("q")?.toLowerCase();
        const effectiveBoard = scope === "board" ? boardId : (!query && parent ? state.resources.get(parent)?.board_id ?? null : null);
        const rows = [...state.resources.values()].filter((item) => item.board_id === effectiveBoard
          && (query ? item.name.toLowerCase().includes(query) : item.parent_id === parent)
          && (!url.searchParams.has("resource_type") || item.resource_type === url.searchParams.get("resource_type"))
          && (!url.searchParams.has("tag") || item.metadata.tags.includes(url.searchParams.get("tag")!)));
        value = rows; receipt.ids = rows.map((item) => item.id); receipt.returned = rows.length;
      } else if (kind === "tags") value = ["review"];
      else {
        const item = state.resources.get(resourceId!);
        assert(item && (scope === "workspace" || item.board_id === boardId), "Exact target must be valid in its requested scope");
        status = state.detailStatus.get(item.id) ?? 200;
        receipt.intentionalError = status !== 200;
        if (status !== 200) value = { detail: "Synthetic exact resource unavailable" };
        else if (kind === "sign") {
          assert(item.gcs_path && suffix === `/${item.id}/download-url`);
          const ticket = `${bodyPrefix}${item.id}?ticket=${state.issuedTickets.size + 1}`;
          state.issuedTickets.set(ticket, item.id);
          value = { download_url: `${url.origin}${ticket}` };
        } else {
          assert.equal(suffix, `/${item.id}`);
          value = detail(state, item);
          if (state.heldDetails.has(item.id)) await new Promise<void>((resolve) => {
            const pending = state.pendingDetails.get(item.id) ?? [];
            pending.push(resolve); state.pendingDetails.set(item.id, pending);
          });
        }
      }
      receipt.status = status; receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(`Resource fixture: ${String(error)}`);
        await route.fulfill({ status: 500, json: { detail: "Synthetic A06 fixture contract failed" } }).catch(() => {});
      }
    } finally { receipt.completedAt = Date.now(); state.inflight -= 1; }
  });
  return state;
}

export function unexpectedConsole(state: ResourceFixture) {
  return state.consoleReceipts.filter((entry) => {
    if (entry.type !== "error") return false;
    const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(entry.text)?.[1];
    if (!status || !entry.url) return true;
    const url = new URL(entry.url);
    return !state.resourceRequests.some((request) => request.intentionalError && request.status === Number(status)
      && request.path === url.pathname && request.query === url.search);
  });
}
