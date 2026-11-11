// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { onlineManager } from "@tanstack/react-query";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import en from "@/i18n/locales/en.json";
import { http, HttpResponse, server } from "@/test/msw-server";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import type { SessionPeriodSummary } from "@/types/agent-session";
import { makeSession, SLUG, stubAuthModes } from "../../__tests__/fixtures";
import { MySessionsPage } from "../MySessionsPage";

const OTHER_SLUG = "other-authorized-workspace";
const RECOVERED_TITLE = "Synthetic session returned only after authorization";
const OTHER_TITLE = "Synthetic session in the new query scope";
const retryName = en.sessions.loadError.retry;
const denialCopy = en.sessions.loadError.accessDenied;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function RouteControls() {
  const location = useLocation();
  return <>
    <Link to={`/${OTHER_SLUG}/sessions`}>Open other workspace</Link>
    <output data-testid="list-location">{location.pathname + location.search}</output>
  </>;
}

interface Attempt {
  scope: "original" | "changed";
  query: string;
  status: number;
  settled: boolean;
}

function mountList(retryStatus: 200 | 403) {
  const retryGate = gate();
  const changedScopeGate = gate();
  const attempts: Attempt[] = [];
  const unexpected: string[] = [];
  const writes: string[] = [];
  let activeHandlers = 0;
  const summary: SessionPeriodSummary = {
    session_count: 0, live_count: 0, wall_duration_seconds: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_creation_tokens: 0, reasoning_tokens: 0,
    cost_api_equivalent_usd: null, cost_spend_usd: null, cost_complete: true,
  };
  stubAuthModes(true);
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([
      { id: "ws-1", slug: SLUG, name: "Acme" },
      { id: "ws-2", slug: OTHER_SLUG, name: "Other workspace" },
    ])),
    http.get("/api/me/companion/installations", () => HttpResponse.json([
      { installation_id: "inst-1", name: "Synthetic computer", revoked_at: null },
    ])),
    http.get("/api/workspaces/:slug/boards", () => HttpResponse.json([])),
    http.get("/api/workspaces/:slug/sessions/summary", () => HttpResponse.json(summary)),
    http.get("/api/workspaces/:slug/sessions", async ({ request, params }) => {
      const url = new URL(request.url);
      const changed = params.slug !== SLUG || url.searchParams.get("linked_only") === "true";
      const previousOriginal = attempts.filter((attempt) => attempt.scope === "original").length;
      const status = changed ? 200 : previousOriginal === 0 ? 403 : retryStatus;
      const attempt: Attempt = { scope: changed ? "changed" : "original", query: url.search, status, settled: false };
      attempts.push(attempt);
      activeHandlers += 1;
      try {
        if (changed) await changedScopeGate.promise;
        else if (previousOriginal > 0) await retryGate.promise;
        return status === 200
          ? HttpResponse.json({ items: [makeSession({
            id: changed ? "changed-session" : "recovered-session",
            workspace_id: params.slug === OTHER_SLUG ? "ws-2" : "ws-1",
            title: changed ? OTHER_TITLE : RECOVERED_TITLE,
          })], next_cursor: null })
          : HttpResponse.json({ detail: "Synthetic session list access denied" }, { status: 403 });
      } finally {
        attempt.settled = true;
        activeHandlers -= 1;
      }
    }),
    http.all("/api/*", ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && ["/api/auth/modes", "/api/me"].includes(path)) return;
      const entry = `${request.method} ${path}`;
      if (request.method !== "GET") writes.push(entry);
      unexpected.push(entry);
      return HttpResponse.json({ detail: "Outside the list retry fixture" }, { status: 400 });
    }),
  );
  const client = createTestQueryClient();
  const rendered = renderWithProviders(
    <Routes><Route path="/:slug/sessions" element={<><RouteControls /><MySessionsPage /></>} /></Routes>,
    { queryClient: client, routerProps: { initialEntries: [`/${SLUG}/sessions`] } },
  );
  return {
    client, attempts, unexpected, writes, retryGate, changedScopeGate,
    async settle() {
      await waitFor(() => {
        expect(activeHandlers).toBe(0);
        expect(client.isFetching()).toBe(0);
      });
    },
    async dispose() {
      // Release even on an assertion failure, then drain HTTP and Query before
      // unmounting: a pending interceptor must not outlive this jsdom fixture.
      retryGate.release();
      changedScopeGate.release();
      try {
        await waitFor(() => {
          expect(activeHandlers).toBe(0);
          expect(client.isFetching()).toBe(0);
        });
      } finally {
        rendered.unmount();
        client.clear();
      }
    },
  };
}

type ListFixture = ReturnType<typeof mountList>;

function assertNoPrivateRows(fixture: ListFixture) {
  expect(screen.queryByText(RECOVERED_TITLE)).not.toBeInTheDocument();
  expect(screen.queryByText(OTHER_TITLE)).not.toBeInTheDocument();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
}

async function startKeyboardRetry(fixture: ListFixture) {
  const retry = await screen.findByRole("button", { name: retryName });
  await waitFor(() => expect(screen.getByText(denialCopy)).toBeVisible());
  expect(fixture.attempts).toHaveLength(1);
  for (let step = 0; step < 64 && document.activeElement !== retry; step += 1) await userEvent.tab();
  expect(retry).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(fixture.attempts).toHaveLength(2));
  expect(fixture.attempts[1]?.settled).toBe(false);
  // Observe the actual pending render, whether it keeps the existing busy
  // action or takes the baseline's incorrect skeleton/unmount branch.
  await waitFor(() => expect(!retry.isConnected || retry.getAttribute("aria-busy") === "true").toBe(true));
  return retry;
}

describe("My sessions first-load denial retry", () => {
  it("keeps a keyboard retry focused while offline and resumes the same attempt on reconnect", async () => {
    const fixture = mountList(403);
    try {
      const retry = await screen.findByRole("button", { name: retryName });
      await fixture.settle();
      act(() => onlineManager.setOnline(false));
      retry.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(fixture.client.getQueryCache().getAll()
        .some((query) => query.state.fetchStatus === "paused")).toBe(true));
      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toHaveAttribute("aria-disabled", "true");
      expect(retry).not.toBeDisabled();
      await userEvent.keyboard("{Enter} ");
      expect(fixture.attempts).toHaveLength(1);
      act(() => onlineManager.setOnline(true));
      await waitFor(() => expect(fixture.attempts).toHaveLength(2));
      expect(retry).toHaveFocus();
      fixture.retryGate.release();
      await fixture.settle();
      expect(await screen.findByRole("button", { name: retryName })).toBe(retry);
      expect(retry).toHaveFocus();
      expect(retry).not.toHaveAttribute("aria-busy", "true");
      assertNoPrivateRows(fixture);
    } finally {
      act(() => onlineManager.setOnline(true));
      await fixture.dispose();
    }
  });

  it("retains keyboard focus and the busy action through a held retry and repeated 403", async () => {
    const fixture = mountList(403);
    try {
      const retry = await startKeyboardRetry(fixture);
      expect.soft(retry).toBeInTheDocument();
      expect.soft(retry).toHaveFocus();
      expect.soft(retry).toHaveAttribute("aria-busy", "true");
      expect.soft(retry).toHaveAttribute("aria-disabled", "true");
      expect.soft(retry).not.toBeDisabled();
      assertNoPrivateRows(fixture);
      await userEvent.keyboard("{Enter} ");
      expect(fixture.attempts).toHaveLength(2);
      expect(fixture.attempts[1]?.query).toBe(fixture.attempts[0]?.query);
      fixture.retryGate.release();
      await fixture.settle();
      const settledRetry = await screen.findByRole("button", { name: retryName });
      expect.soft(settledRetry).toBe(retry);
      expect.soft(settledRetry).toHaveFocus();
      expect(settledRetry).not.toHaveAttribute("aria-busy", "true");
      expect(settledRetry).not.toHaveAttribute("aria-disabled", "true");
      await waitFor(() => expect(screen.getByText(denialCopy)).toBeVisible());
      expect(fixture.attempts.map(({ status, settled }) => ({ status, settled }))).toEqual([
        { status: 403, settled: true }, { status: 403, settled: true },
      ]);
      assertNoPrivateRows(fixture);
    } finally { await fixture.dispose(); }
  });

  it("shows results only after the deliberate held retry succeeds", async () => {
    const fixture = mountList(200);
    try {
      await startKeyboardRetry(fixture);
      assertNoPrivateRows(fixture);
      fixture.retryGate.release();
      expect(await screen.findByRole("link", { name: RECOVERED_TITLE })).toHaveAttribute("href", `/${SLUG}/sessions/recovered-session`);
      await fixture.settle();
      expect(screen.queryByText(denialCopy)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: retryName })).not.toBeInTheDocument();
      expect(screen.queryByTestId("sessions-skeleton")).not.toBeInTheDocument();
      // The focused Retry is gone; keyboard focus lands on the page heading, not the body.
      expect(screen.getByRole("heading", { level: 1, name: en.sessions.title })).toHaveFocus();
      expect(fixture.attempts.map(({ status }) => status)).toEqual([403, 200]);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.writes).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  it("keeps focus on Search when the viewer moved there before the held retry succeeds", async () => {
    const fixture = mountList(200);
    try {
      await startKeyboardRetry(fixture);
      const search = screen.getByRole("searchbox", { name: en.sessions.filters.search });
      for (let step = 0; step < 64 && document.activeElement !== search; step += 1) await userEvent.tab({ shift: true });
      expect(search).toHaveFocus();
      fixture.retryGate.release();
      expect(await screen.findByRole("link", { name: RECOVERED_TITLE })).toBeInTheDocument();
      await fixture.settle();
      expect(screen.queryByRole("button", { name: retryName })).not.toBeInTheDocument();
      expect(search).toHaveFocus();
      expect(fixture.attempts.map(({ status }) => status)).toEqual([403, 200]);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.writes).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  it.each(["workspace", "filter"] as const)("does not retain the prior denial or busy action after a %s change", async (change) => {
    const fixture = mountList(403);
    try {
      await startKeyboardRetry(fixture);
      const changeControl = change === "workspace"
        ? screen.getByRole("link", { name: "Open other workspace" })
        : screen.getByRole("switch", { name: "Linked work only" });
      await userEvent.click(changeControl);
      await waitFor(() => expect(fixture.attempts.filter(({ scope }) => scope === "changed")).toHaveLength(1));
      expect(screen.getByTestId("list-location")).toHaveTextContent(change === "workspace" ? `/${OTHER_SLUG}/sessions` : "linked=1");
      expect(screen.getByTestId("sessions-skeleton")).toBeInTheDocument();
      expect(screen.queryByText(denialCopy)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: retryName })).not.toBeInTheDocument();
      assertNoPrivateRows(fixture);
      fixture.retryGate.release();
      await waitFor(() => expect(fixture.attempts[1]?.settled).toBe(true));
      // The new query is still held when the old query's denial arrives.
      expect(fixture.attempts[2]?.settled).toBe(false);
      expect(screen.queryByText(denialCopy)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: retryName })).not.toBeInTheDocument();
      fixture.changedScopeGate.release();
      expect(await screen.findByRole("link", { name: OTHER_TITLE })).toHaveAttribute("href", `/${change === "workspace" ? OTHER_SLUG : SLUG}/sessions/changed-session`);
      await fixture.settle();
      expect(screen.queryByText(denialCopy)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: retryName })).not.toBeInTheDocument();
      expect(screen.queryByTestId("sessions-skeleton")).not.toBeInTheDocument();
      expect(changeControl).toHaveFocus();
      expect(fixture.attempts.map(({ scope, status }) => ({ scope, status }))).toEqual([
        { scope: "original", status: 403 }, { scope: "original", status: 403 }, { scope: "changed", status: 200 },
      ]);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.writes).toEqual([]);
    } finally { await fixture.dispose(); }
  });
});


describe("My sessions retry scope includes a locally filtered agent family", () => {
  it("drops a held history-probe failure when Codex changes the view without changing the server list query", async () => {
    const retryGate = gate();
    const requests: { kind: "main" | "root-probe" | "any-probe"; query: string; settled: boolean }[] = [];
    const unexpected: string[] = [];
    const writes: string[] = [];
    let activeHandlers = 0;
    const client = createTestQueryClient();
    stubAuthModes(true);
    server.use(
      http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
      http.get("/api/me/companion/installations", () => HttpResponse.json([
        { installation_id: "inst-1", name: "Synthetic computer", revoked_at: null },
      ])),
      http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
      http.get(`/api/workspaces/${SLUG}/sessions/summary`, () => HttpResponse.json({
        session_count: 0, live_count: 0, wall_duration_seconds: 0,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
        cache_creation_tokens: 0, reasoning_tokens: 0,
        cost_api_equivalent_usd: null, cost_spend_usd: null, cost_complete: true,
      } satisfies SessionPeriodSummary)),
      http.get(`/api/workspaces/${SLUG}/sessions`, async ({ request }) => {
        const url = new URL(request.url);
        const kind = url.searchParams.has("since") ? "main"
          : url.searchParams.get("root_only") === "true" ? "root-probe" : "any-probe";
        const previousProbes = requests.filter((entry) => entry.kind === "any-probe").length;
        const entry: (typeof requests)[number] = { kind, query: url.search, settled: false };
        requests.push(entry);
        activeHandlers += 1;
        try {
          if (kind === "any-probe" && previousProbes > 0) await retryGate.promise;
          return kind === "any-probe"
            ? HttpResponse.json({ detail: "Synthetic history probe access denied" }, { status: 403 })
            : HttpResponse.json({ items: [], next_cursor: null });
        } finally {
          entry.settled = true;
          activeHandlers -= 1;
        }
      }),
      http.all("/api/*", ({ request }) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && ["/api/auth/modes", "/api/me"].includes(path)) return;
        const entry = `${request.method} ${path}`;
        if (request.method !== "GET") writes.push(entry);
        unexpected.push(entry);
        return HttpResponse.json({ detail: "Outside the local-family fixture" }, { status: 400 });
      }),
    );
    const rendered = renderWithProviders(
      <Routes><Route path="/:slug/sessions" element={<><RouteControls /><MySessionsPage /></>} /></Routes>,
      { queryClient: client, routerProps: { initialEntries: [`/${SLUG}/sessions`] } },
    );
    try {
      const retry = await screen.findByRole("button", { name: retryName });
      await waitFor(() => expect(screen.getByText(denialCopy)).toBeVisible());
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect(requests.filter(({ kind }) => kind === "main")).toHaveLength(1);
      expect(requests.filter(({ kind }) => kind === "root-probe")).toHaveLength(1);
      expect(requests.filter(({ kind }) => kind === "any-probe")).toHaveLength(1);
      expect(requests.every(({ settled }) => settled)).toBe(true);
      for (let step = 0; step < 64 && document.activeElement !== retry; step += 1) await userEvent.tab();
      expect(retry).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(requests.filter(({ kind }) => kind === "any-probe")).toHaveLength(2));
      await waitFor(() => expect(retry).toHaveAttribute("aria-busy", "true"));
      expect(retry).toHaveFocus();
      expect(requests.filter(({ kind, settled }) => kind === "any-probe" && !settled)).toHaveLength(1);

      await userEvent.click(screen.getByRole("button", { name: "Only Codex" }));
      expect(screen.getByRole("button", { name: "Only Codex" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("list-location")).toHaveTextContent("agent=codex");
      // Preserve the late-response control even if the held-state assertion
      // fails: this is a real local-family change, not a fresh server query.
      await expect.soft(waitFor(() => { expect(screen.getByRole("heading", { name: en.sessions.noMatch.title })).toBeVisible(); })).resolves.toBeUndefined();
      expect.soft(screen.queryByText(denialCopy)).not.toBeInTheDocument();
      expect.soft(screen.queryByRole("button", { name: retryName })).not.toBeInTheDocument();
      expect(requests.filter(({ kind }) => kind === "main")).toHaveLength(1);
      expect(requests.filter(({ kind, settled }) => kind === "any-probe" && !settled)).toHaveLength(1);
      expect(requests.every(({ query }) => !new URLSearchParams(query).has("harness"))).toBe(true);

      retryGate.release();
      await waitFor(() => {
        expect(activeHandlers).toBe(0);
        expect(client.isFetching()).toBe(0);
      });
      await waitFor(() => expect(screen.getByRole("heading", { name: en.sessions.noMatch.title })).toBeVisible());
      expect(screen.queryByText(denialCopy)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: retryName })).not.toBeInTheDocument();
      expect(screen.queryByTestId("sessions-skeleton")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Only Codex" })).toHaveAttribute("aria-pressed", "true");
      expect(requests.filter(({ kind }) => kind === "main")).toHaveLength(1);
      expect(requests.filter(({ kind }) => kind === "root-probe")).toHaveLength(1);
      const probes = requests.filter(({ kind }) => kind === "any-probe");
      expect(probes).toHaveLength(2);
      expect(probes[1]?.query).toBe(probes[0]?.query);
      expect(requests.every(({ settled }) => settled)).toBe(true);
      expect(unexpected).toEqual([]);
      expect(writes).toEqual([]);
    } finally {
      retryGate.release();
      try {
        await waitFor(() => {
          expect(activeHandlers).toBe(0);
          expect(client.isFetching()).toBe(0);
        });
      } finally {
        rendered.unmount();
        client.clear();
      }
    }
  });
});


describe("My sessions Retry ignores a no-longer-relevant roots probe", () => {
  it("settles the current all-session retry while the disabled roots-only probe is still held", async () => {
    const rootGate = gate();
    const retryGate = gate();
    const requests: { kind: "main" | "root-probe" | "any-probe"; query: string; settled: boolean }[] = [];
    const unexpected: string[] = [];
    const writes: string[] = [];
    let holdCurrentRetry = false;
    let activeHandlers = 0;
    const client = createTestQueryClient();
    stubAuthModes(true);
    server.use(
      http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
      http.get("/api/me/companion/installations", () => HttpResponse.json([
        { installation_id: "inst-1", name: "Synthetic computer", revoked_at: null },
      ])),
      http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
      http.get(`/api/workspaces/${SLUG}/sessions/summary`, () => HttpResponse.json({
        session_count: 0, live_count: 0, wall_duration_seconds: 0,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
        cache_creation_tokens: 0, reasoning_tokens: 0,
        cost_api_equivalent_usd: null, cost_spend_usd: null, cost_complete: true,
      } satisfies SessionPeriodSummary)),
      http.get(`/api/workspaces/${SLUG}/sessions`, async ({ request }) => {
        const url = new URL(request.url);
        const kind = url.searchParams.has("since") ? "main"
          : url.searchParams.get("root_only") === "true" ? "root-probe" : "any-probe";
        const entry: (typeof requests)[number] = { kind, query: url.search, settled: false };
        requests.push(entry);
        activeHandlers += 1;
        try {
          if (kind === "root-probe") await rootGate.promise;
          if (kind === "any-probe" && holdCurrentRetry) await retryGate.promise;
          return kind === "any-probe"
            ? HttpResponse.json({ detail: "Synthetic all-session history denied" }, { status: 403 })
            : HttpResponse.json({ items: [], next_cursor: null });
        } finally {
          entry.settled = true;
          activeHandlers -= 1;
        }
      }),
      http.all("/api/*", ({ request }) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && ["/api/auth/modes", "/api/me"].includes(path)) return;
        const entry = `${request.method} ${path}`;
        if (request.method !== "GET") writes.push(entry);
        unexpected.push(entry);
        return HttpResponse.json({ detail: "Outside the roots relevance fixture" }, { status: 400 });
      }),
    );
    const rendered = renderWithProviders(
      <Routes><Route path="/:slug/sessions" element={<><RouteControls /><MySessionsPage /></>} /></Routes>,
      { queryClient: client, routerProps: { initialEntries: [`/${SLUG}/sessions`] } },
    );
    try {
      await waitFor(() => {
        expect(requests.filter(({ kind }) => kind === "root-probe")).toHaveLength(1);
        expect(requests.some(({ kind, settled }) => kind === "any-probe" && settled)).toBe(true);
        expect(client.isFetching()).toBe(1);
      });
      expect(requests.filter(({ kind, settled }) => kind === "root-probe" && !settled)).toHaveLength(1);
      expect(screen.getByTestId("sessions-skeleton")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("switch", { name: "Show subagents" }));
      expect(screen.getByRole("switch", { name: "Show subagents" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("list-location")).toHaveTextContent("subagents=1");
      const retry = await screen.findByRole("button", { name: retryName });
      await waitFor(() => expect(screen.getByText(denialCopy)).toBeVisible());
      // Re-enabling the any-session probe may refetch it normally. Drain that
      // real work before arming the one explicit retry; only the old root waits.
      await waitFor(() => {
        expect(client.isFetching()).toBe(1);
        expect(requests.filter(({ settled }) => !settled).map(({ kind }) => kind)).toEqual(["root-probe"]);
      });
      const mainRequests = requests.filter(({ kind }) => kind === "main");
      expect(mainRequests).toHaveLength(2);
      expect(mainRequests.map(({ query }) => new URLSearchParams(query).get("root_only"))).toEqual(["true", "false"]);
      expect(retry).not.toHaveAttribute("aria-busy", "true");
      const probesBeforeRetry = requests.filter(({ kind }) => kind === "any-probe").length;
      holdCurrentRetry = true;
      for (let step = 0; step < 64 && document.activeElement !== retry; step += 1) await userEvent.tab();
      expect(retry).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(requests.filter(({ kind }) => kind === "any-probe")).toHaveLength(probesBeforeRetry + 1));
      await waitFor(() => expect(retry).toHaveAttribute("aria-busy", "true"));
      expect(requests.filter(({ settled }) => !settled).map(({ kind }) => kind).sort()).toEqual(["any-probe", "root-probe"]);
      expect(retry).toHaveFocus();

      retryGate.release();
      await waitFor(() => {
        expect(client.isFetching()).toBe(1);
        expect(requests.filter(({ settled }) => !settled).map(({ kind }) => kind)).toEqual(["root-probe"]);
      });
      await expect.soft(waitFor(() => { expect(retry).not.toHaveAttribute("aria-busy", "true"); })).resolves.toBeUndefined();
      expect.soft(retry).not.toHaveAttribute("aria-disabled", "true");
      expect(retry).not.toBeDisabled();
      expect(screen.getByRole("button", { name: retryName })).toBe(retry);
      await waitFor(() => expect(screen.getByText(denialCopy)).toBeVisible());
      expect(screen.queryByTestId("sessions-skeleton")).not.toBeInTheDocument();
      expect(requests.filter(({ kind }) => kind === "root-probe")).toHaveLength(1);
      expect(requests.filter(({ kind }) => kind === "main")).toHaveLength(2);
      expect(requests.filter(({ kind }) => kind === "any-probe")).toHaveLength(probesBeforeRetry + 1);

      rootGate.release();
      await waitFor(() => {
        expect(activeHandlers).toBe(0);
        expect(client.isFetching()).toBe(0);
        expect(retry).not.toHaveAttribute("aria-busy", "true");
      });
      expect(retry).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("button", { name: retryName })).toBe(retry);
      expect(screen.getByText(denialCopy)).toBeVisible();
      expect(screen.queryByRole("heading", { name: en.sessions.noMatch.title })).not.toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Show subagents" })).toHaveAttribute("aria-checked", "true");
      expect(requests.every(({ settled }) => settled)).toBe(true);
      expect(requests.filter(({ kind }) => kind === "root-probe")).toHaveLength(1);
      expect(requests.filter(({ kind }) => kind === "main")).toHaveLength(2);
      expect(requests.filter(({ kind }) => kind === "any-probe")).toHaveLength(probesBeforeRetry + 1);
      expect(unexpected).toEqual([]);
      expect(writes).toEqual([]);
    } finally {
      rootGate.release();
      retryGate.release();
      try {
        await waitFor(() => {
          expect(activeHandlers).toBe(0);
          expect(client.isFetching()).toBe(0);
        });
      } finally {
        rendered.unmount();
        client.clear();
      }
    }
  });
});
