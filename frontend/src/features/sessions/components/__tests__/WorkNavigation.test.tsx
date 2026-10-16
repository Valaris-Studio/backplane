// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { cardKeys, noteKeys, workspaceKeys } from "@/lib/query-keys";
import type { LinkedSessionList } from "@/types/agent-session";
import { SLUG, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { CardSessionsSection, NoteSessionsSection } from "../LinkedSessionsSection";
import { WorkChip, type WorkChipRef } from "../WorkChip";

const OTHER_SLUG = "research";
const BOARD = "board-research";
const TARGET = "work-target";
const TITLE = "Private release evidence";
const RESTORED_TITLE = "Reviewed release evidence";
const WORKSPACES = [{ id: "ws-1", slug: SLUG, name: "Acme" }, { id: "ws-2", slug: OTHER_SLUG, name: "Research" }];
const clients: QueryClient[] = [];

function retainedClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } } });
  clients.push(client);
  return client;
}

function work(kind: "card" | "note", overrides: Partial<WorkChipRef & { workspace_id: string }> = {}): WorkChipRef & { workspace_id: string } {
  return {
    entity_type: kind,
    entity_id: TARGET,
    board_id: kind === "card" ? BOARD : null,
    workspace_id: "ws-2",
    relation: "consulted",
    provenance: "correlated",
    ...overrides,
  };
}

function targetPath(kind: "card" | "note", slug = OTHER_SLUG) {
  return kind === "card" ? `/api/workspaces/${slug}/boards/${BOARD}/cards/${TARGET}` : `/api/workspaces/${slug}/notes/${TARGET}`;
}

function targetKey(kind: "card" | "note", slug = OTHER_SLUG) {
  return kind === "card" ? cardKeys.detail(slug, BOARD, TARGET) : noteKeys.detail(slug, TARGET);
}

function href(kind: "card" | "note", slug = OTHER_SLUG) {
  return kind === "card" ? `/${slug}/boards/${BOARD}/kanban?card=${TARGET}` : `/${slug}/notes?note=${TARGET}`;
}

class VisibleObserver {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.report([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
const originalObserver = window.IntersectionObserver;

beforeEach(() => {
  window.IntersectionObserver = VisibleObserver as unknown as typeof IntersectionObserver;
  stubAuthModes(true);
  server.use(http.get("/api/workspaces", () => HttpResponse.json(WORKSPACES)));
});

afterEach(() => {
  window.IntersectionObserver = originalObserver;
  clients.splice(0).forEach((client) => client.clear());
});

describe("Work links use the target's authorized workspace", () => {
  it.each(["card", "note"] as const)("verifies a cross-workspace %s before linking to its canonical title", async (kind) => {
    const correctRead = vi.fn();
    const wrongRead = vi.fn();
    server.use(
      http.get(targetPath(kind), () => { correctRead(); return HttpResponse.json({ id: TARGET, title: TITLE }); }),
      http.get(targetPath(kind, SLUG), () => { wrongRead(); return HttpResponse.json({ detail: "Wrong workspace" }, { status: 404 }); }),
    );
    renderWithProviders(<WorkChip slug={SLUG} work={work(kind, { title: "Older embedded title" })} />, { queryClient: retainedClient() });

    const link = await screen.findByRole("link", { name: new RegExp(TITLE) });
    expect(link).toHaveAttribute("href", href(kind));
    expect(correctRead).toHaveBeenCalledTimes(1);
    expect(wrongRead).not.toHaveBeenCalled();
    expect(screen.queryByText("Older embedded title")).not.toBeInTheDocument();
  });

  it.each(["card", "note"] as const)("keeps a %s list preview without a workspace readable but non-navigable", async (kind) => {
    const reads = vi.fn();
    server.use(http.get(targetPath(kind, SLUG), () => { reads(); return HttpResponse.json({ id: TARGET, title: TITLE }); }));
    const preview: WorkChipRef = { entity_type: kind, entity_id: TARGET, board_id: kind === "card" ? BOARD : null, title: TITLE, relation: "changed", provenance: "exact" };
    const client = retainedClient();
    renderWithProviders(<WorkChip slug={SLUG} work={preview} />, { queryClient: client });

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(["missing membership", "registry unavailable"] as const)("never guesses a workspace when %s", async (condition) => {
    const reads = vi.fn();
    server.use(
      http.get("/api/workspaces", () => condition === "missing membership" ? HttpResponse.json(WORKSPACES.slice(0, 1)) : HttpResponse.json({ detail: "Unavailable" }, { status: 503 })),
      http.get(targetPath("card"), () => { reads(); return HttpResponse.json({ id: TARGET, title: TITLE }); }),
      http.get(targetPath("card", SLUG), () => { reads(); return HttpResponse.json({ id: TARGET, title: TITLE }); }),
    );
    const client = retainedClient();
    renderWithProviders(<WorkChip slug={SLUG} work={work("card", { title: TITLE })} />, { queryClient: client });
    await waitFor(() => expect(client.isFetching()).toBe(0));

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(reads).not.toHaveBeenCalled();
  });

  it.each(["card", "note"] as const)("hides a cached %s after denial through an outage and remount until fresh authorization succeeds", async (kind) => {
    let status = 200;
    let title = TITLE;
    const reads = vi.fn();
    server.use(http.get(targetPath(kind, SLUG), () => {
      reads();
      return status === 200 ? HttpResponse.json({ id: TARGET, title }) : HttpResponse.json({ detail: "Unavailable" }, { status });
    }));
    const client = retainedClient();
    const ref = work(kind, { workspace_id: "ws-1" });
    const element = <WorkChip slug={SLUG} work={ref} />;
    let view = renderWithProviders(element, { queryClient: client });
    expect(await screen.findByRole("link", { name: new RegExp(TITLE) })).toHaveAttribute("href", href(kind, SLUG));

    status = 403;
    await act(async () => { await client.refetchQueries({ queryKey: targetKey(kind, SLUG), exact: true }); });
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    status = 500;
    await act(async () => { await client.refetchQueries({ queryKey: targetKey(kind, SLUG), exact: true }); });
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    view.unmount();
    view = renderWithProviders(element, { queryClient: client });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    status = 200;
    title = RESTORED_TITLE;
    await act(async () => { await client.refetchQueries({ queryKey: targetKey(kind, SLUG), exact: true }); });
    expect(await screen.findByRole("link", { name: new RegExp(RESTORED_TITLE) })).toHaveAttribute("href", href(kind, SLUG));
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(4);
    view.unmount();
  });

  it("does not use an embedded title after the canonical target is deleted", async () => {
    const reads = vi.fn();
    server.use(http.get(targetPath("card"), () => { reads(); return HttpResponse.json({ detail: "Not found" }, { status: 404 }); }));
    const client = retainedClient();
    renderWithProviders(<WorkChip slug={SLUG} work={work("card", { title: TITLE })} />, { queryClient: client });
    await waitFor(() => expect(client.isFetching()).toBe(0));

    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

function linkedList(): LinkedSessionList {
  const session = makeSession({ id: "remote-session", workspace_id: "ws-2", title: "Inspect the captured decision" });
  return {
    items: [{ session, relations: ["consulted"], provenance: "exact", first_seen_at: session.started_at, last_seen_at: session.last_event_at }],
    summary: {
      session_count: 1, first_seen_at: session.started_at, last_seen_at: session.last_event_at,
      total_duration_seconds: 60, wall_duration_seconds: 60, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_usd: null,
      cost_reported_usd: null, cost_estimated_usd: null, cost_source: null, cost_basis: null, cost_complete: false,
    },
  };
}

describe("Work to captured session navigation", () => {
  it.each(["card", "note"] as const)("opens the session's workspace from a %s and removes that route after membership disappears", async (kind) => {
    let workspaces = WORKSPACES;
    server.use(
      http.get("/api/workspaces", () => HttpResponse.json(workspaces)),
      http.get("/api/me/companion/installations", () => HttpResponse.json([])),
      http.get(`/api/workspaces/${SLUG}/boards/${BOARD}/cards/${TARGET}/sessions`, () => HttpResponse.json(linkedList())),
      http.get(`/api/workspaces/${SLUG}/notes/${TARGET}/sessions`, () => HttpResponse.json(linkedList())),
    );
    const client = retainedClient();
    renderWithProviders(kind === "card" ? <CardSessionsSection slug={SLUG} boardId={BOARD} cardId={TARGET} /> : <NoteSessionsSection slug={SLUG} noteId={TARGET} boardId={null} />, { queryClient: client });
    expect(await screen.findByRole("link", { name: "Inspect the captured decision" })).toHaveAttribute("href", `/${OTHER_SLUG}/sessions/remote-session`);

    workspaces = WORKSPACES.slice(0, 1);
    await act(async () => { await client.refetchQueries({ queryKey: workspaceKeys.all, exact: true }); });
    await waitFor(() => expect(screen.queryByRole("link", { name: "Inspect the captured decision" })).not.toBeInTheDocument());
    expect(document.querySelector(`a[href="/${SLUG}/sessions/remote-session"]`)).toBeNull();
  });
});
