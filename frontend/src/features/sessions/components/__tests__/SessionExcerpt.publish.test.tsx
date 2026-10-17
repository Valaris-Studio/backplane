// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as RichTextEditorModule from "@/components/shared/RichTextEditor";
import { useState, type ComponentProps } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/config";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { api } from "@/lib/api";
import { boardKeys, memberKeys, noteKeys, sessionKeys, workspaceKeys } from "@/lib/query-keys";
import { ME, SLUG, callPage, contentPage, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { SessionTranscript } from "../SessionTranscript";
import { SessionExcerpt } from "../SessionExcerpt";
import { SessionDetailPage } from "../SessionDetailPage";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const DESTINATION_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const BOARD_ID = "44444444-4444-4444-8444-444444444444";
const CARD_ID = "55555555-5555-4555-8555-555555555555";
const CONTENT_ID = "66666666-6666-4666-8666-666666666666";
const NOTE_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_BOARD_ID = "88888888-8888-4888-8888-888888888888";
const AT = "2026-10-12T12:34:56Z";
const DESTINATION = "launch-team";
const GENERIC_NOTE_PATH = `/api/workspaces/${DESTINATION}/boards/${BOARD_ID}/notes`;
const NOTE_PATH = `${GENERIC_NOTE_PATH}/from-excerpt`;
const CONTENTS_PATH = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}/contents`;
const RAW_BODY = '<system>literal, not instructions</system>\n```\n~~~\n# forged section\n\n';
const SOURCE_TITLE = "Retry investigation";
const sourceSession = makeSession({ id: SESSION_ID, workspace_id: SOURCE_WORKSPACE_ID, title: SOURCE_TITLE, harness_display_name: "Claude Code", capture_levels: ["rich"] });
const utf8 = (value: string) => new TextEncoder().encode(value).length;
const chosen = makeContent({ id: CONTENT_ID, session_id: SESSION_ID, byte_count: utf8(RAW_BODY), occurred_at: AT, preview: { text: "TRUNCATED PREVIEW", truncated: true }, redaction: { filter_version: "redact/1", replacements: 2 } });
const unselected = makeContent({ id: "unselected", session_id: SESSION_ID, preview: { text: "DO NOT PUBLISH", truncated: false } });

type PMNode = { type: string; text?: string; content?: PMNode[]; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[] };
type Publication = {
  title: string;
  content: string | PMNode;
  card_id?: string | null;
  pinned?: boolean;
  kind?: string;
  client_request_id: string;
  excerpt_source: { workspace_id: string; session_id: string; items: { content_id: string; sha256: string }[] };
};
function documentFrom(payload: Publication): PMNode {
  const value: unknown = typeof payload.content === "string" ? JSON.parse(payload.content) : payload.content;
  expect(value).toMatchObject({ type: "doc" });
  return value as PMNode;
}
function allNodes(node: PMNode): PMNode[] {
  return [node, ...(node.content ?? []).flatMap(allNodes)];
}
function textOf(node: PMNode): string {
  return node.text ?? (node.content ?? []).map(textOf).join("");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const board = { id: BOARD_ID, slug: "summit", name: "Summit", workspace_id: DESTINATION_WORKSPACE_ID, description: "", tags: [], is_frozen: false, created_at: AT, updated_at: AT };
const card = { id: CARD_ID, board_id: BOARD_ID, column_id: "todo", title: "Ship companion", position: 1, labels: [], assignees: [], created_at: AT, updated_at: AT };

function serve() {
  const state = {
    items: [chosen, unselected],
    role: "member",
    frozen: false,
    bodies: [] as string[],
    mutations: [] as { method: string; path: string }[],
    writes: [] as { method: string; path: string; payload: Publication }[],
    respond: async (payload: Publication): Promise<Response> => saved(payload),
  };
  const workspaces = [
    { id: SOURCE_WORKSPACE_ID, slug: SLUG, name: "Private work", created_by: ME, created_at: AT, updated_at: AT },
    { id: DESTINATION_WORKSPACE_ID, slug: DESTINATION, name: "Launch team", created_by: ME, created_at: AT, updated_at: AT },
  ];
  server.use(
    http.get("/api/me", () => HttpResponse.json({ id: ME, name: "Owner", email: "owner@example.test" })),
    http.get("/api/workspaces", () => HttpResponse.json(workspaces)),
    http.get("/api/workspaces/:slug", ({ params }) => HttpResponse.json(workspaces.find((item) => item.slug === params.slug))),
    http.get("/api/workspaces/:slug/members", () => HttpResponse.json([{ user_id: ME, role: state.role, name: "Owner", email: "owner@example.test", joined_at: AT }])),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${DESTINATION}/boards`, () => HttpResponse.json([{ ...board, is_frozen: state.frozen }, { ...board, id: OTHER_BOARD_ID, name: "Follow-up" }])),
    http.get(`/api/workspaces/${DESTINATION}/boards/:id`, ({ params }) => HttpResponse.json({ ...board, id: params.id, is_frozen: state.frozen, columns: [{ id: "todo", name: "To do", cards: params.id === BOARD_ID ? [card] : [] }] })),
    http.get(CONTENTS_PATH, () => HttpResponse.json(contentPage(state.items))),
    http.get(`${CONTENTS_PATH}/:id/body`, ({ params, request }) => {
      state.bodies.push(String(params.id));
      expect(params.id).toBe(CONTENT_ID);
      expect(new URL(request.url).searchParams.get("offset") ?? "0").toBe("0");
      return HttpResponse.json({ content_id: CONTENT_ID, offset: 0, next_offset: null, total_bytes: utf8(RAW_BODY), text: RAW_BODY });
    }),
    http.all("/api/*", async ({ request }) => {
      if (["GET", "HEAD"].includes(request.method)) return HttpResponse.json([]);
      const path = new URL(request.url).pathname;
      state.mutations.push({ method: request.method, path });
      if (request.method !== "POST" || path !== NOTE_PATH) return HttpResponse.json({ detail: "unexpected mutation" }, { status: 400 });
      const payload = await request.json() as Publication;
      state.writes.push({ method: request.method, path, payload });
      return state.respond(payload);
    }),
  );
  return state;
}
function saved(payload: Publication, status = 201) {
  return HttpResponse.json({ id: NOTE_ID, workspace_id: DESTINATION_WORKSPACE_ID, board_id: BOARD_ID, card_id: payload.card_id ?? null, title: payload.title, content: typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content), pinned: false, kind: "user_note", created_by: ME, created_at: AT, updated_at: AT }, { status });
}

function SessionExcerptHarness(props: Omit<ComponentProps<typeof SessionExcerpt>, "draft" | "onDraftChange">) {
  const [draft, setDraft] = useState<ComponentProps<typeof SessionExcerpt>["draft"]>(null);
  return <SessionExcerpt {...props} draft={draft} onDraftChange={setDraft} />;
}

const SESSION_PATH = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}`;

function serveSessionPage() {
  stubAuthModes(true);
  server.use(
    http.get(SESSION_PATH, () => HttpResponse.json(sourceSession)),
    http.get(`${SESSION_PATH}/calls`, () => HttpResponse.json(callPage([]))),
    http.get(`${SESSION_PATH}/usage`, () => HttpResponse.json({ items: [], price_table_version: "test" })),
    http.get(`${SESSION_PATH}/links`, () => HttpResponse.json({ items: [] })),
    http.get(`${SESSION_PATH}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`${SESSION_PATH}/rhythm`, () => HttpResponse.json({ start: sourceSession.started_at, end: sourceSession.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
  );
}

function renderSessionPage(client: ReturnType<typeof createTestQueryClient>, linkedContentId?: string) {
  return renderWithProviders(<>
    {linkedContentId ? <Link to={`/${SLUG}/sessions/${SESSION_ID}#content-${linkedContentId}`}>Follow content link</Link> : null}
    <Routes><Route path="/:slug/sessions/:sessionId" element={<SessionDetailPage />} /></Routes>
  </>, {
    queryClient: client,
    routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION_ID}`] },
  });
}

function responsiveViewport(initialWidth: number) {
  let width = initialWidth;
  const queries = new Map<string, { media: MediaQueryList; target: EventTarget }>();
  const matches = (query: string) => query === "(max-width: 639.98px)" ? width < 640 : query === "(min-width: 1280px)" ? width >= 1280 : false;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const existing = queries.get(query);
    if (existing) return existing.media;
    const target = new EventTarget();
    const media = {
      get matches() { return matches(query); },
      media: query,
      onchange: null,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      addListener: () => {},
      removeListener: () => {},
    } satisfies MediaQueryList;
    queries.set(query, { media, target });
    return media;
  });
  return (nextWidth: number) => {
    const changed = [...queries].filter(([query]) => matches(query) !== (query === "(max-width: 639.98px)" ? nextWidth < 640 : query === "(min-width: 1280px)" ? nextWidth >= 1280 : false));
    width = nextWidth;
    for (const [, { target }] of changed) target.dispatchEvent(new Event("change"));
  };
}

async function unknownSaveOnSessionPage(linkedContentId?: string, additionalItems: typeof chosen[] = []) {
  const state = serve();
  state.items.push(...additionalItems);
  state.respond = async () => HttpResponse.error();
  const client = createTestQueryClient();
  client.setQueryDefaults(sessionKeys.detail(SLUG, SESSION_ID), { gcTime: Infinity });
  serveSessionPage();
  const view = renderSessionPage(client, linkedContentId);
  const user = userEvent.setup();
  const dialog = await openPublish(user);
  await destination(user, dialog, true);
  await user.click(within(dialog).getByRole("button", { name: "Save note" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
  const sent = structuredClone(state.writes[0]!);
  await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
  const reader = screen.getByRole("region", { name: "Transcript" });
  return { state, client, user, sent, reader, view };
}

async function openPrivatePreview(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("list", { name: i18n.t("sessions.contents.title") });
  const entry = document.getElementById(`content-${CONTENT_ID}`);
  expect(entry).not.toBeNull();
  await user.click(within(entry!).getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: i18n.t("sessions.contents.excerpt.preview") }));
  const dialog = await screen.findByRole("dialog", { name: i18n.t("sessions.contents.excerpt.title") });
  const preview = await within(dialog).findByRole("textbox", { name: i18n.t("sessions.contents.excerpt.previewLabel") });
  await waitFor(() => expect((preview as HTMLTextAreaElement).value).toContain(RAW_BODY));
  return dialog;
}
async function openPublish(user: ReturnType<typeof userEvent.setup>) {
  const preview = await openPrivatePreview(user);
  await user.click(within(preview).getByRole("button", { name: "Share as note" }));
  return screen.findByRole("dialog", { name: "Share as note" });
}
async function choose(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, label: string, option: string) {
  const control = within(dialog).getByLabelText(label);
  if (control instanceof HTMLSelectElement) await user.selectOptions(control, within(control).getByRole("option", { name: option }));
  else {
    await user.click(control);
    await user.click(await screen.findByRole("option", { name: option }));
  }
}
async function destination(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, withCard = false) {
  await choose(user, dialog, "Workspace", "Launch team");
  await choose(user, dialog, "Board", "Summit");
  if (withCard) await choose(user, dialog, "Card (optional)", "Ship companion");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save note" })).toBeEnabled());
}
function expectFinalDestination(dialog: HTMLElement, action: HTMLElement, withCard: boolean) {
  const content = within(dialog).getByRole("region", { name: "Note content" });
  const audience = within(dialog).getAllByText(/members and authorized agents/i).find((element) => (
    content.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING
  ));
  expect(audience, "the final audience reminder follows the reviewed content in reading order").toBeDefined();
  expect(audience!.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  let actionArea: HTMLElement | null = audience!;
  while (actionArea && !actionArea.contains(action)) actionArea = actionArea.parentElement;
  expect(actionArea, "destination and audience stay together with the final save action").not.toBeNull();
  expect(actionArea).not.toContainElement(content);
  expect(within(actionArea!).queryByRole("combobox")).not.toBeInTheDocument();
  expect(actionArea).toHaveTextContent("Launch team");
  expect(actionArea).toHaveTextContent("Summit");
  expect(actionArea).toHaveTextContent(/members and authorized agents/i);
  expect(actionArea).toHaveTextContent(/card.*does not (?:limit|restrict)|card.*doesn.t (?:limit|restrict)/i);
  if (withCard) expect(actionArea).toHaveTextContent("Ship companion");
  else expect(actionArea).not.toHaveTextContent("Ship companion");
  return actionArea!;
}
async function editorIn(dialog: HTMLElement) {
  const region = within(dialog).getByRole("region", { name: "Note content" });
  return waitFor(() => {
    const editor = region.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(editor).not.toBeNull();
    return editor!;
  });
}

async function pasteIntoFirstParagraph(editor: HTMLElement) {
  const paragraph = editor.querySelector("p");
  expect(paragraph).not.toBeNull();
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(paragraph!);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { types: ["text/html", "text/plain"], items: [], files: [], getData: (type: string) => type === "text/html" ? "<strong>OWNER-CURATED</strong><br>Reviewed second line" : type === "text/plain" ? "OWNER-CURATED\nReviewed second line" : "" } });
  await act(async () => { editor.dispatchEvent(paste); });
  await waitFor(() => expect(editor.textContent).toContain("OWNER-CURATED"));
}

beforeAll(() => {
  const rect = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage("en"); });

describe("explicit excerpt publication through the session reader", () => {
  it("proves the real-editor edit gesture updates marks and breaks while preserving an untouched literal body", async () => {
    const onChange = vi.fn();
    const original: PMNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Provenance" }] }, { type: "codeBlock", content: [{ type: "text", text: RAW_BODY }] }] };
    const { container } = renderWithProviders(<RichTextEditorModule.RichTextEditor content={JSON.stringify(original)} onChange={onChange} />);
    const editor = await waitFor(() => {
      const value = container.querySelector<HTMLElement>('[contenteditable="true"]');
      expect(value).not.toBeNull();
      return value!;
    });
    await pasteIntoFirstParagraph(editor);
    const updated = JSON.parse(onChange.mock.lastCall![0]) as PMNode;
    expect(textOf(updated)).toContain("OWNER-CURATED");
    expect(allNodes(updated)).toContainEqual(expect.objectContaining({ type: "text", text: "OWNER-CURATED", marks: expect.arrayContaining([{ type: "bold" }]) }));
    expect(allNodes(updated)).toContainEqual({ type: "hardBreak" });
    expect(allNodes(updated).filter((node) => node.type === "codeBlock").map(textOf)).toContain(RAW_BODY);
  });

  it("keeps an ordinary private preview local until an explicit publication action", async () => {
    const state = serve();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const preview = await openPrivatePreview(user);
    expect(state.bodies).toEqual([CONTENT_ID]);
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
    await user.click(within(preview).getByRole("button", { name: "Cancel" }));
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it("requires an explicit destination and explains its audience, including the optional card's unchanged visibility", async () => {
    const state = serve();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    expect(within(dialog).getByRole("button", { name: "Save note" })).toBeDisabled();
    await destination(user, dialog, true);
    expect(within(dialog).getByText(/members and authorized agents.*Launch team|Launch team.*members and authorized agents/i)).toBeVisible();
    expect(within(dialog).getByText(/card.*does not (?:limit|restrict)|card.*doesn.t (?:limit|restrict)/i)).toBeVisible();
    expect(within(dialog).getByText(/session.*(?:private|owner.only)/i)).toBeVisible();
    expect(within(dialog).getByText(/(?:independent|separate).*snapshot|(?:delet|remov).*session.*(?:not|won.t).*note/i)).toBeVisible();
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it.each([false, true])("repeats the selected destination and audience beside the final Save after reviewing content (card: %s)", async (withCard) => {
    const state = serve();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, withCard);
    expectFinalDestination(dialog, within(dialog).getByRole("button", { name: "Save note" }), withCard);
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it("does not describe an unavailable selected card as a board-only destination", async () => {
    const state = serve();
    const client = createTestQueryClient();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />, { queryClient: client });
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    server.use(http.get(`/api/workspaces/${DESTINATION}/boards/${BOARD_ID}`, () => HttpResponse.json({ ...board, columns: [] })));
    await act(() => client.invalidateQueries({ queryKey: boardKeys.detail(DESTINATION, BOARD_ID) }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/destination is unavailable/i);
    const save = within(dialog).getByRole("button", { name: "Save note" });
    expect(save).toBeDisabled();
    const finalArea = expectFinalDestination(dialog, save, false);
    expect(within(finalArea).queryByText("No card")).not.toBeInTheDocument();
    expect(within(finalArea).queryByText("Card (optional)")).not.toBeInTheDocument();
    expect(within(dialog).getAllByText(/destination is unavailable/i)).toHaveLength(1);
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it("claims nothing was sent only before dispatch, including an invalid local draft", async () => {
    const state = serve();
    const response = deferred<Response>();
    state.respond = async () => response.promise;
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    const unsent = /draft only\. nothing has been sent\./i;
    await waitFor(() => expect(within(dialog).getByText(unsent)).toBeVisible());
    await destination(user, dialog);
    const finalArea = expectFinalDestination(dialog, within(dialog).getByRole("button", { name: "Save note" }), false);
    expect(within(finalArea).getByText(unsent)).toBeVisible();
    await user.clear(within(dialog).getByRole("textbox", { name: "Note title" }));
    expect(within(dialog).getByRole("button", { name: "Save note" })).toBeDisabled();
    expect(within(finalArea).getByText(unsent)).toBeVisible();
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
    await user.type(within(dialog).getByRole("textbox", { name: "Note title" }), "Reviewed handoff");
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(within(dialog).queryByText(unsent)).not.toBeInTheDocument();
    await act(async () => { response.resolve(HttpResponse.json({ error: "Invalid request" }, { status: 400 })); });
    await user.click(await within(dialog).findByRole("button", { name: "Revise draft" }));
    expect(within(dialog).queryByText(unsent)).not.toBeInTheDocument();
    state.respond = async () => HttpResponse.error();
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
    expect(within(dialog).queryByText(unsent)).not.toBeInTheDocument();
    const original = state.writes[1]!;
    state.respond = async (payload) => saved(payload, 200);
    await user.click(within(dialog).getByRole("button", { name: "Retry save" }));
    expect(await within(dialog).findByRole("link", { name: "Open note" })).toHaveAttribute("href", `/${DESTINATION}/boards/${BOARD_ID}/notes?note=${NOTE_ID}`);
    expect(state.writes[2]).toEqual(original);
    expect(within(dialog).queryByText(unsent)).not.toBeInTheDocument();
  });

  it.each([false, true])("offers only confirmed canonical note and selected-card links (card: %s)", async (withCard) => {
    const state = serve();
    const response = deferred<Response>();
    state.respond = async () => response.promise;
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, withCard);
    expect(within(dialog).queryByRole("link", { name: /open note|open card/i })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(within(dialog).queryByRole("link", { name: /open note|open card/i })).not.toBeInTheDocument();
    await act(async () => { response.resolve(saved(state.writes[0]!.payload)); });
    expect(await within(dialog).findByRole("link", { name: "Open note" })).toHaveAttribute("href", `/${DESTINATION}/boards/${BOARD_ID}/notes?note=${NOTE_ID}`);
    if (withCard) {
      expect(within(dialog).getByRole("link", { name: "Open card" })).toHaveAttribute("href", `/${DESTINATION}/boards/${BOARD_ID}/kanban?card=${CARD_ID}`);
    } else {
      expect(within(dialog).queryByRole("link", { name: "Open card" })).not.toBeInTheDocument();
    }
    expect(state.writes[0]!.payload.card_id ?? null).toBe(withCard ? CARD_ID : null);
    expect(state.mutations).toEqual([{ method: "POST", path: NOTE_PATH }]);
  });

  it("persists the exact reviewed editor document, selected full literal bodies and edited title as an unpinned ordinary card note", async () => {
    // Observe the existing editor's public onChange boundary without replacing
    // its renderer or edit behavior; text equality alone would miss lost marks.
    const reviewed: PMNode[] = [];
    const RealEditor = RichTextEditorModule.RichTextEditor;
    vi.spyOn(RichTextEditorModule, "RichTextEditor").mockImplementation((props) => (
      <RealEditor {...props} onChange={(json) => { reviewed.push(JSON.parse(json) as PMNode); props.onChange(json); }} />
    ));
    const state = serve();
    const client = createTestQueryClient();
    client.setQueryDefaults(noteKeys.byBoard(DESTINATION, BOARD_ID), { gcTime: Infinity });
    client.setQueryData(noteKeys.byBoard(DESTINATION, BOARD_ID), []);
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />, { queryClient: client });
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    const editor = await editorIn(dialog);
    const code = [...editor.querySelectorAll("pre code")].find((node) => node.textContent === RAW_BODY);
    expect(code, "captured markup remains one literal body, including trailing newlines").toBeDefined();
    expect(editor.querySelector("system")).toBeNull();
    for (const value of [SESSION_ID, CONTENT_ID, AT, "Claude Code", SOURCE_TITLE]) expect(editor.textContent).toContain(value);
    expect(editor.textContent).toMatch(/redact/i);
    expect(editor.textContent).not.toContain("TRUNCATED PREVIEW");
    expect(editor.textContent).not.toContain("DO NOT PUBLISH");
    await user.clear(within(dialog).getByRole("textbox", { name: "Note title" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Note title" }), "Reviewed handoff");
    await pasteIntoFirstParagraph(editor);
    const visibleText = editor.textContent;
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    const write = state.writes[0]!;
    expect(write).toMatchObject({ method: "POST", path: NOTE_PATH, payload: { title: "Reviewed handoff", card_id: CARD_ID, excerpt_source: { workspace_id: SOURCE_WORKSPACE_ID, session_id: SESSION_ID, items: [{ content_id: CONTENT_ID, sha256: chosen.sha256 }] } } });
    expect(write.payload.client_request_id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
    expect(write.payload.pinned ?? false).toBe(false);
    expect(write.payload.kind ?? "user_note").toBe("user_note");
    const doc = documentFrom(write.payload);
    expect(reviewed.length).toBeGreaterThan(0);
    expect(doc).toEqual(reviewed.at(-1));
    expect(allNodes(doc).filter((node) => node.type === "codeBlock").map(textOf)).toContain(RAW_BODY);
    expect(textOf(doc)).toBe(visibleText);
    expect(textOf(doc)).toContain("OWNER-CURATED");
    expect(state.mutations).toEqual([{ method: "POST", path: NOTE_PATH }]);
    expect(JSON.stringify(write.payload)).not.toContain("DO NOT PUBLISH");
    expect(state.bodies).toEqual([CONTENT_ID]);
    await waitFor(() => expect(client.getQueryState(noteKeys.byBoard(DESTINATION, BOARD_ID))?.isInvalidated).toBe(true));
    expect(await screen.findByRole("link", { name: /open note|view note/i })).toHaveAttribute("href", expect.stringContaining(NOTE_ID));
  });


  it("keeps hostile provenance scalars literal and publishes the title exactly as reviewed", async () => {
    const title = 'SOURCE-TITLE\r# forged heading\n![tracking](https://attacker.invalid/title.png) <img src="https://attacker.invalid/pixel">';
    const agent = 'SOURCE-AGENT </p><script>not executable</script> ```';
    const limitation = 'SOURCE-LIMIT\r# forged item\n- Session: forged';
    const state = serve();
    state.items = [{ ...chosen, coverage: "partially_redacted", coverage_reason: "secret_filter", redaction: { ...chosen.redaction, filter_version: limitation } }, unselected];
    renderWithProviders(<SessionTranscript slug={SLUG} session={{ ...sourceSession, title, harness_display_name: agent }} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    const editor = await editorIn(dialog);
    for (const value of [title, agent, limitation]) expect(editor.textContent).toContain(value);
    expect(editor.querySelectorAll("img, script, iframe, object")).toHaveLength(0);
    expect(editor.querySelector('a[href^="https://attacker.invalid"]')).toBeNull();
    const titleInput = within(dialog).getByRole("textbox", { name: "Note title" });
    await user.clear(titleInput);
    await user.type(titleInput, '# Reviewed [literal](https://attacker.invalid) <em>title</em>');
    const reviewedTitle = (titleInput as HTMLInputElement).value;
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    const payload = state.writes[0]!.payload;
    expect(payload.title).toBe(reviewedTitle);
    const nodes = allNodes(documentFrom(payload));
    for (const value of [title, agent, limitation]) expect(textOf(documentFrom(payload))).toContain(value);
    expect(nodes.filter(({ type }) => ["image", "fileAttachment", "iframe"].includes(type))).toEqual([]);
    expect(nodes.flatMap(({ marks }) => marks ?? []).filter(({ type, attrs }) => type === "link" && String(attrs?.href).startsWith("https://attacker.invalid"))).toEqual([]);
    expect(nodes.filter(({ type }) => type === "codeBlock").map(textOf)).toContain(RAW_BODY);
    expect(state.mutations).toEqual([{ method: "POST", path: NOTE_PATH }]);
  });

  it("does not mutate when an edited draft is cancelled with Escape", async () => {
    const state = serve();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    await user.type(within(dialog).getByRole("textbox", { name: "Note title" }), " edited");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument());
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it.each(["paste", "drop"])("does not upload images or attachments through %s while the draft is still local", async (gesture) => {
    const state = serve();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    const editor = await editorIn(dialog);
    for (const name of [i18n.t("editor.uploadImage"), i18n.t("editor.attachFile")]) {
      const button = within(dialog).queryByRole("button", { name });
      if (button) expect(button).toBeDisabled();
    }
    for (const [name, type] of [["shot.png", "image/png"], ["private.txt", "text/plain"]]) {
      const file = new File(["must stay local"], name!, { type });
      const event = new Event(gesture, { bubbles: true, cancelable: true });
      Object.defineProperty(event, gesture === "paste" ? "clipboardData" : "dataTransfer", { value: { types: ["Files"], files: [file], items: [{ kind: "file", type, getAsFile: () => file }], getData: () => "" } });
      Object.defineProperty(event, "clientX", { value: 1 });
      Object.defineProperty(event, "clientY", { value: 1 });
      await act(async () => { editor.dispatchEvent(event); });
    }
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it("clears an optional card when the board changes instead of sending a stale cross-board card", async () => {
    const state = serve();
    state.respond = async (payload) => saved(payload);
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await choose(user, dialog, "Board", "Follow-up");
    expect(within(dialog).getByLabelText("Card (optional)")).not.toHaveTextContent("Ship companion");
    await choose(user, dialog, "Board", "Summit");
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]!.payload.card_id ?? null).toBeNull();
  });

  it.each(["viewer", "frozen"])("blocks a draft when its chosen destination becomes %s before dispatch", async (change) => {
    const state = serve();
    const client = createTestQueryClient();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />, { queryClient: client });
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    if (change === "viewer") state.role = "viewer";
    else state.frozen = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: memberKeys.list(DESTINATION) });
      await client.invalidateQueries({ queryKey: boardKeys.byWorkspace(DESTINATION) });
    });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save note" })).toBeDisabled());
    expect(within(dialog).getByRole("alert")).toHaveTextContent(change === "viewer" ? /permission|write|read.only/i : /frozen/i);
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it.each(["removed", "digest changed"])("cannot publish a stale selected snapshot when source metadata is %s before first dispatch", async (change) => {
    const state = serve();
    const client = createTestQueryClient();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />, { queryClient: client });
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    state.items = change === "removed" ? [unselected] : [{ ...chosen, sha256: "b".repeat(64) }, unselected];
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.all(SLUG) }));
    await waitFor(() => {
      const save = screen.queryByRole("button", { name: "Save note" });
      if (save) expect(save).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(/changed|unavailable|no longer|select.*again/i);
    });
    expect(state.bodies).toEqual([CONTENT_ID]);
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it.each(["metadata loss", "404"])("deduplicates a double-click and preserves the frozen request after unknown outcome and source %s", async (sourceLoss) => {
    const state = serve();
    const first = deferred<Response>();
    state.respond = async (payload) => state.writes.length === 1 ? first.promise : saved(payload, 200);
    const client = createTestQueryClient();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />, { queryClient: client });
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await user.dblClick(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(within(dialog).getByRole("textbox", { name: "Note title" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Workspace")).toBeDisabled();
    expect(within(dialog).getByLabelText("Board")).toBeDisabled();
    expect(within(dialog).getByLabelText("Card (optional)")).toBeDisabled();
    expect(within(dialog).getByRole("region", { name: "Note content" }).querySelector('[contenteditable="true"]')).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    const sent = structuredClone(state.writes[0]!);
    await act(async () => { first.resolve(HttpResponse.error()); });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/could not confirm|couldn.t confirm|unknown|may have been saved/i);
    expect(state.writes).toHaveLength(1);
    expect(within(dialog).getByRole("textbox", { name: "Note title" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Card (optional)")).toBeDisabled();
    expect(within(dialog).getByRole("region", { name: "Note content" }).querySelector('[contenteditable="true"]')).toBeNull();
    await user.keyboard("{Escape}");
    const remainingDialog = screen.queryByRole("dialog", { name: "Share as note" });
    const close = remainingDialog && within(remainingDialog).queryByRole("button", { name: /^(?:close|dismiss)$/i });
    if (close) await user.click(close);
    state.items = [unselected];
    if (sourceLoss === "404") server.use(http.get(CONTENTS_PATH, () => HttpResponse.json({ detail: "Source deleted" }, { status: 404 })));
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.all(SLUG) }));
    if (sourceLoss === "404") {
      await screen.findByText("Couldn't load the transcript.");
      expect(screen.getByRole("button", { name: "Resume note save" })).toBeVisible();
    }
    // Dismissal is permitted, but it must preserve an accessible recovery action.
    let retry = screen.queryByRole("button", { name: "Retry save" });
    if (!retry) {
      await user.click(screen.getByRole("button", { name: "Resume note save" }));
      retry = screen.getByRole("button", { name: "Retry save" });
    }
    await user.click(retry);
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes[1]).toEqual(sent);
    expect(state.bodies).toEqual([CONTENT_ID]);
    expect(await screen.findByRole("link", { name: /open note|view note/i })).toHaveAttribute("href", expect.stringContaining(NOTE_ID));
  });

  it("preserves the frozen request while source metadata is pending and then reloads", async () => {
    const state = serve();
    state.respond = async () => HttpResponse.error();
    const client = createTestQueryClient();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />, { queryClient: client });
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
    const sent = structuredClone(state.writes[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    const metadata = deferred<Response>();
    server.use(http.get(CONTENTS_PATH, () => metadata.promise));
    const key = sessionKeys.contents(SLUG, SESSION_ID, { limit: 100 });
    try {
      await act(async () => { void client.resetQueries({ queryKey: key, exact: true }); });
      await waitFor(() => expect(client.getQueryState(key)?.status).toBe("pending"));
      expect(screen.getByRole("button", { name: "Resume note save" })).toBeVisible();
    } finally {
      await act(async () => { metadata.resolve(HttpResponse.json(contentPage(state.items))); });
    }
    await screen.findByRole("list", { name: "Transcript" });
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    state.respond = async (payload) => saved(payload, 200);
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByRole("link", { name: "Open note" });
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]).toEqual(sent);
    expect(state.bodies).toEqual([CONTENT_ID]);
  });

  it.each(["404", "pending", "empty"])("retains the frozen save after unselecting every item and source metadata becomes %s", async (sourceChange) => {
    const state = serve();
    state.respond = async () => HttpResponse.error();
    const client = createTestQueryClient();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />, { queryClient: client });
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
    const sent = structuredClone(state.writes[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    const entry = document.getElementById(`content-${CONTENT_ID}`)!;
    const checkbox = within(entry).getByRole("checkbox");
    expect(checkbox).toBeEnabled();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("0 selected from 2 loaded items")).toBeVisible();
    expect(screen.getByRole("button", { name: "Resume note save" })).toBeVisible();
    const key = sessionKeys.contents(SLUG, SESSION_ID, { limit: 100 });
    if (sourceChange === "pending") {
      const metadata = deferred<Response>();
      server.use(http.get(CONTENTS_PATH, () => metadata.promise));
      try {
        await act(async () => { void client.resetQueries({ queryKey: key, exact: true }); });
        await waitFor(() => expect(client.getQueryState(key)?.status).toBe("pending"));
        expect(screen.getByRole("button", { name: "Resume note save" })).toBeVisible();
      } finally {
        await act(async () => { metadata.resolve(HttpResponse.json(contentPage(state.items))); });
      }
      await screen.findByRole("list", { name: "Transcript" });
    } else {
      state.items = [];
      if (sourceChange === "404") server.use(http.get(CONTENTS_PATH, () => HttpResponse.json({ detail: "Source deleted" }, { status: 404 })));
      await act(() => client.invalidateQueries({ queryKey: key, exact: true }));
      await waitFor(() => expect(screen.queryByRole("list", { name: "Transcript" })).not.toBeInTheDocument());
      expect(client.getQueryState(key)?.status).toBe(sourceChange === "404" ? "error" : "success");
    }
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    const resumed = screen.getByRole("dialog", { name: "Share as note" });
    const retry = within(resumed).getByRole("button", { name: "Retry save" });
    expectFinalDestination(resumed, retry, true);
    state.respond = async (payload) => saved(payload, 200);
    await user.click(retry);
    expect(await screen.findByRole("link", { name: "Open note" })).toHaveAttribute("href", `/${DESTINATION}/boards/${BOARD_ID}/notes?note=${NOTE_ID}`);
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]).toEqual(sent);
    expect(state.bodies).toEqual([CONTENT_ID]);
  });

  it("keeps hidden pending, unknown and confirmed save actions with the persistent selection controls", async () => {
    const state = serve();
    const first = deferred<Response>();
    const retry = deferred<Response>();
    state.respond = async () => first.promise;
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    const sent = structuredClone(state.writes[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    const actions = screen.getByText("1 selected from 2 loaded items").parentElement!;
    expect(actions).toContainElement(screen.getByRole("button", { name: "Clear selection" }));
    expect(actions).not.toContainElement(screen.getByRole("list", { name: "Transcript" }));
    expect(actions).toContainElement(screen.getByRole("button", { name: "Resume note save" }));
    await act(async () => { first.resolve(HttpResponse.error()); });
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/may have been saved/i);
    await user.click(screen.getByRole("button", { name: "Hide for now" }));
    expect(actions).toContainElement(screen.getByRole("button", { name: "Resume note save" }));
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    state.respond = async () => retry.promise;
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Hide for now" }));
    await act(async () => { retry.resolve(saved(sent.payload, 200)); });
    expect(actions).toContainElement(await screen.findByRole("link", { name: "Open note" }));
    expect(actions).toContainElement(screen.getByRole("link", { name: "Open card" }));
    expect(state.writes[1]).toEqual(sent);
    expect(state.bodies).toEqual([CONTENT_ID]);
  });


  it("retains one frozen handoff on the full session page through every responsive boundary and compact tab", async () => {
    const resize = responsiveViewport(1280);
    const { state, user, sent, reader } = await unknownSaveOnSessionPage();
    for (const width of [1279, 640, 639]) {
      act(() => resize(width));
      expect(screen.getByRole("region", { name: "Transcript" })).toBe(reader);
      expect(screen.getAllByRole("region", { name: "Transcript" })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Resume note save" })).toBeVisible();
    }
    const linked = screen.getByRole("tab", { name: "Linked work" });
    await user.click(linked);
    expect(reader).toBeInTheDocument();
    expect(reader).not.toBeVisible();
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls")!;
      expect(document.getElementById(panelId)).toHaveAttribute("aria-labelledby", tab.id);
      expect(document.querySelectorAll(`[id="${panelId}"]`)).toHaveLength(1);
    }
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", linked.id);
    await user.keyboard("{ArrowRight}");
    const cost = screen.getByRole("tab", { name: "Cost" });
    expect(cost).toHaveFocus();
    expect(cost).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", cost.id);
    expect(reader).not.toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(reader).toBeVisible();
    for (const width of [640, 1279, 1280]) {
      act(() => resize(width));
      expect(screen.getByRole("region", { name: "Transcript" })).toBe(reader);
      expect(screen.getAllByRole("region", { name: "Transcript" })).toHaveLength(1);
    }
    for (const name of ["Cost", "Tokens", "Linked work", "Capture level"]) {
      expect(reader.compareDocumentPosition(screen.getByRole("region", { name })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    const dialog = screen.getByRole("dialog", { name: "Share as note" });
    expectFinalDestination(dialog, within(dialog).getByRole("button", { name: "Retry save" }), true);
    state.respond = async (payload) => saved(payload, 200);
    await user.click(within(dialog).getByRole("button", { name: "Retry save" }));
    await screen.findByRole("link", { name: "Open note" });
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]).toEqual(sent);
    expect(state.bodies).toEqual([CONTENT_ID]);
  });

  it.each([
    { tab: "Linked work", target: "unselected" },
    { tab: "Cost", target: "linked-output" },
  ])("defers a content link opened in compact $tab until Timeline returns without losing its frozen handoff", async ({ tab, target }) => {
    responsiveViewport(375);
    const { state, user, sent, reader } = await unknownSaveOnSessionPage(target, [
      makeContent({ id: "linked-input", role: "tool", channel: "tool_input", call_id: "linked-call" }),
      makeContent({ id: "linked-output", role: "tool", channel: "tool_output", call_id: "linked-call" }),
    ]);
    await user.click(screen.getByRole("tab", { name: tab }));
    expect(reader).not.toBeVisible();
    const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      await user.click(screen.getByRole("link", { name: "Follow content link" }));
      const hiddenScrolls = scroll.mock.calls.length;
      scroll.mockClear();
      await user.click(screen.getByRole("tab", { name: "Timeline" }));
      const destination = document.getElementById(`content-${target}`);
      await waitFor(() => expect(destination).toHaveFocus());
      expect(destination).toBeVisible();
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      expect(hiddenScrolls).toBe(0);
      expect(screen.getByRole("region", { name: "Transcript" })).toBe(reader);
      expect(within(document.getElementById(`content-${CONTENT_ID}`)!).getByRole("checkbox")).toBeChecked();
      await user.click(screen.getByRole("button", { name: "Resume note save" }));
      state.respond = async (payload) => saved(payload, 200);
      await user.click(screen.getByRole("button", { name: "Retry save" }));
      await screen.findByRole("link", { name: "Open note" });
      expect(state.writes).toHaveLength(2);
      expect(state.writes[1]).toEqual(sent);
      expect(state.bodies).toEqual([CONTENT_ID]);
    } finally {
      if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it.each([
    { tab: "Linked work", target: "unselected", away: "{ArrowRight}", back: "{ArrowLeft}" },
    { tab: "Cost", target: "linked-output", away: "{ArrowLeft}", back: "{ArrowRight}" },
  ])("keeps compact tab focus after an already-followed $target link when returning from $tab", async ({ tab, target, away, back }) => {
    responsiveViewport(375);
    const { state, user, sent, reader } = await unknownSaveOnSessionPage(target, [
      makeContent({ id: "linked-input", role: "tool", channel: "tool_input", call_id: "linked-call" }),
      makeContent({ id: "linked-output", role: "tool", channel: "tool_output", call_id: "linked-call" }),
    ]);
    const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      await user.click(screen.getByRole("link", { name: "Follow content link" }));
      await waitFor(() => expect(document.getElementById(`content-${target}`)).toHaveFocus());
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      scroll.mockClear();

      const timeline = screen.getByRole("tab", { name: "Timeline" });
      await user.click(timeline);
      await user.keyboard(away);
      expect(screen.getByRole("tab", { name: tab })).toHaveFocus();
      expect(reader).not.toBeVisible();
      await user.keyboard(back);
      expect(timeline).toHaveFocus();
      expect(timeline).toHaveAttribute("aria-selected", "true");
      expect(reader).toBeVisible();
      expect(scroll).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Transcript" })).toBe(reader);
      expect(within(document.getElementById(`content-${CONTENT_ID}`)!).getByRole("checkbox")).toBeChecked();
      await user.click(screen.getByRole("button", { name: "Resume note save" }));
      state.respond = async (payload) => saved(payload, 200);
      await user.click(screen.getByRole("button", { name: "Retry save" }));
      await screen.findByRole("link", { name: "Open note" });
      expect(state.writes).toHaveLength(2);
      expect(state.writes[1]).toEqual(sent);
      expect(state.bodies).toEqual([CONTENT_ID]);
    } finally {
      if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it.each([0, 408, 429, 500])("retains the frozen handoff on the full session page through a transient %s metadata failure and recovery", async (status) => {
    const { state, client, user, sent, reader } = await unknownSaveOnSessionPage();
    server.use(http.get(SESSION_PATH, () => status === 0 ? HttpResponse.error() : HttpResponse.json({ detail: "Temporarily unavailable" }, { status })));
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.detail(SLUG, SESSION_ID), exact: true }));
    await screen.findByRole("heading", { name: "Couldn't load this session" });
    expect(screen.getByRole("region", { name: "Transcript" })).toBe(reader);
    expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION_ID))).toEqual(sourceSession);
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    state.respond = async (payload) => saved(payload, 200);
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByRole("link", { name: "Open note" });
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]).toEqual(sent);
    server.use(http.get(SESSION_PATH, () => HttpResponse.json(sourceSession)));
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.detail(SLUG, SESSION_ID), exact: true }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Couldn't load this session" })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Transcript" })).toBe(reader);
    expect(state.bodies).toEqual([CONTENT_ID]);
  });

  it("keeps newer authorized metadata and the frozen handoff when a cancelled older request settles with a denial", async () => {
    const { state, client, reader } = await unknownSaveOnSessionPage();
    const queryKey = sessionKeys.detail(SLUG, SESSION_ID);
    const oldResponse = deferred<Response>();
    let oldStarted = false;
    const apiCalls = vi.spyOn(api, "get");
    server.use(http.get(SESSION_PATH, () => {
      oldStarted = true;
      return oldResponse.promise;
    }));
    act(() => { void client.refetchQueries({ queryKey, exact: true }); });
    await waitFor(() => expect(oldStarted).toBe(true));
    const oldRequestIndex = apiCalls.mock.calls.findIndex(([path]) => path === SESSION_PATH.slice(4));
    const oldRequest = apiCalls.mock.results[oldRequestIndex];
    if (!oldRequest || oldRequest.type !== "return") throw new Error("Expected the pending metadata transport");
    const oldSettled = Promise.resolve(oldRequest.value).catch(() => undefined);
    try {
      await act(() => client.cancelQueries({ queryKey, exact: true }));
      const refreshed = { ...sourceSession, title: "Authorized refreshed session" };
      server.use(http.get(SESSION_PATH, () => HttpResponse.json(refreshed)));
      await act(() => client.refetchQueries({ queryKey, exact: true }));
      await screen.findByRole("heading", { name: refreshed.title });
      expect(client.getQueryData(queryKey)).toEqual(refreshed);
      await act(async () => {
        oldResponse.resolve(HttpResponse.json({ detail: "Unavailable" }, { status: 403 }));
        await oldSettled;
      });
      expect(client.getQueryData(queryKey)).toEqual(refreshed);
      expect(screen.getByRole("heading", { name: refreshed.title })).toBeVisible();
      expect(screen.getByRole("region", { name: "Transcript" })).toBe(reader);
      expect(screen.getByRole("button", { name: "Resume note save" })).toBeVisible();
      expect(state.writes).toHaveLength(1);
      expect(state.bodies).toEqual([CONTENT_ID]);
    } finally {
      oldResponse.resolve(HttpResponse.json({ detail: "Unavailable" }, { status: 403 }));
      await oldSettled;
    }
  });

  it.each([401, 403, 404])("purges private content and the frozen handoff on the full session page after definitive %s", async (status) => {
    const { state, client, reader, view } = await unknownSaveOnSessionPage();
    const bodyKey = sessionKeys.contentBody(SLUG, SESSION_ID, CONTENT_ID, chosen.sha256!, 0);
    const fileKey = sessionKeys.contentFile(SLUG, SESSION_ID, CONTENT_ID, chosen.sha256!);
    const otherKey = sessionKeys.contentBody(SLUG, "other-session", "other-content", "other-digest", 0);
    client.setQueryDefaults(otherKey, { gcTime: Infinity });
    client.setQueryData(bodyKey, { text: RAW_BODY });
    client.setQueryData(fileKey, { url: "private-capture" });
    client.setQueryData(otherKey, { text: "Other session" });
    expect(client.getQueryData(sessionKeys.contents(SLUG, SESSION_ID, { limit: 100 }))).toBeDefined();
    server.use(http.get(SESSION_PATH, () => HttpResponse.json({ detail: "Unavailable" }, { status })));
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.detail(SLUG, SESSION_ID), exact: true }));
    await waitFor(() => expect(reader).not.toBeInTheDocument());
    expect(client.getQueryState(sessionKeys.detail(SLUG, SESSION_ID))).toMatchObject({ status: "error", error: { status } });
    expect(screen.queryByRole("button", { name: "Resume note save" })).not.toBeInTheDocument();
    expect(screen.queryByText(RAW_BODY)).not.toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData(bodyKey)).toBeUndefined());
    expect(client.getQueryData(fileKey)).toBeUndefined();
    expect(client.getQueryData(sessionKeys.contents(SLUG, SESSION_ID, { limit: 100 }))).toBeUndefined();
    expect(client.getQueryData(otherKey)).toEqual({ text: "Other session" });
    expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION_ID))).toBeNull();
    server.use(http.get(SESSION_PATH, () => HttpResponse.json({ detail: "Temporarily unavailable" }, { status: 500 })));
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.detail(SLUG, SESSION_ID), exact: true }));
    await screen.findByRole("heading", { name: "Couldn't load this session" });
    expect(screen.queryByRole("region", { name: "Transcript" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume note save" })).not.toBeInTheDocument();
    expect(client.getQueryData(sessionKeys.contents(SLUG, SESSION_ID, { limit: 100 }))).toBeUndefined();
    view.unmount();
    renderSessionPage(client);
    await screen.findByRole("heading", { name: "Couldn't load this session" });
    await waitFor(() => expect(client.getQueryState(sessionKeys.detail(SLUG, SESSION_ID))?.fetchStatus).toBe("idle"));
    expect(screen.queryByRole("region", { name: "Transcript" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: SOURCE_TITLE })).not.toBeInTheDocument();
    expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION_ID))).toBeNull();
    server.use(http.get(SESSION_PATH, () => HttpResponse.json(sourceSession)));
    await act(() => client.invalidateQueries({ queryKey: sessionKeys.detail(SLUG, SESSION_ID), exact: true }));
    await screen.findByRole("region", { name: "Transcript" });
    expect(screen.queryByRole("button", { name: "Resume note save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview excerpt" })).toBeDisabled();
    expect(state.writes).toHaveLength(1);
    expect(state.bodies).toEqual([CONTENT_ID]);
  });

  it("finishes only a confirmed hidden handoff on the full session page and permits a new excerpt", async () => {
    const { state, user, sent } = await unknownSaveOnSessionPage();
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    const response = deferred<Response>();
    state.respond = async () => response.promise;
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Hide for now" }));
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    await act(async () => { response.resolve(saved(sent.payload, 200)); });
    await screen.findByRole("link", { name: "Open note" });
    expect(state.writes[1]).toEqual(sent);
    expect(screen.getByRole("button", { name: "Preview excerpt" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("link", { name: "Open note" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview excerpt" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Preview excerpt" }));
    const preview = await screen.findByRole("dialog", { name: "Selected excerpt" });
    const share = within(preview).getByRole("button", { name: "Share as note" });
    await waitFor(() => expect(share).toBeEnabled());
    await user.click(share);
    const dialog = await screen.findByRole("dialog", { name: "Share as note" });
    await destination(user, dialog, true);
    state.respond = async (payload) => saved(payload);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(3));
    expect(state.writes[2]!.payload.client_request_id).not.toBe(sent.payload.client_request_id);
    expect(state.bodies).toEqual([CONTENT_ID, CONTENT_ID]);
  });

  it("posts an unedited generated title exactly as its single-line input displays it", async () => {
    const state = serve();
    renderWithProviders(<SessionTranscript slug={SLUG} session={{ ...sourceSession, title: "First line\r\nSecond line\rThird line" }} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    const reviewedTitle = (within(dialog).getByRole("textbox", { name: "Note title" }) as HTMLInputElement).value;
    expect(reviewedTitle).not.toMatch(/[\r\n]/);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]!.payload.title).toBe(reviewedTitle);
  });

  it("lets the owner deliberately revise a definitively rejected fresh draft, preserving edits and issuing a new key only on the next Save", async () => {
    const state = serve();
    state.respond = async (payload) => state.writes.length === 1
      ? HttpResponse.json({ detail: "Too large", error_code: "payload_too_large" }, { status: 413 })
      : saved(payload);
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await pasteIntoFirstParagraph(await editorIn(dialog));
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/16 MiB|16 MB/);
    const first = structuredClone(state.writes[0]!.payload);
    await user.click(within(dialog).getByRole("button", { name: "Revise draft" }));
    expect(state.writes).toHaveLength(1);
    const title = within(dialog).getByRole("textbox", { name: "Note title" });
    expect(title).toBeEnabled();
    expect(title).toHaveValue(first.title);
    expect((await editorIn(dialog)).textContent).toContain("OWNER-CURATED");
    await user.type(title, " revised");
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    const second = state.writes[1]!.payload;
    expect(second.client_request_id).not.toBe(first.client_request_id);
    expect(second.title).toBe(`${first.title} revised`);
    expect(documentFrom(second)).toEqual(documentFrom(first));
    expect(second.card_id).toBe(CARD_ID);
    expect(second.excerpt_source).toEqual(first.excerpt_source);
    expect(state.bodies).toEqual([CONTENT_ID]);
  });

  it.each(["network", "408"])("keeps an unknown %s request frozen after a forbidden retry and can later recover its original receipt", async (failure) => {
    const state = serve();
    state.respond = async (payload) => {
      if (state.writes.length === 1) return failure === "network" ? HttpResponse.error() : HttpResponse.json({ detail: "Request timeout" }, { status: 408 });
      if (state.writes.length === 2) return HttpResponse.json({ detail: "Denied", error_code: "forbidden" }, { status: 403 });
      return saved(payload, 200);
    };
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/could not confirm|couldn.t confirm|unknown|may have been saved/i);
    const original = structuredClone(state.writes[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/permission|access|write/i));
    expect(within(dialog).queryByRole("button", { name: "Revise draft" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Note title" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Workspace")).toBeDisabled();
    expect(within(dialog).getByRole("region", { name: "Note content" }).querySelector('[contenteditable="true"]')).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(state.writes).toHaveLength(3));
    expect(state.writes[1]).toEqual(original);
    expect(state.writes[2]).toEqual(original);
    expect(state.bodies).toEqual([CONTENT_ID]);
    expect(await screen.findByRole("link", { name: /open note|view note/i })).toHaveAttribute("href", expect.stringContaining(NOTE_ID));
  });

  it.each(["removed", "renamed"])("keeps the frozen destination names and audience visible when live destination lists are %s after dispatch", async (change) => {
    const state = serve();
    const replay = deferred<Response>();
    state.respond = async () => state.writes.length === 1 ? HttpResponse.error() : replay.promise;
    const client = createTestQueryClient();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />, { queryClient: client });
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await within(dialog).findByRole("alert");
    const original = structuredClone(state.writes[0]!);
    const renamedWorkspace = { id: DESTINATION_WORKSPACE_ID, slug: DESTINATION, name: "Renamed workspace", created_by: ME, created_at: AT, updated_at: AT };
    const renamedBoard = { ...board, name: "Renamed board" };
    const updatedWorkspaces = change === "removed" ? [] : [renamedWorkspace];
    const updatedBoards = change === "removed" ? [] : [renamedBoard];
    const updatedBoard = change === "removed" ? { ...board, columns: [] }
      : { ...renamedBoard, columns: [{ id: "todo", name: "To do", cards: [{ ...card, title: "Renamed card" }] }] };
    server.use(
      http.get("/api/workspaces", () => HttpResponse.json(updatedWorkspaces)),
      http.get(`/api/workspaces/${DESTINATION}/boards`, () => HttpResponse.json(updatedBoards)),
      http.get(`/api/workspaces/${DESTINATION}/boards/${BOARD_ID}`, () => HttpResponse.json(updatedBoard)),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: workspaceKeys.all });
      await client.invalidateQueries({ queryKey: boardKeys.byWorkspace(DESTINATION) });
      // Query notifications are batched onto the next task, after refetch resolves.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.getQueryData(workspaceKeys.all)).toEqual(updatedWorkspaces);
    expect(client.getQueryData(boardKeys.byWorkspace(DESTINATION))).toEqual(updatedBoards);
    for (const [label, name] of [["Workspace", "Launch team"], ["Board", "Summit"], ["Card (optional)", "Ship companion"]]) {
      const control = within(dialog).getByLabelText(label!);
      expect(control).toBeDisabled();
      if (control instanceof HTMLSelectElement) expect(control.selectedOptions[0]?.textContent).toBe(name);
      else expect(control).toHaveTextContent(name!);
    }
    expect(within(dialog).getByText(/members and authorized agents/i)).toHaveTextContent("Launch team");
    await user.click(within(dialog).getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes[1]).toEqual(original);
    expect(within(dialog).queryByRole("link", { name: /open note|open card/i })).not.toBeInTheDocument();
    await act(async () => { replay.resolve(saved(original.payload, 200)); });
    expect(await within(dialog).findByRole("link", { name: "Open note" })).toHaveAttribute("href", `/${DESTINATION}/boards/${BOARD_ID}/notes?note=${NOTE_ID}`);
    expect(dialog).not.toHaveTextContent(/Renamed workspace|Renamed board|Renamed card/);
    expectFinalDestination(dialog, within(dialog).getByRole("button", { name: "Hide for now" }), true);
  });

  it.each([
    { status: 404, code: undefined, priorUnknown: false },
    { status: 404, code: "not_found", priorUnknown: false },
    { status: 405, code: "method_not_allowed", priorUnknown: false },
    { status: 404, code: undefined, priorUnknown: true },
    { status: 404, code: "not_found", priorUnknown: true },
    { status: 405, code: "method_not_allowed", priorUnknown: true },
  ])("refuses an old server's $status/$code without generic note creation (prior unknown: $priorUnknown) and retries the exact request after upgrade", async ({ status, code, priorUnknown }) => {
    const state = serve();
    let upgraded = false;
    const genericWrites: { method: string; path: string }[] = [];
    // A real old server still accepts this generic POST and ignores unknown
    // receipt/source fields. A friendly404-only mock would miss that mutation.
    server.use(http.post(GENERIC_NOTE_PATH, async ({ request }) => {
      const attempt = { method: request.method, path: new URL(request.url).pathname };
      genericWrites.push(attempt);
      state.mutations.push(attempt);
      return saved(await request.json() as Publication);
    }));
    state.respond = async (payload) => {
      if (priorUnknown && state.writes.length === 1) return HttpResponse.error();
      if (!upgraded) return HttpResponse.json({ detail: status === 404 ? "Not Found" : "Method Not Allowed", error_code: code }, { status });
      return saved(payload, 200);
    };
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog, true);
    await pasteIntoFirstParagraph(await editorIn(dialog));
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.mutations).toHaveLength(1));
    expect(genericWrites, "unsupported publication must never create a generic note").toEqual([]);
    expect(state.writes).toHaveLength(1);
    const frozen = structuredClone(state.writes[0]!);
    expect(frozen.path).toBe(NOTE_PATH);
    expect(textOf(documentFrom(frozen.payload))).toContain("OWNER-CURATED");
    if (priorUnknown) {
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(/could not confirm|couldn.t confirm|unknown|may have been saved/i);
      await user.click(within(dialog).getByRole("button", { name: "Retry save" }));
      await waitFor(() => expect(state.writes).toHaveLength(2));
    }
    await waitFor(() => {
      const alert = within(dialog).getByRole("alert");
      expect(alert).toHaveTextContent(/server|deployment|version/i);
      expect(alert).toHaveTextContent(/support|upgrad|updat|unavailable/i);
      expect(alert).toHaveTextContent(/retry|try again/i);
      expect(alert).not.toHaveTextContent(/select the items again/i);
    });
    if (priorUnknown) expect(within(dialog).queryByRole("button", { name: "Revise draft" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Note title" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Workspace")).toBeDisabled();
    expect(within(dialog).getByLabelText("Card (optional)")).toBeDisabled();
    expect(within(dialog).getByRole("region", { name: "Note content" }).querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.queryByRole("link", { name: /open note|view note/i })).not.toBeInTheDocument();
    expect(genericWrites).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    upgraded = true;
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(state.writes).toHaveLength(priorUnknown ? 3 : 2));
    expect(state.writes.every((write) => JSON.stringify(write) === JSON.stringify(frozen))).toBe(true);
    expect(state.mutations).toEqual(state.writes.map(() => ({ method: "POST", path: NOTE_PATH })));
    expect(genericWrites).toEqual([]);
    expect(state.bodies).toEqual([CONTENT_ID]);
    expect(await screen.findByRole("link", { name: /open note|view note/i })).toHaveAttribute("href", expect.stringContaining(NOTE_ID));
  });

  it.each([
    [403, "forbidden", /permission|access|write/i],
    [409, "board_frozen", /frozen/i],
    [409, "excerpt_source_stale", /source|selected|changed/i],
    [404, "content_not_found", /source|selected|unavailable/i],
    [409, "client_request_conflict", /conflict|different|changed|request/i],
    [413, "payload_too_large", /16 MiB|16 MB/i],
    [410, "gone", /deleted|removed/i],
  ] as const)("shows an actionable %s/%s failure without silently saving elsewhere or changing the key", async (status, code, message) => {
    const state = serve();
    state.respond = async () => HttpResponse.json({ detail: "Rejected", error_code: code }, { status });
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(state.writes).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /open note|view note/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Note title" })).not.toHaveValue("");
  });
});


describe("publication-only bounds at the existing structured editor boundary", () => {
  it.each([0, 1])("measures compact UTF-8 PM bytes at 16 MiB plus %s, without counting outer JSON-string escaping", async (extra) => {
    // The real editor is covered above. This seam injects its ordinary JSON onChange
    // value so the size guard can be exercised without a 16 MiB contenteditable DOM.
    const limit = 16 * 1024 * 1024;
    const empty: PMNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }] };
    const budget = limit - utf8(JSON.stringify(empty));
    const text = "é".repeat(Math.floor(budget / 2)) + "a".repeat(budget % 2 + extra);
    const reviewed: PMNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
    const json = JSON.stringify(reviewed);
    expect(utf8(json)).toBe(limit + extra);
    vi.spyOn(RichTextEditorModule, "RichTextEditor").mockImplementation(({ onChange }) => (
      <button type="button" onClick={() => onChange(json)}>Apply reviewed large document</button>
    ));
    const state = serve();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Apply reviewed large document" }));
    const save = within(dialog).getByRole("button", { name: "Save note" });
    if (extra) {
      expect(save).toBeDisabled();
      expect(within(dialog).getByRole("alert")).toHaveTextContent(/16 MiB|16 MB/i);
      expect(state.writes).toEqual([]);
      expect(state.mutations).toEqual([]);
    } else {
      expect(save).toBeEnabled();
      await user.click(save);
      await waitFor(() => expect(state.writes).toHaveLength(1));
      expect(documentFrom(state.writes[0]!.payload)).toEqual(reviewed);
    }
  }, 15000);

  it("counts escaped control characters in the reviewed document, independently of the selected source size", async () => {
    const reviewed: PMNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "\x01".repeat(3 * 1024 * 1024) }] }] };
    expect(utf8(JSON.stringify(reviewed))).toBeGreaterThan(16 * 1024 * 1024);
    vi.spyOn(RichTextEditorModule, "RichTextEditor").mockImplementation(({ onChange }) => (
      <button type="button" onClick={() => onChange(JSON.stringify(reviewed))}>Apply escaped large document</button>
    ));
    const state = serve();
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const dialog = await openPublish(user);
    await destination(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Apply escaped large document" }));
    expect(within(dialog).getByRole("button", { name: "Save note" })).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/16 MiB|16 MB/i);
    expect(state.writes).toEqual([]);
    expect(state.mutations).toEqual([]);
  }, 15000);
});

const LOCALES = [
  { language: "en", share: "Share as note", workspace: "Workspace", board: "Board", save: "Save note", audience: /members and authorized agents/i },
  { language: "es", share: "Compartir como nota", workspace: "Espacio de trabajo", board: "Tablero", save: "Guardar nota", audience: /miembros y agentes autorizados/i },
  { language: "pt-BR", share: "Compartilhar como nota", workspace: "Espaço de trabalho", board: "Quadro", save: "Salvar nota", audience: /membros e agentes autorizados/i },
] as const;

describe.each(LOCALES)("publication copy in $language", (copy) => {
  it("localizes an unsupported publication route without misreporting a missing captured source", async () => {
    await i18n.changeLanguage(copy.language);
    const state = serve();
    state.respond = async () => HttpResponse.json({ detail: "Not Found", error_code: "not_found" }, { status: 404 });
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const preview = await openPrivatePreview(user);
    await user.click(within(preview).getByRole("button", { name: copy.share }));
    const dialog = await screen.findByRole("dialog", { name: copy.share });
    await choose(user, dialog, copy.workspace, "Launch team");
    await choose(user, dialog, copy.board, "Summit");
    const save = within(dialog).getByRole("button", { name: copy.save });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(copy.language === "en" ? /server|deployment|version/i : /servidor|vers[aã]o|versión/i);
    expect(alert).toHaveTextContent(copy.language === "en" ? /support|updat|upgrad|unavailable/i : /compat|admit|soport|suport|atualiz|actualiz|dispon/i);
    expect(alert.textContent).not.toMatch(/sessions\.|errorCode\.|errors\.|Not Found/);
    if (copy.language !== "en") expect(alert.textContent).not.toMatch(/\bserver\b|try again|update the/i);
    expect(state.mutations).toEqual([{ method: "POST", path: NOTE_PATH }]);
  });

  it("localizes the action, destination, audience and bounded-document error together", async () => {
    await i18n.changeLanguage(copy.language);
    const state = serve();
    state.respond = async () => HttpResponse.json({ detail: "Rejected", error_code: "payload_too_large" }, { status: 413 });
    renderWithProviders(<SessionTranscript slug={SLUG} session={sourceSession} />);
    const user = userEvent.setup();
    const preview = await openPrivatePreview(user);
    await user.click(within(preview).getByRole("button", { name: copy.share }));
    const dialog = await screen.findByRole("dialog", { name: copy.share });
    await choose(user, dialog, copy.workspace, "Launch team");
    await choose(user, dialog, copy.board, "Summit");
    expect(within(dialog).getByText(copy.audience)).toHaveTextContent("Launch team");
    const save = within(dialog).getByRole("button", { name: copy.save });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/16 MiB|16 MB/);
    expect(alert.textContent).not.toMatch(/sessions\.|errorCode\.|errors\.|Rejected/);
    if (copy.language !== "en") expect(alert.textContent).not.toMatch(/too large|reviewed document/i);
  });
});


describe("publication descriptor limit preserves local export", () => {
  it.each([{ count: 256, copy: LOCALES[0] }, ...LOCALES.map((copy) => ({ count: 257, copy }))])("handles $count selected items in $copy.language without fetching or publishing any hidden item", async ({ count, copy }) => {
    await i18n.changeLanguage(copy.language);
    const state = serve();
    const items = Array.from({ length: count }, (_, index) => makeContent({
      ...chosen,
      id: `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`,
      byte_count: 0,
      source: { kind: "claude_transcript", order: index + 1 },
      preview: { text: "", truncated: false },
    }));
    const requested: string[] = [];
    server.use(http.get(`${CONTENTS_PATH}/:id/body`, ({ params }) => {
      requested.push(String(params.id));
      return HttpResponse.json({ content_id: params.id, offset: 0, next_offset: null, total_bytes: 0, text: "" });
    }));
    renderWithProviders(<SessionExcerptHarness slug={SLUG} session={sourceSession} items={items} selected={new Set(items.map(({ id }) => id))} hasMore onClear={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: i18n.t("sessions.contents.excerpt.preview") }));
    const preview = await screen.findByRole("dialog", { name: i18n.t("sessions.contents.excerpt.title") });
    await waitFor(() => expect(within(preview).getByRole("button", { name: i18n.t("sessions.contents.excerpt.copy") })).toBeEnabled(), { timeout: 10000 });
    expect(requested).toEqual(items.map(({ id }) => id));
    const share = within(preview).getByRole("button", { name: copy.share });
    if (count === 256) {
      expect(share).toBeEnabled();
      await user.click(share);
      const dialog = await screen.findByRole("dialog", { name: copy.share });
      await destination(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: copy.save }));
      await waitFor(() => expect(state.writes).toHaveLength(1));
      expect(state.writes[0]!.payload.excerpt_source.items.map(({ content_id }) => content_id)).toEqual(items.map(({ id }) => id));
    } else {
      if (!(share as HTMLButtonElement).disabled) {
        await user.click(share);
        const dialog = await screen.findByRole("dialog", { name: copy.share });
        expect(within(dialog).getByRole("button", { name: copy.save })).toBeDisabled();
      }
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/256/);
      expect(alert.textContent).not.toMatch(/sessions\.|errors\./);
      if (copy.language !== "en") expect(alert.textContent).not.toMatch(/\b(?:items|selected|select|maximum|fewer)\b/i);
      expect(state.mutations).toEqual([]);
    }
  }, 15000);
});
