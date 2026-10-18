// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page, WebSocketRoute } from "@playwright/test";

export const alphaSlug = "observer-alpha";
export const betaSlug = "observer-beta";
export const observerRoute = (slug = alphaSlug) => `/${slug}/boards`;
const stamp = "2026-10-18T20:00:00Z";
const workspaces = [alphaSlug, betaSlug].map((slug) => ({
  id: `synthetic-${slug}`, slug, name: `Synthetic ${slug}`, description: "Observer browser fixture",
  created_by: "observer-owner", created_at: stamp, updated_at: stamp,
}));

interface SocketConnection {
  id: number;
  slug: string;
  route: WebSocketRoute;
  open: boolean;
  wildcardDenied: boolean;
  requested: string[];
  accepted: string[];
}

export interface ObserverFixture {
  requests: Array<{ method: string; path: string; query: string; at: number; status?: number }>;
  socketLedger: Array<{ kind: string; connection: number; slug: string; at: number; payload?: unknown }>;
  unexpected: string[];
  failures: string[];
  inflight: number;
  subscriptions: (slug?: string) => string[];
  publish: (event: string, id: string, slug?: string, payload?: Record<string, unknown>) => void;
  denyWildcard: (slug?: string) => void;
  disconnect: (slug?: string) => Promise<void>;
}

// This supplies synthetic responses at the network boundary. All routing,
// permissions UI, subscriptions and shell components remain production code.
// Accepted-pattern filtering models delivery; it does not prove server authz.
export async function installObserverFixture(
  page: Page,
  locale = "en",
): Promise<ObserverFixture> {
  const sockets: SocketConnection[] = [];
  const latest = (slug: string) => {
    const connection = sockets.findLast((socket) => socket.slug === slug && socket.open);
    assert(connection, `No live synthetic socket for ${slug}`);
    return connection;
  };
  const state: ObserverFixture = {
    requests: [], socketLedger: [], unexpected: [], failures: [], inflight: 0,
    subscriptions(slug = alphaSlug) {
      return sockets.findLast((socket) => socket.slug === slug && socket.open)?.requested ?? [];
    },
    publish(event, id, slug = alphaSlug, payload = {}) {
      const connection = latest(slug);
      const admitted = connection.accepted.some((pattern) =>
        pattern === "*" || pattern === event ||
        (pattern.endsWith(".*") && event.startsWith(pattern.slice(0, -1))),
      );
      assert(admitted, `No accepted subscription admits ${event} in ${slug}`);
      const frame = { event, event_id: id, timestamp: stamp, payload: { title: id, ...payload } };
      state.socketLedger.push({ kind: "domain", connection: connection.id, slug, at: Date.now(), payload: frame });
      connection.route.send(JSON.stringify(frame));
    },
    denyWildcard(slug = alphaSlug) {
      const connection = latest(slug);
      assert(connection.requested.includes("*"), "A wildcard must be requested before its synthetic refusal");
      connection.wildcardDenied = true;
      connection.accepted = connection.accepted.filter((pattern) => pattern !== "*");
      const denial = { type: "subscription_denied", patterns: ["*"], error_code: "admin_required" };
      state.socketLedger.push({ kind: "denial", connection: connection.id, slug, at: Date.now(), payload: denial });
      connection.route.send(JSON.stringify(denial));
    },
    async disconnect(slug = alphaSlug) {
      const connection = latest(slug);
      connection.open = false;
      state.socketLedger.push({ kind: "disconnect", connection: connection.id, slug, at: Date.now() });
      await connection.route.close({ code: 1000, reason: "Synthetic diagnostic disconnection" });
    },
  };

  await page.addInitScript((language) => {
    localStorage.setItem("i18n-lang", language);
    localStorage.setItem("valaris-theme", "light");
    localStorage.setItem("valaris-welcome-dismissed", "true");
  }, locale);
  page.on("pageerror", (error) => state.unexpected.push(`Page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") state.unexpected.push(`Console error: ${message.text()}`);
  });
  page.on("requestfailed", (request) => state.failures.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));

  await page.routeWebSocket("**/ws/workspaces/**", (route) => {
    const path = new URL(route.url()).pathname;
    const slug = path.split("/")[3];
    assert(workspaces.some((workspace) => workspace.slug === slug), `Unexpected socket ${path}`);
    const connection: SocketConnection = { id: sockets.length + 1, slug, route, open: true, wildcardDenied: false, requested: [], accepted: [] };
    sockets.push(connection);
    state.socketLedger.push({ kind: "connect", connection: connection.id, slug, at: Date.now() });
    route.onMessage((message) => {
      const frame = JSON.parse(String(message));
      assert(Array.isArray(frame.subscribe), "Observer fixture expects subscription replacement frames");
      connection.requested = frame.subscribe;
      connection.accepted = frame.subscribe.filter((pattern: string) => !connection.wildcardDenied || pattern !== "*");
      state.socketLedger.push({ kind: "subscribe", connection: connection.id, slug, at: Date.now(), payload: frame.subscribe });
      if (connection.wildcardDenied && frame.subscribe.includes("*")) {
        const denial = { type: "subscription_denied", patterns: ["*"], error_code: "admin_required" };
        state.socketLedger.push({ kind: "denial", connection: connection.id, slug, at: Date.now(), payload: denial });
        route.send(JSON.stringify(denial));
      }
    });
    route.onClose((code, reason) => {
      connection.open = false;
      state.socketLedger.push({ kind: "client-close", connection: connection.id, slug, at: Date.now(), payload: { code, reason } });
    });
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      state.unexpected.push(`External request blocked: ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    const receipt: ObserverFixture["requests"][number] = { method: request.method(), path, query: url.search, at: Date.now() };
    state.requests.push(receipt);
    state.inflight += 1;
    try {
      assert.equal(request.method(), "GET", `Unexpected mutation: ${request.method()} ${path}`);
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests must carry no credentials");
      let value: unknown;
      const workspace = workspaces.find((item) => path === `/api/workspaces/${item.slug}` || path.startsWith(`/api/workspaces/${item.slug}/`));
      if (path === "/api/auth/modes") value = { oidc_enabled: false, password_enabled: false, dev_mode: true, companion_enabled: false, rich_capture_enabled: false };
      else if (path === "/api/auth/setup-status") value = { needs_setup: false };
      else if (path === "/api/me") value = { id: "observer-owner", name: "Synthetic Observer operator", email: "observer@example.test", avatar_url: null };
      else if (path === "/api/workspaces") value = workspaces;
      else if (workspace && path === `/api/workspaces/${workspace.slug}`) value = workspace;
      else if (workspace && path.endsWith("/members")) value = [{ user_id: "observer-owner", role: "owner", email: "observer@example.test", name: "Synthetic Observer operator" }];
      else if (workspace && (path.endsWith("/boards") || path.endsWith("/approvals"))) value = [];
      else if (path === "/api/notifications/unread-count") value = { count: 0 };
      else if (path === "/api/notifications") value = [];
      else assert.fail(`Unhandled synthetic API: ${request.method()} ${path}`);
      receipt.status = 200;
      await route.fulfill({ status: 200, json: value });
    } catch (error) {
      state.unexpected.push(String(error));
      receipt.status = 500;
      await route.fulfill({ status: 500, json: { detail: "Synthetic Observer fixture contract failed" } }).catch(() => {});
    } finally {
      state.inflight -= 1;
    }
  });
  return state;
}
