// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { SessionTranscript } from "../SessionTranscript";

const SESSION = "81000000-0000-4000-8000-000000000001";
const WORKSPACE = "82000000-0000-4000-8000-000000000001";
const BOARD = "83000000-0000-4000-8000-000000000001";
const CONTENT = "84000000-0000-4000-8000-000000000001";
const NOTE = "85000000-0000-4000-8000-000000000001";
const AT = "2026-10-18T12:00:00Z";
const BODY = "Authorized complete evidence, absent from the metadata preview.";
const EDIT = "Reviewed publication é";
const TITLE = "Reviewed HTTP handoff";
const CONTENTS = `/api/workspaces/acme/sessions/${SESSION}/contents`;
const PUBLICATION = `/api/workspaces/acme/boards/${BOARD}/notes/from-excerpt`;
const source = makeSession({ id: SESSION, workspace_id: WORKSPACE, title: "Publication source", capture_levels: ["rich"] });
const item = makeContent({
  id: CONTENT, session_id: SESSION, occurred_at: AT,
  byte_count: new TextEncoder().encode(BODY).length,
  preview: { text: "Selected publication evidence", truncated: true },
});
type Publication = {
  client_request_id: string;
  title: string;
  content: string;
  card_id: string | null;
  excerpt_source: { workspace_id: string; session_id: string; items: { content_id: string; sha256: string }[] };
};
type Context = { signal: AbortSignal; onTestFinished: (cleanup: () => void) => void };

const disposers: (() => void)[] = [];
let restoreCrypto: (() => void) | undefined;
const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

beforeAll(() => {
  // jsdom has no range geometry; the editor, selection and paste remain real.
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
beforeEach(() => stubReducedMotion(true));
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  restoreCrypto?.();
  restoreCrypto = undefined;
  stubReducedMotion(false);
});

function servePublication() {
  const writes: Publication[] = [];
  const bodyReads: string[] = [];
  const metadataReads: string[][] = [];
  const unexpected: string[] = [];
  const board = { id: BOARD, workspace_id: WORKSPACE, name: "Delivery", is_frozen: false, description: "", tags: [], created_at: AT, updated_at: AT };
  server.use(
    http.get(`${CONTENTS}/window`, () => HttpResponse.json({
      capability: "content-window-v1", mode: "latest", items: [item],
      earlier_cursor: null, later_cursor: null, window_cursor: "one-record", anchor_id: null,
    })),
    http.post(`${CONTENTS}/metadata`, async ({ request }) => {
      const { content_ids } = await request.json() as { content_ids: string[] };
      metadataReads.push(content_ids);
      return HttpResponse.json({ items: content_ids.includes(CONTENT) ? [{ ...item, preview: null }] : [], unavailable_ids: [] });
    }),
    http.get(`${CONTENTS}/:id/body`, ({ params }) => {
      bodyReads.push(String(params.id));
      if (params.id !== CONTENT) return HttpResponse.json({ error_code: "content_not_found" }, { status: 404 });
      return HttpResponse.json({ content_id: CONTENT, offset: 0, next_offset: null, total_bytes: item.byte_count, text: BODY });
    }),
    http.get("/api/workspaces", () => HttpResponse.json([{ id: WORKSPACE, slug: "acme", name: "Private work", created_at: AT, updated_at: AT }])),
    http.get("/api/workspaces/acme/boards", () => HttpResponse.json([board])),
    http.get(`/api/workspaces/acme/boards/${BOARD}`, () => HttpResponse.json({ ...board, columns: [] })),
    http.get("/api/workspaces/acme/members", () => HttpResponse.json([{ user_id: "user-me", role: "owner", name: "Owner", email: "owner@example.test", joined_at: AT }])),
    http.post(PUBLICATION, async ({ request }) => {
      const payload = await request.json() as Publication;
      writes.push(payload);
      return HttpResponse.json({
        id: NOTE, workspace_id: WORKSPACE, board_id: BOARD, card_id: payload.card_id,
        title: payload.title, content: payload.content, pinned: false, kind: "user_note",
        created_by: "user-me", created_at: AT, updated_at: AT,
      }, { status: 201 });
    }),
    http.all("/api/*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected publication fixture request" }, { status: 418 });
    }),
  );
  stubAuthModes(true);
  return { writes, bodyReads, metadataReads, unexpected };
}

function renderPublication(context: Context) {
  const view = renderNavigationRouter([
    { path: "/:slug/sessions/:sessionId", element: <SessionTranscript slug="acme" session={source} /> },
  ], { initialEntries: [`/acme/sessions/${SESSION}`] });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    view.unmount();
    view.router.dispose();
    view.client.clear();
  };
  disposers.push(dispose);
  context.onTestFinished(dispose);
  return view;
}

async function editBody(editor: HTMLElement, context: Context) {
  const paragraph = editor.querySelector("p")!;
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: {
    types: ["text/html", "text/plain"], items: [], files: [],
    getData: (type: string) => type === "text/html" ? `<strong>${EDIT}</strong>` : type === "text/plain" ? EDIT : "",
  } });
  await act(async () => { context.signal.throwIfAborted(); editor.dispatchEvent(paste); });
  context.signal.throwIfAborted();
  await waitFor(() => expect(editor.querySelector("strong")?.textContent).toBe(EDIT), { container: editor });
  context.signal.throwIfAborted();
  expect(editor).toHaveFocus();
}

describe("ExcerptNoteDialog publication UUID availability", () => {
  it.for(["native UUID", "native UUID unavailable"] as const)(
    "publishes the actual prepared and edited handoff with %s and secure random values retained",
    async (availability, context) => {
      const cryptoObject = globalThis.crypto;
      const getRandomValues = cryptoObject.getRandomValues;
      expect(cryptoObject).toBe(window.crypto);
      expect(getRandomValues).toBeTypeOf("function");
      expect(cryptoObject.randomUUID).toBeTypeOf("function");
      if (availability === "native UUID unavailable") {
        const descriptor = Object.getOwnPropertyDescriptor(cryptoObject, "randomUUID");
        Object.defineProperty(cryptoObject, "randomUUID", { configurable: true, value: undefined });
        restoreCrypto = () => {
          if (descriptor) Object.defineProperty(cryptoObject, "randomUUID", descriptor);
          else Reflect.deleteProperty(cryptoObject, "randomUUID");
        };
        expect(cryptoObject.randomUUID).toBeUndefined();
      }
      expect(cryptoObject.getRandomValues).toBe(getRandomValues);

      const state = servePublication();
      const view = renderPublication(context);
      const user = userEvent.setup();
      await screen.findByText("Selected publication evidence"); context.signal.throwIfAborted();
      const row = document.getElementById(`content-${CONTENT}`)!;
      expect(row).not.toBeNull();
      await user.click(within(row).getByRole("checkbox")); context.signal.throwIfAborted();
      expect(within(row).getByRole("checkbox")).toBeChecked();
      await user.click(screen.getByRole("button", { name: "Preview excerpt" })); context.signal.throwIfAborted();
      const preview = await screen.findByRole("dialog", { name: "Selected excerpt" }); context.signal.throwIfAborted();
      await waitFor(() => expect((within(preview).getByRole("textbox", { name: "Excerpt preview" }) as HTMLTextAreaElement).value).toContain(BODY));
      context.signal.throwIfAborted();
      await waitFor(() => expect(within(preview).getByRole("button", { name: "Share as note" })).toBeEnabled());
      await user.click(within(preview).getByRole("button", { name: "Share as note" })); context.signal.throwIfAborted();
      const dialog = await screen.findByRole("dialog", { name: "Share as note" }); context.signal.throwIfAborted();
      await user.selectOptions(within(dialog).getByRole("combobox", { name: "Workspace" }), "acme"); context.signal.throwIfAborted();
      await within(dialog).findByRole("option", { name: "Delivery" }); context.signal.throwIfAborted();
      await user.selectOptions(within(dialog).getByRole("combobox", { name: "Board" }), BOARD); context.signal.throwIfAborted();
      await user.clear(within(dialog).getByRole("textbox", { name: "Note title" }));
      await user.paste(TITLE); context.signal.throwIfAborted();
      const editor = await waitFor(() => {
        const element = within(dialog).getByRole("region", { name: "Note content" }).querySelector<HTMLElement>('[contenteditable="true"]');
        expect(element).not.toBeNull();
        return element!;
      }, { container: dialog });
      context.signal.throwIfAborted();
      expect(editor.textContent).toContain(BODY);
      await editBody(editor, context);
      const save = within(dialog).getByRole("button", { name: "Save note" });
      await waitFor(() => expect(save).toBeEnabled(), { container: dialog }); context.signal.throwIfAborted();
      expect(state.writes).toEqual([]);
      await user.click(save); context.signal.throwIfAborted();
      const open = await within(dialog).findByRole("link", { name: "Open note" }); context.signal.throwIfAborted();
      expect(open).toHaveAttribute("href", `/acme/boards/${BOARD}/notes?note=${NOTE}`);
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0]).toMatchObject({ title: TITLE, card_id: null, excerpt_source: {
        workspace_id: WORKSPACE, session_id: SESSION, items: [{ content_id: CONTENT, sha256: item.sha256 }],
      } });
      expect(state.writes[0]!.client_request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(state.writes[0]!.content).toContain(BODY);
      expect(state.writes[0]!.content).toContain(EDIT);
      expect(state.writes[0]!.content).toContain('"type":"bold"');
      expect(state.bodyReads).toEqual([CONTENT]);
      expect(state.metadataReads.length).toBeGreaterThan(0);
      for (const ids of state.metadataReads) expect(ids).toEqual([CONTENT]);
      expect(cryptoObject.getRandomValues).toBe(getRandomValues);
      if (availability === "native UUID unavailable") expect(cryptoObject.randomUUID).toBeUndefined();
      else expect(cryptoObject.randomUUID).toBeTypeOf("function");
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
      expect(state.unexpected).toEqual([]);
    },
  );
});
