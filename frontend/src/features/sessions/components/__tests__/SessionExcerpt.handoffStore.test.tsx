// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { EntityLink } from "@/components/shared/EntityLink";
import { ME, SLUG, contentPage, makeContent, makeSession } from "../../__tests__/fixtures";
import { contentWindowResponse, selectedMetadata } from "../../__tests__/window-fixtures";
import i18n from "@/i18n/config";
import { sessionKeys } from "@/lib/query-keys";

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange, editable = true }: { content: string; onChange: (value: string) => void; editable?: boolean }) => (
    <textarea aria-label="Reviewed handoff body" readOnly={!editable} value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));
import { SessionTranscript } from "../SessionTranscript";

const SESSION = "11111111-1111-4111-8111-111111111111";
const CONTENT = "22222222-2222-4222-8222-222222222222";
const BOARD = "33333333-3333-4333-8333-333333333333";
const CARD = "44444444-4444-4444-8444-444444444444";
const WORKSPACE = "55555555-5555-4555-8555-555555555555";
const PRIVATE_BODY = "Private retained source text, never serialized into a shared URL";
const source = makeSession({ id: SESSION, title: "Private source title", capture_levels: ["rich"] });
const item = makeContent({ id: CONTENT, session_id: SESSION, byte_count: new TextEncoder().encode(PRIVATE_BODY).length, preview: { text: "Preview only", truncated: true } });
const sourcePath = `/${SLUG}/sessions/${SESSION}`;
const cardPath = `/team/boards/${BOARD}/kanban?card=${CARD}`;
const contentsPath = `/api/workspaces/${SLUG}/sessions/${SESSION}/contents`;
type Publication = { title: string; content: string; client_request_id: string; excerpt_source: { session_id: string; items: { content_id: string; sha256: string }[] } };

function serve() {
  const writes: Publication[] = [];
  const metadataReads: string[][] = [];
  const state = { writes, metadataReads, respond: async (): Promise<Response> => HttpResponse.error() };
  const workspace = { id: WORKSPACE, slug: "team", name: "Team", created_by: ME, created_at: "2026-10-18T04:00:00Z", updated_at: "2026-10-18T04:00:00Z" };
  const board = { id: BOARD, slug: "board", workspace_id: WORKSPACE, name: "Delivery", is_frozen: false, columns: [{ id: "todo", name: "To do", cards: [{ id: CARD, title: "Related work" }] }] };
  server.use(
    http.get("/api/me", () => HttpResponse.json({ id: ME, name: "Owner", email: "owner@example.test" })),
    http.get("/api/workspaces", () => HttpResponse.json([workspace])),
    http.get("/api/workspaces/team/boards", () => HttpResponse.json([board])),
    http.get(`/api/workspaces/team/boards/${BOARD}`, () => HttpResponse.json(board)),
    http.get("/api/workspaces/team/members", () => HttpResponse.json([{ user_id: ME, role: "member", name: "Owner" }])),
    http.get(`${contentsPath}/window`, ({ request }) => contentWindowResponse([contentPage([item])], new URL(request.url).searchParams)),
    http.post(`${contentsPath}/metadata`, async ({ request }) => {
      const { content_ids } = await request.json() as { content_ids: string[] };
      metadataReads.push(content_ids);
      return HttpResponse.json(selectedMetadata([item], content_ids));
    }),
    http.get(`${contentsPath}/${CONTENT}/body`, () => HttpResponse.json({ content_id: CONTENT, offset: 0, next_offset: null, total_bytes: item.byte_count, text: PRIVATE_BODY })),
    http.post(`/api/workspaces/team/boards/${BOARD}/notes/from-excerpt`, async ({ request }) => {
      writes.push(await request.json() as Publication);
      return state.respond();
    }),
  );
  return state;
}
function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
function savedResponse() {
  return HttpResponse.json({ id: "66666666-6666-4666-8666-666666666666", title: "Reviewed handoff", board_id: BOARD, workspace_id: WORKSPACE });
}
function mount() {
  return renderNavigationRouter([
    { path: "/:slug/sessions/:sessionId", element: <><EntityLink type="card" slug="team" boardId={BOARD} id={CARD}>Inspect related work</EntityLink><SessionTranscript slug={SLUG} session={source} /></> },
    { path: "/team/boards/:boardId/kanban", element: <h1>Related work destination</h1> },
  ], { initialEntries: [sourcePath] });
}
async function draft() {
  const user = userEvent.setup();
  await screen.findByRole("list", { name: i18n.t("sessions.contents.title") });
  const entry = document.getElementById(`content-${CONTENT}`)!;
  await user.click(within(entry).getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: i18n.t("sessions.contents.excerpt.preview") }));
  const preview = await screen.findByRole("dialog", { name: i18n.t("sessions.contents.excerpt.title") });
  await waitFor(() => expect((within(preview).getByRole("textbox") as HTMLTextAreaElement).value).toContain(PRIVATE_BODY));
  await user.click(within(preview).getByRole("button", { name: "Share as note" }));
  const dialog = await screen.findByRole("dialog", { name: "Share as note" });
  await user.selectOptions(within(dialog).getByLabelText("Workspace"), "team");
  await user.selectOptions(within(dialog).getByLabelText("Board"), BOARD);
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save note" })).toBeEnabled());
  fireEvent.change(within(dialog).getByLabelText("Note title"), { target: { value: "Reviewed handoff" } });
  return { user, dialog };
}
beforeEach(() => stubReducedMotion(true));
afterEach(() => stubReducedMotion(false));

describe("Session handoff across real route unmounts", () => {
  it("updates a remounted pending dialog when the original attempt fails and retries its exact request", async () => {
    const state = serve();
    const response = deferredResponse();
    state.respond = () => response.promise;
    const { router } = mount();
    const { user, dialog } = await draft();
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    const original = structuredClone(state.writes[0]);
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    await user.click(screen.getByRole("link", { name: "Inspect related work" }));
    expect(screen.getByRole("heading", { name: "Related work destination" })).toBeVisible();
    await act(async () => { await router.navigate(-1); });
    await user.click(await screen.findByRole("button", { name: "Resume note save" }));
    const resumed = screen.getByRole("dialog", { name: "Share as note" });
    expect(within(resumed).getByRole("button", { name: "Save note" })).toBeDisabled();

    await act(async () => { response.resolve(HttpResponse.error()); });
    expect(await within(resumed).findByRole("alert")).toHaveTextContent(/may have been saved/i);
    expect(resumed).toBeVisible();
    state.respond = async () => HttpResponse.error();
    await user.click(within(resumed).getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes[1]).toEqual(original);
  });

  it("releases a successful pending handoff after return while keeping reusable selection metadata", async () => {
    const state = serve();
    const response = deferredResponse();
    state.respond = () => response.promise;
    const { router, client } = mount();
    const { user, dialog } = await draft();
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    await user.click(screen.getByRole("link", { name: "Inspect related work" }));
    await act(async () => { await router.navigate(-1); });
    await user.click(await screen.findByRole("button", { name: "Resume note save" }));
    await act(async () => { response.resolve(savedResponse()); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument());
    expect(within(document.getElementById(`content-${CONTENT}`)!).getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("button", { name: i18n.t("sessions.contents.excerpt.preview") })).toBeEnabled();
    const warning = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(warning);
    expect(warning.defaultPrevented).toBe(false);
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
    expect(screen.queryByDisplayValue(/Private retained source text/)).not.toBeInTheDocument();
    expect(state.writes).toHaveLength(1);
  });

  it.each(["success", "unknown"])("cannot restore a revoked handoff when a late %s response arrives", async (outcome) => {
    const state = serve();
    const response = deferredResponse();
    state.respond = () => response.promise;
    const { router, client } = mount();
    const { user, dialog } = await draft();
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    await user.click(screen.getByRole("link", { name: "Inspect related work" }));
    act(() => client.setQueryData(sessionKeys.detail(SLUG, SESSION), null));
    await act(async () => { response.resolve(outcome === "success" ? savedResponse() : HttpResponse.error()); });
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
    await act(async () => { await router.navigate(-1); });
    await screen.findByRole("list", { name: i18n.t("sessions.contents.title") });
    expect(within(document.getElementById(`content-${CONTENT}`)!).getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Resume note save" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/Private retained source text/)).not.toBeInTheDocument();
    const warning = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(warning);
    expect(warning.defaultPrevented).toBe(false);
    expect(state.writes).toHaveLength(1);
  });

  it("keeps selected sources, reviewed destination and the exact unknown-outcome request after work and Back", async () => {
    const state = serve();
    const { router } = mount();
    const originKey = router.state.location.key;
    const { user, dialog } = await draft();
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
    expect(state.writes).toHaveLength(1);
    const firstRequest = structuredClone(state.writes[0]!);
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    const related = screen.getByRole("link", { name: "Inspect related work" });
    expect(related).toHaveAttribute("href", cardPath);
    await user.click(related);
    expect(router.state.location.pathname + router.state.location.search).toBe(cardPath);
    expect(JSON.stringify(router.state.location.state)).not.toContain(PRIVATE_BODY);
    await act(async () => { await router.navigate(-1); });

    expect(router.state.location.key).toBe(originKey);
    await screen.findByRole("list", { name: i18n.t("sessions.contents.title") });
    expect(within(document.getElementById(`content-${CONTENT}`)!).getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Resume note save" }));
    const resumed = screen.getByRole("dialog", { name: "Share as note" });
    expect(within(resumed).getByLabelText("Note title")).toHaveValue("Reviewed handoff");
    expect(within(resumed).getByLabelText("Workspace")).toHaveValue("team");
    expect(within(resumed).getByLabelText("Board")).toHaveValue(BOARD);
    await user.click(within(resumed).getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes[1]).toEqual(firstRequest);
    expect(state.writes[1]!.client_request_id).toBe(firstRequest.client_request_id);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(PRIVATE_BODY);
  });

  it("asks before Escape discards an edited unpublished handoff and Cancel preserves it", async () => {
    const state = serve();
    mount();
    const { user } = await draft();
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("unsaved-changes-prompt")).toBeVisible();
    await user.click(screen.getByTestId("unsaved-changes-keep-editing"));
    expect(screen.getByRole("dialog", { name: "Share as note" })).toBeVisible();
    expect(screen.getByLabelText("Note title")).toHaveValue("Reviewed handoff");
    expect(state.writes).toEqual([]);
  });

  it("guards route departure while an edited handoff dialog is open and Cancel retains its destination", async () => {
    const state = serve();
    const { router } = mount();
    const { user } = await draft();
    await act(async () => { await router.navigate(cardPath); });
    expect(router.state.location.pathname).toBe(sourcePath);
    await user.click(screen.getByTestId("unsaved-changes-keep-editing"));
    const dialog = screen.getByRole("dialog", { name: "Share as note" });
    expect(within(dialog).getByLabelText("Note title")).toHaveValue("Reviewed handoff");
    expect(within(dialog).getByLabelText("Workspace")).toHaveValue("team");
    expect(within(dialog).getByLabelText("Board")).toHaveValue(BOARD);
    expect(state.writes).toEqual([]);
  });

  it("warns before reload of an unknown-outcome request without persisting its private body", async () => {
    const state = serve();
    mount();
    const { user, dialog } = await draft();
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(state.writes).toHaveLength(1);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(PRIVATE_BODY);
    expect(JSON.stringify(window.history.state)).not.toContain(PRIVATE_BODY);
  });
});
