// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { act, renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ApiError } from "@/lib/api-error";
import { meKeys, memberKeys } from "@/lib/query-keys";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { Note } from "@/types/note";
import i18n from "@/i18n/config";
import { NoteEditorMeta } from "../NoteEditorMeta";

const SLUG = "identity-loss-workspace";
const OWNER = { id: "owner-a", name: "Owner A", email: "a@example.test", avatar_url: null };
const DIGEST = "a".repeat(64);
const NOTE: Note = {
  id: "published-note", workspace_id: "workspace-id", board_id: "board-id", card_id: null,
  title: "Synthetic published handoff", content: "Saved body", pinned: false, kind: "user_note",
  failure_class: null, findings: null, source_execution_id: null, created_by: OWNER.id,
  created_at: "2026-10-18T15:00:00Z", updated_at: "2026-10-18T15:00:00Z",
};
const clients: QueryClient[] = [];
const pending: Array<() => void> = [];
function gate() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  pending.push(release);
  return { ready, release };
}
const comparisonLabel = () => String(i18n.t("notes.publicationRevision.action"));
const message = (key: string) => String(i18n.t(`notes.publicationRevision.${key}`));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(meKeys.me(), OWNER);
  client.setQueryData(memberKeys.list(SLUG), [{ user_id: OWNER.id, name: OWNER.name, email: OWNER.email, role: "member" }]);
  const state = { identityStatus: 200, publicationOnline: true, presenceReads: 0, revisionReads: 0, revisionGate: null as Promise<void> | null };
  const base = `/api/workspaces/${SLUG}/boards/${NOTE.board_id}/notes/${NOTE.id}/publication-revision`;
  server.use(
    http.get("/api/me", () => HttpResponse.json(
      state.identityStatus === 200 ? OWNER : { detail: "Synthetic identity unavailable" },
      { status: state.identityStatus },
    )),
    http.get(`/api/workspaces/${SLUG}/boards/${NOTE.board_id}`, () => HttpResponse.json({ id: NOTE.board_id, name: "Board", columns: [] })),
    http.get(`${base}/presence`, () => {
      state.presenceReads++;
      return HttpResponse.json(state.publicationOnline ? { has_record: true, recorded_at: NOTE.created_at } : { detail: "Offline" }, { status: state.publicationOnline ? 200 : 503 });
    }),
    http.get(base, async () => {
      state.revisionReads++;
      const onlineAtRequest = state.publicationOnline;
      await state.revisionGate;
      return HttpResponse.json(onlineAtRequest ? {
        status: "recorded", recorded_at: NOTE.created_at, revision_version: 1,
        published_revision_sha256: DIGEST, current_revision_sha256: DIGEST,
        comparison: "matches", comparison_reason: null,
      } : { detail: "Offline" }, { status: onlineAtRequest ? 200 : 503 });
    }),
  );
  renderWithProviders(
    <WebSocketContext.Provider value={{ status: "disconnected", subscribe: () => () => {} }}>
      <NoteEditorMeta note={NOTE} slug={SLUG} />
    </WebSocketContext.Provider>,
    { queryClient: client },
  );
  return { client, state };
}
async function refetchIdentity(client: QueryClient, status: number) {
  await act(async () => { await client.invalidateQueries({ queryKey: meKeys.me() }); });
  await waitFor(() => {
    const identity = client.getQueryState(meKeys.me());
    expect(identity?.status).toBe("error");
    expect(identity?.error).toBeInstanceOf(ApiError);
    expect((identity?.error as ApiError).status).toBe(status);
  });
}
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); pending.splice(0).forEach((release) => release()); clients.splice(0).forEach((client) => client.clear()); });

describe("Publication inspection after authoritative identity loss", () => {
  it("removes the owner-only action after /me 403 even when authorized presence is cached and the socket is offline", async () => {
    const { client, state } = setup();
    expect(await screen.findByRole("button", { name: comparisonLabel() })).toBeVisible();
    expect(state.presenceReads).toBe(1);
    expect(state.revisionReads).toBe(0);
    state.identityStatus = 403;
    state.publicationOnline = false;
    await refetchIdentity(client, 403);
    expect(screen.queryByRole("button", { name: comparisonLabel() }) === null).toBe(true);
    expect(state.revisionReads).toBe(0);
  });

  it("removes previously displayed and cached fingerprints when /me 403 invalidates the current owner", async () => {
    const { client, state } = setup();
    fireEvent.click(await screen.findByRole("button", { name: comparisonLabel() }));
    expect(await screen.findByText(message("matches"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: message("details") }));
    expect(screen.getAllByText(DIGEST)).toHaveLength(2);
    expect(state.revisionReads).toBe(1);
    state.identityStatus = 403;
    state.publicationOnline = false;
    await refetchIdentity(client, 403);
    expect.soft(screen.queryByRole("button", { name: comparisonLabel() }) === null).toBe(true);
    expect.soft(screen.queryAllByText(DIGEST)).toHaveLength(0);
    expect.soft(screen.queryByText(message("matches")) === null).toBe(true);
    await waitFor(() => expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(DIGEST));
  });

  it("keeps an already authorized disclosure useful through transient identity 503 without creating a new comparison read", async () => {
    const { client, state } = setup();
    fireEvent.click(await screen.findByRole("button", { name: comparisonLabel() }));
    expect(await screen.findByText(message("matches"))).toBeVisible();
    state.identityStatus = 503;
    state.publicationOnline = false;
    await refetchIdentity(client, 503);
    expect(screen.getByRole("button", { name: comparisonLabel() })).toBeVisible();
    expect(screen.getByText(message("matches"))).toBeVisible();
    expect(state.revisionReads).toBe(1);
  });
});


describe("Publication identity-loss recovery controls", () => {
  it("does not restore old private proof when a later identity read fails transiently, then recovers deliberately after successful identity", async () => {
    const { client, state } = setup();
    fireEvent.click(await screen.findByRole("button", { name: comparisonLabel() }));
    expect(await screen.findByText(message("matches"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: message("details") }));
    expect(screen.getAllByText(DIGEST)).toHaveLength(2);
    state.identityStatus = 403;
    state.publicationOnline = false;
    await refetchIdentity(client, 403);
    await waitFor(() => expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(DIGEST));
    state.identityStatus = 503;
    await refetchIdentity(client, 503);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByRole("button", { name: comparisonLabel() })).not.toBeInTheDocument();
    expect(screen.queryAllByText(DIGEST)).toHaveLength(0);
    expect(screen.queryByText(message("matches"))).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(DIGEST);
    expect(state.revisionReads).toBe(1);

    state.identityStatus = 200;
    state.publicationOnline = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: meKeys.me() });
      // A failed presence read may also need its normal retry after connectivity returns.
      await client.invalidateQueries({ queryKey: ["note-publication-revision", SLUG] });
    });
    const action = await screen.findByRole("button", { name: comparisonLabel() });
    expect(action).toHaveAttribute("aria-expanded", "false");
    expect(state.revisionReads).toBe(1);
    fireEvent.click(action);
    expect(await screen.findByText(message("matches"))).toBeVisible();
    expect(state.revisionReads).toBe(2);
  });

  it("ignores a successful comparison response that settles after authoritative identity denial", async () => {
    const { client, state } = setup();
    const pendingComparison = gate();
    state.revisionGate = pendingComparison.ready;
    fireEvent.click(await screen.findByRole("button", { name: comparisonLabel() }));
    await waitFor(() => expect(state.revisionReads).toBe(1));
    expect(screen.getByText(message("loading"))).toBeVisible();
    state.identityStatus = 403;
    state.publicationOnline = false;
    await refetchIdentity(client, 403);
    await act(async () => { pendingComparison.release(); });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByRole("button", { name: comparisonLabel() })).not.toBeInTheDocument();
    expect(screen.queryByText(message("matches"))).not.toBeInTheDocument();
    expect(screen.queryAllByText(DIGEST)).toHaveLength(0);
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(DIGEST);
  });
});
