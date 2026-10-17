// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarkdownIt from "markdown-it";
import i18n from "@/i18n/config";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { sessionKeys } from "@/lib/query-keys";
import type { SessionContent, SessionContentPage } from "@/types/agent-session";
import { SLUG, contentPage, makeContent, makeSession } from "../../__tests__/fixtures";
import { contentWindowResponse, selectedMetadata } from "../../__tests__/window-fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { SessionTranscript } from "../SessionTranscript";

const SESSION_ID = "excerpt-session";
const CONTENTS = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}/contents`;
const AT = "2026-10-10T12:34:56Z";
const session = makeSession({ id: SESSION_ID, title: "Investigate the retry", harness_display_name: "Claude Code", capture_levels: ["rich"] });
const utf8 = (text: string) => new TextEncoder().encode(text).length;

function textItem(id: string, text: string, order: number, overrides: Partial<SessionContent> = {}) {
  return makeContent({
    id, session_id: SESSION_ID, occurred_at: AT,
    byte_count: utf8(text), source: { kind: "claude_transcript", order },
    preview: { text: `PREVIEW-${id}`, truncated: true }, ...overrides,
  });
}

interface Requests {
  lists: (string | null)[];
  bodies: { id: string; offset: number }[];
}

function serve(pages: SessionContentPage[] | (() => SessionContentPage), sessionId = SESSION_ID): Requests {
  const requests: Requests = { lists: [], bodies: [] };
  const currentPages = () => typeof pages === "function" ? [pages()] : pages;
  const path = `/api/workspaces/${SLUG}/sessions/${sessionId}/contents`;
  server.use(
    http.get(`${path}/window`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      requests.lists.push(params.get("cursor"));
      return contentWindowResponse(currentPages(), params);
    }),
    http.post(`${path}/metadata`, async ({ request }) => {
      const { content_ids } = await request.json() as { content_ids: string[] };
      return HttpResponse.json(selectedMetadata(currentPages().flatMap((page) => page.items), content_ids));
    }),
  );
  return requests;
}

function serveBody(requests: Requests, id: string, parts: string[]) {
  const total = parts.reduce((sum, part) => sum + utf8(part), 0);
  server.use(http.get(`${CONTENTS}/${id}/body`, ({ request }) => {
    const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
    requests.bodies.push({ id, offset });
    let start = 0;
    for (const part of parts) {
      if (start === offset) {
        const next = start + utf8(part);
        return HttpResponse.json({ content_id: id, offset, next_offset: next === total ? null : next, total_bytes: total, text: part });
      }
      start += utf8(part);
    }
    return HttpResponse.json({ detail: "unexpected offset" }, { status: 422 });
  }));
}

async function item(id: string) {
  await screen.findByRole("list", { name: "Transcript" });
  const entry = document.getElementById(`content-${id}`);
  expect(entry, `rendered content item ${id}`).not.toBeNull();
  return entry!;
}

async function select(id: string, user: ReturnType<typeof userEvent.setup>) {
  const checkbox = within(await item(id)).getByRole("checkbox");
  expect(checkbox).toHaveAccessibleName(/\S/);
  await user.click(checkbox);
  return checkbox;
}

async function preview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Preview excerpt" }));
  return screen.findByRole("dialog", { name: "Selected excerpt" });
}

async function previewText(dialog: HTMLElement) {
  const field = await within(dialog).findByRole("textbox", { name: "Excerpt preview" });
  await waitFor(() => expect(field).not.toHaveValue(""));
  return (field as HTMLTextAreaElement).value;
}

function expectNoExport(dialog: HTMLElement) {
  for (const name of ["Copy excerpt", "Download excerpt"]) {
    const button = within(dialog).queryByRole("button", { name });
    if (button) expect(button).toBeDisabled();
  }
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private-excerpt");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(async () => {
  act(() => setPromptsHidden(false));
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

describe("private excerpt selection", () => {
  it("counts selected evidence independently of the current window and never selects visited history implicitly", async () => {
    const user = userEvent.setup();
    const requests = serve([
      contentPage([textItem("a", "alpha", 1), textItem("b", "beta", 2)], "1"),
      contentPage([textItem("c", "gamma", 3)]),
    ]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);

    await select("c", user);
    expect(screen.getByText("Selected: 1 · 1 record in this window")).toBeInTheDocument();
    expect(screen.getByText(/Selection stays with you/)).toBeInTheDocument();
    expect(requests.lists).toEqual([null]);
    expect(requests.bodies).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Earlier records" }));
    expect(within(await item("a")).getByRole("checkbox")).not.toBeChecked();
    expect(within(await item("b")).getByRole("checkbox")).not.toBeChecked();
    expect(document.getElementById("content-c")).toBeNull();
    expect(screen.getByText("Selected: 1 · 2 records in this window")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Later records" }));
    expect(within(await item("c")).getByRole("checkbox")).toBeChecked();
  });

  it("keeps explicitly selected tool parts counted and previewed when their call is collapsed", async () => {
    const user = userEvent.setup();
    const requests = serve([contentPage([
      textItem("input", "do not copy this input", 1, { call_id: "call-9", channel: "tool_input", role: "tool" }),
      textItem("output", "chosen tool result", 2, { call_id: "call-9", channel: "tool_output", role: "tool" }),
    ])]);
    serveBody(requests, "output", ["chosen tool result"]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    await user.click(within(await item("input")).getByRole("button", { name: /Tool call/ }));
    const parts = within(await item("input")).getAllByRole("checkbox");
    expect(parts).toHaveLength(2);
    parts.forEach((part) => expect(part).toHaveAccessibleName(/\S/));
    await user.click(parts[1]!);
    await user.click(within(await item("input")).getByRole("button", { name: /Tool call/ }));
    expect(within(await item("input")).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("Selected: 1 · 2 records in this window")).toBeInTheDocument();

    const text = await previewText(await preview(user));
    expect(text).toContain("chosen tool result");
    expect(text).not.toContain("do not copy this input");
    expect(requests.bodies).toEqual([{ id: "output", offset: 0 }]);
  });

  it("keeps an explicitly selected raw record counted and previewed after returning to Conversation", async () => {
    const user = userEvent.setup();
    const requests = serve([contentPage([
      textItem("raw", "chosen native record", 1, { channel: "native_record" }),
      textItem("reply", "unselected reply", 2),
    ])]);
    serveBody(requests, "raw", ["chosen native record"]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    await screen.findByRole("list", { name: "Transcript" });
    await user.click(screen.getByRole("button", { name: "Everything" }));
    await select("raw", user);
    await user.click(screen.getByRole("button", { name: "Conversation" }));
    expect(document.getElementById("content-raw")).toBeNull();
    expect(screen.getByText("Selected: 1 · 2 records in this window")).toBeInTheDocument();

    const text = await previewText(await preview(user));
    expect(text).toContain("chosen native record");
    expect(text).not.toContain("unselected reply");
    expect(requests.bodies).toEqual([{ id: "raw", offset: 0 }]);
  });

  it("opens and focuses an individually linked tool part from an excerpt", async () => {
    serve([contentPage([
      textItem("input", "tool input", 1, { call_id: "call-9", channel: "tool_input", role: "tool" }),
      textItem("output", "tool output", 2, { call_id: "call-9", channel: "tool_output", role: "tool" }),
    ])]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />, {
      routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION_ID}#content-output`] },
    });
    await waitFor(() => expect(document.getElementById("content-output")).toHaveFocus());
    expect(within(document.getElementById("content-output")!).getByRole("checkbox")).not.toBeChecked();
  });

  it("keeps the pinned window and selection through refresh, then reaches new records only through Latest", async () => {
    const user = userEvent.setup();
    const client = createTestQueryClient();
    let items = [textItem("a", "alpha", 1)];
    serve(() => contentPage(items));
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />, { queryClient: client });
    await select("a", user);

    items = [...items, textItem("new", "new content", 2)];
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.all(SLUG) }));
    expect(document.getElementById("content-new")).toBeNull();
    expect(within(await item("a")).getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Latest" }));
    expect(within(await item("new")).getByRole("checkbox")).not.toBeChecked();
    expect(within(await item("a")).getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("Selected: 1 · 2 records in this window")).toBeInTheDocument();
  });

  it.each(["disappears", "becomes unavailable"])("blocks export when a selected item %s during refresh, instead of silently exporting the remaining subset", async (change) => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const client = createTestQueryClient();
    const kept = textItem("kept", "still available", 1);
    const lost = textItem("lost", "previously selected", 2);
    let items = [kept, lost];
    const requests = serve(() => contentPage(items));
    serveBody(requests, "kept", ["still available"]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />, { queryClient: client });
    await select("kept", user);
    await select("lost", user);

    items = change === "disappears" ? [kept] : [kept, {
      ...lost, coverage: "source_unavailable", coverage_reason: "encrypted_at_source", render: "none", preview: null,
    }];
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.all(SLUG) }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/selected.*(?:unavailable|no longer)|(?:unavailable|no longer).*selected/i);
    expect(screen.getByRole("button", { name: "Preview excerpt" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Excerpt preview" })).not.toBeInTheDocument();
    expect(requests.bodies).toEqual([]);
    expect(clipboard).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("clears selection when the mounted reader changes sessions, including reused item ids", async () => {
    const user = userEvent.setup();
    serve([contentPage([textItem("a", "first session", 1)])]);
    serve([contentPage([textItem("a", "other session", 1, { session_id: "other-session" })])], "other-session");
    const view = renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    await select("a", user);
    view.rerender(<SessionTranscript slug={SLUG} session={{ ...session, id: "other-session" }} />);

    await waitFor(() => expect(within(document.getElementById("content-a")!).getByRole("checkbox")).not.toBeChecked());
    expect(screen.getByRole("button", { name: "Preview excerpt" })).toBeDisabled();
  });

  it("allows keyboard selection and restores focus after cancelling the preview", async () => {
    const user = userEvent.setup();
    const requests = serve([contentPage([textItem("a", "alpha", 1)])]);
    serveBody(requests, "a", ["alpha"]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    const checkbox = within(await item("a")).getByRole("checkbox");
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
    const trigger = screen.getByRole("button", { name: "Preview excerpt" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Selected excerpt" });
    await previewText(dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(checkbox).toBeChecked();
    expect(screen.getByText("Selected: 1 · 1 record in this window")).toBeInTheDocument();
    expect(requests.lists).toEqual([null]);
    expect(requests.bodies).toEqual([{ id: "a", offset: 0 }]);
  });
});

describe("private excerpt bytes and provenance", () => {
  it("previews full selected bodies in source order, then copies and downloads precisely that text without publishing", async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const clicked: { name: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.href });
    });
    const network: Request[] = [];
    const observe = ({ request }: { request: Request }) => network.push(request);
    server.events.on("request:start", observe);
    try {
      const first = "first line\nsegunda línea 🦊\n";
      const tail = "FULL BODY TAIL\n";
      const chosen = textItem("chosen", first + tail, 7, {
        coverage: "partially_redacted", coverage_reason: "secret_filter",
        redaction: { filter_version: "redact/1", replacements: 2 },
      });
      const later = textItem("later", "later body", 8);
      const requests = serve([contentPage([chosen, textItem("private", "UNSELECTED SECRET", 9), later])]);
      serveBody(requests, "chosen", [first, tail]);
      serveBody(requests, "later", ["later body"]);
      renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
      await select("later", user);
      await select("chosen", user);
      expect(requests.bodies).toEqual([]);
      expect(clipboard).not.toHaveBeenCalled();
      expect(clicked).toEqual([]);

      const dialog = await preview(user);
      const text = await previewText(dialog);
      expect(text).toContain(first + tail);
      const blocks = new MarkdownIt().parse(text, {}).filter((token) => token.type === "fence");
      expect(blocks.map((block) => block.content.slice(0, -1))).toEqual([first + tail, "later body"]);
      expect(text.indexOf(first)).toBeLessThan(text.indexOf("later body"));
      expect(text).not.toMatch(/PREVIEW-|UNSELECTED SECRET/);
      for (const fact of [SESSION_ID, "chosen", "later", "Claude Code", AT, "claude_transcript", "7"]) expect(text).toContain(fact);
      expect(text).toContain(`/${SLUG}/sessions/${SESSION_ID}#content-chosen`);
      expect(text).toMatch(/curated|selected/i);
      expect(text).toMatch(/not (?:a |the )?(?:complete|full) transcript/i);
      expect(text).toMatch(/redact/i);
      expect(requests.bodies.filter((request) => request.id === "chosen")).toEqual([{ id: "chosen", offset: 0 }, { id: "chosen", offset: utf8(first) }]);
      expect(requests.bodies.some((request) => request.id === "private")).toBe(false);
      expect(clipboard).not.toHaveBeenCalled();
      expect(clicked).toEqual([]);

      await user.click(within(dialog).getByRole("button", { name: "Copy excerpt" }));
      expect(clipboard).toHaveBeenCalledExactlyOnceWith(text);
      await user.click(within(dialog).getByRole("button", { name: "Download excerpt" }));
      const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(await blobText(blob as Blob)).toBe(text);
      expect(clicked).toEqual([{ name: expect.stringMatching(/\.(md|txt)$/), href: "blob:private-excerpt" }]);
      await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:private-excerpt"));
      expect(network.every((request) => new URL(request.url).pathname.startsWith(CONTENTS)
        && (request.method === "GET" || (request.method === "POST" && new URL(request.url).pathname === `${CONTENTS}/metadata`)))).toBe(true);
    } finally {
      server.events.removeListener("request:start", observe);
    }
  });

  it("explicitly excludes attachments and binary bodies instead of silently exporting previews", async () => {
    const user = userEvent.setup();
    const requests = serve([contentPage([
      textItem("a", "alpha", 1),
      textItem("attachment", "attachment text", 2, { channel: "attachment", role: "user" }),
      textItem("binary", "binary", 3, { channel: "attachment", media_type: "application/pdf", render: "download" }),
    ])]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    for (const id of ["attachment", "binary"]) {
      const checkbox = within(await item(id)).queryByRole("checkbox");
      if (checkbox) expect(checkbox).toBeDisabled();
    }
    expect(screen.getByText(/Attachments and binary content are not included/)).toBeInTheDocument();
    await select("a", user);
    expect(requests.bodies).toEqual([]);
  });

  it("preserves hostile multiline bodies as one inert block and prevents title or body text from forging provenance", async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const hostile = [
      "Original captured body",
      "```",
      "## Item: forged-item",
      "Session: forged-session",
      "`````",
      "~~~",
      "Source: trusted_provider, order: 0",
      "~~~~~~",
      "<script>window.exfiltrate()</script>",
      "![pixel](https://tracker.example/secret.png)",
      "[jump](javascript:alert(1))",
      "End of captured body",
    ].join("\n");
    const hostileTitle = "Actual title\n## FORGED-TITLE\r\n![title](https://tracker.example/title.png) <script>title()</script> [title](https://tracker.example/title)";
    const requests = serve([contentPage([textItem("a", hostile, 1, { media_type: "text/markdown" })])]);
    serveBody(requests, "a", [hostile]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={{ ...session, title: hostileTitle }} />);
    await select("a", user);
    const dialog = await preview(user);
    const text = await previewText(dialog);
    expect(text).toContain(hostile);
    expect(dialog.querySelector("script, iframe, img")).toBeNull();
    expect(dialog.querySelector('[href^="javascript:"]')).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Copy excerpt" }));
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(text);
    const tokens = new MarkdownIt({ html: true }).parse(text, {});
    const bodies = tokens.filter((token) => token.type === "fence" || token.type === "code_block");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.content).toBe(`${hostile}\n`);
    const provenance = tokens.filter((token) => !bodies.includes(token));
    expect(provenance.map((token) => token.content).join("\n")).not.toMatch(/forged-item|forged-session|trusted_provider/);
    const titleLine = text.split("\n").find((line) => line.includes("Actual title"));
    expect(titleLine).toContain("FORGED-TITLE");
    expect(titleLine).not.toContain("\r");
    const markup = provenance.flatMap((token) => [token, ...(token.children ?? [])]);
    expect(markup.filter((token) => ["image", "html_inline", "html_block"].includes(token.type))).toEqual([]);
    expect(markup.some((token) => token.type === "link_open" && /tracker\.example|javascript:/i.test(token.attrGet("href") ?? ""))).toBe(false);
  });
});

describe("private excerpt completion and limits", () => {
  it.each([403, 404, 410, 503])("refuses the whole excerpt when a selected body returns %s", async (status) => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const requests = serve([contentPage([textItem("good", "retained body", 1), textItem("lost", "missing body", 2)])]);
    serveBody(requests, "good", ["retained body"]);
    server.use(http.get(`${CONTENTS}/lost/body`, () => HttpResponse.json({ detail: "body unavailable" }, { status })));
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    await select("good", user);
    await select("lost", user);
    const dialog = await preview(user);
    await within(dialog).findByRole("alert");
    expectNoExport(dialog);
    expect(within(dialog).queryByRole("textbox", { name: "Excerpt preview" })).not.toBeInTheDocument();
    expect(clipboard).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects selections over the aggregate 2 MiB bound before fetching bodies", async () => {
    const user = userEvent.setup();
    const requests = serve([contentPage([
      textItem("a", "small preview", 1, { byte_count: 1024 * 1024 + 1 }),
      textItem("b", "small preview", 2, { byte_count: 1024 * 1024 }),
    ])]);
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    await select("a", user);
    await select("b", user);
    await preview(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(/2 (?:MiB|MB)|too large/i);
    expect(requests.bodies).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("checks actual returned UTF-8 bytes instead of trusting an understated body size", async () => {
    const user = userEvent.setup();
    serve([contentPage([textItem("a", "one", 1)])]);
    server.use(http.get(`${CONTENTS}/a/body`, () => HttpResponse.json({
      content_id: "a", offset: 0, next_offset: null, total_bytes: 3, text: "🦊".repeat(600_000),
    })));
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    await select("a", user);
    const dialog = await preview(user);
    await within(dialog).findByRole("alert");
    expectNoExport(dialog);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    { content_id: "wrong-item", offset: 0, next_offset: null, total_bytes: 5, text: "alpha" },
    { content_id: "a", offset: 0, next_offset: null, total_bytes: 9, text: "alpha" },
    { content_id: "a", offset: 0, next_offset: 0, total_bytes: 5, text: "alpha" },
  ])("rejects an inconsistent body response without exporting partial or foreign content: %j", async (body) => {
    const user = userEvent.setup();
    serve([contentPage([textItem("a", "alpha", 1)])]);
    server.use(http.get(`${CONTENTS}/a/body`, () => HttpResponse.json(body)));
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    await select("a", user);
    const dialog = await preview(user);
    await within(dialog).findByRole("alert");
    expectNoExport(dialog);
  });

  it.each([
    { issue: "changed total", offset: 5, total_bytes: 11 },
    { issue: "wrong offset", offset: 4, total_bytes: 10 },
  ])("rejects a later body page with $issue instead of exporting a partial or spliced body", async ({ offset, total_bytes }) => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const requests = serve([contentPage([textItem("a", "alphabravo", 1)])]);
    server.use(http.get(`${CONTENTS}/a/body`, ({ request }) => {
      const requestedOffset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
      requests.bodies.push({ id: "a", offset: requestedOffset });
      return HttpResponse.json(requestedOffset === 0
        ? { content_id: "a", offset: 0, next_offset: 5, total_bytes: 10, text: "alpha" }
        : { content_id: "a", offset, next_offset: null, total_bytes, text: "bravo" });
    }));
    renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    await select("a", user);
    const dialog = await preview(user);
    await within(dialog).findByRole("alert");
    expect(requests.bodies).toEqual([{ id: "a", offset: 0 }, { id: "a", offset: 5 }]);
    expectNoExport(dialog);
    expect(within(dialog).queryByRole("textbox", { name: "Excerpt preview" })).not.toBeInTheDocument();
    expect(clipboard).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["cancel", "session change"])("aborts a pending preview on %s and never exports its late response", async (action) => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    serve([contentPage([textItem("a", "alpha", 1)])]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let requestSignal: AbortSignal | undefined;
    server.use(http.get(`${CONTENTS}/a/body`, async ({ request }) => {
      requestSignal = request.signal;
      await pending;
      return HttpResponse.json({ content_id: "a", offset: 0, next_offset: null, total_bytes: 5, text: "alpha" });
    }));
    const view = renderWithProviders(<SessionTranscript slug={SLUG} session={session} />);
    try {
      await select("a", user);
      const dialog = await preview(user);
      await waitFor(() => expect(requestSignal).toBeDefined());
      expectNoExport(dialog);
      if (action === "cancel") {
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      } else {
        serve([contentPage([textItem("other", "other session", 1, { session_id: "other-session" })])], "other-session");
        view.rerender(<SessionTranscript slug={SLUG} session={{ ...session, id: "other-session" }} />);
      }
      await waitFor(() => expect(requestSignal?.aborted).toBe(true));
      await act(async () => { release(); await pending; });
      expect(screen.queryByRole("dialog", { name: "Selected excerpt" })).not.toBeInTheDocument();
      expect(clipboard).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
