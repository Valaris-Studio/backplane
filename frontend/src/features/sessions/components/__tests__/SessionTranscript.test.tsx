// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import i18n from "@/i18n/config";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { sessionKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { AgentSession, SessionContent, SessionContentPage } from "@/types/agent-session";
import { ME, SLUG, callPage, contentPage, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { contentWindowResponse, selectedMetadata, windowFromResponse } from "../../__tests__/window-fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { formatBytes, formatClock } from "../../utils/format";
import { SessionDetailPage } from "../SessionDetailPage";
import { SessionRealtimeOwner } from "../SessionRealtimeOwner";

type SessionSubscriber = (event: WebSocketEvent) => void;
const socket = { handlers: new Map<string, Set<SessionSubscriber>>() };
const subscribe = (pattern: string, callback: SessionSubscriber) => {
  const handlers = socket.handlers.get(pattern) ?? new Set<SessionSubscriber>();
  socket.handlers.set(pattern, handlers);
  handlers.add(callback);
  return () => { handlers.delete(callback); };
};
const socketContext = { status: "connected" as const, subscribe };

// Read at run time from the repository: the frontend also builds on its own,
// where contracts/ is absent.
const READER_PAGE = (
  JSON.parse(readFileSync(path.resolve(__dirname, "../../../../../../contracts/rich-capture/wire/reader-content-page.json"), "utf8")) as {
    body: SessionContentPage;
  }
).body;

const SESSION_ID = "6f1c2d0e-8a3b-4c5d-9e7f-0a1b2c3d4e5f";
const CONTENTS = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}/contents`;
// The realtime hook coalesces an agent's bursts for 2 s; live tests step a fake clock past it.
const PAST_DEBOUNCE_MS = 2100;

function useFakeClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
}

interface ContentServer {
  listRequests: URLSearchParams[];
  bodyRequests: { id: string; offset: string | null }[];
  downloads: string[];
}

interface ServeOptions {
  session?: Partial<AgentSession>;
  pages?: SessionContentPage[];
  list?: () => Response | Promise<Response>;
}

function serveSession(options: ServeOptions = {}): ContentServer {
  stubAuthModes(true);
  const requests: ContentServer = { listRequests: [], bodyRequests: [], downloads: [] };
  const session = makeSession({ id: SESSION_ID, title: "Add a retry to the uploader", capture_levels: ["rich"], ...options.session });
  const pages = options.pages ?? [contentPage([])];
  server.use(
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}`, () => HttpResponse.json(session)),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/calls`, () => HttpResponse.json(callPage([]))),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/usage`, () => HttpResponse.json({ price_table_version: "x", items: [] })),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/rhythm`, () =>
      HttpResponse.json({ start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 }),
    ),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/links`, () => HttpResponse.json({ items: [] })),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
    http.get(`${CONTENTS}/window`, async ({ request }) => {
      const params = new URL(request.url).searchParams;
      requests.listRequests.push(params);
      if (options.list) return windowFromResponse(await options.list(), params);
      return contentWindowResponse(pages, params);
    }),
    http.post(`${CONTENTS}/metadata`, async ({ request }) => {
      const { content_ids } = await request.json() as { content_ids: string[] };
      let current = pages;
      if (options.list) {
        const response = await options.list();
        if (!response.ok) return response;
        current = [await response.json() as SessionContentPage];
      }
      return HttpResponse.json(selectedMetadata(current.flatMap((page) => page.items), content_ids));
    }),
  );
  return requests;
}

function serveBody(requests: ContentServer, id: string, text: string, pageBytes = 256 * 1024) {
  const bytes = new TextEncoder().encode(text);
  server.use(
    http.get(`${CONTENTS}/${id}/body`, ({ request }) => {
      const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
      requests.bodyRequests.push({ id, offset: new URL(request.url).searchParams.get("offset") });
      const end = Math.min(offset + pageBytes, bytes.length);
      return HttpResponse.json({
        content_id: id,
        offset,
        next_offset: end === bytes.length ? null : end,
        total_bytes: bytes.length,
        text: new TextDecoder().decode(bytes.slice(offset, end)),
      });
    }),
  );
}

async function renderSession(queryClient?: QueryClient) {
  const view = renderWithProviders(
    <WebSocketContext.Provider value={socketContext}>
      <Routes>
        <Route path="/:slug/sessions/:sessionId" element={<><SessionRealtimeOwner slug={SLUG} /><SessionDetailPage /></>} />
      </Routes>
    </WebSocketContext.Provider>,
    { routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION_ID}`] }, queryClient },
  );
  fireEvent.click(await screen.findByRole("tab", { name: i18n.t("sessions.detail.tabs.transcript") }));
  return view;
}

async function transcript() {
  return screen.findByRole("list", { name: "Transcript" });
}

function entry(list: HTMLElement, label: string) {
  return within(list).getByRole("listitem", { name: label });
}

function entryNames(list: HTMLElement) {
  return within(list)
    .getAllByRole("listitem")
    .map((item) => (item.getAttribute("aria-labelledby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent).join(" "));
}

async function emitSessionUpdate(reason: string, ownerId = ME) {
  const handlers = socket.handlers.get("agent_session.*");
  if (!handlers?.size) throw new Error("the workspace owner does not listen for agent_session events");
  act(() => {
    for (const handler of [...handlers]) handler({
      event: "agent_session.updated",
      timestamp: new Date().toISOString(),
      event_id: `evt-${reason}`,
      payload: { owner_id: ownerId, session_id: SESSION_ID, workspace_id: "ws-1", reason },
    });
  });
  await act(() => vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS));
}

async function settled(queryClient: QueryClient) {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
}

beforeEach(() => {
  socket.handlers.clear();
  let urls = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:session-content-${++urls}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(async () => {
  act(() => setPromptsHidden(false));
  vi.useRealTimers();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("Transcript — the contract's content page", () => {
  it("lists every item of the wire page in the server's order, each with its label", async () => {
    serveSession({ pages: [READER_PAGE] });
    await renderSession();

    const list = await transcript();
    expect(entryNames(list)).toEqual(["Attachment", "Prompt", "Claude Code", "Tool call", "Attachment", "Instructions", "Tool call", "Attachment"]);
    expect(within(entry(list, "Prompt")).getByText("Add a retry with exponential backoff to the uploader and keep the tests green.")).toBeInTheDocument();
    expect(within(entry(list, "Instructions")).getByText("CLAUDE.md")).toBeInTheDocument();
    expect(within(entry(list, "Prompt")).getByRole("checkbox", { name: /^Select Prompt, source item/ })).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Jump to loaded content" })).getByRole("option", { name: /^Prompt ·/ })).toBeInTheDocument();
  });

  it("gives each item a stable anchor and copies its link", async () => {
    const user = userEvent.setup();
    serveSession({ pages: [contentPage([makeContent({ id: "4fcdae96-5071-4293-8e3f-4a5b6c7d8e9f" })])] });
    await renderSession();

    const list = await transcript();
    const item = entry(list, "Claude Code");
    expect(item).toHaveAttribute("id", "content-4fcdae96-5071-4293-8e3f-4a5b6c7d8e9f");
    await user.click(within(item).getByRole("button", { name: "Copy link to this item" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain(`/${SLUG}/sessions/${SESSION_ID}#content-4fcdae96-5071-4293-8e3f-4a5b6c7d8e9f`),
    );
  });

  it("names the source of every item and the call it belongs to", async () => {
    serveSession({
      pages: [
        contentPage([
          makeContent({ id: "in", role: "tool", channel: "tool_input", call_id: "toolu_01AbC", source: { kind: "claude_transcript", order: 47 } }),
        ]),
      ],
    });
    await renderSession();

    const tool = entry(await transcript(), "Tool call");
    expect(within(tool).getByText("toolu_01AbC")).toBeInTheDocument();
    expect(within(tool).getByText("Claude Code transcript #47")).toBeInTheDocument();
  });

  it("keeps an empty captured-content view discoverable when the historical capture level was standard", async () => {
    const requests = serveSession({ session: { capture_levels: ["standard"] }, pages: [contentPage([])] });
    await renderSession();

    await screen.findByRole("heading", { level: 1, name: "Add a retry to the uploader" });
    await waitFor(() => expect(requests.listRequests).toHaveLength(1));
    expect(screen.queryByRole("list", { name: "Transcript" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Transcript" })).toBeVisible();
    expect(screen.getByText("No captured content was received for this session.")).toBeVisible();
  });
});

describe("Transcript — observed rich content availability", () => {
  it("distinguishes an empty observed window from hidden native-only records", async () => {
    const requests = serveSession({ session: { capture_levels: [] }, pages: [contentPage([])] });
    const first = await renderSession();
    await waitFor(() => expect(requests.listRequests).toHaveLength(1));
    expect(screen.getByText("No captured content was received for this session.")).toBeVisible();
    first.unmount();
    serveSession({ pages: [contentPage([makeContent({ id: "only-native", channel: "native_record", preview: { text: "SYNTHETIC_NATIVE", truncated: false } })])] });
    await renderSession();
    expect(await screen.findByText("Only raw records were captured. Choose Everything to see them.")).toBeInTheDocument();
    expect(screen.queryByText("No captured content was received for this session.")).not.toBeInTheDocument();
    expect(screen.queryByText("SYNTHETIC_NATIVE")).not.toBeInTheDocument();
  });

  it("does not call a pending rich metadata request empty", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const requests = serveSession({ list: () => pending });
    await renderSession();
    await waitFor(() => expect(requests.listRequests).toHaveLength(1));
    expect(screen.queryByText("No captured content was received for this session.")).not.toBeInTheDocument();
    await act(async () => release(HttpResponse.json(contentPage([makeContent()]))));
    await transcript();
    expect(screen.queryByText("No captured content was received for this session.")).not.toBeInTheDocument();
  });

  it.each([{ capture_levels: ["rich"] }, { capture_levels: ["rich", "standard"] }] satisfies { capture_levels: AgentSession["capture_levels"] }[])("explains an exhausted empty reader with historical levels $capture_levels without promising future content", async ({ capture_levels }) => {
    const requests = serveSession({ session: { capture_levels }, pages: [contentPage([])] });
    await renderSession();
    expect(await screen.findByText("No captured content was received for this session.")).toBeInTheDocument();
    expect(requests.listRequests).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.queryByText(/complete tool output|content will arrive/i)).not.toBeInTheDocument();
  });
});

describe("Transcript — messages, tools and edits", () => {
  it("groups a call's input, output and edit under one expandable tool call", async () => {
    const user = userEvent.setup();
    serveSession({
      pages: [
        contentPage([
          makeContent({ id: "p", role: "user", channel: "prompt", preview: { text: "Fix the parser", truncated: false } }),
          makeContent({ id: "in", role: "tool", channel: "tool_input", call_id: "call-7", media_type: "application/json", preview: { text: '{"file_path":"parser.go"}', truncated: false } }),
          makeContent({ id: "r", role: "assistant", channel: "reply", preview: { text: "Editing now.", truncated: false } }),
          makeContent({ id: "d", role: "tool", channel: "diff", call_id: "call-7", display_path: "internal/parser.go", media_type: "text/x-diff", preview: { text: "-old\n+new", truncated: false } }),
          makeContent({ id: "out", role: "tool", channel: "tool_output", call_id: "call-7", preview: { text: "The file was updated.", truncated: false } }),
        ]),
      ],
    });
    await renderSession();

    const list = await transcript();
    expect(entryNames(list)).toEqual(["Prompt", "Tool call", "Claude Code"]);

    const tool = entry(list, "Tool call");
    const toggle = within(tool).getByRole("button", { name: /Tool call/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(tool).queryByText("The file was updated.")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(tool).getByText("Input")).toBeInTheDocument();
    expect(within(tool).getByText("Edit · internal/parser.go")).toBeInTheDocument();
    expect(within(tool).getByText("Output")).toBeInTheDocument();
    expect(within(tool).getByText("The file was updated.")).toBeInTheDocument();
    expect(within(tool).getByText(/-old\s+\+new/)).toBeInTheDocument();
  });

  it("says on a closed tool call when one of its parts wasn't fully captured", async () => {
    serveSession({
      pages: [
        contentPage([
          makeContent({ id: "in", role: "tool", channel: "tool_input", call_id: "exec-9", preview: { text: "make test", truncated: false } }),
          makeContent({ id: "out", role: "tool", channel: "command_output", call_id: "exec-9", coverage: "not_yet_uploaded", coverage_reason: "upload_pending", render: "none", preview: null }),
        ]),
      ],
    });
    await renderSession();

    const tool = entry(await transcript(), "Tool call");
    expect(within(tool).getByRole("button", { name: /Tool call/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(tool).getByText("Uploading")).toBeInTheDocument();
  });

  it("blurs a closed tool call's preview while prompts are hidden", async () => {
    act(() => setPromptsHidden(true));
    serveSession({
      pages: [contentPage([makeContent({ id: "in", role: "tool", channel: "tool_input", call_id: "toolu_9", preview: { text: '{"command":"deploy --prod"}', truncated: false } })])],
    });
    await renderSession();

    const tool = entry(await transcript(), "Tool call");
    expect(within(tool).getByText('{"command":"deploy --prod"}').closest("[data-prompt-hidden]")).not.toBeNull();
  });

  it("opens a tool call from the keyboard", async () => {
    const user = userEvent.setup();
    serveSession({
      pages: [contentPage([makeContent({ id: "out", role: "tool", channel: "command_output", call_id: "exec-1", preview: { text: "ok 42 tests", truncated: false } })])],
    });
    await renderSession();

    const tool = entry(await transcript(), "Tool call");
    within(tool).getByRole("button", { name: /Tool call/ }).focus();
    await user.keyboard("{Enter}");
    expect(within(tool).getByText("ok 42 tests")).toBeInTheDocument();
  });

  it("hides raw native records until asked for everything", async () => {
    const user = userEvent.setup();
    serveSession({
      pages: [
        contentPage([
          makeContent({ id: "r", channel: "reply" }),
          makeContent({ id: "n", role: "unknown", channel: "native_record", media_type: "application/json", preview: { text: '{"type":"assistant"}', truncated: false } }),
        ]),
      ],
    });
    await renderSession();

    const list = await transcript();
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Everything" }));
    expect(entry(list, "Raw record")).toBeInTheDocument();
  });

  it("renders captured markdown without fetching anything it names", async () => {
    serveSession({
      pages: [
        contentPage([
          makeContent({
            id: "md",
            channel: "reply",
            media_type: "text/markdown",
            preview: {
              text: "**Done**\n\n![chart](https://tracker.example/pixel.png)\n\n[docs](https://example.com/docs) [run](javascript:alert(1))\n\n<script>alert(1)</script><img src=x onerror=alert(1)>",
              truncated: false,
            },
          }),
        ]),
      ],
    });
    await renderSession();

    const reply = entry(await transcript(), "Claude Code");
    expect(within(reply).getByText("Done").tagName).toBe("STRONG");
    expect(reply.querySelector("img")).toBeNull();
    expect(reply.querySelector("script")).toBeNull();
    expect(within(reply).getByRole("link", { name: "docs" })).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(within(reply).getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
    // The image becomes a plain link to its address, never an <img>.
    expect(within(reply).getByRole("link", { name: "chart" })).toHaveAttribute("href", "https://tracker.example/pixel.png");
    expect(within(reply).queryByRole("link", { name: "run" })).toBeNull();
  });

  it("blurs captured content while prompts are hidden", async () => {
    act(() => setPromptsHidden(true));
    serveSession({ pages: [contentPage([makeContent({ id: "r", preview: { text: "secret plan", truncated: false } })])] });
    await renderSession();

    const reply = entry(await transcript(), "Claude Code");
    expect(within(reply).getByText("secret plan").closest("[data-prompt-hidden]")).not.toBeNull();
  });
});

describe("Transcript — paging and large bodies", () => {
  it("opens recent records and replaces the window when reading earlier or later history", async () => {
    const user = userEvent.setup();
    const requests = serveSession({
      pages: [
        contentPage([makeContent({ id: "a", preview: { text: "first page", truncated: false } })], "page-1"),
        contentPage([makeContent({ id: "b", preview: { text: "second page", truncated: false } })]),
      ],
    });
    await renderSession();

    const list = await transcript();
    expect(within(list).getByText("second page")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Earlier records" }));
    expect(await screen.findByText("first page")).toBeInTheDocument();
    expect(screen.queryByText("second page")).not.toBeInTheDocument();
    expect(within(await transcript()).getAllByRole("listitem")).toHaveLength(1);
    expect(requests.listRequests.at(-1)?.get("mode")).toBe("earlier");
    await user.click(screen.getByRole("button", { name: "Later records" }));
    expect(await screen.findByText("second page")).toBeInTheDocument();
    expect(screen.queryByText("first page")).not.toBeInTheDocument();
  });

  it("fetches a long body page by page, independent of the preview, and only when asked", async () => {
    const user = userEvent.setup();
    const head = "a".repeat(256 * 1024);
    const tail = `${"b".repeat(100 * 1024)}TAIL-OF-THE-BODY`;
    const requests = serveSession({
      pages: [
        contentPage([
          makeContent({ id: "big", byte_count: head.length + tail.length, sha256: "b".repeat(64), preview: { text: "a".repeat(40), truncated: true } }),
        ]),
      ],
    });
    serveBody(requests, "big", head + tail);
    await renderSession();

    const reply = entry(await transcript(), "Claude Code");
    expect(requests.bodyRequests).toEqual([]);
    await user.click(within(reply).getByRole("button", { name: "Show all (356 KB)" }));
    await within(reply).findByRole("button", { name: "Load more (256 KB of 356 KB)" });
    expect(within(reply).queryByText(/TAIL-OF-THE-BODY/)).not.toBeInTheDocument();

    await user.click(within(reply).getByRole("button", { name: /^Load more/ }));
    expect(await within(reply).findByText(/TAIL-OF-THE-BODY$/)).toBeInTheDocument();
    expect(requests.bodyRequests).toEqual([
      { id: "big", offset: "0" },
      { id: "big", offset: String(256 * 1024) },
    ]);
    expect(within(reply).queryByRole("button", { name: /^Load more/ })).not.toBeInTheDocument();

    await user.click(within(reply).getByRole("button", { name: "Show less" }));
    expect(within(reply).queryByText(/TAIL-OF-THE-BODY/)).not.toBeInTheDocument();
  });

  it("caches body pages by digest, so a live update never refetches them", async () => {
    useFakeClock();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const queryClient = createTestQueryClient();
    const requests = serveSession({
      pages: [contentPage([makeContent({ id: "r", byte_count: 300, preview: { text: "short", truncated: true } })])],
    });
    serveBody(requests, "r", "x".repeat(300));
    await renderSession(queryClient);

    const reply = entry(await transcript(), "Claude Code");
    await user.click(within(reply).getByRole("button", { name: /^Show all/ }));
    await within(reply).findByRole("button", { name: "Show less" });
    const listCount = requests.listRequests.length;

    await emitSessionUpdate("contents");
    await settled(queryClient);
    expect(requests.listRequests.length).toBe(listCount + 1);
    expect(requests.bodyRequests).toHaveLength(1);
  });

  it("closes a changed digest's body until another explicit disclosure, then fetches the new body", async () => {
    useFakeClock();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const queryClient = createTestQueryClient();
    let sha256 = "1".repeat(64);
    const source = makeContent({ id: "r", byte_count: 300, preview: { text: "short", truncated: true } });
    const requests = serveSession({
      list: () => HttpResponse.json(contentPage([{ ...source, sha256 }])),
    });
    serveBody(requests, "r", "y".repeat(300));
    await renderSession(queryClient);

    const reply = entry(await transcript(), "Claude Code");
    await user.click(within(reply).getByRole("button", { name: /^Show all/ }));
    await within(reply).findByRole("button", { name: "Show less" });

    sha256 = "2".repeat(64);
    serveBody(requests, "r", "z".repeat(300));
    await emitSessionUpdate("contents");
    await settled(queryClient);
    expect(requests.bodyRequests).toHaveLength(1);
    const refreshed = entry(await transcript(), "Claude Code");
    expect(within(refreshed).queryByRole("button", { name: "Show less" })).not.toBeInTheDocument();
    expect(within(refreshed).queryByText("y".repeat(300))).not.toBeInTheDocument();
    await user.click(within(refreshed).getByRole("button", { name: /^Show all/ }));
    expect(await within(refreshed).findByText("z".repeat(300))).toBeVisible();
    expect(requests.bodyRequests).toHaveLength(2);
    expect(queryClient.getQueryData(sessionKeys.contentBody(SLUG, SESSION_ID, "r", sha256, 0))).toMatchObject({ text: "z".repeat(300) });
  });

  it("says storage is unavailable when a stored body is damaged, and retries", async () => {
    const user = userEvent.setup();
    serveSession({ pages: [contentPage([makeContent({ id: "r", preview: { text: "short", truncated: true } })])] });
    let attempts = 0;
    server.use(
      http.get(`${CONTENTS}/r/body`, () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            { detail: "Content storage is unavailable; retry later", error_code: "storage_backend_unavailable", error_params: {}, context: null },
            { status: 503 },
          );
        }
        return HttpResponse.json({ content_id: "r", offset: 0, next_offset: null, total_bytes: 9, text: "recovered" });
      }),
    );
    await renderSession();

    const reply = entry(await transcript(), "Claude Code");
    await user.click(within(reply).getByRole("button", { name: /^Show all/ }));
    expect(await within(reply).findByText("Storage is unavailable right now. Try again in a moment.")).toBeInTheDocument();
    await user.click(within(reply).getByRole("button", { name: "Try again" }));
    expect(await within(reply).findByText("recovered")).toBeInTheDocument();
  });

  it("says it is waiting for a connection when a body is asked for offline", async () => {
    const user = userEvent.setup();
    const requests = serveSession({ pages: [contentPage([makeContent({ id: "r", preview: { text: "short", truncated: true } })])] });
    serveBody(requests, "r", "arrives once online");
    await renderSession();

    const reply = entry(await transcript(), "Claude Code");
    act(() => onlineManager.setOnline(false));
    try {
      await user.click(within(reply).getByRole("button", { name: /^Show all/ }));
      expect(await within(reply).findByText("Waiting for a connection…")).toBeInTheDocument();
      expect(requests.bodyRequests).toEqual([]);
    } finally {
      act(() => onlineManager.setOnline(true));
    }
    expect(await within(reply).findByText("arrives once online")).toBeInTheDocument();
  });

  it("offers no Load more past a page that failed, and recovers it once", async () => {
    const user = userEvent.setup();
    const head = "h".repeat(256 * 1024);
    const requests = serveSession({
      pages: [contentPage([makeContent({ id: "big", byte_count: head.length + 7, preview: { text: "h", truncated: true } })])],
    });
    let secondPageFails = true;
    server.use(
      http.get(`${CONTENTS}/big/body`, ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        requests.bodyRequests.push({ id: "big", offset: String(offset) });
        if (offset === 0) return HttpResponse.json({ content_id: "big", offset: 0, next_offset: head.length, total_bytes: head.length + 7, text: head });
        if (secondPageFails) {
          return HttpResponse.json({ detail: "x", error_code: "storage_backend_unavailable", error_params: {}, context: null }, { status: 503 });
        }
        return HttpResponse.json({ content_id: "big", offset, next_offset: null, total_bytes: head.length + 7, text: "THE-END" });
      }),
    );
    await renderSession();

    const reply = entry(await transcript(), "Claude Code");
    await user.click(within(reply).getByRole("button", { name: /^Show all/ }));
    await user.click(await within(reply).findByRole("button", { name: /^Load more/ }));
    await within(reply).findByText("Storage is unavailable right now. Try again in a moment.");
    expect(within(reply).queryByRole("button", { name: /^Load more/ })).toBeNull();

    secondPageFails = false;
    await user.click(within(reply).getByRole("button", { name: "Try again" }));
    expect(await within(reply).findByText(/THE-END$/)).toBeInTheDocument();
    expect(within(reply).getAllByText(/THE-END/)).toHaveLength(1);
    expect(within(reply).getByText(/THE-END$/).textContent?.match(/THE-END/g)).toHaveLength(1);
  });

  it("says a body that went away isn't here anymore", async () => {
    const user = userEvent.setup();
    serveSession({ pages: [contentPage([makeContent({ id: "r", preview: { text: "short", truncated: true } })])] });
    server.use(
      http.get(`${CONTENTS}/r/body`, () =>
        HttpResponse.json({ detail: "Content not found", error_code: "content_not_found", error_params: {}, context: null }, { status: 404 }),
      ),
    );
    await renderSession();

    const reply = entry(await transcript(), "Claude Code");
    await user.click(within(reply).getByRole("button", { name: /^Show all/ }));
    expect(await within(reply).findByText("This content isn't here anymore.")).toBeInTheDocument();
  });
});

describe("Transcript — coverage", () => {
  const cases: [string, Partial<SessionContent>, string, string][] = [
    ["captured", { coverage: "captured" }, "", "Done: the retry is in place."],
    [
      "partially redacted",
      { coverage: "partially_redacted", coverage_reason: "secret_filter", redaction: { filter_version: "r/1", replacements: 2 } },
      "Partly masked",
      "2 secrets masked.",
    ],
    [
      "withheld by policy",
      { coverage: "withheld_by_policy", coverage_reason: "quota_exceeded", render: "none", preview: null, byte_count: null, sha256: null, original_byte_count: 91226112 },
      "Withheld",
      "The session's or the device's storage limit was reached.",
    ],
    [
      "source unavailable",
      { coverage: "source_unavailable", coverage_reason: "encrypted_at_source", render: "none", preview: null, byte_count: null, sha256: null },
      "Not available at the source",
      "The agent stores it encrypted.",
    ],
    [
      "not yet uploaded",
      { coverage: "not_yet_uploaded", coverage_reason: "upload_pending", render: "none", preview: null },
      "Uploading",
      "Your device is still uploading it.",
    ],
    [
      "collection failed",
      { coverage: "collection_failed", coverage_reason: "placement_failed", render: "none", preview: null, byte_count: null, sha256: null },
      "Couldn't collect",
      "It still held a device path, so it wasn't stored.",
    ],
    [
      "truncated",
      { coverage: "truncated", coverage_reason: "source_limit", byte_count: 1048606, original_byte_count: 1200017 },
      "Cut short",
      "The agent itself kept only part of it: 1 MB of 1.1 MB.",
    ],
    [
      "expired",
      { coverage: "expired", coverage_reason: "staging_expired", render: "none", preview: null },
      "Expired",
      "The upload didn't finish within 7 days.",
    ],
  ];

  for (const [name, overrides, badge, explanation] of cases) {
    it(`states ${name} content plainly`, async () => {
      serveSession({ pages: [contentPage([makeContent({ id: "c", ...overrides })])] });
      await renderSession();

      const reply = entry(await transcript(), "Claude Code");
      if (badge) expect(within(reply).getByText(badge)).toBeInTheDocument();
      expect(within(reply).getByText(explanation)).toBeInTheDocument();
      if (overrides.render === "none") expect(within(reply).queryByRole("button", { name: /^Show all|^Download/ })).toBeNull();
    });
  }

  it("states the size of withheld content when the device reported it", async () => {
    serveSession({
      pages: [
        contentPage([
          makeContent({ id: "c", coverage: "withheld_by_policy", coverage_reason: "media_type_not_permitted", channel: "attachment", role: "user", media_type: "application/zip", render: "none", preview: null, byte_count: null, sha256: null, original_byte_count: 1048576 }),
        ]),
      ],
    });
    await renderSession();

    const attachment = entry(await transcript(), "Attachment");
    expect(within(attachment).getByText("This file type isn't captured.")).toBeInTheDocument();
    expect(within(attachment).getByText("application/zip · 1 MB")).toBeInTheDocument();
  });
});

describe("Transcript — attachments", () => {
  it("shows a raster image from the authenticated download and revokes its object URL on unmount", async () => {
    const requests = serveSession({
      pages: [contentPage([makeContent({ id: "img", role: "user", channel: "attachment", media_type: "image/png", render: "image", preview: null, byte_count: 284211 })])],
    });
    server.use(
      http.get(`${CONTENTS}/img/download`, () => {
        requests.downloads.push("img");
        return new HttpResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "Content-Type": "image/png" } });
      }),
    );
    const { unmount } = await renderSession();

    const attachment = entry(await transcript(), "Attachment");
    expect(requests.downloads).toEqual([]);
    await userEvent.setup().click(within(attachment).getByRole("button", { name: "Show image" }));
    const image = await within(attachment).findByRole("img", { name: "Attached image, 278 KB" });
    expect(image.getAttribute("src")).toMatch(/^blob:session-content-/);
    expect(requests.downloads).toEqual(["img"]);
    const src = image.getAttribute("src");
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(src);
  });

  it("never shows SVG, HTML or PDF inline: they download under a safe name", async () => {
    const user = userEvent.setup();
    serveSession({
      pages: [contentPage([makeContent({ id: "pdf", role: "user", channel: "attachment", media_type: "application/pdf", render: "download", preview: null, byte_count: 90112 })])],
    });
    server.use(
      http.get(`${CONTENTS}/pdf/download`, () =>
        new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename*=UTF-8''..%2F..%2Freport%0A.pdf" },
        }),
      ),
    );
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    await renderSession();

    const attachment = entry(await transcript(), "Attachment");
    expect(attachment.querySelector("img, iframe, object, embed")).toBeNull();
    expect(within(attachment).getByText("application/pdf · 88 KB")).toBeInTheDocument();
    await user.click(within(attachment).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clicked).toEqual(["report.pdf"]));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
  });
});

describe("Transcript — live updates", () => {
  it("shows an upload that finishes without a reload", async () => {
    useFakeClock();
    let finished = false;
    const pending = makeContent({ id: "up", coverage: "not_yet_uploaded", coverage_reason: "upload_pending", render: "none", preview: null });
    const available = makeContent({ id: "up", occurred_at: pending.occurred_at, preview: { text: "uploaded at last", truncated: false } });
    serveSession({ list: () => HttpResponse.json(contentPage([finished ? available : pending])) });
    await renderSession();

    const list = await transcript();
    expect(within(list).getByText("Your device is still uploading it.")).toBeInTheDocument();
    finished = true;
    await emitSessionUpdate("content_available");
    expect(await within(list).findByText("uploaded at last")).toBeInTheDocument();
  });

  it("says an upload expired once the server gives up on it", async () => {
    useFakeClock();
    let expired = false;
    const pending = makeContent({ id: "up", coverage: "not_yet_uploaded", coverage_reason: "upload_pending", render: "none", preview: null });
    const gone = makeContent({ id: "up", occurred_at: pending.occurred_at, coverage: "expired", coverage_reason: "staging_expired", render: "none", preview: null });
    serveSession({ list: () => HttpResponse.json(contentPage([expired ? gone : pending])) });
    await renderSession();

    const list = await transcript();
    expired = true;
    await emitSessionUpdate("content_expired");
    expect(await within(list).findByText("The upload didn't finish within 7 days.")).toBeInTheDocument();
    expect(within(list).queryByText("Your device is still uploading it.")).not.toBeInTheDocument();
  });

  it("refreshes only the current pinned window after visiting earlier history, without duplicate records", async () => {
    useFakeClock();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const queryClient = createTestQueryClient();
    let finished = false;
    const first = makeContent({ id: "a", preview: { text: "on page one", truncated: false } });
    const source = makeContent({ id: "b" });
    const second = (): SessionContent => finished
      ? { ...source, preview: { text: "page two arrived", truncated: false } }
      : { ...source, coverage: "not_yet_uploaded", coverage_reason: "upload_pending", render: "none", preview: null };
    const requests = serveSession();
    server.use(
      http.get(`${CONTENTS}/window`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        requests.listRequests.push(params);
        return contentWindowResponse([contentPage([first]), contentPage([second()])], params);
      }),
    );
    await renderSession(queryClient);

    const list = await transcript();
    await within(list).findByText("Your device is still uploading it.");
    await user.click(screen.getByRole("button", { name: "Earlier records" }));
    await screen.findByText("on page one");
    await user.click(screen.getByRole("button", { name: "Later records" }));
    await screen.findByText("Your device is still uploading it.");
    const before = requests.listRequests.length;

    finished = true;
    await emitSessionUpdate("contents");
    expect(await screen.findByText("page two arrived")).toBeInTheDocument();
    await settled(queryClient);
    expect(within(await transcript()).getAllByRole("listitem").map((item) => item.id)).toEqual(["content-b"]);
    expect(requests.listRequests.slice(before).map((params) => params.get("mode"))).toEqual(["refresh"]);
  });

  it("ignores another member's session events", async () => {
    useFakeClock();
    const queryClient = createTestQueryClient();
    const requests = serveSession({ pages: [contentPage([makeContent()])] });
    await renderSession(queryClient);
    await transcript();
    await settled(queryClient);
    const count = requests.listRequests.length;

    await emitSessionUpdate("contents", "someone-else");
    await settled(queryClient);
    expect(requests.listRequests.length).toBe(count);
  });

  it("drops the content list and its cached bodies when the session is deleted", async () => {
    useFakeClock();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 5 * 60_000 } });
    let deleted = false;
    const requests = serveSession({
      list: () =>
        deleted
          ? HttpResponse.json({ detail: "Not found" }, { status: 404 })
          : HttpResponse.json(contentPage([makeContent({ id: "r", preview: { text: "short", truncated: true } })])),
    });
    serveBody(requests, "r", "the whole private body");
    await renderSession(queryClient);

    const reply = entry(await transcript(), "Claude Code");
    await user.click(within(reply).getByRole("button", { name: /^Show all/ }));
    await within(reply).findByText("the whole private body");

    deleted = true;
    server.use(http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}`, () => HttpResponse.json({ detail: "Not found" }, { status: 404 })));
    await emitSessionUpdate("deleted");
    expect(await screen.findByRole("heading", { name: "This session isn't here anymore" })).toBeInTheDocument();
    expect(screen.queryByText("the whole private body")).not.toBeInTheDocument();
    const cachedContent = queryClient
      .getQueryCache()
      .findAll({ predicate: (query) => query.queryKey.includes("contents") || query.queryKey.includes("content-body") });
    expect(cachedContent).toEqual([]);
  });
});

describe("Transcript — access", () => {
  it("removes the reader after denied content authority instead of calling it empty", async () => {
    serveSession({
      list: () => HttpResponse.json({ detail: "Forbidden" }, { status: 403 }),
    });
    await renderSession();

    await waitFor(() => expect(screen.queryByRole("region", { name: "Transcript" })).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Add a retry to the uploader" })).not.toBeInTheDocument();
    expect(screen.queryByText("No captured content was received for this session.")).not.toBeInTheDocument();
  });

  it("offers a retry when the transcript fails to load", async () => {
    const user = userEvent.setup();
    let failing = true;
    serveSession({
      list: () => (failing ? HttpResponse.json({ detail: "boom" }, { status: 500 }) : HttpResponse.json(contentPage([makeContent()]))),
    });
    await renderSession();

    expect(await screen.findByText("Couldn't load the transcript.")).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await transcript()).toBeInTheDocument();
  });
});

describe("Transcript — more coverage", () => {
  it("explains content the folder's level kept on the device, the common mixed-version case", async () => {
    serveSession({
      pages: [contentPage([makeContent({ id: "c", coverage: "withheld_by_policy", coverage_reason: "content_level", render: "none", preview: null, byte_count: null, sha256: null })])],
    });
    await renderSession();

    const reply = entry(await transcript(), "Claude Code");
    expect(within(reply).getByText("Withheld")).toBeInTheDocument();
    expect(within(reply).getByText("Not kept: rich capture wasn't on for this folder then.")).toBeInTheDocument();
  });

  it("counts a single masked secret in the singular", async () => {
    serveSession({
      pages: [contentPage([makeContent({ id: "c", coverage: "partially_redacted", coverage_reason: "secret_filter", redaction: { filter_version: "r/1", replacements: 1 } })])],
    });
    await renderSession();

    expect(within(entry(await transcript(), "Claude Code")).getByText("1 secret masked.")).toBeInTheDocument();
  });

  it("refuses a body read after access was revoked, without retrying", async () => {
    const user = userEvent.setup();
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } });
    const root = sessionKeys.detail(SLUG, SESSION_ID);
    const unrelated = makeSession({ id: "unrelated-session", title: "Other authorized session" });
    queryClient.setQueryData(sessionKeys.detail(SLUG, unrelated.id), unrelated);
    const unrelatedBody = sessionKeys.contentBody(SLUG, unrelated.id, "other-body", "other-digest", 0);
    queryClient.setQueryData(unrelatedBody, { text: "OTHER_SESSION_BODY" });
    queryClient.setQueryData(sessionKeys.contentBody(SLUG, SESSION_ID, "retained-body", "private-digest", 0), { text: "PRIVATE_RETAINED_BODY" });
    serveSession({ pages: [contentPage([makeContent({ id: "r", preview: { text: "short", truncated: true } })])] });
    let attempts = 0;
    server.use(
      http.get(`${CONTENTS}/r/body`, () => {
        attempts += 1;
        return HttpResponse.json({ detail: "Forbidden" }, { status: 403 });
      }),
    );
    await renderSession(queryClient);

    const reply = entry(await transcript(), "Claude Code");
    await user.click(within(reply).getByRole("button", { name: /^Show all/ }));
    await waitFor(() => expect(queryClient.getQueryData(root)).toBeNull());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Session unavailable" })).toBeVisible());
    await settled(queryClient);
    expect(attempts).toBe(1);
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: root, predicate: (query) => query.queryKey.length > root.length })).toEqual([]));
    expect(screen.queryByText("short")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Transcript" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(queryClient.getQueryData(sessionKeys.detail(SLUG, unrelated.id))).toEqual(unrelated);
    expect(queryClient.getQueryData(unrelatedBody)).toEqual({ text: "OTHER_SESSION_BODY" });
  });
});

describe("Transcript — attachment failures", () => {
  const image = makeContent({ id: "img", role: "user", channel: "attachment", media_type: "image/png", render: "image", preview: null, byte_count: 284211 });
  const file = makeContent({ id: "pdf", role: "user", channel: "attachment", media_type: "application/pdf", render: "download", preview: null, byte_count: 90112 });
  const storageDown = () =>
    HttpResponse.json({ detail: "Content storage is unavailable; retry later", error_code: "storage_backend_unavailable", error_params: {}, context: null }, { status: 503 });

  it("falls back to a retry, never a broken image, when the preview can't be fetched", async () => {
    const user = userEvent.setup();
    serveSession({ pages: [contentPage([image])] });
    let attempts = 0;
    server.use(
      http.get(`${CONTENTS}/img/download`, () => {
        attempts += 1;
        return attempts === 1 ? storageDown() : new HttpResponse(new Uint8Array([0x89, 0x50]), { headers: { "Content-Type": "image/png" } });
      }),
    );
    await renderSession();

    const attachment = entry(await transcript(), "Attachment");
    expect(attempts).toBe(0);
    await user.click(within(attachment).getByRole("button", { name: "Show image" }));
    expect(await within(attachment).findByText("Storage is unavailable right now. Try again in a moment.")).toBeInTheDocument();
    expect(attachment.querySelector("img")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await user.click(within(attachment).getByRole("button", { name: "Try again" }));
    expect(await within(attachment).findByRole("img", { name: "Attached image, 278 KB" })).toBeInTheDocument();
  });

  it("says a file that went away isn't here anymore, and starts no download", async () => {
    const user = userEvent.setup();
    serveSession({ pages: [contentPage([file])] });
    server.use(http.get(`${CONTENTS}/pdf/download`, () => HttpResponse.json({ detail: "Content not found", error_code: "content_not_found" }, { status: 404 })));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await renderSession();

    const attachment = entry(await transcript(), "Attachment");
    await user.click(within(attachment).getByRole("button", { name: "Download" }));
    expect(await within(attachment).findByText("This content isn't here anymore.")).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("says storage is unavailable when a download fails on the server's side", async () => {
    const user = userEvent.setup();
    serveSession({ pages: [contentPage([file])] });
    server.use(http.get(`${CONTENTS}/pdf/download`, storageDown));
    await renderSession();

    const attachment = entry(await transcript(), "Attachment");
    await user.click(within(attachment).getByRole("button", { name: "Download" }));
    expect(await within(attachment).findByText("Storage is unavailable right now. Try again in a moment.")).toBeInTheDocument();
  });

  for (const mediaType of ["image/svg+xml", "text/html", "image/png"]) {
    it(`lets the server's render decide: ${mediaType} offered for download stays a download`, async () => {
      serveSession({
        pages: [contentPage([makeContent({ id: "f", role: "user", channel: "attachment", media_type: mediaType, render: "download", preview: null, byte_count: 2048 })])],
      });
      await renderSession();

      const attachment = entry(await transcript(), "Attachment");
      expect(attachment.querySelector("img, iframe, object, embed, svg image")).toBeNull();
      expect(within(attachment).getByRole("button", { name: "Download" })).toBeInTheDocument();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
  }
});

describe("Transcript — deep links", () => {
  function renderAt(hash: string) {
    return renderWithProviders(
      <Routes>
        <Route path="/:slug/sessions/:sessionId" element={<SessionDetailPage />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION_ID}${hash}`] } },
    );
  }

  it("focuses a linked item that is loaded", async () => {
    serveSession({ pages: [contentPage([makeContent({ id: "a" }), makeContent({ id: "b", preview: { text: "linked one", truncated: false } })])] });
    renderAt("#content-b");

    await transcript();
    await waitFor(() => expect(document.getElementById("content-b")).toHaveFocus());
  });

  it("focuses only raw-record provenance until Everything reveals its preview without fetching another window or body", async () => {
    const user = userEvent.setup();
    const requests = serveSession({ pages: [contentPage([
      makeContent({ id: "reply" }),
      makeContent({ id: "raw", channel: "native_record", role: "unknown", preview: { text: "native envelope", truncated: true } }),
    ], "page-1")] });
    serveBody(requests, "raw", "Complete native envelope");
    renderAt("#content-raw");

    await transcript();
    await waitFor(() => expect(document.getElementById("content-raw")).toHaveFocus());
    expect(document.getElementById("content-raw")).not.toHaveTextContent("native envelope");
    expect(screen.queryByText("native envelope")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Everything" }));
    await waitFor(() => expect(document.getElementById("content-raw")).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Conversation" }));
    await waitFor(() => expect(document.getElementById("content-raw")).toHaveFocus());
    expect(document.getElementById("content-raw")).not.toHaveTextContent("native envelope");
    expect(screen.queryByText("native envelope")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Everything" }));
    await waitFor(() => expect(document.getElementById("content-raw")).toHaveFocus());
    expect(requests.listRequests.map((params) => params.get("cursor"))).toEqual([null]);
    expect(requests.bodyRequests).toEqual([]);
  });

  it("resolves a distant linked item in one bounded anchor request without draining history", async () => {
    const requests = serveSession({ pages: [contentPage([makeContent({ id: "a" })], "page-1"), contentPage([makeContent({ id: "far" })])] });
    renderAt("#content-far");

    await transcript();
    await waitFor(() => expect(document.getElementById("content-far")).toHaveFocus());
    expect(document.getElementById("content-a")).toBeNull();
    expect(requests.listRequests.map((params) => [params.get("mode"), params.get("anchor_id")])).toEqual([["anchor", "far"]]);
    expect(requests.bodyRequests).toEqual([]);
  });
});

describe("Transcript — loaded-content orientation", () => {
  it("offers only content in the current view with source and coverage metadata, never body or path text", async () => {
    const user = userEvent.setup();
    const requests = serveSession({ pages: [contentPage([
      makeContent({ id: "reply", occurred_at: "2026-10-16T14:35:00Z", source: { kind: "claude_transcript", order: 1 }, display_path: "private/plan.md", preview: { text: "CONFIDENTIAL PREVIEW", truncated: true } }),
      makeContent({ id: "input", role: "tool", channel: "tool_input", call_id: "call-7", source: { kind: "claude_transcript", order: 2 } }),
      makeContent({ id: "output", role: "tool", channel: "tool_output", call_id: "call-7", coverage: "withheld_by_policy", coverage_reason: "excluded_path", render: "none", preview: null, source: { kind: "claude_transcript", order: 3 } }),
      makeContent({ id: "raw", role: "unknown", channel: "native_record", display_path: "private-envelope.json", source: { kind: "claude_transcript", order: 4 } }),
    ], "page-1"), contentPage([makeContent({ id: "unloaded", source: { kind: "claude_transcript", order: 5 } })])] });
    for (const id of ["reply", "input", "output", "raw"]) serveBody(requests, id, `Complete body for ${id}`);
    await renderSession();

    await transcript();
    await user.click(screen.getByRole("button", { name: "Beginning" }));
    await screen.findByText("CONFIDENTIAL PREVIEW");
    const navigation = screen.getByRole("combobox", { name: "Jump to loaded content" });
    expect(within(navigation).getByRole("option", { name: /Claude Code.*#1/ })).toHaveTextContent(formatClock("2026-10-16T14:35:00Z"));
    expect(within(navigation).getByRole("option", { name: /Input.*#2/ })).toBeInTheDocument();
    expect(within(navigation).getByRole("option", { name: /Output.*#3.*Withheld/ })).toBeInTheDocument();
    expect(within(navigation).queryByRole("option", { name: /#4|#5/ })).not.toBeInTheDocument();
    expect(navigation).not.toHaveTextContent(/CONFIDENTIAL PREVIEW|private\/plan\.md|private-envelope\.json/);
    expect(navigation).toHaveAccessibleDescription(/loaded.*current view.*more.*available/i);

    await user.click(screen.getByRole("button", { name: "Everything" }));
    expect(within(navigation).getByRole("option", { name: /Raw record.*#4/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Conversation" }));
    expect(within(navigation).queryByRole("option", { name: /#4/ })).not.toBeInTheDocument();
    expect(requests.listRequests.map((params) => params.get("mode"))).toEqual(["latest", "beginning"]);
    expect(requests.bodyRequests).toEqual([]);
  });

  it("reaches a grouped loaded part repeatedly while preserving selection, view and explicit paging", async () => {
    const user = userEvent.setup();
    const requests = serveSession({ pages: [contentPage([
      makeContent({ id: "reply", source: { kind: "claude_transcript", order: 1 } }),
      makeContent({ id: "input", role: "tool", channel: "tool_input", call_id: "call-7", source: { kind: "claude_transcript", order: 2 } }),
      makeContent({ id: "output", role: "tool", channel: "tool_output", call_id: "call-7", preview: { text: "Output preview", truncated: true }, source: { kind: "claude_transcript", order: 3 } }),
    ], "page-1")] });
    serveBody(requests, "output", "Complete grouped output");
    await renderSession();

    const list = await transcript();
    const selected = within(entry(list, "Claude Code")).getByRole("checkbox");
    await user.click(selected);
    const call = entry(list, "Tool call");
    const toggle = within(call).getByRole("button", { name: /Tool call/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const navigation = screen.getByRole("combobox", { name: "Jump to loaded content" });
    const destination = within(navigation).getByRole("option", { name: /Output.*#3/ });
    await user.selectOptions(navigation, destination);
    await waitFor(() => expect(document.getElementById("content-output")).toHaveFocus());
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(selected).toBeChecked();
    expect(within(call).getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("Selected: 1 · 3 records in this window")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversation" })).toHaveAttribute("aria-pressed", "true");

    await user.selectOptions(navigation, destination);
    await waitFor(() => expect(document.getElementById("content-output")).toHaveFocus());
    await user.click(toggle);
    expect(document.getElementById("content-output")).toBeNull();
    await user.click(toggle);
    await waitFor(() => expect(document.getElementById("content-output")).toHaveFocus());
    await user.click(toggle);
    expect(document.getElementById("content-output")).toBeNull();
    await user.selectOptions(navigation, destination);
    await waitFor(() => expect(document.getElementById("content-output")).toHaveFocus());
    expect(selected).toBeChecked();
    expect(requests.listRequests.map((params) => params.get("cursor"))).toEqual([null]);
    expect(requests.bodyRequests).toEqual([]);
  });
});

describe("Transcript — every locale", () => {
  for (const language of ["es", "pt-BR"]) {
    it(`renders states and controls in ${language}`, async () => {
      await act(() => i18n.changeLanguage(language));
      const t = i18n.getFixedT(language);
      const en = i18n.getFixedT("en");
      serveSession({
        pages: [
          contentPage([
            makeContent({ id: "w", coverage: "withheld_by_policy", coverage_reason: "quota_exceeded", render: "none", preview: null, byte_count: null, sha256: null }),
            makeContent({ id: "big", byte_count: 48213, preview: { text: "head", truncated: true } }),
          ]),
        ],
      });
      await renderSession();

      const list = await screen.findByRole("list", { name: t("sessions.contents.title") });
      const navigation = screen.getByRole("combobox", { name: t("sessions.contents.navigation.label") });
      expect(navigation).toHaveAccessibleDescription(t("sessions.contents.navigation.loaded"));
      expect(t("sessions.contents.navigation.label")).not.toBe(en("sessions.contents.navigation.label"));
      expect(navigation).not.toHaveTextContent(/sessions\.contents\./);
      const translated = [
        t("sessions.contents.coverage.withheld_by_policy"),
        t("sessions.contents.reasons.quota_exceeded"),
        t("sessions.contents.body.showAll", { size: formatBytes(48213) }),
      ];
      for (const text of translated) {
        expect(text).not.toMatch(/^sessions\./);
        expect(within(list).getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
      }
      expect(t("sessions.contents.reasons.quota_exceeded")).not.toBe(en("sessions.contents.reasons.quota_exceeded"));
      expect(t("sessions.contents.coverage.withheld_by_policy")).not.toBe(en("sessions.contents.coverage.withheld_by_policy"));
    });
  }
});
