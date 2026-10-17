// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { api } from "@/lib/api";
import { sessionKeys } from "@/lib/query-keys";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { SessionContent } from "@/types/agent-session";
import { SessionReaderActive } from "../../api/use-session-contents";
import { SLUG, contentPage, makeCall, makeContent, makeSession } from "../../__tests__/fixtures";
import { CallRow } from "../CallRow";
import { ContentBody } from "../ContentBody";
import { SessionTranscript } from "../SessionTranscript";

const SESSION = "reader-privacy";
const PATH = `/api/workspaces/${SLUG}/sessions/${SESSION}`;
const clients: ReturnType<typeof createTestQueryClient>[] = [];
const interceptors: number[] = [];

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderBody(item: SessionContent) {
  const client = createTestQueryClient();
  clients.push(client);
  function Reader() {
    const [active, setActive] = useState(true);
    return <>
      <button onClick={() => setActive(false)}>Leave reader</button>
      <SessionReaderActive.Provider value={active}>
        <div hidden={!active}><ContentBody slug={SLUG} sessionId={SESSION} content={item} prose={false} /></div>
      </SessionReaderActive.Provider>
    </>;
  }
  return { client, ...renderWithProviders(<Reader />, { queryClient: client }) };
}

function observeSignal(suffix: string) {
  let signal: { readonly aborted: boolean } | undefined;
  interceptors.push(api.interceptors.request.use((config) => {
    if (config.url?.endsWith(suffix)) signal = config.signal;
    return config;
  }));
  return () => signal;
}

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reader-private");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  interceptors.splice(0).forEach((id) => api.interceptors.request.eject(id));
  vi.restoreAllMocks();
});

describe("reader disclosure and cancellation", () => {
  it("closes message, grouped body, and image disclosure when refreshed metadata changes its digest", async () => {
    let version = 1;
    const requests: string[] = [];
    const items = () => [
      makeContent({ id: "changed-message", session_id: SESSION, sha256: `digest-${version}`, preview: null }),
      makeContent({ id: "changed-part", session_id: SESSION, sha256: `digest-${version}`, call_id: "changed-call", channel: "tool_output", role: "tool", preview: null }),
      makeContent({ id: "changed-image", session_id: SESSION, sha256: `digest-${version}`, render: "image", channel: "attachment", media_type: "image/png", preview: null }),
    ];
    server.use(
      http.get(`${PATH}/contents/window`, () => HttpResponse.json({ capability: "content-window-v1", mode: "refresh", items: items(), earlier_cursor: null, later_cursor: null, window_cursor: "fixed-bounds", anchor_id: null })),
      http.get(`${PATH}/contents/changed-image/download`, () => { requests.push(`changed-image:${version}`); return new HttpResponse(new Uint8Array([1])); }),
      http.get(`${PATH}/contents/:id/body`, ({ params }) => {
        requests.push(`${params.id}:${version}`);
        const text = `DISCLOSED_VERSION_${version}_${params.id}`;
        return HttpResponse.json({ content_id: params.id, text, offset: 0, next_offset: null, total_bytes: new TextEncoder().encode(text).length });
      }),
    );
    const client = createTestQueryClient(); clients.push(client);
    renderWithProviders(<SessionTranscript slug={SLUG} session={makeSession({ id: SESSION, capture_levels: ["rich"] })} />, { queryClient: client });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Show content" });
    const grouped = document.getElementById("content-changed-part")!;
    await user.click(within(grouped).getByRole("button", { expanded: false }));
    for (const show of screen.getAllByRole("button", { name: "Show content" })) await user.click(show);
    await screen.findByText("DISCLOSED_VERSION_1_changed-message");
    await screen.findByText("DISCLOSED_VERSION_1_changed-part");
    await user.click(screen.getByRole("button", { name: "Show image" }));
    await screen.findByRole("img");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(requests).toEqual(["changed-message:1", "changed-part:1", "changed-image:1"]);
    version = 2;
    await act(async () => { await client.invalidateQueries({ queryKey: sessionKeys.contentsRoot(SLUG, SESSION) }); });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(requests).toEqual(["changed-message:1", "changed-part:1", "changed-image:1"]);
    expect(screen.queryByText(/DISCLOSED_VERSION_/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Show content" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show image" })).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Show content" })[0]!);
    await screen.findByText("DISCLOSED_VERSION_2_changed-message");
    expect(requests).toEqual(["changed-message:1", "changed-part:1", "changed-image:1", "changed-message:2"]);
  });

  it("focuses a native anchor as safe metadata until Everything is deliberately selected", async () => {
    const item = makeContent({ id: "native-anchor", session_id: SESSION, channel: "native_record", preview: { text: "RAW_PRIVATE_PREVIEW", truncated: true } });
    const reads: string[] = [];
    server.use(http.get(`${PATH}/contents/window`, ({ request }) => {
      reads.push(new URL(request.url).searchParams.get("mode")!);
      return HttpResponse.json({ capability: "content-window-v1", mode: "anchor", items: [item], earlier_cursor: null, later_cursor: null, window_cursor: "pinned-native", anchor_id: item.id });
    }));
    const client = createTestQueryClient(); clients.push(client);
    renderWithProviders(<SessionTranscript slug={SLUG} session={makeSession({ id: SESSION, capture_levels: ["rich"] })} />, { queryClient: client, routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION}#content-${item.id}`] } });
    await screen.findByText(/1 raw record in this window is hidden/);
    expect(document.getElementById(`content-${item.id}`)).toHaveFocus();
    expect(screen.queryByText("RAW_PRIVATE_PREVIEW")).not.toBeInTheDocument();
    expect(reads).toEqual(["anchor"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Everything" }));
    expect(await screen.findByText("RAW_PRIVATE_PREVIEW")).toBeVisible();
    expect(document.getElementById(`content-${item.id}`)).toHaveFocus();
  });

  it.each(["text", "image"] as const)("requests %s bytes only after disclosure and aborts them on unmount", async (render) => {
    const item = makeContent({ id: render, session_id: SESSION, render, channel: render === "image" ? "attachment" : "reply", media_type: render === "image" ? "image/png" : "text/plain", preview: null });
    const suffix = `/${item.id}/${render === "image" ? "download" : "body"}`;
    const signal = observeSignal(suffix);
    const pending = deferredResponse();
    const requests: string[] = [];
    server.use(http.get(`${PATH}/contents${suffix}`, ({ request }) => { requests.push(request.url); return pending.promise; }));
    const { unmount } = renderBody(item);
    const user = userEvent.setup();
    expect(requests).toEqual([]);
    await user.click(screen.getByRole("button", { name: render === "image" ? "Show image" : "Show content" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(signal()?.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(signal()?.aborted).toBe(true));
    await act(async () => { pending.resolve(render === "image" ? new HttpResponse(new Uint8Array([1])) : HttpResponse.json({ content_id: item.id, text: "Private late body", offset: 0, next_offset: null, total_bytes: 17 })); });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("aborts an explicit download before a late response can click a save link", async () => {
    const item = makeContent({ id: "download", session_id: SESSION, render: "download", channel: "attachment", media_type: "application/pdf", preview: null });
    const signal = observeSignal(`/${item.id}/download`);
    const pending = deferredResponse();
    let reads = 0;
    server.use(http.get(`${PATH}/contents/${item.id}/download`, () => { reads += 1; return pending.promise; }));
    const { unmount } = renderBody(item);
    expect(reads).toBe(0);
    await userEvent.setup().click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(reads).toBe(1));
    unmount();
    await waitFor(() => expect(signal()?.aborted).toBe(true));
    await act(async () => { pending.resolve(new HttpResponse(new Uint8Array([1]))); });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("cancels a pending body read when its mounted reader becomes inactive", async () => {
    const item = makeContent({ id: "pending", session_id: SESSION, preview: null });
    const signal = observeSignal(`/${item.id}/body`);
    const pending = deferredResponse();
    server.use(http.get(`${PATH}/contents/${item.id}/body`, () => pending.promise));
    renderBody(item);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show content" }));
    await waitFor(() => expect(signal()?.aborted).toBe(false));
    try {
      await user.click(screen.getByRole("button", { name: "Leave reader" }));
      await waitFor(() => expect(signal()?.aborted).toBe(true));
    } finally { pending.resolve(HttpResponse.json({ content_id: item.id, text: "Late private text", offset: 0, next_offset: null, total_bytes: 17 })); }
  });

  it("does not refresh an expanded call or literal content inspector while Timeline is inactive", async () => {
    const client = createTestQueryClient(); clients.push(client);
    const call = makeCall({ key: "call", call_id: "native-call", name: "Inspect fixture", outcome: "unknown" });
    const item = makeContent({ id: "call-content", session_id: SESSION, call_id: "native-call", preview: { text: "Private call preview", truncated: false } });
    const reads: string[] = [];
    server.use(
      http.get(`${PATH}/calls/call`, () => { reads.push("detail"); return HttpResponse.json({ key: call.key, events: [] }); }),
      http.get(`${PATH}/contents`, ({ request }) => { reads.push(new URL(request.url).searchParams.get("call_id")!); return HttpResponse.json(contentPage([item])); }),
    );
    function Reader() {
      const [active, setActive] = useState(true);
      return <><button onClick={() => setActive(false)}>Leave Timeline</button><SessionReaderActive.Provider value={active}><ul hidden={!active}><CallRow slug={SLUG} sessionId={SESSION} item={call} /></ul></SessionReaderActive.Provider></>;
    }
    renderWithProviders(<Reader />, { queryClient: client });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Inspect fixture/ }));
    await user.click(await screen.findByRole("button", { name: "Inspect captured content" }));
    await screen.findByText("Private call preview");
    expect(reads).toEqual(["detail", "native-call"]);
    await user.click(screen.getByRole("button", { name: "Leave Timeline" }));
    await act(async () => { await client.invalidateQueries({ queryKey: sessionKeys.detail(SLUG, SESSION) }); });
    expect(reads).toEqual(["detail", "native-call"]);
    expect(screen.queryByText("Private call preview")).not.toBeVisible();
  });
});
