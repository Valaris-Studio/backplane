// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isInaccessible } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import i18n from "@/i18n/config";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { SessionContent } from "@/types/agent-session";
import { ME, SLUG, callPage, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { useHandoffDraft } from "../../hooks/use-handoff-drafts";
import { SessionDetailPage } from "../SessionDetailPage";
import { SessionTranscript } from "../SessionTranscript";

const SESSION = "93111111-1111-4111-8111-111111111111";
const BOARD = "93222222-2222-4222-8222-222222222222";
const ROUTE = `/${SLUG}/sessions/${SESSION}`;
const PATH = `/api/workspaces/${SLUG}/sessions/${SESSION}`;
const CONTENTS = `${PATH}/contents`;
const NOTE_PATH = `/api/workspaces/${SLUG}/boards/${BOARD}/notes/from-excerpt`;
const AT = "2026-10-17T12:00:00.000Z";
const EDIT = "OWNER RETAINED EDIT é";
const TITLE = "Owner reviewed bounded draft";
const session = makeSession({ id: SESSION, title: "Draft rendering evidence", capture_levels: ["rich"], started_at: AT, last_event_at: AT, ended_at: AT });
const contentId = (order: number) => `93333333-3333-4333-8333-${String(order).padStart(12, "0")}`;
const bodyText = (order: number) => `Private full evidence ${order} — absent from every metadata preview.`;
const record = (order: number): SessionContent => makeContent({
  id: contentId(order), session_id: SESSION, source: { kind: "claude_transcript", order },
  occurred_at: new Date(Date.parse(AT) + order * 60_000).toISOString(),
  byte_count: new TextEncoder().encode(bodyText(order)).length,
  preview: { text: `Captured record ${order}`, truncated: false },
});

type Context = { signal: AbortSignal; onTestFinished: (cleanup: () => void) => void };
type Publication = Record<string, unknown>;

function serveReader(total: number) {
  const items = Array.from({ length: total }, (_, index) => record(index + 1));
  const state = {
    items,
    metadataStatus: 200,
    saveStatus: "success" as "success" | "unknown",
    requests: [] as string[],
    unexpected: [] as string[],
    windows: [] as string[],
    metadata: [] as { ids: string[]; status: number }[],
    bodies: [] as string[],
    writes: [] as Publication[],
  };
  const board = { id: BOARD, workspace_id: "ws-1", name: "Reader review", description: "", tags: [], is_frozen: false, created_at: AT, updated_at: AT };
  const tracked = (request: Request) => state.requests.push(`${request.method} ${new URL(request.url).pathname}`);
  server.use(
    http.get(PATH, ({ request }) => { tracked(request); return HttpResponse.json(session); }),
    http.get(`${PATH}/calls`, ({ request }) => { tracked(request); return HttpResponse.json(callPage([])); }),
    http.get(`${PATH}/usage`, ({ request }) => { tracked(request); return HttpResponse.json({ items: [], price_table_version: "test" }); }),
    http.get(`${PATH}/links`, ({ request }) => { tracked(request); return HttpResponse.json({ items: [] }); }),
    http.get(`${PATH}/children`, ({ request }) => { tracked(request); return HttpResponse.json({ items: [] }); }),
    http.get(`${PATH}/rhythm`, ({ request }) => {
      tracked(request);
      return HttpResponse.json({ start: AT, end: AT, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 });
    }),
    http.get(`${CONTENTS}/window`, ({ request }) => {
      tracked(request);
      const params = new URL(request.url).searchParams;
      const mode = params.get("mode") ?? "latest";
      state.windows.push(mode);
      let from = Math.max(0, items.length - 100);
      let to = items.length;
      if (mode === "beginning") { from = 0; to = Math.min(100, items.length); }
      if (mode === "anchor") {
        const index = items.findIndex((item) => item.id === params.get("anchor_id"));
        if (index < 0) return HttpResponse.json({ error_code: "content_not_found" }, { status: 404 });
        from = Math.max(0, index - 49); to = Math.min(items.length, index + 51);
      }
      if (mode === "refresh") {
        const cursor = params.get("cursor")!.split(":"); from = Number(cursor[1]); to = Number(cursor[2]);
      }
      return HttpResponse.json({ capability: "content-window-v1", mode, items: items.slice(from, to),
        earlier_cursor: from > 0 ? `earlier:${from}` : null, later_cursor: to < items.length ? `later:${to}` : null,
        window_cursor: `window:${from}:${to}`, anchor_id: mode === "anchor" ? params.get("anchor_id") : null });
    }),
    http.post(`${CONTENTS}/metadata`, async ({ request }) => {
      tracked(request);
      const { content_ids: ids } = await request.json() as { content_ids: string[] };
      state.metadata.push({ ids, status: state.metadataStatus });
      if (state.metadataStatus !== 200) return HttpResponse.json({ detail: "Selected evidence unavailable", error_code: "content_not_found" }, { status: state.metadataStatus });
      return HttpResponse.json({ items: items.filter((item) => ids.includes(item.id)).map((item) => ({ ...item, preview: null })), unavailable_ids: [] });
    }),
    http.get(`${CONTENTS}/:id/body`, ({ request, params }) => {
      tracked(request);
      const id = String(params.id); state.bodies.push(id);
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return HttpResponse.json({ error_code: "content_not_found" }, { status: 404 });
      return HttpResponse.json({ content_id: id, offset: 0, next_offset: null, total_bytes: item.byte_count, text: bodyText(item.source.order) });
    }),
    http.get("/api/workspaces", ({ request }) => { tracked(request); return HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Private work" }]); }),
    http.get(`/api/workspaces/${SLUG}/boards`, ({ request }) => { tracked(request); return HttpResponse.json([board]); }),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD}`, ({ request }) => { tracked(request); return HttpResponse.json({ ...board, columns: [] }); }),
    http.get(`/api/workspaces/${SLUG}/members`, ({ request }) => {
      tracked(request); return HttpResponse.json([{ user_id: ME, role: "owner", name: "Owner", email: "owner@example.test", joined_at: AT }]);
    }),
    http.post(NOTE_PATH, async ({ request }) => {
      tracked(request);
      const payload = await request.json() as Publication; state.writes.push(payload);
      if (state.saveStatus === "unknown") return HttpResponse.error();
      return HttpResponse.json({ id: "note-draft-rendering", workspace_id: "ws-1", board_id: BOARD, card_id: null,
        title: payload.title, content: payload.content, kind: "user_note", pinned: false, created_by: ME, created_at: AT, updated_at: AT }, { status: 201 });
    }),
    // Reject every unlisted route instead of allowing a synthetic test to reach a live server.
    http.all("*", ({ request }) => {
      const unexpected = `${request.method} ${new URL(request.url).pathname}`;
      state.unexpected.push(unexpected);
      return HttpResponse.json({ detail: `Unexpected fixture request: ${unexpected}` }, { status: 418 });
    }),
  );
  stubAuthModes(true);
  return state;
}

// Read-only observation of the actual provider. No private cache or store writes.
function RetentionProbe() {
  const { state } = useHandoffDraft(SLUG, SESSION);
  return <output data-testid="retention" hidden
    data-selected={[...state.selected.keys()].join(",")}
    data-draft={state.draft !== null ? "yes" : "no"}
    data-form={state.form !== null ? "yes" : "no"}
    data-request={state.form?.request !== null && state.form?.request !== undefined ? "yes" : "no"}
    data-unknown={state.form?.hadUnknownOutcome ? "yes" : "no"}
    data-pending={state.form?.pending ? "yes" : "no"} />;
}

function mountReader(context: Context, fullPage = false) {
  // The existing router fixture supplies actual navigation, return and owner-scoped draft providers.
  const view = renderNavigationRouter([
    { path: "/:slug/sessions/:sessionId", element: <><RetentionProbe />{fullPage ? <SessionDetailPage /> : <SessionTranscript slug={SLUG} session={session} />}</> },
  ], { initialEntries: [fullPage ? `${ROUTE}#content-${contentId(2)}` : ROUTE] });
  const dispose = () => { view.unmount(); view.router.dispose(); view.client.clear(); };
  context.onTestFinished(dispose);
  return { ...view, dispose };
}

function action(container: HTMLElement, name: string) {
  const button = within(container).getByText(name, { selector: "button" });
  expect(button.getAttribute("role")?.split(" ")[0] ?? "button").toBe("button");
  expect(button).toHaveAccessibleName(name);
  expect(isInaccessible(button)).toBe(false);
  return button;
}

function labeledControl(container: HTMLElement, name: string, role: "combobox" | "textbox") {
  const label = within(container).getByText(name, { selector: "label" }) as HTMLLabelElement;
  expect(isInaccessible(label)).toBe(false);
  // Resolve the explicit association before checking its one accessible name:
  // jsdom otherwise scans all retained row labels for every candidate control.
  const control = label.control;
  expect(control).not.toBeNull();
  expect(control).toBeInstanceOf(role === "combobox" ? HTMLSelectElement : HTMLInputElement);
  expect(container).toContainElement(control);
  expect(within(label).getByRole(role)).toBe(control);
  expect(control).toHaveAccessibleName(name);
  expect(isInaccessible(control!)).toBe(false);
  return control!;
}

function row(container: HTMLElement, order: number) {
  const element = container.querySelector<HTMLElement>(`[id="content-${contentId(order)}"]`);
  expect(element).not.toBeNull();
  return element!;
}

async function idle(client: QueryClient, context: Context) {
  await waitFor(() => expect(client.isFetching()).toBe(0));
  context.signal.throwIfAborted();
}

async function prepareDraft(container: HTMLElement, user: ReturnType<typeof userEvent.setup>, order: number, context: Context) {
  await within(container).findByText(`Captured record ${order}`); context.signal.throwIfAborted();
  await user.click(within(row(container, order)).getByRole("checkbox")); context.signal.throwIfAborted();
  expect(within(row(container, order)).getByRole("checkbox")).toBeChecked();
  const actions = within(container).getByText(/^Selected: \d+ · /).parentElement!;
  await user.click(action(actions, "Preview excerpt")); context.signal.throwIfAborted();
  const preview = await screen.findByRole("dialog", { name: "Selected excerpt" }); context.signal.throwIfAborted();
  await waitFor(() => expect(within(preview).getByText("Share as note", { selector: "button" })).toBeEnabled(), { container: preview });
  context.signal.throwIfAborted();
  expect((within(preview).getByRole("textbox", { name: "Excerpt preview" }) as HTMLTextAreaElement).value).toContain(bodyText(order));
  await user.click(action(preview, "Share as note")); context.signal.throwIfAborted();
  const dialog = await screen.findByRole("dialog", { name: "Share as note" }); context.signal.throwIfAborted();
  await user.selectOptions(labeledControl(dialog, "Workspace", "combobox"), SLUG); context.signal.throwIfAborted();
  await within(dialog).findByRole("option", { name: "Reader review" }); context.signal.throwIfAborted();
  await user.selectOptions(labeledControl(dialog, "Board", "combobox"), BOARD); context.signal.throwIfAborted();
  await user.clear(labeledControl(dialog, "Note title", "textbox")); context.signal.throwIfAborted();
  await user.paste(TITLE); context.signal.throwIfAborted();
  await waitFor(() => expect(within(dialog).getByText("Save note", { selector: "button" })).toBeEnabled(), { container: dialog });
  context.signal.throwIfAborted();
  const editor = await waitFor(() => {
    const element = within(dialog).getByRole("region", { name: "Note content" }).querySelector<HTMLElement>('[contenteditable="true"]');
    expect(element).not.toBeNull(); return element!;
  }, { container: dialog });
  context.signal.throwIfAborted();
  expect(editor.textContent).toContain(bodyText(order));
  return { dialog, editor };
}

async function pasteBody(editor: HTMLElement, context: Context) {
  const paragraph = editor.querySelector("p")!;
  editor.focus();
  const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    types: ["text/html", "text/plain"], items: [], files: [],
    getData: (type: string) => type === "text/html" ? `<strong>${EDIT}</strong>` : type === "text/plain" ? EDIT : "",
  } });
  await act(async () => { context.signal.throwIfAborted(); editor.dispatchEvent(event); });
  context.signal.throwIfAborted();
  await waitFor(() => expect(editor.textContent).toContain(EDIT), { container: editor });
  context.signal.throwIfAborted();
  expect(editor.querySelector("strong")?.textContent).toBe(EDIT);
  expect(editor).toHaveFocus();
}

function unloadWarns() {
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
}

const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
beforeAll(() => {
  const rect = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) });
});
afterAll(() => {
  for (const [name, descriptor] of [["getBoundingClientRect", originalRect], ["getClientRects", originalRects]] as const) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
    else Reflect.deleteProperty(Range.prototype, name);
  }
});
beforeEach(async () => { await i18n.changeLanguage("en"); stubReducedMotion(true); });
afterEach(async () => { vi.restoreAllMocks(); stubReducedMotion(false); await i18n.changeLanguage("en"); });

describe("retained transcript work while editing a handoff", () => {
  it("keeps a real body edit bounded independently of 4 versus 100 loaded rows, preserving output and selection", async (context) => {
    const calls = vi.spyOn(Date.prototype, "toLocaleTimeString"); // Call through: timestamps stay real.
    const measured: { rows: number; calls: number }[] = [];
    for (const total of [4, 201]) {
      const state = serveReader(total);
      const view = mountReader(context);
      const user = userEvent.setup();
      try {
        await within(view.container).findByText(`Captured record ${total}`); context.signal.throwIfAborted();
        const list = within(view.container).getByRole("list", { name: "Transcript" });
        const { dialog, editor } = await prepareDraft(view.container, user, total, context);
        await idle(view.client, context);
        const ids = [...list.children].map((element) => element.id);
        const expectedIds = state.items.slice(-100).map((item) => `content-${item.id}`);
        expect(ids).toEqual(expectedIds);
        const labels = [...view.container.querySelectorAll('select option[value^="93333333-"]')].map((option) => option.textContent);
        const times = [...list.querySelectorAll("time")].map((element) => [element.dateTime, element.textContent]);
        expect(labels).toHaveLength(Math.min(total, 100));
        expect(times).toHaveLength(Math.min(total, 100));
        const readsBefore = [...state.requests];
        const before = calls.mock.calls.length;
        await pasteBody(editor, context);
        const formattingCalls = calls.mock.calls.length - before;
        measured.push({ rows: expectedIds.length, calls: formattingCalls });
        expect(state.requests).toEqual(readsBefore);
        expect([...list.children].map((element) => element.id)).toEqual(ids);
        expect([...list.querySelectorAll("time")].map((element) => [element.dateTime, element.textContent])).toEqual(times);
        expect([...view.container.querySelectorAll('select option[value^="93333333-"]')].map((option) => option.textContent)).toEqual(labels);
        expect(row(view.container, total).querySelector('input[type="checkbox"]')).toBeChecked();
        expect(within(view.container).getByTestId("retention")).toHaveAttribute("data-selected", contentId(total));
        await user.click(action(dialog, "Save note")); context.signal.throwIfAborted();
        await within(dialog).findByRole("link", { name: "Open note" }); context.signal.throwIfAborted();
        expect(state.writes).toHaveLength(1);
        expect(state.writes[0]).toMatchObject({ title: TITLE, excerpt_source: { session_id: SESSION, items: [{ content_id: contentId(total), sha256: "a".repeat(64) }] } });
        expect(String(state.writes[0]!.content)).toContain(EDIT);
        expect(String(state.writes[0]!.content)).toContain(bodyText(total));
        expect(String(state.writes[0]!.content)).toContain('"type":"bold"');
        expect(state.bodies).toEqual([contentId(total)]);
        await user.click(action(dialog, "Hide for now")); context.signal.throwIfAborted();
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument()); context.signal.throwIfAborted();
        if (total === 201) {
          await user.click(action(within(view.container).getByRole("navigation", { name: "Captured records" }), "Beginning")); context.signal.throwIfAborted();
          await within(view.container).findByText("Captured record 1"); context.signal.throwIfAborted();
          expect(view.container.querySelector(`[id="content-${contentId(201)}"]`)).toBeNull();
          await user.click(within(row(view.container, 1)).getByRole("checkbox")); context.signal.throwIfAborted();
          expect(within(row(view.container, 1)).getByRole("checkbox")).toBeChecked();
          expect(within(view.container).getByTestId("retention")).toHaveAttribute("data-selected", `${contentId(201)},${contentId(1)}`);
          for (const language of ["es", "pt-BR", "en"]) {
            await act(async () => { await i18n.changeLanguage(language); }); context.signal.throwIfAborted();
            const expected = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(new Date(record(1).occurred_at));
            expect(row(view.container, 1).querySelector("time")?.textContent).toBe(expected);
            expect(view.container.querySelector(`option[value="${contentId(1)}"]`)?.textContent).toContain(expected);
            expect(within(row(view.container, 1)).getByRole("checkbox")).toBeChecked();
          }
          expect(state.windows).toEqual(["latest", "beginning"]);
        }
        expect(state.unexpected).toEqual([]);
      } finally { view.dispose(); }
    }
    console.info("A01 handoff body-edit formatting", JSON.stringify(measured));
    // Fixed range/header bookkeeping is allowed; an additional 96 unchanged
    // rows must not add per-row formatting work to an unrelated editor paste.
    expect(measured[1]!.calls, JSON.stringify(measured)).toBeLessThanOrEqual(measured[0]!.calls + 4);
  });

  it("replays an authorized unknown outcome with the same request and no source/body revalidation", async (context) => {
    const state = serveReader(2); state.saveStatus = "unknown";
    const view = mountReader(context, true); const user = userEvent.setup();
    const { dialog, editor } = await prepareDraft(view.container, user, 2, context);
    await pasteBody(editor, context);
    await user.click(action(dialog, "Save note")); context.signal.throwIfAborted();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i); context.signal.throwIfAborted();
    expect(state.writes).toHaveLength(1);
    const frozen = structuredClone(state.writes[0]);
    expect(frozen).toMatchObject({ title: TITLE, client_request_id: expect.any(String) });
    expect(String(frozen!.content)).toContain(EDIT);
    expect(within(view.container).getByTestId("retention")).toHaveAttribute("data-unknown", "yes");
    expect(unloadWarns()).toBe(true);
    await user.click(action(dialog, "Hide for now")); context.signal.throwIfAborted();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument()); context.signal.throwIfAborted();
    await user.click(action(view.container, "Resume note save")); context.signal.throwIfAborted();
    const resumed = await screen.findByRole("dialog", { name: "Share as note" }); context.signal.throwIfAborted();
    expect(within(resumed).getByRole("textbox", { name: "Note title" })).toHaveValue(TITLE);
    await idle(view.client, context);
    const readsBefore = { metadata: state.metadata.length, bodies: state.bodies.length };
    state.saveStatus = "success";
    await user.click(action(resumed, "Retry save")); context.signal.throwIfAborted();
    await within(resumed).findByRole("link", { name: "Open note" }); context.signal.throwIfAborted();
    expect(state.writes).toEqual([frozen, frozen]);
    expect({ metadata: state.metadata.length, bodies: state.bodies.length }).toEqual(readsBefore);
    expect(within(view.container).getByTestId("retention")).toHaveAttribute("data-draft", "no");
    expect(unloadWarns()).toBe(false);
    expect(state.unexpected).toEqual([]);
  });

  it.for([403, 404])("purges an unknown outcome's retained source, document and retry on actual selected-metadata %i", async (status, context) => {
    const state = serveReader(2); state.saveStatus = "unknown";
    const view = mountReader(context, true); const user = userEvent.setup();
    const { dialog, editor } = await prepareDraft(view.container, user, 2, context);
    await pasteBody(editor, context);
    await user.click(action(dialog, "Save note")); context.signal.throwIfAborted();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i); context.signal.throwIfAborted();
    const retained = within(view.container).getByTestId("retention");
    expect(retained).toHaveAttribute("data-request", "yes");
    expect(retained).toHaveAttribute("data-draft", "yes");
    expect(retained).toHaveAttribute("data-selected", contentId(2));
    expect(unloadWarns()).toBe(true);
    expect(state.writes).toHaveLength(1);
    expect(String(state.writes[0]!.content)).toContain(EDIT);
    await user.click(action(dialog, "Hide for now")); context.signal.throwIfAborted();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument()); context.signal.throwIfAborted();
    await idle(view.client, context);
    const readsBefore = state.metadata.length;
    const bodiesBefore = [...state.bodies];
    state.metadataStatus = status;
    await user.click(action(view.container, "Refresh evidence")); context.signal.throwIfAborted();
    await waitFor(() => expect(state.metadata.slice(readsBefore)).toEqual([{ ids: [contentId(2)], status }])); context.signal.throwIfAborted();
    await waitFor(() => {
      expect(retained).toHaveAttribute("data-draft", "no");
      expect(retained).toHaveAttribute("data-form", "no");
      expect(retained).toHaveAttribute("data-request", "no");
      expect(retained).toHaveAttribute("data-selected", "");
    }, { container: view.container });
    context.signal.throwIfAborted();
    await idle(view.client, context);
    expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument();
    expect(within(view.container).queryByText("Resume note save", { selector: "button" })).not.toBeInTheDocument();
    expect(view.container.textContent).not.toContain(EDIT);
    expect(view.container.textContent).not.toContain(bodyText(2));
    expect(state.bodies).toEqual(bodiesBefore);
    expect(state.writes).toHaveLength(1);
    expect(unloadWarns()).toBe(false);
    expect(state.unexpected).toEqual([]);
    console.info("A01 unknown-outcome authority", JSON.stringify({ status, metadata: state.metadata, writes: state.writes.length, bodies: state.bodies }));
  });
});
