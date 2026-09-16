// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders, screen, act, userEvent } from "@/test/test-utils";
import { App } from "@/App";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { shouldRetry } from "@/lib/should-retry";
import { workspaceKeys } from "@/lib/query-keys";

// A bad workspace slug used to mount the whole dashboard: every child query
// fired against a workspace the caller cannot see, each 404'd, and shouldRetry
// re-issued it. WorkspaceLayout resolves the workspace FIRST and renders one
// of three things — fallback, NotFound, or the child route.

// The production QueryClient retries via shouldRetry; the shared test client
// hardcodes retry:false, which would mask the whole point of putting
// `retry: false` on the workspace query. Build a client that matches main.tsx.
function createProductionLikeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

const SETTLED_BOOTSTRAP = new Set(["/auth/setup-status", "/auth/modes"]);

// Account-level chrome traffic: identical on every route, good slug or bad,
// and carrying no workspace slug. Not what the gate is about — the gate's job
// is that NOTHING scoped to an unresolved workspace goes out.
const ACCOUNT_SCOPED = new Set([
  "/me",
  "/me/api-keys",
  "/notifications",
  "/notifications/unread-count",
]);

// Every request naming the workspace beyond the single resolve call. This is
// the number the gate drives to zero.
function workspaceScopedCalls(urls: string[], slug: string) {
  return urls.filter(
    (url) =>
      !SETTLED_BOOTSTRAP.has(url) &&
      !ACCOUNT_SCOPED.has(url) &&
      url !== `/workspaces/${slug}`,
  );
}

// Every request the app makes goes through `api`, so spying here is a COMPLETE
// request log — a per-endpoint msw handler would silently miss a stray fan-out.
function mockApi(resolveWorkspace: (slug: string) => Promise<unknown>) {
  const requestedUrls: string[] = [];
  vi.spyOn(api, "get").mockImplementation(((url: string) => {
    requestedUrls.push(url);
    if (SETTLED_BOOTSTRAP.has(url)) {
      return Promise.resolve({ data: { needs_setup: false, modes: [] } });
    }
    const workspaceDetail = /^\/workspaces\/([^/]+)$/.exec(url);
    if (workspaceDetail) return resolveWorkspace(workspaceDetail[1]!);
    // Account-level chrome endpoints have object shapes; a bare [] makes their
    // select() return undefined, which React Query reports as a console error
    // and would masquerade as the very defect this suite pins.
    if (url === "/notifications/unread-count") {
      return Promise.resolve({ data: { count: 0 } });
    }
    if (url === "/me") return Promise.resolve({ data: { email: "dev@valaris.dev" } });
    return Promise.resolve({ data: [] });
  }) as never);
  return requestedUrls;
}

async function flushRouteChunks() {
  // Long enough for the lazy page chunks to resolve — the window in which an
  // ungated child would mount and fan out its queries.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
}

describe("App workspace slug gate", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("costs exactly one request and mounts no child page on an unknown slug", async () => {
    const requestedUrls = mockApi(() =>
      Promise.reject(new ApiError("Workspace 'ghost' not found", 404)),
    );

    renderWithProviders(<App />, {
      routerProps: { initialEntries: ["/ghost"] },
      queryClient: createProductionLikeQueryClient(),
    });

    expect(await screen.findByTestId("workspace-not-found")).toBeInTheDocument();
    await flushRouteChunks();

    const workspaceCalls = requestedUrls.filter((url) => url === "/workspaces/ghost");
    expect(workspaceCalls).toHaveLength(1);

    // Zero workspace-scoped traffic: no child page and no chrome badge may
    // query a workspace the gate has not confirmed exists.
    expect(workspaceScopedCalls(requestedUrls, "ghost")).toEqual([]);
    expect(requestedUrls).not.toContain("/workspaces/ghost/approvals");
    expect(requestedUrls).not.toContain("/workspaces/ghost/members");
  });

  it("renders the unknown-slug surface without a single console error", async () => {
    mockApi(() => Promise.reject(new ApiError("not found", 404)));

    renderWithProviders(<App />, {
      routerProps: { initialEntries: ["/ghost"] },
      queryClient: createProductionLikeQueryClient(),
    });

    expect(await screen.findByTestId("workspace-not-found")).toBeInTheDocument();
    await flushRouteChunks();

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("offers a link back to the workspace list and navigates there", async () => {
    const user = userEvent.setup();
    mockApi(() => Promise.reject(new ApiError("not found", 404)));

    renderWithProviders(<App />, {
      routerProps: { initialEntries: ["/ghost"] },
      queryClient: createProductionLikeQueryClient(),
    });

    const backLink = await screen.findByRole("link", {
      name: /all workspaces/i,
    });
    expect(backLink).toHaveAttribute("href", "/");

    await user.click(backLink);
    // The workspace list is the "/" route; its heading proves we landed.
    expect(
      await screen.findByRole("heading", { name: /workspaces/i }),
    ).toBeInTheDocument();
  });

  it("shows the same surface on a 403 so membership is not disclosed", async () => {
    mockApi(() => Promise.reject(new ApiError("forbidden", 403)));

    renderWithProviders(<App />, {
      routerProps: { initialEntries: ["/secret"] },
      queryClient: createProductionLikeQueryClient(),
    });

    expect(await screen.findByTestId("workspace-not-found")).toBeInTheDocument();
    // The copy must not distinguish 403 from 404 — same node, same words.
    expect(screen.queryByText(/forbidden|permission|not a member/i)).toBeNull();
  });

  it("holds children on the route fallback while the workspace is pending", async () => {
    const requestedUrls = mockApi(() => new Promise(() => {}));

    renderWithProviders(<App />, {
      routerProps: { initialEntries: ["/pending-ws"] },
      queryClient: createProductionLikeQueryClient(),
    });

    expect(await screen.findByRole("status")).toBeInTheDocument();
    await flushRouteChunks();

    expect(screen.queryByTestId("workspace-not-found")).toBeNull();
    expect(workspaceScopedCalls(requestedUrls, "pending-ws")).toEqual([]);
  });

  it("mounts the child route unchanged once a good slug resolves", async () => {
    const requestedUrls = mockApi((slug) =>
      Promise.resolve({
        data: {
          id: "ws-1",
          name: "Acme",
          slug,
          created_by: "u1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      }),
    );

    renderWithProviders(<App />, {
      routerProps: { initialEntries: ["/acme"] },
      queryClient: createProductionLikeQueryClient(),
    });

    await flushRouteChunks();

    expect(screen.queryByTestId("workspace-not-found")).toBeNull();
    // The Dashboard mounting is what proves passthrough: it fans out queries
    // the gate would otherwise have suppressed.
    expect(
      requestedUrls.some(
        (url) => url.startsWith("/workspaces/acme/") || url.startsWith("/boards/acme"),
      ),
    ).toBe(true);
  });

  it("keys the gate per slug, so the workspace LIST cannot vouch for a slug", async () => {
    // Both this query and useWorkspaces() live under ["workspaces"]. If the
    // gate reused the LIST's key instead of a per-slug one, visiting "/" would
    // pre-seed its cache with an array, the gate would read that truthy value
    // as "this workspace resolved", and a bad slug would sail straight through
    // into the dashboard — the exact bug this card removes.
    const requestedUrls = mockApi(() =>
      Promise.reject(new ApiError("not found", 404)),
    );

    // One client, and the list stays warm: gcTime keeps ["workspaces"] alive
    // across the navigation, which is what makes the collision observable.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: shouldRetry, gcTime: Infinity },
        mutations: { retry: false },
      },
    });

    // Seed the LIST exactly as a visit to "/" would.
    queryClient.setQueryData(workspaceKeys.all, [
      { id: "ws-1", name: "Acme", slug: "acme" },
    ]);

    renderWithProviders(<App />, {
      routerProps: { initialEntries: ["/ghost"] },
      queryClient,
    });

    expect(await screen.findByTestId("workspace-not-found")).toBeInTheDocument();
    // The gate genuinely ASKED rather than trusting the warm list...
    expect(requestedUrls).toContain("/workspaces/ghost");
    // ...and never briefly published "resolved" off the list's truthy array.
    // A shared key makes the chrome badges fire against the bad slug for the
    // tick before the refetch 404s — page output looks identical, so only the
    // request log can see it.
    expect(workspaceScopedCalls(requestedUrls, "ghost")).toEqual([]);
  });

  it("keeps the static /documentation route out of the slug gate", async () => {
    const requestedUrls = mockApi(() => {
      throw new Error("the workspace gate must not run on /documentation");
    });

    renderWithProviders(<App />, {
      routerProps: { initialEntries: ["/documentation"] },
      queryClient: createProductionLikeQueryClient(),
    });

    await flushRouteChunks();

    expect(
      requestedUrls.some((url) => /^\/workspaces\/[^/]+$/.test(url)),
    ).toBe(false);
  });
});
