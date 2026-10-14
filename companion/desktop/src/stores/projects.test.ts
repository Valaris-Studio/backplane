// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardsOverview, CompanionStatus, ProjectsOverview } from "../ipc/bindings";
import { fixtureStatus, mockDaemonIpc } from "../test/daemon-ipc";
import { applyStreamMessage, startDaemonStream, statusStore } from "./daemon-stream";
import { boardLinkFor, boardLinkForSession, boardOfSession, projectsStore, useBoardsCatalog, useDiscovered, useIgnored, useMappings } from "./projects";

const CATALOG: BoardsOverview = {
  workspaces: [
    {
      id: "ws-1",
      slug: "acme",
      name: "Acme",
      boards: [
        { id: "board-1", name: "Platform", repos: ["github.com/acme/app"] },
        { id: "board-2", name: "Mobile", repos: ["github.com/acme/mobile", "github.com/acme/shared"] },
      ],
    },
    { id: "ws-2", slug: "labs", name: "Labs", boards: [{ id: "board-3", name: "Research", repos: ["github.com/acme/shared"] }] },
  ],
};

const MAPPING = { id: "map-1", workspace_id: "ws-1", board_id: "board-1", repo_url_normalized: "github.com/acme/app", enabled: true, content_level: "standard" };
const ROOT_MAPPING = { id: "map-2", workspace_id: "ws-1", board_id: "board-2", root_path: "/home/me/code/mobile", enabled: true, content_level: "metadata" };
const ORPHAN_MAPPING = { id: "map-3", workspace_id: "ws-gone", board_id: "board-gone", repo_url_normalized: "github.com/acme/gone", enabled: false };

const DISCOVERED = { root: "/home/me/code/tool", repo_url: "github.com/acme/tool", first_seen: "2026-09-28T09:00:00Z", reason: "not_bound", candidates: [] };

function overview(patch: Partial<ProjectsOverview> = {}): ProjectsOverview {
  return { mappings: [MAPPING, ROOT_MAPPING], discovered: [DISCOVERED], ignored: ["/home/me/code/secret"], ...patch };
}

function statusWith(account: CompanionStatus["account"], endpoint = "https://api.backplane.example"): CompanionStatus {
  return { ...fixtureStatus, account, endpoint } as CompanionStatus;
}

const ACCOUNT = { email: "jane@example.com", display_name: "Jane", web_origin: "https://app.backplane.example", device_name: "laptop" };

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function countOf(invoked: string[], command: string): number {
  return invoked.filter((name) => name === command).length;
}

describe("projects store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fetches the projects and the boards catalog when a consumer mounts", async () => {
    const daemon = mockDaemonIpc({ projects: () => overview(), boards: () => CATALOG });
    const { result } = renderHook(() => ({ mappings: useMappings(), discovered: useDiscovered(), ignored: useIgnored(), catalog: useBoardsCatalog() }));
    await settle();
    expect(countOf(daemon.invoked(), "projects")).toBe(1);
    expect(countOf(daemon.invoked(), "boards")).toBe(1);
    expect(result.current.discovered).toEqual([DISCOVERED]);
    expect(result.current.ignored).toEqual(["/home/me/code/secret"]);
    expect(result.current.catalog?.workspaces.map((workspace) => workspace.slug)).toEqual(["acme", "labs"]);
  });

  it("joins each mapping with its board name, workspace name and workspace slug", async () => {
    mockDaemonIpc({ projects: () => overview({ mappings: [MAPPING, ROOT_MAPPING, ORPHAN_MAPPING] }), boards: () => CATALOG });
    const { result } = renderHook(() => useMappings());
    await settle();
    expect(result.current).toEqual([
      expect.objectContaining({ id: "map-1", board_id: "board-1", board_name: "Platform", workspace_name: "Acme", workspace_slug: "acme" }),
      expect.objectContaining({ id: "map-2", board_name: "Mobile", workspace_name: "Acme", workspace_slug: "acme", root_path: "/home/me/code/mobile" }),
      expect.objectContaining({ id: "map-3", board_name: null, workspace_name: null, workspace_slug: null }),
    ]);
  });

  it("is empty, not loading forever, before anything arrives", () => {
    mockDaemonIpc({ projects: () => new Promise(() => {}), boards: () => new Promise(() => {}) });
    const { result } = renderHook(() => ({ mappings: useMappings(), discovered: useDiscovered(), ignored: useIgnored(), catalog: useBoardsCatalog() }));
    expect(result.current).toEqual({ mappings: [], discovered: [], ignored: [], catalog: null });
  });

  it("serves re-renders from the cache instead of refetching", async () => {
    const daemon = mockDaemonIpc({ projects: () => overview(), boards: () => CATALOG });
    const { rerender } = renderHook(() => useMappings());
    await settle();
    rerender();
    rerender();
    await settle();
    expect(countOf(daemon.invoked(), "boards")).toBe(1);
    expect(countOf(daemon.invoked(), "projects")).toBe(1);
  });

  it("collapses consumers mounting together into one catalog request", async () => {
    const daemon = mockDaemonIpc({ projects: () => overview(), boards: () => CATALOG });
    renderHook(() => ({ a: useMappings(), b: useBoardsCatalog(), c: useDiscovered() }));
    renderHook(() => useBoardsCatalog());
    await settle();
    expect(countOf(daemon.invoked(), "boards")).toBe(1);
  });

  it("takes the SSE projects event as the new overview", async () => {
    const daemon = mockDaemonIpc({ projects: () => overview(), boards: () => CATALOG });
    startDaemonStream();
    const { result } = renderHook(() => ({ discovered: useDiscovered(), ignored: useIgnored() }));
    await settle();
    act(() => daemon.emit({ type: "projects", data: overview({ discovered: [], ignored: [] }) }));
    expect(result.current).toEqual({ discovered: [], ignored: [] });
  });

  it("ignores a malformed projects event and keeps what it had", async () => {
    mockDaemonIpc({ projects: () => overview(), boards: () => CATALOG });
    const { result } = renderHook(() => useDiscovered());
    await settle();
    act(() => applyStreamMessage({ type: "projects", data: { mappings: "nope" } }));
    act(() => applyStreamMessage({ type: "projects", data: null }));
    expect(result.current).toEqual([DISCOVERED]);
  });

  it("refetches the catalog and the projects on policy.changed", async () => {
    let catalog = CATALOG;
    const daemon = mockDaemonIpc({ projects: () => overview(), boards: () => catalog });
    const { result } = renderHook(() => useMappings());
    await settle();
    catalog = { workspaces: [{ id: "ws-1", slug: "acme", name: "Acme Corp", boards: [{ id: "board-1", name: "Core", repos: [] }] }] };
    act(() => applyStreamMessage({ type: "policy.changed" }));
    await settle();
    expect(countOf(daemon.invoked(), "boards")).toBe(2);
    expect(countOf(daemon.invoked(), "projects")).toBe(2);
    expect(result.current[0]).toMatchObject({ board_name: "Core", workspace_name: "Acme Corp" });
  });

  it("keeps the last catalog when a refetch fails", async () => {
    let failing = false;
    mockDaemonIpc({
      projects: () => overview(),
      boards: () => {
        if (failing) throw { kind: "api", status: 502, code: "server_unreachable", message: "down", detail: null };
        return CATALOG;
      },
    });
    const { result } = renderHook(() => useBoardsCatalog());
    await settle();
    failing = true;
    act(() => applyStreamMessage({ type: "policy.changed" }));
    await settle();
    expect(result.current).toEqual(CATALOG);
  });

  it("stays empty without throwing when the daemon cannot list anything", async () => {
    mockDaemonIpc({
      projects: () => {
        throw { kind: "unreachable", reason: "socket_unavailable" };
      },
      boards: () => {
        throw { kind: "unreachable", reason: "socket_unavailable" };
      },
    });
    const { result } = renderHook(() => ({ mappings: useMappings(), catalog: useBoardsCatalog() }));
    await settle();
    expect(result.current).toEqual({ mappings: [], catalog: null });
  });
});

describe("account scoping", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ACCOUNT_B = { email: "bob@other.example", display_name: "Bob", web_origin: "https://b.example", device_name: null };
  const CATALOG_B: BoardsOverview = { workspaces: [{ id: "ws-1", slug: "bravo", name: "Bravo", boards: [{ id: "board-1", name: "B1", repos: [] }] }] };
  const statusOf = (installation: string, account: CompanionStatus["account"]) =>
    ({ ...statusWith(account), installation_id: installation }) as CompanionStatus;

  it("never joins one account's catalog with another account's origin", async () => {
    let catalog = CATALOG;
    const daemon = mockDaemonIpc({ projects: () => overview(), boards: () => catalog });
    applyStreamMessage({ type: "status", data: statusOf("inst-a", ACCOUNT) });
    renderHook(() => useMappings());
    await settle();
    expect(boardLinkFor(MAPPING)).toBe("https://app.backplane.example/acme/boards/board-1/kanban");
    catalog = CATALOG_B;
    act(() => applyStreamMessage({ type: "status", data: statusOf("inst-b", ACCOUNT_B) }));
    expect(boardLinkFor(MAPPING)).toBeNull();
    await settle();
    expect(countOf(daemon.invoked(), "boards")).toBe(2);
    expect(countOf(daemon.invoked(), "projects")).toBe(2);
    expect(boardLinkFor(MAPPING)).toBe("https://b.example/bravo/boards/board-1/kanban");
  });

  it("discards the old account's catalog when it answers after the switch", async () => {
    const answers: ((catalog: BoardsOverview) => void)[] = [];
    mockDaemonIpc({ projects: () => overview(), boards: () => new Promise<BoardsOverview>((resolve) => answers.push(resolve)) });
    applyStreamMessage({ type: "status", data: statusOf("inst-a", ACCOUNT) });
    renderHook(() => useBoardsCatalog());
    await settle();
    act(() => applyStreamMessage({ type: "status", data: statusOf("inst-b", ACCOUNT_B) }));
    answers[0]?.(CATALOG);
    await settle();
    expect(projectsStore.get().catalog).toBeNull();
    answers[1]?.(CATALOG_B);
    await settle();
    expect(projectsStore.get().catalog).toEqual(CATALOG_B);
  });

  it("keeps the cache across status updates of the same installation", async () => {
    const daemon = mockDaemonIpc({ projects: () => overview(), boards: () => CATALOG });
    applyStreamMessage({ type: "status", data: statusOf("inst-a", null) });
    renderHook(() => useMappings());
    await settle();
    act(() => applyStreamMessage({ type: "status", data: statusOf("inst-a", ACCOUNT) }));
    await settle();
    expect(countOf(daemon.invoked(), "boards")).toBe(1);
  });

  it("drops everything while the daemon is unreachable and refetches once it is back", async () => {
    const daemon = mockDaemonIpc({ projects: () => overview(), boards: () => CATALOG });
    const { result } = renderHook(() => ({ mappings: useMappings(), catalog: useBoardsCatalog() }));
    await settle();
    act(() => applyStreamMessage({ type: "daemon.unreachable", data: { reason: "socket_unavailable" } }));
    expect(result.current).toEqual({ mappings: [], catalog: null });
    act(() => applyStreamMessage({ type: "daemon.connected" }));
    await settle();
    expect(countOf(daemon.invoked(), "boards")).toBe(2);
    expect(result.current.catalog).toEqual(CATALOG);
  });

  it("refetches after a reconnect even when a fetch was already running", async () => {
    const answers: ((overview: ProjectsOverview) => void)[] = [];
    const daemon = mockDaemonIpc({ projects: () => new Promise<ProjectsOverview>((resolve) => answers.push(resolve)), boards: () => CATALOG });
    renderHook(() => useDiscovered());
    await settle();
    act(() => applyStreamMessage({ type: "daemon.connected" }));
    answers[0]?.(overview());
    await settle();
    expect(countOf(daemon.invoked(), "projects")).toBe(2);
  });
});

describe("boardLinkFor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function loaded(mappings: unknown[] = [MAPPING, ROOT_MAPPING]) {
    mockDaemonIpc({ projects: () => overview({ mappings }), boards: () => CATALOG });
    renderHook(() => useMappings());
    await settle();
  }

  it("links a mapping to its board's kanban on the web origin", async () => {
    await loaded();
    statusStore.set(statusWith(ACCOUNT));
    expect(boardLinkFor(MAPPING)).toBe("https://app.backplane.example/acme/boards/board-1/kanban");
  });

  it("falls back to the endpoint when the account has no web origin", async () => {
    await loaded();
    statusStore.set(statusWith({ ...ACCOUNT, web_origin: null }, "https://api.backplane.example/"));
    expect(boardLinkFor(MAPPING)).toBe("https://api.backplane.example/acme/boards/board-1/kanban");
  });

  it("falls back to the endpoint when there is no account yet", async () => {
    await loaded();
    statusStore.set(statusWith(null));
    expect(boardLinkFor(MAPPING)).toBe("https://api.backplane.example/acme/boards/board-1/kanban");
  });

  it("resolves a repo through its mapping first", async () => {
    await loaded();
    statusStore.set(statusWith(ACCOUNT));
    expect(boardLinkFor("github.com/acme/app")).toBe("https://app.backplane.example/acme/boards/board-1/kanban");
  });

  it("resolves an unmapped repo through the catalog when exactly one board has it", async () => {
    await loaded();
    statusStore.set(statusWith(ACCOUNT));
    expect(boardLinkFor("github.com/acme/mobile")).toBe("https://app.backplane.example/acme/boards/board-2/kanban");
  });

  it("is null for a repo several boards share and no mapping settles", async () => {
    await loaded();
    statusStore.set(statusWith(ACCOUNT));
    expect(boardLinkFor("github.com/acme/shared")).toBeNull();
  });

  it("is null for an unknown repo, a board missing from the catalog, or nothing at all", async () => {
    await loaded([MAPPING, ORPHAN_MAPPING]);
    statusStore.set(statusWith(ACCOUNT));
    expect(boardLinkFor("github.com/acme/unknown")).toBeNull();
    expect(boardLinkFor(ORPHAN_MAPPING)).toBeNull();
    expect(boardLinkFor("github.com/acme/gone")).toBeNull();
    expect(boardLinkFor(null)).toBeNull();
    expect(boardLinkFor("")).toBeNull();
  });

  it("is null while the origin is unknown", async () => {
    await loaded();
    statusStore.set(null);
    expect(boardLinkFor(MAPPING)).toBeNull();
    statusStore.set(statusWith({ ...ACCOUNT, web_origin: null }, ""));
    expect(boardLinkFor(MAPPING)).toBeNull();
  });

  it("is null before the catalog has loaded", () => {
    statusStore.set(statusWith(ACCOUNT));
    expect(projectsStore.get().catalog).toBeNull();
    expect(boardLinkFor(MAPPING)).toBeNull();
  });

  it("refuses dot segments, which would climb out of the board path", async () => {
    mockDaemonIpc({
      projects: () => overview({ mappings: [] }),
      boards: () => ({ workspaces: [{ id: "w", slug: "..", name: "A", boards: [{ id: ".", name: "X", repos: [] }, { id: "ok", name: "Y", repos: [] }] }] }),
    });
    renderHook(() => useBoardsCatalog());
    await settle();
    statusStore.set(statusWith(ACCOUNT));
    expect(boardLinkFor({ workspace_id: "w", board_id: "." })).toBeNull();
    expect(boardLinkFor({ workspace_id: "w", board_id: "ok" })).toBeNull();
  });

  it("escapes path segments", async () => {
    mockDaemonIpc({
      projects: () => overview({ mappings: [] }),
      boards: () => ({ workspaces: [{ id: "w", slug: "a b", name: "A", boards: [{ id: "x/y", name: "X", repos: [] }] }] }),
    });
    renderHook(() => useBoardsCatalog());
    await settle();
    statusStore.set(statusWith(ACCOUNT));
    expect(boardLinkFor({ workspace_id: "w", board_id: "x/y" })).toBe("https://app.backplane.example/a%20b/boards/x%2Fy/kanban");
  });
});

describe("boardLinkForSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const BOARD_1 = "https://app.backplane.example/acme/boards/board-1/kanban";
  const BOARD_2 = "https://app.backplane.example/acme/boards/board-2/kanban";
  // A folder bound by path: its remote is not what any mapping or board lists.
  const PATH_BOUND = { repo: "github.com/acme/mobile-fork", mapping_id: "map-2" };

  async function loaded(mappings: unknown[] = [MAPPING, ROOT_MAPPING, ORPHAN_MAPPING], catalog: BoardsOverview = CATALOG) {
    mockDaemonIpc({ projects: () => overview({ mappings }), boards: () => catalog });
    renderHook(() => useMappings());
    await settle();
    statusStore.set(statusWith(ACCOUNT));
  }

  it("links a session captured by a path-bound mapping to that mapping's board", async () => {
    await loaded();
    expect(boardLinkForSession(PATH_BOUND)).toBe(BOARD_2);
  });

  it("still links a session through its repo when nothing else names the board", async () => {
    await loaded();
    expect(boardLinkForSession({ repo: "github.com/acme/app" })).toBe(BOARD_1);
    expect(boardLinkForSession({ repo: "github.com/acme/mobile", mapping_id: null })).toBe(BOARD_2);
  });

  it("prefers the server's board over the daemon's mapping and the repo", async () => {
    await loaded();
    expect(boardLinkForSession({ ...PATH_BOUND, server_workspace_id: "ws-1", server_board_id: "board-1" })).toBe(BOARD_1);
  });

  it("uses the server's mapping when the daemon did not name one", async () => {
    await loaded();
    expect(boardLinkForSession({ repo: null, server_mapping_id: "map-2", server_board_id: null })).toBe(BOARD_2);
  });

  it("falls through to the repo when the named mapping is no longer in the policy", async () => {
    await loaded();
    expect(boardLinkForSession({ repo: "github.com/acme/app", mapping_id: "map-deleted" })).toBe(BOARD_1);
  });

  it("is null for a repo several boards share when nothing else settles it", async () => {
    await loaded();
    expect(boardLinkForSession({ repo: "github.com/acme/shared", mapping_id: null })).toBeNull();
    expect(boardLinkForSession({ repo: null })).toBeNull();
  });

  it("is null, never a guess from the repo, when the capturing board is unknown", async () => {
    await loaded();
    expect(boardLinkForSession({ repo: "github.com/acme/app", server_workspace_id: "ws-1", server_board_id: "board-gone" })).toBeNull();
    expect(boardLinkForSession({ repo: "github.com/acme/app", mapping_id: "map-3" })).toBeNull();
  });

  it("does not take a server board from another workspace", async () => {
    await loaded();
    expect(boardLinkForSession({ repo: null, server_workspace_id: "ws-2", server_board_id: "board-1" })).toBeNull();
  });

  it("falls back to the endpoint without a web origin, and is null without either", async () => {
    await loaded();
    statusStore.set(statusWith({ ...ACCOUNT, web_origin: null }, "https://api.backplane.example/"));
    expect(boardLinkForSession(PATH_BOUND)).toBe("https://api.backplane.example/acme/boards/board-2/kanban");
    statusStore.set(statusWith({ ...ACCOUNT, web_origin: null }, ""));
    expect(boardLinkForSession(PATH_BOUND)).toBeNull();
    statusStore.set(null);
    expect(boardLinkForSession(PATH_BOUND)).toBeNull();
  });

  it("refuses an unsafe id segment from any source", async () => {
    const unsafe: BoardsOverview = { workspaces: [{ id: "w", slug: "..", name: "A", boards: [{ id: ".", name: "X", repos: ["github.com/acme/dot"] }] }] };
    await loaded([{ id: "map-dot", workspace_id: "w", board_id: ".", root_path: "/home/me/code/dot", enabled: true }], unsafe);
    expect(boardLinkForSession({ repo: null, server_workspace_id: "w", server_board_id: "." })).toBeNull();
    expect(boardLinkForSession({ repo: null, mapping_id: "map-dot" })).toBeNull();
    expect(boardLinkForSession({ repo: "github.com/acme/dot" })).toBeNull();
  });
});

describe("boardOfSession", () => {
  it("names the board that captured a path-bound session", () => {
    expect(boardOfSession(CATALOG, [MAPPING, ROOT_MAPPING], { repo: null, mapping_id: "map-2" })).toEqual({
      workspaceSlug: "acme",
      boardId: "board-2",
      boardName: "Mobile",
    });
  });

  it("names nothing for a repo two boards list and no mapping settles", () => {
    expect(boardOfSession(CATALOG, [], { repo: "github.com/acme/shared" })).toBeNull();
  });

  it("drops the name when two mappings of the repo point at different boards", () => {
    const other = { ...MAPPING, id: "map-9", board_id: "board-2" };
    expect(boardOfSession(CATALOG, [MAPPING, other], { repo: "github.com/acme/app" })).toBeNull();
  });
});
