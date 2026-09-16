// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// RED (card cb54eb39): pins the useUpdateNote half of notes ↔ cards linking.
//
// Contract under test:
//   1. `NoteUpdate` gains `card_id?: string | null` — the typed payload below
//      is a compile error today (vitest does not typecheck; `pnpm build`/tsc
//      is the red gate for this half).
//   2. The mutation sends card_id through in the PUT body (link and unlink).
//   3. onSuccess ALSO invalidates the noteKeys.byCard scope explicitly, so
//      card-scoped note lists refetch on link/unlink regardless of how the
//      broader byBoard/byWorkspace keys evolve.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { noteKeys } from "@/lib/query-keys";
import type { NoteUpdate } from "@/types/note";

const apiPut = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: (...args: unknown[]) => apiPut(...args),
    delete: vi.fn(),
  },
}));

import { useUpdateNote } from "../use-notes";

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  apiPut.mockReset();
  apiPut.mockResolvedValue({ data: { id: "note-1" } });
});

describe("useUpdateNote — card link/unlink payload", () => {
  it("accepts card_id in NoteUpdate and sends it in the PUT body when linking", async () => {
    const { result } = renderHook(() => useUpdateNote("acme", "board-1"), {
      wrapper: withClient(newClient()),
    });

    // Type-level pin: NoteUpdate must admit card_id. Red under tsc until the
    // type gains the field.
    const payload: NoteUpdate & { noteId: string } = {
      noteId: "note-1",
      card_id: "card-9",
    };

    act(() => result.current.mutate(payload));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiPut).toHaveBeenCalledWith(
      "/workspaces/acme/boards/board-1/notes/note-1",
      expect.objectContaining({ card_id: "card-9" }),
    );
  });

  it("sends card_id null in the PUT body when unlinking", async () => {
    const { result } = renderHook(() => useUpdateNote("acme", "board-1"), {
      wrapper: withClient(newClient()),
    });

    const payload: NoteUpdate & { noteId: string } = {
      noteId: "note-1",
      card_id: null,
    };

    act(() => result.current.mutate(payload));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiPut).toHaveBeenCalledWith(
      "/workspaces/acme/boards/board-1/notes/note-1",
      expect.objectContaining({ card_id: null }),
    );
  });
});

describe("useUpdateNote — byCard cache invalidation", () => {
  it("explicitly invalidates the noteKeys.byCard scope after a link/unlink", async () => {
    const client = newClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useUpdateNote("acme", "board-1"), {
      wrapper: withClient(client),
    });

    act(() =>
      result.current.mutate({
        noteId: "note-1",
        card_id: "card-9",
      } as NoteUpdate & { noteId: string }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Accept either the full byCard key or the board's card-scope prefix
    // (byCard minus the trailing cardId) — both derived from noteKeys.byCard,
    // never hand-rolled. A bare byBoard/byWorkspace invalidation does NOT
    // count: it lacks the "card" scope segment, so this pins an EXPLICIT
    // card-scope call rather than incidental prefix fuzzy-matching.
    const cardScopePrefix = noteKeys
      .byCard("acme", "board-1", "card-9")
      .slice(0, -1); // ["notes", "acme", "board-1", "card"]

    const cardScopeCall = invalidateSpy.mock.calls.find(([filters]) => {
      const key = (filters as { queryKey?: unknown })?.queryKey;
      return (
        Array.isArray(key) &&
        key.length >= cardScopePrefix.length &&
        cardScopePrefix.every((segment, i) => key[i] === segment)
      );
    });
    expect(cardScopeCall).toBeDefined();
  });
});
