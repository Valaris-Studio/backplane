// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { http, HttpResponse, server } from "@/test/msw-server";
import {
  useConnectionRepositories,
  useCreatePatConnection,
  useDeleteGitConnection,
  useGitConnections,
  useVerifyGitConnection,
} from "../use-git-connections";
import { gitConnectionKeys } from "@/lib/query-keys";
import { isApiError } from "@/lib/api-error";
import type { GitConnection, GitConnectionRepositoryPage } from "@/types/git";

const SLUG = "acme";
const CONNECTION_ID = "conn-1";

function makeConnection(overrides: Partial<GitConnection> = {}): GitConnection {
  return {
    id: CONNECTION_ID,
    workspace_id: "ws-1",
    provider: "github",
    account_login: "octocat",
    account_type: "user",
    auth_kind: "oauth",
    scopes: ["repo", "workflow"],
    expires_at: null,
    base_url: null,
    last_verified_at: null,
    last_error: null,
    scopes_confirmed: null,
    connected_by: "user-1",
    created_at: "2026-04-20T00:00:00Z",
    updated_at: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

function makePage(
  items: GitConnectionRepositoryPage["items"],
  next: string | null = null,
): GitConnectionRepositoryPage {
  return { items, next_cursor: next };
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return { client, Wrapper };
}

describe("useGitConnections", () => {
  it("returns the parsed list from the API", async () => {
    const connection = makeConnection();
    server.use(
      http.get(`/api/workspaces/${SLUG}/git-connections`, () =>
        HttpResponse.json([connection]),
      ),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useGitConnections(SLUG), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.account_login).toBe("octocat");
    expect(result.current.data?.[0]).not.toHaveProperty("token");
    expect(result.current.data?.[0]).not.toHaveProperty("access_token");
  });
});

describe("useDeleteGitConnection", () => {
  it("invalidates the connections list query on success", async () => {
    server.use(
      http.get(`/api/workspaces/${SLUG}/git-connections`, () =>
        HttpResponse.json([makeConnection()]),
      ),
      http.delete(
        `/api/workspaces/${SLUG}/git-connections/${CONNECTION_ID}`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const { client, Wrapper } = createWrapper();

    // Prime the list query so we can observe the post-delete invalidation.
    await client.fetchQuery({
      queryKey: gitConnectionKeys.list(SLUG),
      queryFn: async () => [makeConnection()],
    });

    const { result } = renderHook(() => useDeleteGitConnection(SLUG), {
      wrapper: Wrapper,
    });

    await result.current.mutateAsync(CONNECTION_ID);

    const cached = client.getQueryState(gitConnectionKeys.list(SLUG));
    expect(cached?.isInvalidated).toBe(true);
  });
});

describe("useCreatePatConnection", () => {
  it("posts the token and invalidates the list on success", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`/api/workspaces/${SLUG}/git-connections`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          makeConnection({ auth_kind: "pat", account_login: "deploy-bot" }),
          { status: 201 },
        );
      }),
    );
    const { client, Wrapper } = createWrapper();
    await client.fetchQuery({
      queryKey: gitConnectionKeys.list(SLUG),
      queryFn: async () => [],
    });

    const { result } = renderHook(() => useCreatePatConnection(SLUG), {
      wrapper: Wrapper,
    });

    const { connection, created } = await result.current.mutateAsync({
      provider: "github",
      token: "ghp_secret",
    });

    expect(bodies[0]).toEqual({ provider: "github", token: "ghp_secret" });
    expect(connection.auth_kind).toBe("pat");
    expect(connection.account_login).toBe("deploy-bot");
    expect(created).toBe(true);
    expect(
      client.getQueryState(gitConnectionKeys.list(SLUG))?.isInvalidated,
    ).toBe(true);
  });

  it("sends base_url when the provider is self-hosted", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`/api/workspaces/${SLUG}/git-connections`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          makeConnection({ provider: "gitea", base_url: "https://git.acme.dev" }),
          { status: 201 },
        );
      }),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCreatePatConnection(SLUG), {
      wrapper: Wrapper,
    });
    await result.current.mutateAsync({
      provider: "gitea",
      token: "gt_secret",
      base_url: "https://git.acme.dev",
    });

    expect(bodies[0]).toEqual({
      provider: "gitea",
      token: "gt_secret",
      base_url: "https://git.acme.dev",
    });
  });

  it("surfaces the 422 detail so the dialog can show it verbatim", async () => {
    server.use(
      http.post(`/api/workspaces/${SLUG}/git-connections`, () =>
        HttpResponse.json(
          { detail: "GitHub rejected this token (401). Check it has not expired." },
          { status: 422 },
        ),
      ),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useCreatePatConnection(SLUG), {
      wrapper: Wrapper,
    });

    await expect(
      result.current.mutateAsync({ provider: "github", token: "bad" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isApiError(err) &&
        err.status === 422 &&
        err.message.includes("GitHub rejected this token"),
    );
  });
});

describe("useVerifyGitConnection", () => {
  it("returns the checks list and refreshes the cached connections", async () => {
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/git-connections/${CONNECTION_ID}/verify`,
        () =>
          HttpResponse.json({
            connection: makeConnection({
              last_verified_at: "2026-08-09T10:00:00Z",
            }),
            checks: [
              { name: "identity", ok: true, guidance: "Authenticated as 'octocat'." },
              {
                name: "scope:repo",
                ok: false,
                guidance: "Missing 'repo' scope. Re-issue the token with it.",
              },
            ],
          }),
      ),
    );
    const { client, Wrapper } = createWrapper();
    await client.fetchQuery({
      queryKey: gitConnectionKeys.list(SLUG),
      queryFn: async () => [makeConnection()],
    });

    const { result } = renderHook(() => useVerifyGitConnection(SLUG), {
      wrapper: Wrapper,
    });

    const verdict = await result.current.mutateAsync(CONNECTION_ID);

    expect(verdict.checks).toHaveLength(2);
    expect(verdict.checks[1]?.ok).toBe(false);
    expect(verdict.connection.last_verified_at).toBe("2026-08-09T10:00:00Z");
    expect(
      client.getQueryState(gitConnectionKeys.list(SLUG))?.isInvalidated,
    ).toBe(true);
  });

  it("treats an unhealthy 200 as data, never as a rejection", async () => {
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/git-connections/${CONNECTION_ID}/verify`,
        () =>
          HttpResponse.json({
            connection: makeConnection({ last_error: "token expired" }),
            checks: [
              { name: "identity", ok: false, guidance: "token expired" },
            ],
          }),
      ),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useVerifyGitConnection(SLUG), {
      wrapper: Wrapper,
    });

    const verdict = await result.current.mutateAsync(CONNECTION_ID);
    expect(verdict.connection.last_error).toBe("token expired");
    expect(verdict.checks.every((c) => c.ok)).toBe(false);
  });
});

describe("useConnectionRepositories pagination", () => {
  it("flattens multiple pages and stops when next_cursor is null", async () => {
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/git-connections/${CONNECTION_ID}/repositories`,
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor");
          if (!cursor) {
            return HttpResponse.json(
              makePage(
                [
                  {
                    provider: "github",
                    id: "octocat/widgets",
                    full_name: "octocat/widgets",
                    default_branch: "main",
                    private: false,
                    clone_url_https: "https://github.com/octocat/widgets.git",
                    updated_at: "2026-04-20T00:00:00Z",
                  },
                ],
                "page-2",
              ),
            );
          }
          return HttpResponse.json(
            makePage([
              {
                provider: "github",
                id: "octocat/gadgets",
                full_name: "octocat/gadgets",
                default_branch: "trunk",
                private: true,
                clone_url_https: "https://github.com/octocat/gadgets.git",
                updated_at: "2026-04-21T00:00:00Z",
              },
            ]),
          );
        },
      ),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useConnectionRepositories(SLUG, CONNECTION_ID),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    expect(result.current.data?.pages[0]?.items[0]?.id).toBe("octocat/widgets");

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(false));

    expect(result.current.data?.pages).toHaveLength(2);
    expect(result.current.hasNextPage).toBe(false);
    const allIds = result.current.data?.pages.flatMap((p) =>
      p.items.map((i) => i.id),
    );
    expect(allIds).toEqual(["octocat/widgets", "octocat/gadgets"]);
  });
});
