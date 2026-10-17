// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import i18n from "@/i18n/config";
import { api } from "@/lib/api";
import { sessionKeys } from "@/lib/query-keys";
import { act, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { SessionContentWindowMode } from "@/types/agent-session";
import { SLUG, contentPage, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { contentWindowResponse } from "../../__tests__/window-fixtures";
import { useSession } from "../../api/use-sessions";
import { SessionTranscript } from "../SessionTranscript";

const SESSION = "reader-navigation";
const PATH = `/api/workspaces/${SLUG}/sessions/${SESSION}`;
const CONTENTS = `${PATH}/contents`;
const session = makeSession({ id: SESSION, capture_levels: ["rich"] });
const records = [1, 2, 3].map((order) => makeContent({
  id: `navigation-${order}`, session_id: SESSION,
  occurred_at: `2026-10-17T12:00:0${order}.000Z`,
  source: { kind: "claude_transcript", order },
  preview: { text: `Navigation record ${order}`, truncated: false },
}));
const pages = records.map((record) => contentPage([record]));
const clients: QueryClient[] = [];
const interceptors: number[] = [];

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function serveReader() {
  stubAuthModes(true);
  const state = {
    pages: pages.map((page) => ({ ...page, items: [...page.items] })),
    windows: [] as URLSearchParams[],
    legacy: [] as URLSearchParams[],
    authorityReads: 0,
    rawReads: 0,
    unsupported: false,
    hold: null as { mode: SessionContentWindowMode; promise: Promise<void> } | null,
    signals: [] as { mode: SessionContentWindowMode; signal: AbortSignal }[],
  };
  interceptors.push(api.interceptors.request.use((config) => {
    if (config.url?.endsWith("/contents/window") && config.signal) state.signals.push({ mode: config.params.mode, signal: config.signal as AbortSignal });
    return config;
  }));
  server.use(
    http.get(PATH, () => { state.authorityReads += 1; return HttpResponse.json(session); }),
    http.get(`${CONTENTS}/window`, async ({ request }) => {
      const params = new URL(request.url).searchParams;
      state.windows.push(params);
      if (state.hold?.mode === params.get("mode")) await state.hold.promise;
      return state.unsupported
        ? HttpResponse.json({ detail: "Route unavailable", error_code: "not_found" }, { status: 404 })
        : contentWindowResponse(state.pages, params);
    }),
    http.get(CONTENTS, ({ request }) => {
      const params = new URL(request.url).searchParams;
      state.legacy.push(params);
      const index = Number(params.get("cursor") ?? 0);
      return HttpResponse.json(contentPage([records[index]!], index < records.length - 1 ? String(index + 1) : null));
    }),
    http.get(`${CONTENTS}/:id/body`, () => { state.rawReads += 1; return HttpResponse.json({}); }),
    http.get(`${CONTENTS}/:id/download`, () => { state.rawReads += 1; return new HttpResponse(); }),
  );
  return state;
}

function Reader() {
  const authority = useSession(SLUG, SESSION, true);
  const location = useLocation();
  return <>
    <output aria-label="Current reader location">{location.hash}</output>
    {authority.data ? <SessionTranscript slug={SLUG} session={authority.data} /> : null}
  </>;
}

function renderReader(hash = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  return { ...renderWithProviders(<Reader />, {
    queryClient: client,
    routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION}${hash}`] },
  }), client };
}

const recordElement = (index: number) => document.getElementById(`content-${records[index - 1]!.id}`)!;
async function settled(client: QueryClient) { await waitFor(() => expect(client.isFetching()).toBe(0)); }
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  interceptors.splice(0).forEach((interceptor) => api.interceptors.request.eject(interceptor));
  vi.restoreAllMocks();
});

describe("session reader deliberate navigation", () => {
  it("replaces a pending window when an anchor names a record in its old placeholder", async () => {
    const state = serveReader(); const { client } = renderReader(); const user = userEvent.setup();
    await screen.findByText("Navigation record 3"); await settled(client);
    await user.click(within(recordElement(3)).getByRole("checkbox"));
    const earlier = deferred(); state.hold = { mode: "earlier", promise: earlier.promise };
    try {
      await user.click(screen.getByRole("button", { name: "Earlier records" }));
      await waitFor(() => expect(state.windows.map((params) => params.get("mode"))).toEqual(["latest", "earlier"]));
      expect(screen.getByText("Navigation record 3")).toBeVisible();
      await user.selectOptions(screen.getByRole("combobox", { name: "Jump to loaded content" }), records[2]!.id);
      await waitFor(() => expect(state.windows.map((params) => params.get("mode"))).toEqual(["latest", "earlier", "anchor"]));
      expect(state.windows[2]!.get("anchor_id")).toBe(records[2]!.id);
      await waitFor(() => expect(state.signals.find(({ mode }) => mode === "earlier")!.signal.aborted).toBe(true));
      await settled(client);
      await act(async () => { earlier.release(); });
      expect(screen.getByLabelText("Current reader location")).toHaveTextContent(`#content-${records[2]!.id}`);
      expect(recordElement(3)).toHaveFocus();
      expect(within(recordElement(3)).getByRole("checkbox")).toBeChecked();
      expect(screen.queryByText("Navigation record 2")).not.toBeInTheDocument();
      expect(state.rawReads).toBe(0); expect(state.legacy).toEqual([]);
    } finally { earlier.release(); }
  });

  it("lets deliberate navigation replace a passive refresh without disabling its controls", async () => {
    const state = serveReader(); const { client } = renderReader(`#content-${records[1]!.id}`); const user = userEvent.setup();
    await screen.findByText("Navigation record 2"); await settled(client);
    const refresh = deferred(); state.hold = { mode: "refresh", promise: refresh.promise };
    try {
      act(() => { void client.invalidateQueries({ queryKey: sessionKeys.contentsRoot(SLUG, SESSION) }); });
      await waitFor(() => expect(state.windows.map((params) => params.get("mode"))).toEqual(["anchor", "refresh"]));
      for (const name of ["Beginning", "Latest", "Earlier records", "Later records"]) expect(screen.getByRole("button", { name })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Beginning" }));
      await screen.findByText("Navigation record 1"); await settled(client);
      expect(state.signals.find(({ mode }) => mode === "refresh")!.signal.aborted).toBe(true);
      await act(async () => { refresh.release(); });
      expect(screen.getByRole("heading", { name: "Transcript" })).toHaveFocus();
      expect(screen.getByLabelText("Current reader location")).toBeEmptyDOMElement();
      expect(screen.queryByText("Navigation record 2")).not.toBeInTheDocument();
      expect(state.windows.map((params) => params.get("mode"))).toEqual(["anchor", "refresh", "beginning"]);
      expect(state.rawReads).toBe(0);
    } finally { refresh.release(); }
  });

  it.each(["digest", "render"] as const)("returns focus to the retained record after passive %s replacement without disclosing content or scrolling", async (change) => {
    const state = serveReader();
    state.pages[2]!.items[0] = { ...records[2]!, preview: { text: "Short retained preview", truncated: true } };
    const { client } = renderReader();
    await screen.findByText("Short retained preview"); await settled(client);
    const retained = recordElement(3);
    const disclosure = within(retained).getByRole("button", { name: /^Show all/ });
    act(() => { disclosure.focus(); });
    expect(disclosure).toHaveFocus();
    const focus = vi.spyOn(retained, "focus");
    const scrollIntoView = vi.fn();
    retained.scrollIntoView = scrollIntoView;
    screen.getByRole("heading", { name: "Transcript" }).scrollIntoView = scrollIntoView;
    const scrollBy = vi.spyOn(window, "scrollBy");
    const current = state.pages[2]!.items[0]!;
    state.pages[2]!.items[0] = change === "digest"
      ? { ...current, sha256: "b".repeat(64), preview: { text: "Changed retained preview", truncated: true } }
      : { ...current, render: "image", channel: "attachment", media_type: "image/png", preview: null };

    await act(async () => { await client.invalidateQueries({ queryKey: sessionKeys.contentsRoot(SLUG, SESSION) }); });
    await settled(client);
    expect(recordElement(3)).toBe(retained);
    expect(disclosure).not.toBeInTheDocument();
    expect(retained).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.getByRole("heading", { name: "Transcript" })).not.toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(state.windows.map((params) => params.get("mode"))).toEqual(["latest", "refresh"]);
    expect(state.rawReads).toBe(0); expect(state.legacy).toEqual([]);
    expect(within(retained).getByRole("button", { name: change === "digest" ? /^Show all/ : "Show image" })).toBeEnabled();

    // A subsequent passive replacement must not take focus from a deliberate
    // control outside the replaced record.
    const beginning = screen.getByRole("button", { name: "Beginning" });
    act(() => { beginning.focus(); });
    state.pages[2]!.items[0] = { ...state.pages[2]!.items[0]!, sha256: "c".repeat(64) };
    focus.mockClear();
    await act(async () => { await client.invalidateQueries({ queryKey: sessionKeys.contentsRoot(SLUG, SESSION) }); });
    await settled(client);
    expect(beginning).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(state.rawReads).toBe(0);
  });

  it.each([false, true])("does not reclaim deliberately blurred focus on passive refresh (digest changes: %s)", async (changeDigest) => {
    const state = serveReader();
    state.pages[2]!.items[0] = { ...records[2]!, preview: { text: "Deliberately left preview", truncated: true } };
    const { client } = renderReader();
    await screen.findByText("Deliberately left preview"); await settled(client);
    const retained = recordElement(3);
    const disclosure = within(retained).getByRole("button", { name: /^Show all/ });
    act(() => { disclosure.focus(); });
    expect(disclosure).toHaveFocus();
    await act(async () => { disclosure.blur(); await Promise.resolve(); });
    expect(disclosure.isConnected).toBe(true);
    expect(document.body).toHaveFocus();
    const focus = vi.spyOn(retained, "focus");
    const scrollBy = vi.spyOn(window, "scrollBy");
    if (changeDigest) state.pages[2]!.items[0] = { ...state.pages[2]!.items[0]!, sha256: "d".repeat(64) };

    await act(async () => { await client.invalidateQueries({ queryKey: sessionKeys.contentsRoot(SLUG, SESSION) }); });
    await settled(client);
    expect(recordElement(3)).toBe(retained);
    expect(document.body).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(state.rawReads).toBe(0);
    expect(state.windows.map((params) => params.get("mode"))).toEqual(["latest", "refresh"]);
  });

  it("keeps Beginning available after paging through an explicitly chosen old-server fallback", async () => {
    const state = serveReader(); state.unsupported = true;
    const { client } = renderReader(); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Read from beginning" }));
    await screen.findByText("Navigation record 1"); await settled(client);
    expect(state.authorityReads).toBe(2);
    await user.click(screen.getByRole("button", { name: "Later records" }));
    await screen.findByText("Navigation record 2"); await settled(client);
    await user.click(screen.getByRole("button", { name: "Beginning" }));
    await screen.findByText("Navigation record 1"); await settled(client);
    expect(screen.getByText("Reading in source order on this server.")).toBeVisible();
    expect(state.legacy.map((params) => params.get("cursor"))).toEqual([null, "1", null]);
    expect(screen.queryByRole("button", { name: "Latest" })).not.toBeInTheDocument();
    expect(screen.queryByText("Navigation record 2")).not.toBeInTheDocument();
    expect(state.rawReads).toBe(0); expect(state.windows).toHaveLength(1);
  });

  it("explains an unlocated old-server anchor without claiming that the record is unavailable", async () => {
    const state = serveReader(); state.unsupported = true;
    const { client } = renderReader(`#content-${records[2]!.id}`); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Read from beginning" }));
    await screen.findByText("Navigation record 1"); await settled(client);
    const unlocated = screen.getByText("The linked record is not in the loaded records.");
    expect(unlocated).toHaveAttribute("role", "status");
    expect(screen.getByRole("heading", { name: "Transcript" })).toHaveFocus();
    expect(screen.queryByText("Linked record unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later records" })).toBeEnabled();
    expect(state.windows).toHaveLength(1); expect(state.legacy).toHaveLength(1); expect(state.rawReads).toBe(0);
  });

  it("announces an unavailable anchor and focuses the stable reader heading without falling back", async () => {
    const state = serveReader(); const { client } = renderReader("#content-missing-record");
    const unavailable = await screen.findByText("Linked record unavailable"); await settled(client);
    expect.soft(unavailable).toHaveAttribute("role", "status");
    expect.soft(screen.getByRole("heading", { name: "Transcript" })).toHaveFocus();
    expect(screen.getByRole("region", { name: "Transcript" })).toBeVisible();
    expect(state.windows.map((params) => [params.get("mode"), params.get("anchor_id")])).toEqual([["anchor", "missing-record"]]);
    expect(state.legacy).toEqual([]); expect(state.rawReads).toBe(0);
    expect(screen.queryByRole("button", { name: "Read from beginning" })).not.toBeInTheDocument();
  });
});
