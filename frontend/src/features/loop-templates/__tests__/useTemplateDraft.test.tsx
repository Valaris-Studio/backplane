// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { server, http, HttpResponse } from "@/test/msw-server";
import { toast } from "sonner";
import { loopTemplateKeys } from "@/lib/query-keys";
// Card 2c18790f (F6) — the store now consults the caller's workspace ROLE, so
// every test in this file has to declare one. Admin is the default because
// every pre-existing case in here asserts editable behaviour.
const adminState = {
  current: { role: "admin" as string | null, isLoading: false, isError: false },
};
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" ||
      adminState.current.role === "owner",
    isLoading: adminState.current.isLoading,
    isError: adminState.current.isError,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { useTemplateDraft } from "../hooks/useTemplateDraft";
import {
  TemplateDraftProvider,
  useTemplateDraftContext,
} from "../hooks/TemplateDraftProvider";

// Same local-wrapper harness as useLoopTemplateSync.test.ts — retries off so a
// 409 surfaces on the first response instead of after react-query's backoff.
function createWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// Card 0a65a907 — the ONE draft store every editing tab writes into.
//
// Contract under test (spec §5.1 draft/publish F9):
// - autosave is debounced and fires ONCE per settled edit burst
// - every PATCH carries `expected_updated_at`, and the value is the detail's
//   `draft_updated_at` — NOT `updated_at`, which tracks the whole row on a
//   different clock (backend LoopTemplateUpdate docstring is explicit).
// - a 409 `stale_draft` latches conflict and stops all further autosaves
// - reload() refetches server state and clears both dirty and conflict
// - system templates never PATCH at all

const SLUG = "acme";
const REF = "11111111-2222-3333-4444-555555555555";
const DETAIL_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}`;

const WORKSPACE_DETAIL = {
  id: REF,
  slug: "my-loop",
  source: "workspace" as const,
  name: "My loop",
  version: 3,
  is_system: false,
  is_draft: true,
  profile: { emoji: "🔁", tagline: "does things" },
  content: { system_prompt: "sys", loop_prompt: "loop", slots: [] },
  lineage: null,
  updated_at: "2026-08-17T10:00:00Z",
  draft_updated_at: "2026-08-17T11:30:00Z",
  has_unpublished_changes: true,
};

const SYSTEM_DETAIL = {
  ...WORKSPACE_DETAIL,
  id: "coding-loop",
  slug: "coding-loop",
  source: "system" as const,
  is_system: true,
  has_unpublished_changes: false,
};

/** Bodies of every PATCH msw saw, in order. */
let patches: Record<string, unknown>[];

function serveDetail(detail: Record<string, unknown> = WORKSPACE_DETAIL) {
  server.use(
    http.get(DETAIL_URL, () => HttpResponse.json(detail)),
    http.get(`/api/workspaces/${SLUG}/loop-templates/coding-loop`, () =>
      HttpResponse.json(SYSTEM_DETAIL),
    ),
  );
}

function servePatch(
  responder: (body: Record<string, unknown>) => Response = () =>
    HttpResponse.json({
      ...WORKSPACE_DETAIL,
      draft_updated_at: "2026-08-17T12:00:00Z",
    }),
) {
  server.use(
    http.patch(DETAIL_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      return responder(body);
    }),
  );
}

function renderDraft(ref = REF) {
  return renderHook(() => useTemplateDraft(SLUG, ref), {
    wrapper: createWrapper(freshClient()),
  });
}

beforeEach(() => {
  adminState.current = { role: "admin", isLoading: false, isError: false };
  vi.mocked(toast.error).mockClear();
  patches = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  serveDetail();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the debounce elapse and any resulting request settle. */
async function settleAutosave() {
  await act(async () => {
    vi.advanceTimersByTime(1200);
  });
}

/**
 * Serves genuinely different bodies for `?draft=true` and the paramless GET,
 * and records which the editor asked for.
 *
 * The published half is deliberately UNLIKE the draft half: the earlier
 * handlers answer one fixture for the URL regardless of query string, which is
 * exactly why a read that never sent `?draft=true` looked green.
 */
function serveBothHalves() {
  const seen: (string | null)[] = [];
  server.use(
    http.get(DETAIL_URL, ({ request }) => {
      const draft = new URL(request.url).searchParams.get("draft");
      seen.push(draft);
      return HttpResponse.json({
        ...WORKSPACE_DETAIL,
        name: draft === "true" ? "Draft name" : "Published name",
        content: {
          ...WORKSPACE_DETAIL.content,
          loop_prompt: draft === "true" ? "draft loop" : "published loop",
        },
      });
    }),
  );
  return seen;
}

describe("useTemplateDraft draft/published half (card 1847716e)", () => {
  it("hydrates the editor from the DRAFT half of a published template", async () => {
    const seen = serveBothHalves();

    const { result } = renderDraft();

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.draft?.name).toBe("Draft name");
    expect(result.current.draft?.content.loop_prompt).toBe("draft loop");
    expect(seen).toContain("true");
  });

  it("writes the saved draft into the entry the editor reads back", async () => {
    // AC2: persist's setQueryData must target the same key the read uses, or
    // the optimistic post-save update lands on an entry nothing reads.
    serveBothHalves();
    servePatch(() =>
      HttpResponse.json({
        ...WORKSPACE_DETAIL,
        name: "Saved name",
        draft_updated_at: "2026-08-17T12:00:00Z",
      }),
    );
    const client = freshClient();
    const { result } = renderHook(() => useTemplateDraft(SLUG, REF), {
      wrapper: createWrapper(client),
    });
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Edited"));
    await settleAutosave();

    await waitFor(() =>
      expect(
        client.getQueryData(loopTemplateKeys.detail(SLUG, REF, true)),
      ).toMatchObject({ name: "Saved name" }),
    );
  });
});

describe("useTemplateDraft", () => {
  it("hydrates the draft from the server and starts clean", async () => {
    const { result } = renderDraft();

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.draft?.name).toBe("My loop");
    expect(result.current.dirty).toBe(false);
    expect(result.current.readOnly).toBe(false);
  });

  it("autosaves ONCE after the debounce, no matter how many edits land inside it", async () => {
    servePatch();
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => {
      result.current.setField("name", "One");
      result.current.setField("name", "Two");
      result.current.setField("name", "Three");
    });
    expect(result.current.dirty).toBe(true);

    await settleAutosave();

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.name).toBe("Three");
  });

  it("locks each autosave with expected_updated_at taken from draft_updated_at", async () => {
    servePatch();
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Renamed"));
    await settleAutosave();

    await waitFor(() => expect(patches).toHaveLength(1));
    // The row-level `updated_at` (10:00) is the WRONG token and would be
    // accepted by a naive implementation reading the more obvious field.
    expect(patches[0]?.expected_updated_at).toBe("2026-08-17T11:30:00Z");
    expect(patches[0]?.expected_updated_at).not.toBe("2026-08-17T10:00:00Z");
  });

  it("advances the lock token to the value the server returned", async () => {
    servePatch();
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "First"));
    await settleAutosave();
    await waitFor(() => expect(patches).toHaveLength(1));

    act(() => result.current.setField("name", "Second"));
    await settleAutosave();

    await waitFor(() => expect(patches).toHaveLength(2));
    // Reusing 11:30 on the second save would 409 against a server that just
    // moved the draft to 12:00.
    expect(patches[1]?.expected_updated_at).toBe("2026-08-17T12:00:00Z");
  });

  it("patches nested content by path without clobbering its siblings", async () => {
    servePatch();
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("content.system_prompt", "new sys"));
    await settleAutosave();

    await waitFor(() => expect(patches).toHaveLength(1));
    const content = patches[0]?.content as Record<string, unknown>;
    expect(content.system_prompt).toBe("new sys");
    expect(content.loop_prompt).toBe("loop");
  });

  it("latches conflict on a 409 stale_draft and stops autosaving entirely", async () => {
    servePatch(() =>
      HttpResponse.json(
        { detail: "Draft edited elsewhere", error_code: "stale_draft" },
        { status: 409 },
      ),
    );
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Doomed"));
    await settleAutosave();

    await waitFor(() => expect(result.current.conflict).toBe(true));
    expect(patches).toHaveLength(1);

    // A further edit must NOT produce a second request: the banner is
    // non-dismissable and reload is the only way forward.
    act(() => result.current.setField("name", "Still doomed"));
    await settleAutosave();
    await settleAutosave();
    expect(patches).toHaveLength(1);
  });

  it("refuses the edit itself once conflicted, so the draft stops diverging", async () => {
    servePatch(() =>
      HttpResponse.json({ error_code: "stale_draft" }, { status: 409 }),
    );
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Doomed"));
    await settleAutosave();
    await waitFor(() => expect(result.current.conflict).toBe(true));

    // Reaches the setField guard specifically: the value must not move, or the
    // operator keeps typing into a draft that can never be saved.
    act(() => result.current.setField("name", "Typed after the banner"));
    expect(result.current.draft?.name).toBe("Doomed");
  });

  it("refuses a FORCED flush once conflicted", async () => {
    servePatch(() =>
      HttpResponse.json({ error_code: "stale_draft" }, { status: 409 }),
    );
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Doomed"));
    await settleAutosave();
    await waitFor(() => expect(result.current.conflict).toBe(true));

    // Reaches the persist guard specifically: flush() bypasses the debounce,
    // so nothing but that guard stands between a conflict and an overwrite of
    // the other editor's work.
    await act(async () => {
      await result.current.flush();
    });
    expect(patches).toHaveLength(1);
  });

  it("reload() restores server state and clears dirty and conflict", async () => {
    servePatch(() =>
      HttpResponse.json({ error_code: "stale_draft" }, { status: 409 }),
    );
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Local edit"));
    await settleAutosave();
    await waitFor(() => expect(result.current.conflict).toBe(true));

    serveDetail({ ...WORKSPACE_DETAIL, name: "Server wins" });
    await act(async () => {
      await result.current.reload();
    });

    await waitFor(() => expect(result.current.draft?.name).toBe("Server wins"));
    expect(result.current.conflict).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("treats a system template as read-only and never PATCHes it", async () => {
    servePatch();
    const { result } = renderDraft("coding-loop");
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    expect(result.current.readOnly).toBe(true);

    act(() => result.current.setField("name", "Cannot edit"));
    await settleAutosave();
    await settleAutosave();

    expect(patches).toHaveLength(0);
    expect(result.current.dirty).toBe(false);
  });

  it("flush() saves immediately instead of waiting out the debounce", async () => {
    servePatch();
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Urgent"));
    await act(async () => {
      await result.current.flush();
    });

    // No timer was advanced — the save happened because flush forced it.
    expect(patches).toHaveLength(1);
    expect(patches[0]?.name).toBe("Urgent");
  });

  it("flush() on a clean draft is a no-op", async () => {
    servePatch();
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    await act(async () => {
      await result.current.flush();
    });

    expect(patches).toHaveLength(0);
  });

  it("reports saving while a PATCH is in flight and clears it after", async () => {
    let release: (() => void) | undefined;
    servePatch(() => {
      // Hold the response open so `saving` is observable rather than a
      // sub-tick flicker jsdom would never let a test see.
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve(
            HttpResponse.json({
              ...WORKSPACE_DETAIL,
              draft_updated_at: "2026-08-17T12:00:00Z",
            }),
          );
      }) as unknown as Response;
    });

    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Slow"));
    await settleAutosave();

    await waitFor(() => expect(result.current.saving).toBe(true));
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.dirty).toBe(false);
  });

  it("does NOT latch conflict on a non-409 failure — autosave retries", async () => {
    let attempt = 0;
    servePatch(() => {
      attempt += 1;
      return attempt === 1
        ? HttpResponse.json({ detail: "boom" }, { status: 500 })
        : HttpResponse.json({
            ...WORKSPACE_DETAIL,
            draft_updated_at: "2026-08-17T12:00:00Z",
          });
    });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Flaky network"));
    await settleAutosave();
    await waitFor(() => expect(patches).toHaveLength(1));

    // A transient 500 is NOT "someone else edited this" — treating it as a
    // conflict would strand the operator behind a reload banner for a blip.
    expect(result.current.conflict).toBe(false);
    expect(result.current.dirty).toBe(true);

    act(() => result.current.setField("name", "Retried"));
    await settleAutosave();
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(result.current.conflict).toBe(false);
  });

  it("never lets a background refetch clobber unsaved edits", async () => {
    servePatch();
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Local unsaved"));

    // The server row moves (another tab published) and the query refetches
    // while the operator has uncommitted edits on screen.
    serveDetail({
      ...WORKSPACE_DETAIL,
      name: "Server name",
      draft_updated_at: "2026-08-17T13:00:00Z",
    });
    await act(async () => {
      await result.current.refetchDetail();
    });
    // The hydration effect runs on the render AFTER the query settles, so the
    // clobber (if the guard were gone) lands a tick later than the refetch
    // promise. Settle that tick before asserting, or this passes vacuously.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.draft?.name).toBe("Local unsaved");
    expect(result.current.dirty).toBe(true);
  });

  it("keeps an edit made DURING a save marked dirty, and saves it after", async () => {
    let release: (() => void) | undefined;
    servePatch(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              HttpResponse.json({
                ...WORKSPACE_DETAIL,
                draft_updated_at: "2026-08-17T12:00:00Z",
              }),
            );
        }) as unknown as Response,
    );

    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "First"));
    await settleAutosave();
    await waitFor(() => expect(result.current.saving).toBe(true));

    // Typed while the first PATCH is still open. The response that comes back
    // describes the PREVIOUS snapshot, so clearing dirty on it would silently
    // drop this keystroke.
    act(() => result.current.setField("name", "Typed mid-flight"));

    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(result.current.saving).toBe(false));

    expect(result.current.dirty).toBe(true);
    expect(result.current.draft?.name).toBe("Typed mid-flight");
  });

  it("keeps dirty true while a save is in flight so the guard still blocks", async () => {
    let release: (() => void) | undefined;
    servePatch(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(HttpResponse.json(WORKSPACE_DETAIL));
        }) as unknown as Response,
    );

    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "In flight"));
    await settleAutosave();
    await waitFor(() => expect(result.current.saving).toBe(true));

    // "Save in flight" counts as unsaved work (card: Risks/gotchas).
    expect(result.current.hasUnsavedWork).toBe(true);

    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(result.current.hasUnsavedWork).toBe(false));
  });
});

// Card e5ecad48 (F2) — ONE draft store. The hook documents itself as "the
// single draft store for one open template… the detail shell provides it via
// context so a tab switch never re-creates the draft" — this describe pins the
// provider that makes that sentence true.
describe("TemplateDraftProvider (card e5ecad48)", () => {
  /** Two sibling consumers, exactly like two tabs mounted under one shell. */
  function renderTwoConsumers(ref = REF) {
    const client = freshClient();
    return renderHook(
      () => ({
        a: useTemplateDraftContext(),
        b: useTemplateDraftContext(),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>
            <TemplateDraftProvider slug={SLUG} templateRef={ref}>
              {children}
            </TemplateDraftProvider>
          </QueryClientProvider>
        ),
      },
    );
  }

  it("hands both consumers the SAME store object", async () => {
    const { result } = renderTwoConsumers();
    await waitFor(() => expect(result.current.a.draft).not.toBeNull());

    // Identity, not deep equality: two structurally-equal stores would still
    // be two debounce timers and two lock tokens.
    expect(result.current.a).toBe(result.current.b);
  });

  it("propagates one consumer's edit to the other and issues ONE patch", async () => {
    servePatch();
    const { result } = renderTwoConsumers();
    await waitFor(() => expect(result.current.a.draft).not.toBeNull());

    act(() => result.current.a.setField("content.system_prompt", "from A"));

    // The other consumer sees it before any network round-trip.
    expect(result.current.b.draft?.content).toMatchObject({
      system_prompt: "from A",
    });

    await settleAutosave();
    // Four independent stores would have scheduled four timers for one edit.
    await waitFor(() => expect(patches).toHaveLength(1));
  });

  it("throws a NAMED error outside the provider rather than returning undefined", () => {
    // A silent undefined here would let a tab fall back to its own store and
    // resurrect the four-store bug invisibly.
    expect(() =>
      renderHook(() => useTemplateDraftContext(), {
        wrapper: createWrapper(freshClient()),
      }),
    ).toThrow(/TemplateDraftProvider/);
  });

  it("reload() through the context clears a latched conflict for BOTH consumers", async () => {
    servePatch(() =>
      HttpResponse.json({ detail: "stale" }, { status: 409 }),
    );
    const { result } = renderTwoConsumers();
    await waitFor(() => expect(result.current.a.draft).not.toBeNull());

    act(() => result.current.a.setField("name", "Conflicting"));
    await settleAutosave();
    await waitFor(() => expect(result.current.a.conflict).toBe(true));
    // The conflict is the shared store's, so the sibling sees it too.
    expect(result.current.b.conflict).toBe(true);

    serveDetail();
    await act(async () => {
      await result.current.b.reload();
    });
    await waitFor(() => expect(result.current.a.conflict).toBe(false));
    expect(result.current.b.conflict).toBe(false);
  });

  it("keeps the context value identity stable across an unrelated re-render", async () => {
    // The 58-slot render-count guard in LoopTemplateSlotsTab depends on this:
    // a context value rebuilt every render re-renders every memoized row.
    const { result, rerender } = renderTwoConsumers();
    await waitFor(() => expect(result.current.a.draft).not.toBeNull());

    const before = result.current.a;
    rerender();
    expect(result.current.a).toBe(before);
  });
});

describe("no lost edits (card 0cbf1049)", () => {
  function renderInProvider(ref = REF, client = freshClient()) {
    return renderHook(() => useTemplateDraftContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <TemplateDraftProvider slug={SLUG} templateRef={ref}>
            {children}
          </TemplateDraftProvider>
        </QueryClientProvider>
      ),
    });
  }

  it("issues the pending PATCH when the store unmounts inside the debounce window", async () => {
    servePatch();
    const { result, unmount } = renderInProvider();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Typed then left"));
    // Deliberately BEFORE the 800ms debounce: this is the window the operator
    // loses work in — the timer would otherwise be cleared, not fired.
    expect(patches).toHaveLength(0);

    unmount();

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ name: "Typed then left" });
  });

  it("issues NOTHING when a clean store unmounts", async () => {
    servePatch();
    const { result, unmount } = renderInProvider();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(patches).toHaveLength(0);
  });

  it("issues nothing when a read-only (system) store unmounts", async () => {
    servePatch();
    const { result, unmount } = renderInProvider("coding-loop");
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.readOnly).toBe(true);

    // setField is refused on a system template, so there is nothing pending;
    // the unmount path must not invent a PATCH out of the hydrated draft.
    act(() => result.current.setField("name", "Nope"));
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(patches).toHaveLength(0);
  });

  it("does not re-issue the PATCH a second time when the same unmount runs twice", async () => {
    // StrictMode double-invokes effect cleanups. `flush()` clears dirtyRef via
    // persist(), but the second cleanup must not fire a duplicate save.
    servePatch();
    const { result, unmount } = renderInProvider();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.setField("name", "Once only"));
    unmount();

    await waitFor(() => expect(patches).toHaveLength(1));
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(patches).toHaveLength(1);
  });

  it("registers a beforeunload handler only while there is unsaved work", async () => {
    servePatch();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { result } = renderInProvider();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    const beforeAdds = add.mock.calls.filter(([type]) => type === "beforeunload");
    expect(beforeAdds).toHaveLength(0);

    act(() => result.current.setField("name", "Dirty now"));
    await waitFor(() =>
      expect(
        add.mock.calls.filter(([type]) => type === "beforeunload"),
      ).toHaveLength(1),
    );

    await settleAutosave();
    await waitFor(() => expect(result.current.hasUnsavedWork).toBe(false));
    expect(
      remove.mock.calls.filter(([type]) => type === "beforeunload"),
    ).not.toHaveLength(0);

    add.mockRestore();
    remove.mockRestore();
  });

  it("the beforeunload handler calls preventDefault so the browser prompts", async () => {
    servePatch();
    const handlers: EventListener[] = [];
    const add = vi
      .spyOn(window, "addEventListener")
      .mockImplementation(((type: string, handler: EventListener) => {
        if (type === "beforeunload") handlers.push(handler);
      }) as typeof window.addEventListener);

    const { result } = renderInProvider();
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setField("name", "Dirty"));
    await waitFor(() => expect(handlers).toHaveLength(1));
    add.mockRestore();

    // jsdom fires the event but shows no chrome; preventDefault IS the contract.
    //
    // Spied directly rather than read off `defaultPrevented`: in jsdom the
    // legacy `event.returnValue = ""` assignment ALSO flips defaultPrevented,
    // so that assertion stays green on a handler that never calls
    // preventDefault at all — and Safari/Firefox honour only the real call.
    const event = new Event("beforeunload", { cancelable: true });
    const prevented = vi.spyOn(event, "preventDefault");
    handlers[0]?.(event);
    expect(prevented).toHaveBeenCalled();
    // Both halves cancel; asserting the outcome too keeps the test honest if
    // the handler ever drops one of them.
    expect(event.defaultPrevented).toBe(true);
  });
});

// Card 2c18790f (F6) — a MEMBER could type into every editor field and have
// each autosave rejected by a 403 the store threw away. Two independent bugs:
// the read-only predicate never consulted role, and the persist catch knew
// only about 409.
describe("read-only by role (card 2c18790f)", () => {
  function serveFailingPatch(status: number) {
    server.use(
      http.patch(DETAIL_URL, () => {
        patches.push({});
        return new HttpResponse(null, { status });
      }),
    );
  }

  describe("the readOnly matrix", () => {
    it("a MEMBER cannot edit a workspace template", async () => {
      adminState.current = { role: "member", isLoading: false, isError: false };
      servePatch();
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      expect(result.current.readOnly).toBe(true);

      act(() => result.current.setField("name", "Cannot edit"));
      await settleAutosave();
      await settleAutosave();

      // AC1: no PATCH, and the draft never went dirty in the first place.
      expect(patches).toHaveLength(0);
      expect(result.current.dirty).toBe(false);
      expect(result.current.draft?.name).toBe("My loop");
    });

    it("an ADMIN can still edit a workspace template", async () => {
      adminState.current = { role: "admin", isLoading: false, isError: false };
      servePatch();
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      expect(result.current.readOnly).toBe(false);

      act(() => result.current.setField("name", "Edited"));
      await settleAutosave();

      expect(patches).toHaveLength(1);
    });

    it("an OWNER can edit a workspace template", async () => {
      adminState.current = { role: "owner", isLoading: false, isError: false };
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      expect(result.current.readOnly).toBe(false);
    });

    it("an ADMIN still cannot edit a SYSTEM template", async () => {
      adminState.current = { role: "admin", isLoading: false, isError: false };
      const { result } = renderDraft("coding-loop");
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      // AC3: the system rule survives the role rule; both together, not either
      // replacing the other.
      expect(result.current.readOnly).toBe(true);
      expect(result.current.readOnlyReason).toBe("system");
    });

    it("a MEMBER on a SYSTEM template is told it is a system template", async () => {
      adminState.current = { role: "member", isLoading: false, isError: false };
      const { result } = renderDraft("coding-loop");
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      // AC7: the two reasons are never interchangeable. When BOTH apply, the
      // system reason wins — its remedy (there is none, duplicate instead) is
      // the true one; "ask an admin for a role" would send the operator to a
      // person who also cannot edit it.
      expect(result.current.readOnlyReason).toBe("system");
    });

    it("a MEMBER on a workspace template is told it is their role", async () => {
      adminState.current = { role: "member", isLoading: false, isError: false };
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      expect(result.current.readOnlyReason).toBe("role");
    });

    it("an editable store reports NO read-only reason", async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      expect(result.current.readOnly).toBe(false);
      expect(result.current.readOnlyReason).toBeNull();
    });

    it("treats a member-list ERROR as not-admin, never as admin", async () => {
      // A member may legitimately lack permission to read the member list. An
      // errored role lookup must fail CLOSED — reading `isAdmin: false` off an
      // errored query is the only safe interpretation.
      adminState.current = { role: null, isLoading: false, isError: true };
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      expect(result.current.readOnly).toBe(true);
      expect(result.current.readOnlyReason).toBe("role");
    });
  });

  describe("the role-resolving window fails closed", () => {
    it("is read-only while the role is still LOADING", async () => {
      adminState.current = { role: null, isLoading: true, isError: false };
      servePatch();
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      // AC4 first half: an unresolved role is not an admin. Typing here would
      // be discarded by the backend, so the field must refuse it.
      expect(result.current.readOnly).toBe(true);

      act(() => result.current.setField("name", "Raced the resolve"));
      await settleAutosave();
      expect(patches).toHaveLength(0);
    });

    it("becomes editable when the role resolves to admin, without a remount", async () => {
      adminState.current = { role: null, isLoading: true, isError: false };
      servePatch();
      const { result, rerender } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());
      expect(result.current.readOnly).toBe(true);

      // AC4 second half: the same mounted store flips to editable. A store
      // that only reads the role at mount would stay read-only forever for
      // anyone whose member list resolved a beat after the template did.
      adminState.current = { role: "admin", isLoading: false, isError: false };
      rerender();

      await waitFor(() => expect(result.current.readOnly).toBe(false));

      act(() => result.current.setField("name", "Now editable"));
      await settleAutosave();
      expect(patches).toHaveLength(1);
    });
  });

  describe("persist() stops swallowing non-409 failures", () => {
    it("toasts the PERMISSION message on a 403 and latches no conflict", async () => {
      serveFailingPatch(403);
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      act(() => result.current.setField("name", "Edited"));
      await settleAutosave();

      expect(patches).toHaveLength(1);
      expect(toast.error).toHaveBeenCalledWith(
        "You do not have permission to edit this template.",
        expect.objectContaining({ id: expect.any(String) }),
      );
      // AC5: nothing is latched — the operator may still be granted the role,
      // and the next edit should be allowed to try again.
      expect(result.current.conflict).toBe(false);
    });

    it("toasts the GENERIC message on a 500", async () => {
      serveFailingPatch(500);
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      act(() => result.current.setField("name", "Edited"));
      await settleAutosave();

      expect(toast.error).toHaveBeenCalledWith(
        "Could not save your changes. Your edits are still here — try again.",
        expect.objectContaining({ id: expect.any(String) }),
      );
      expect(result.current.conflict).toBe(false);
    });

    it("toasts the GENERIC message when the failure is not an ApiError at all", async () => {
      // A network drop rejects with a plain Error; reading `.status` off it
      // yields undefined, which must not fall through as "not a 403, so fine".
      server.use(http.patch(DETAIL_URL, () => HttpResponse.error()));
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      act(() => result.current.setField("name", "Edited"));
      await settleAutosave();

      expect(toast.error).toHaveBeenCalledWith(
        "Could not save your changes. Your edits are still here — try again.",
        expect.objectContaining({ id: expect.any(String) }),
      );
    });

    it("still latches conflict on a 409 and raises NO toast", async () => {
      serveFailingPatch(409);
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      act(() => result.current.setField("name", "Edited"));
      await settleAutosave();

      await waitFor(() => expect(result.current.conflict).toBe(true));
      // AC5 last clause: the conflict banner owns that message. A toast on top
      // of it would say the same thing twice with two different remedies.
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("reuses ONE toast id so a keystroke burst cannot stack a wall of toasts", async () => {
      serveFailingPatch(403);
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      act(() => result.current.setField("name", "one"));
      await settleAutosave();
      act(() => result.current.setField("name", "two"));
      await settleAutosave();

      expect(patches).toHaveLength(2);
      const ids = vi
        .mocked(toast.error)
        .mock.calls.map((call) => (call[1] as { id?: string } | undefined)?.id);
      expect(ids).toHaveLength(2);
      // sonner replaces a toast rendered under an id it already shows, so a
      // stable id is what collapses the burst into one visible toast.
      expect(new Set(ids).size).toBe(1);
    });

    it("never toasts on a SUCCESSFUL save", async () => {
      servePatch();
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      // Cleared HERE, not in beforeEach: a rejected persist left in flight by
      // an earlier case settles during this test's first timer advance and
      // would otherwise land its toast inside this assertion window.
      vi.mocked(toast.error).mockClear();

      act(() => result.current.setField("name", "Edited"));
      await settleAutosave();

      expect(patches).toHaveLength(1);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe("a read-only store holds no unsaved work", () => {
    it("reports hasUnsavedWork false for a member however hard they type", async () => {
      adminState.current = { role: "member", isLoading: false, isError: false };
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft).not.toBeNull());

      act(() => result.current.setField("name", "a"));
      act(() => result.current.setField("profile.tagline", "b"));

      // AC8: the leave guard reads exactly this, so a member is never stopped
      // on the way out by work that could not have been created.
      expect(result.current.hasUnsavedWork).toBe(false);
    });
  });
});

// Card 2c18790f (F6) — the ONE path that reaches persist()'s own readOnly
// guard. `setField` refuses a read-only store, so nothing a member does can
// get there; the reachable case is a role that goes read-only while a dirty
// draft already exists — an admin demoted mid-session, or a member-list
// refetch that resolves differently than it did at mount.
describe("a role that drops mid-edit (card 2c18790f)", () => {
  it("refuses to flush a dirty draft once the role has gone read-only", async () => {
    servePatch();
    const { result, rerender } = renderDraft();
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    // Dirty it as an admin, but do NOT let the debounce fire.
    act(() => result.current.setField("name", "Edited while admin"));
    expect(result.current.dirty).toBe(true);
    expect(patches).toHaveLength(0);

    // The role drops out from under the still-unsaved draft.
    adminState.current = { role: "member", isLoading: false, isError: false };
    rerender();
    await waitFor(() => expect(result.current.readOnly).toBe(true));

    // The leave guard and Publish both call flush() directly, bypassing
    // setField entirely. Without persist()'s own guard this PATCHes work the
    // backend will reject, and reports success when it does not.
    let landed: boolean | undefined;
    await act(async () => {
      landed = await result.current.flush();
    });

    expect(patches).toHaveLength(0);
    // It did not land, and flush must say so rather than claim a clean save.
    expect(landed).toBe(false);
  });
});
