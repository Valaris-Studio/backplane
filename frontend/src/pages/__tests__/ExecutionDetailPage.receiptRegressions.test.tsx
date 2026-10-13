// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { toast } from "sonner";
import { Link, Route, Routes, useLocation, useParams } from "react-router-dom";
import {
  createTestQueryClient, renderWithProviders, screen, stubReducedMotion, userEvent,
  waitFor, within,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { WebSocketEvent } from "@/lib/websocket";
import { NoteList } from "@/features/notes/components/NoteList";
import { ExecutionDetailPage } from "../ExecutionDetailPage";

const transport = vi.hoisted(() => ({
  status: "connected" as "connected" | "disconnected",
  subscribe(_pattern: string, _handler: (event: WebSocketEvent) => void) {
    return () => {};
  },
}));
vi.mock("@/providers/WebSocketProvider", () => ({ useWebSocketContext: () => transport }));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: () => <textarea aria-label="Note content editor" />,
}));

const NOTE_ID = "note-current-9";
const NOTE_TITLE = "Retained handoff title";

function execution(slug: string, executionId: string) {
  return {
    id: executionId, agent_id: "agent-9", workspace_id: `ws-${slug}`, board_id: "board-9",
    session_id: null, action: "operator_stage_9", status: "completed",
    started_at: "2026-10-01T01:02:03Z", completed_at: "2026-10-01T01:05:03Z",
    input_summary: "", output_summary: null, tools_used: [], cards_affected: [],
    cards_affected_detail: [], error_message: null, tool_calls_count: 0, tokens_used: 0,
    cost_usd: 0, duration_seconds: 180, parent_execution_id: null, role: null,
    prompt_slug: null, model: null, provider: null,
    input_prompt: `legacy ${slug}/${executionId}`, tool_invocations: [],
    context_receipt_count: 2, context_binding: null,
  };
}

// The same receipt IDs deliberately exist under every workspace/execution route.
function receipt(slug: string, executionId: string, ordinal: number) {
  const input = `prompt ${ordinal} for ${slug}/${executionId}`;
  return {
    id: `receipt-${ordinal}`, execution_id: executionId, ordinal,
    client_request_id: `request-${ordinal}`, context_revision: "a".repeat(64),
    prompt_sha256: "b".repeat(64), prompt_bytes: input.length,
    system_prompt_sha256: "c".repeat(64), system_prompt_bytes: 6,
    provider: `provider-${slug}`, model: `model-${executionId}`,
    status: "prepared", use_verification: "not_verified",
    created_at: `2026-10-02T12:0${ordinal}:00Z`,
    context_manifest: {
      schema_version: 1, renderer_version: "context-v1",
      sources: [{
        source_index: 0, kind: "card_notes", alias: `handoff_${slug}`, filter: {},
        coverage: "record_traced", rendered_sha256: "d".repeat(64), rendered_bytes: 30,
        records: [{
          record_index: 0, note_id: NOTE_ID, workspace_id: `ws-${slug}`, board_id: "board-9",
          card_id: "card-9", title: NOTE_TITLE, kind: "handoff", updated_at: "2026-09-30T23:04:05Z",
          revision_sha256: "e".repeat(64), rendered_sha256: "f".repeat(64), rendered_bytes: 30,
        }],
      }],
    },
    input_prompt: input, system_prompt: "system",
  };
}

function serveReceipts() {
  const calls = { lists: [] as string[], details: [] as string[] };
  server.use(
    http.get("/api/workspaces/:slug/metrics/agents", () => HttpResponse.json({ agents: [] })),
    http.get("/api/workspaces/:slug/executions/:executionId", ({ params }) =>
      HttpResponse.json(execution(String(params.slug), String(params.executionId)))),
    http.get("/api/workspaces/:slug/executions/:executionId/context-receipts", ({ params, request }) => {
      calls.lists.push(new URL(request.url).pathname);
      const slug = String(params.slug); const executionId = String(params.executionId);
      const rows = [receipt(slug, executionId, 2), receipt(slug, executionId, 1)].map((row) => {
        const summary: Partial<typeof row> = { ...row };
        delete summary.context_manifest; delete summary.input_prompt; delete summary.system_prompt;
        return summary;
      });
      return HttpResponse.json(rows, { headers: { "X-Total-Count": "2" } });
    }),
    http.get("/api/workspaces/:slug/executions/:executionId/context-receipts/:receiptId", ({ params, request }) => {
      calls.details.push(new URL(request.url).pathname);
      const ordinal = Number(String(params.receiptId).replace("receipt-", ""));
      return HttpResponse.json(receipt(String(params.slug), String(params.executionId), ordinal));
    }),
  );
  return calls;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function BoardNotesRoute() {
  const { slug = "", boardId = "" } = useParams();
  return <NoteList slug={slug} boardId={boardId} />;
}

function renderPage(initialPath: string, extra?: ReactNode) {
  const queryClient = createTestQueryClient();
  const view = renderWithProviders(
    <>
      <Routes>
        <Route path="/:slug/agents/executions/:executionId" element={<ExecutionDetailPage />} />
        <Route path="/:slug/boards/:boardId/notes" element={<BoardNotesRoute />} />
      </Routes>
      {extra}
      <LocationProbe />
    </>,
    { queryClient, routerProps: { initialEntries: [initialPath] } },
  );
  return { queryClient, ...view };
}

const panel = () => screen.getByRole("tabpanel", { name: "Prompt" });
async function openPrompt() {
  const tab = await screen.findByRole("tab", { name: "Prompt" });
  if (tab.getAttribute("aria-selected") !== "true") fireEvent.click(tab);
}
async function shownPrompt(text: string) {
  await waitFor(() => expect(screen.getByTestId("execution-prompt-body").textContent).toBe(text));
}

beforeEach(() => { transport.status = "connected"; stubReducedMotion(true); });
afterEach(() => { cleanup(); stubReducedMotion(false); vi.restoreAllMocks(); });

describe("implementer-authored regressions: receipt history", () => {
  it.each([
    ["another workspace", "/ws-b/agents/executions/exec-1", "ws-b", "exec-1"],
    ["another execution in the same workspace", "/ws-a/agents/executions/exec-2", "ws-a", "exec-2"],
  ])("never reuses a same-ID receipt body across %s", async (_label, nextPath, slug, executionId) => {
    const calls = serveReceipts();
    renderPage("/ws-a/agents/executions/exec-1", <Link to={nextPath}>switch route</Link>);
    await openPrompt();
    await shownPrompt("prompt 2 for ws-a/exec-1");
    fireEvent.click(screen.getByRole("link", { name: "switch route" }));
    await openPrompt();
    await shownPrompt(`prompt 2 for ${slug}/${executionId}`);
    expect(panel().textContent).not.toContain("ws-a/exec-1");
    expect(within(panel()).getByText(`provider-${slug}`)).toBeVisible();
    expect(calls.details).toEqual([
      "/api/workspaces/ws-a/executions/exec-1/context-receipts/receipt-2",
      `/api/workspaces/${slug}/executions/${executionId}/context-receipts/receipt-2`,
    ]);
  });

  it("reports a failed copy through the clipboard helper and never claims success", async () => {
    serveReceipts();
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const execCommand = vi.fn().mockReturnValue(false);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    renderPage("/ws-a/agents/executions/exec-1");
    await openPrompt(); await shownPrompt("prompt 2 for ws-a/exec-1");
    fireEvent.click(within(panel()).getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("prompt 2 for ws-a/exec-1");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(success).not.toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole("button", { name: "Copy system prompt" }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    expect(success).not.toHaveBeenCalled();
  });

  it("opens the current note through the canonical link without dropping the deep link", async () => {
    serveReceipts();
    server.use(
      http.get("/api/workspaces/ws-a/members", () => HttpResponse.json([])),
      http.get("/api/workspaces/ws-a/boards/board-9", () => HttpResponse.json({ detail: "unused" }, { status: 404 })),
      http.get("/api/workspaces/ws-a/boards/board-9/notes", () =>
        HttpResponse.json([], { headers: { "X-Total-Count": "0" } })),
      http.get(`/api/workspaces/ws-a/boards/board-9/notes/${NOTE_ID}`, () => HttpResponse.json({
        id: NOTE_ID, workspace_id: "ws-ws-a", board_id: "board-9", card_id: "card-9",
        title: "Current title after rename", content: "<p>current body</p>", pinned: false,
        kind: "handoff", failure_class: null, findings: null, source_execution_id: null,
        created_by: "u1", created_at: "2026-09-30T23:04:05Z", updated_at: "2026-10-03T00:00:00Z",
      })),
    );
    renderPage("/ws-a/agents/executions/exec-1");
    await openPrompt(); await shownPrompt("prompt 2 for ws-a/exec-1");
    fireEvent.click(within(panel()).getByRole("button", { name: /handoff_ws-a/ }));
    const link = within(panel()).getByRole("link", { name: new RegExp(NOTE_TITLE) });
    expect(link).toHaveAttribute("href", `/ws-a/boards/board-9/notes?note=${NOTE_ID}`);
    fireEvent.click(link);
    expect(await screen.findByDisplayValue("Current title after rename")).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe(`/ws-a/boards/board-9/notes?note=${NOTE_ID}`);
    expect(screen.queryByText(/unavailable or you no longer have access/i)).not.toBeInTheDocument();
  });

  it("keeps keyboard focus and native semantics through selection, disclosures and tabs", async () => {
    serveReceipts();
    const user = userEvent.setup();
    renderPage("/ws-a/agents/executions/exec-1");
    await openPrompt(); await shownPrompt("prompt 2 for ws-a/exec-1");

    const promptTab = screen.getByRole("tab", { name: "Prompt" });
    expect(promptTab).toHaveAttribute("aria-selected", "true");
    expect(promptTab.getAttribute("aria-controls")).toBe(panel().id);
    expect(panel()).toHaveAttribute("aria-labelledby", promptTab.id);

    const select = within(panel()).getByLabelText("Invocation");
    expect(select.tagName).toBe("SELECT");
    select.focus();
    await user.selectOptions(select, within(select).getByRole("option", { name: /Invocation 1\b/ }));
    await shownPrompt("prompt 1 for ws-a/exec-1");
    expect(document.activeElement).toBe(select);
    expect(within(panel()).getByRole("status")).toHaveTextContent(/invocation 1\b/i);

    for (const name of [/^System prompt/, /handoff_ws-a/, /Receipt evidence/]) {
      const disclosure = within(panel()).getByRole("button", { name });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      disclosure.focus();
      await user.keyboard("{Enter}");
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      const controlled = document.getElementById(disclosure.getAttribute("aria-controls") ?? "");
      expect(controlled).not.toBeNull();
      expect(panel().contains(controlled)).toBe(true);
      await user.keyboard(" ");
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
    }
  });
});

describe("implementer-authored regressions: authorization loss and mis-scoped bodies", () => {
  const RECEIPT_DETAIL = "/api/workspaces/ws-a/executions/exec-1/context-receipts/:receiptId";
  const RECEIPT_LIST = "/api/workspaces/ws-a/executions/exec-1/context-receipts";

  // Records every DOM commit that shows a retained body, an enabled copy or the
  // transient "refresh failed" notice once the server has answered 401/403.
  function watchAfterDenial(denied: { value: boolean }) {
    const violations: string[] = [];
    const observer = new MutationObserver(() => {
      if (!denied.value) return;
      if (screen.queryByTestId("execution-prompt-body")) violations.push("body");
      for (const button of screen.queryAllByRole("button", { name: /^Copy (prompt|system prompt)$/ })) {
        if (!(button as HTMLButtonElement).disabled) violations.push("enabled copy");
      }
      if (/Refreshing it failed/.test(document.body.textContent ?? "")) violations.push("stale notice");
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    return { violations, stop: () => observer.disconnect() };
  }

  it.each([401, 403])("never commits a cached body after a detail refetch answers %i", async (status) => {
    serveReceipts();
    const { queryClient } = renderPage("/ws-a/agents/executions/exec-1");
    await openPrompt(); await shownPrompt("prompt 2 for ws-a/exec-1");
    const denied = { value: false };
    server.use(http.get(RECEIPT_DETAIL, () => {
      denied.value = true;
      return HttpResponse.json({ detail: "denied" }, { status });
    }));
    const watch = watchAfterDenial(denied);
    await queryClient.invalidateQueries({ queryKey: ["agents", "ws-a", "execution-context-receipt"] });
    await within(panel()).findByText(/no longer have access/i);
    watch.stop();
    expect(watch.violations).toEqual([]);
  });

  it("never commits a cached body after a summary refresh answers 403", async () => {
    serveReceipts();
    renderPage("/ws-a/agents/executions/exec-1");
    await openPrompt(); await shownPrompt("prompt 2 for ws-a/exec-1");
    const denied = { value: false };
    server.use(http.get(RECEIPT_LIST, () => {
      denied.value = true;
      return HttpResponse.json({ detail: "denied" }, { status: 403 });
    }));
    const watch = watchAfterDenial(denied);
    fireEvent.click(within(panel()).getByRole("button", { name: "Refresh" }));
    await within(panel()).findByText(/no longer have access/i);
    watch.stop();
    expect(watch.violations).toEqual([]);
  });

  it("clears cached summaries and stops listing invocations once access is lost", async () => {
    serveReceipts();
    const { queryClient } = renderPage("/ws-a/agents/executions/exec-1");
    await openPrompt(); await shownPrompt("prompt 2 for ws-a/exec-1");
    server.use(http.get(RECEIPT_DETAIL, () => HttpResponse.json({ detail: "denied" }, { status: 403 })));
    await queryClient.invalidateQueries({ queryKey: ["agents", "ws-a", "execution-context-receipt"] });
    await within(panel()).findByText(/no longer have access/i);
    const cached = JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data));
    expect(cached).not.toContain("b".repeat(64));
    expect(cached).not.toContain("request-1");
    expect(within(panel()).queryAllByRole("option")).toEqual([]);
    expect(within(panel()).getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("does not present a body whose identity differs from the selected invocation", async () => {
    serveReceipts();
    renderPage("/ws-a/agents/executions/exec-1");
    await openPrompt(); await shownPrompt("prompt 2 for ws-a/exec-1");
    // A mis-scoped server answers the receipt-1 URL with receipt 2's body.
    server.use(http.get(RECEIPT_DETAIL, () => HttpResponse.json(receipt("ws-a", "exec-1", 2))));
    const select = within(panel()).getByLabelText("Invocation");
    fireEvent.change(select, { target: { value: "receipt-1" } });
    await within(panel()).findByText(/Couldn't load this invocation snapshot/i);
    expect(screen.queryByTestId("execution-prompt-body")).not.toBeInTheDocument();
    expect(within(panel()).getByRole("status").textContent).toBe("");
    expect(within(panel()).queryByText("provider-ws-a")).not.toBeInTheDocument();

    server.use(http.get(RECEIPT_DETAIL, () =>
      HttpResponse.json({ ...receipt("ws-a", "exec-1", 1), execution_id: "exec-other" })));
    fireEvent.click(within(panel()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(panel()).getByRole("button", { name: "Retry" })).toBeEnabled());
    await within(panel()).findByText(/Couldn't load this invocation snapshot/i);
    expect(screen.queryByTestId("execution-prompt-body")).not.toBeInTheDocument();
  });
});

describe("implementer-authored regressions: unavailable current note", () => {
  const PATH = "/ws-a/boards/board-9/notes?keep=1&note=note-gone-9&view=list";
  function serveNote(statuses: number[]) {
    const state = { calls: 0, mutations: 0 };
    server.use(
      http.get("/api/workspaces/ws-a/members", () => HttpResponse.json([])),
      http.get("/api/workspaces/ws-a/boards/board-9/notes", () =>
        HttpResponse.json([], { headers: { "X-Total-Count": "0" } })),
      http.get("/api/workspaces/ws-a/boards/board-9/notes/note-gone-9", () => {
        const status = statuses[Math.min(state.calls, statuses.length - 1)] ?? 404;
        state.calls += 1;
        if (status === 200) {
          return HttpResponse.json({
            id: "note-gone-9", workspace_id: "ws-ws-a", board_id: "board-9", card_id: null,
            title: "Recovered note", content: "<p>body</p>", pinned: false, kind: "user_note",
            failure_class: null, findings: null, source_execution_id: null, created_by: "u1",
            created_at: "2026-09-30T23:04:05Z", updated_at: "2026-10-03T00:00:00Z",
          });
        }
        return HttpResponse.json({ detail: "fixture" }, { status });
      }),
      http.patch("/api/workspaces/ws-a/boards/board-9/notes/note-gone-9", () => {
        state.mutations += 1; return HttpResponse.json({});
      }),
    );
    renderPage(PATH);
    return state;
  }

  it("leaves through Back to notes removing only the note param, never opening an editor", async () => {
    const state = serveNote([404]);
    expect(await screen.findByText(/This note is unavailable or you no longer have access/i)).toBeVisible();
    expect(screen.queryByText(/deleted/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Note content editor" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe(PATH);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/ws-a/boards/board-9/notes?keep=1&view=list"));
    expect(screen.queryByText(/This note is unavailable/i)).not.toBeInTheDocument();
    expect(state.mutations).toBe(0);
  });

  it("lets the reader open another listed note after an unavailable deep link", async () => {
    const otherDetailCalls: string[] = [];
    server.use(
      http.get("/api/workspaces/ws-a/members", () => HttpResponse.json([])),
      http.get("/api/workspaces/ws-a/boards/board-9/notes", () => HttpResponse.json([{
        id: "note-other-9", workspace_id: "ws-ws-a", board_id: "board-9", card_id: null,
        title: "Other listed note", preview: "", pinned: false, kind: "user_note",
        failure_class: null, findings: null, source_execution_id: null, created_by: "u1",
        created_at: "2026-09-30T23:04:05Z", updated_at: "2026-10-03T00:00:00Z",
      }], { headers: { "X-Total-Count": "1" } })),
      http.get("/api/workspaces/ws-a/boards/board-9/notes/note-gone-9", () =>
        HttpResponse.json({ detail: "fixture" }, { status: 404 })),
      http.get("/api/workspaces/ws-a/boards/board-9/notes/note-other-9", ({ request }) => {
        otherDetailCalls.push(new URL(request.url).pathname);
        return HttpResponse.json({
          id: "note-other-9", workspace_id: "ws-ws-a", board_id: "board-9", card_id: null,
          title: "Other listed note", content: "<p>other body</p>", pinned: false, kind: "user_note",
          failure_class: null, findings: null, source_execution_id: null, created_by: "u1",
          created_at: "2026-09-30T23:04:05Z", updated_at: "2026-10-03T00:00:00Z",
        });
      }),
    );
    renderPage(PATH);
    await screen.findByText(/This note is unavailable or you no longer have access/i);
    fireEvent.click(screen.getByText("Other listed note"));
    await waitFor(() => expect(otherDetailCalls).toHaveLength(1));
    expect(await screen.findByDisplayValue("Other listed note")).toBeInTheDocument();
    expect(screen.queryByText(/This note is unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("/ws-a/boards/board-9/notes?keep=1&view=list");
  });

  it("opens the note once a retried transient failure succeeds, keeping every param", async () => {
    const state = serveNote([503, 200]);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue("Recovered note")).toBeInTheDocument();
    expect(state.calls).toBe(2);
    expect(screen.getByTestId("location").textContent).toBe(PATH);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
