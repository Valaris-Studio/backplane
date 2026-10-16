// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { createHash } from "node:crypto";
import { Route, Routes } from "react-router-dom";
import {
  act, createTestQueryClient, renderWithProviders, screen, userEvent,
  waitFor, within,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { Execution } from "@/features/agents/api/agents";
import type { WebSocketEvent } from "@/lib/websocket";
import { ExecutionDetailPage } from "../ExecutionDetailPage";

// Only the transport is substituted. The page, API client, query cache and
// domain-event subscription/invalidation code are the production components.
const transport = vi.hoisted(() => ({
  status: "connected" as "connected" | "disconnected",
  subscriptions: [] as { pattern: string; handler: (event: WebSocketEvent) => void }[],
  subscribe(pattern: string, handler: (event: WebSocketEvent) => void) {
    const subscription = { pattern, handler };
    transport.subscriptions.push(subscription);
    return () => {
      transport.subscriptions = transport.subscriptions.filter((item) => item !== subscription);
    };
  },
}));
vi.mock("@/providers/WebSocketProvider", () => ({ useWebSocketContext: () => transport }));

const SLUG = "receipt-workspace";
const EXECUTION_ID = "execution-custom-47";
const BASE = `/api/workspaces/${SLUG}/executions/${EXECUTION_ID}`;
const LEGACY = "legacy last-saved prompt — never substitute for an unavailable receipt";
const EXECUTION: Execution = {
  id: EXECUTION_ID, agent_id: "agent-custom-47", workspace_id: "workspace-47",
  board_id: "board-47", session_id: null, action: "operator_stage_47",
  status: "completed", started_at: "2026-10-01T01:02:03Z",
  completed_at: "2026-10-01T01:05:03Z", input_summary: "Operator-defined review", output_summary: null,
  tools_used: [], cards_affected: [], cards_affected_detail: [], error_message: null,
  tool_calls_count: 0, tokens_used: 0, cost_usd: 0, duration_seconds: 180,
  parent_execution_id: null, role: "operator_stage_47", prompt_slug: "operator_stage_47",
  model: "execution-last-model", provider: "execution-last-provider",
  input_prompt: LEGACY, tool_invocations: [],
};
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const ALIASES = ["ReviewedHandoff_47", "Órbita_重复_47", "OperatorStage47"];
const TITLE = "Retained title — café 🧭";
const NOTE_ID = "note-historical-47";
const record = (recordIndex: number) => ({
  record_index: recordIndex, note_id: NOTE_ID, workspace_id: "workspace-47",
  board_id: "board-47", card_id: "card-47", title: TITLE, kind: "user_note",
  updated_at: "2026-09-30T23:04:05Z", revision_sha256: sha("historical note body"),
  rendered_sha256: sha("rendered historical note"), rendered_bytes: 24,
});
const manifest = {
  schema_version: 1, renderer_version: "context-v1",
  sources: [
    { source_index: 0, kind: "card_notes", alias: ALIASES[0], filter: { kind: "user_note" },
      coverage: "record_traced", rendered_sha256: sha("source one"), rendered_bytes: 24,
      records: [record(0), { ...record(1), note_id: "note-second-47", title: "Second retained note" }] },
    { source_index: 1, kind: "card_notes", alias: ALIASES[1], filter: {},
      coverage: "record_traced", rendered_sha256: sha("source two"), rendered_bytes: 24,
      records: [record(0)] },
    { source_index: 2, kind: "pipeline_expectations", alias: ALIASES[2], filter: {},
      coverage: "source_only", rendered_sha256: sha("stage policy"), rendered_bytes: 12,
      records: [] },
  ],
};

// Frozen A1 summary/detail fields + the approved historical title/kind addendum.
// The fixture intentionally contains no A2 dispatch/span/used-token fields.
function receipt(ordinal: number) {
  const input = `  Invocation ${ordinal} — café 🧭\r\n\`\`\`html\r\n<script>untrusted()</script>\r\n\`\`\`  \r\n`;
  const system = `  System ${ordinal} — ação\r\nkeep trailing spaces  `;
  return {
    id: `receipt-${ordinal}`, execution_id: EXECUTION_ID, ordinal,
    client_request_id: `request-${ordinal}`, context_revision: sha(`context-${ordinal}`),
    prompt_sha256: sha(input), prompt_bytes: bytes(input),
    system_prompt_sha256: sha(system), system_prompt_bytes: bytes(system),
    provider: `operator-provider-${ordinal}`, model: `operator-model-${ordinal}`,
    status: "prepared", use_verification: "not_verified",
    created_at: `2026-10-02T12:${String(ordinal).padStart(2, "0")}:00Z`,
    context_manifest: {
      ...structuredClone(manifest),
      sources: manifest.sources.map((source) => ({ ...structuredClone(source),
        alias: ordinal === 1 ? `${source.alias}_earlier` : source.alias,
        records: source.records.map((item) => ({ ...item, title: ordinal === 1 ? `${item.title} earlier` : item.title })),
      })),
    }, input_prompt: input, system_prompt: system,
  };
}
type Receipt = ReturnType<typeof receipt>;
function summary(value: Receipt) {
  const row: Partial<Receipt> = { ...value };
  delete row.context_manifest;
  delete row.input_prompt;
  delete row.system_prompt;
  return row;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function setup(rows: Receipt[] = [receipt(2), receipt(1)], options: {
  count?: number | "missing"; legacy?: string | null; bound?: boolean;
} = {}) {
  const calls = { lists: [] as { limit: number; offset: number }[], details: [] as string[],
    other: [] as string[], mutations: [] as string[], executions: 0 };
  const state = { rows, detailStatus: new Map<string, number>(),
    holds: new Map<string, ReturnType<typeof gate>>(), listStatus: 200 };
  const count = options.count ?? rows.length;
  server.use(
    http.get(BASE, () => {
      calls.executions += 1;
      return HttpResponse.json({ ...EXECUTION, input_prompt: options.legacy === undefined ? LEGACY : options.legacy,
        ...(count === "missing" ? {} : { context_receipt_count: state.rows.length }),
        context_binding: options.bound ? { reservation_id: "reservation-47", agent_id: EXECUTION.agent_id,
          workspace_id: EXECUTION.workspace_id, board_id: "board-47", card_id: "card-47",
          role: "operator_stage_47", created_at: EXECUTION.started_at } : null });
    }),
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () => HttpResponse.json({ agents: [] })),
    http.get(`${BASE}/context-receipts`, ({ request }) => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      calls.lists.push({ limit, offset });
      if (state.listStatus !== 200) return HttpResponse.json({ detail: "fixture unavailable" }, { status: state.listStatus });
      return HttpResponse.json(state.rows.slice(offset, offset + limit).map(summary), {
        headers: { "X-Total-Count": String(state.rows.length) },
      });
    }),
    http.get(`${BASE}/context-receipts/:receiptId`, async ({ params }) => {
      const id = String(params.receiptId);
      calls.details.push(id);
      await state.holds.get(id)?.promise;
      const status = state.detailStatus.get(id) ?? 200;
      if (status !== 200) return HttpResponse.json({ detail: "fixture unavailable" }, { status });
      return HttpResponse.json(state.rows.find((row) => row.id === id));
    }),
    http.get(`/api/workspaces/${SLUG}/*`, ({ request }) => {
      calls.other.push(new URL(request.url).pathname);
      return HttpResponse.json({ detail: "not a viewer route" }, { status: 404 });
    }),
    http.post(`/api/workspaces/${SLUG}/*`, ({ request }) => {
      calls.mutations.push(new URL(request.url).pathname);
      return HttpResponse.json({ detail: "viewer must be read-only" }, { status: 405 });
    }),
  );
  const queryClient = createTestQueryClient();
  // Keep inactive receipt data long enough to exercise real cached-403 eviction.
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 60_000 } });
  const view = renderWithProviders(
    <Routes><Route path="/:slug/agents/executions/:executionId" element={<ExecutionDetailPage />} /></Routes>,
    { queryClient, routerProps: { initialEntries: [`/${SLUG}/agents/executions/${EXECUTION_ID}`] } },
  );
  return { calls, state, queryClient, ...view };
}

const panel = () => screen.getByRole("tabpanel", { name: "Prompt" });
async function openPrompt() { fireEvent.click(await screen.findByRole("tab", { name: "Prompt" })); }
async function loaded(row: Receipt) {
  await waitFor(() => expect(screen.getByTestId("execution-prompt-body").textContent).toBe(row.input_prompt));
}
async function choose(ordinal: number) {
  const select = within(panel()).getByRole("combobox", { name: "Invocation" });
  const option = within(select).getByRole("option", { name: new RegExp(`Invocation ${ordinal}\\b`) });
  fireEvent.change(select, { target: { value: (option as HTMLOptionElement).value } });
}
function emit(executionId: string, row: Receipt) {
  const event: WebSocketEvent = { event: "execution.context_receipt_created", event_id: `event-${row.id}`,
    timestamp: row.created_at, payload: { execution_id: executionId, workspace_id: "workspace-47",
      receipt_id: row.id, ordinal: row.ordinal } };
  act(() => {
    for (const subscription of transport.subscriptions) {
      if (subscription.pattern === event.event || subscription.pattern === "*" ||
          (subscription.pattern.endsWith(".*") && event.event.startsWith(subscription.pattern.slice(0, -1)))) {
        subscription.handler(event);
      }
    }
  });
}
async function settleEvents() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); }); }

beforeEach(() => { transport.status = "connected"; transport.subscriptions = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); focusManager.setFocused(undefined); vi.restoreAllMocks(); });

describe("execution receipt history through the real page", () => {
  it("keeps Overview lazy, then requests bounded summaries and only the latest body", async () => {
    const { calls } = setup();
    await screen.findByRole("tab", { name: "Prompt" });
    expect(calls.lists).toEqual([]);
    expect(calls.details).toEqual([]);
    await openPrompt();
    await loaded(receipt(2));
    expect(calls.lists).toEqual([{ limit: 20, offset: 0 }]);
    expect(calls.details).toEqual(["receipt-2"]);
    expect(calls.other).toEqual([]);
    expect(calls.mutations).toEqual([]);
  });

  it("copies exact prompt and system independently, preserving CRLF, Unicode and inert markup", async () => {
    setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await openPrompt(); await loaded(receipt(2));
    expect(panel().querySelector("script")).toBeNull();
    expect(within(panel()).getByText(new RegExp(`${receipt(2).prompt_bytes} bytes`))).toBeVisible();
    expect(receipt(2).prompt_bytes).not.toBe(receipt(2).input_prompt.length);
    fireEvent.click(within(panel()).getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(receipt(2).input_prompt));
    const system = within(panel()).getByRole("button", { name: /^System prompt/ });
    expect(system).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(system);
    fireEvent.click(within(panel()).getByRole("button", { name: "Copy system prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(receipt(2).system_prompt));
    await choose(1); await loaded(receipt(1));
    expect(within(panel()).getByText("operator-provider-1")).toBeVisible();
    expect(within(panel()).queryByText("operator-provider-2")).not.toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: /ReviewedHandoff_47_earlier/ })).toBeVisible();
    expect(within(panel()).queryByRole("button", { name: /ReviewedHandoff_47(?!_earlier)/ })).not.toBeInTheDocument();
    fireEvent.click(within(panel()).getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(receipt(1).input_prompt));
    // Copy system remains bound to the same newly selected invocation.
    const nextSystem = within(panel()).getByRole("button", { name: /^System prompt/ });
    if (nextSystem.getAttribute("aria-expanded") === "false") fireEvent.click(nextSystem);
    fireEvent.click(within(panel()).getByRole("button", { name: "Copy system prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(receipt(1).system_prompt));
  });

  it("switches atomically and ignores a delayed response for a no-longer-selected invocation", async () => {
    const { state, calls } = setup();
    await openPrompt(); await loaded(receipt(2));
    const pending = gate(); state.holds.set("receipt-1", pending);
    try {
      await choose(1);
      await waitFor(() => expect(calls.details).toContain("receipt-1"));
      expect(screen.queryByTestId("execution-prompt-body")).not.toBeInTheDocument();
      expect(within(panel()).queryByText("operator-provider-2")).not.toBeInTheDocument();
      for (const button of within(panel()).queryAllByRole("button", { name: /^Copy (prompt|system prompt)$/ })) {
        expect(button).toBeDisabled();
      }
      await choose(2); await loaded(receipt(2));
    } finally { pending.release(); }
    await settleEvents();
    await loaded(receipt(2));
    expect(within(panel()).queryByText("operator-provider-1")).not.toBeInTheDocument();
  });

  it("explains the selected historical context before its full prompt while copying the retained bytes exactly", async () => {
    const historical = receipt(1);
    historical.input_prompt += Array.from({ length: 200 }, (_, index) =>
      `Retained context line ${index + 1} — café 🧭  \r\n`,
    ).join("");
    historical.prompt_bytes = bytes(historical.input_prompt);
    historical.prompt_sha256 = sha(historical.input_prompt);
    setup([receipt(2), historical]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await openPrompt(); await loaded(receipt(2));
    await choose(1); await loaded(historical);
    fireEvent.click(within(panel()).getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(historical.input_prompt));

    const promptBody = within(panel()).getByTestId("execution-prompt-body");
    const contextHeading = within(panel()).getByRole("heading", { name: "Selected context" });
    const sources = historical.context_manifest.sources.map((source) => {
      if (!source.alias) throw new Error("Historical receipt fixture must name every source");
      return within(panel()).getByRole("button", { name: new RegExp(source.alias) });
    });
    let preceding = contextHeading;
    for (const following of [...sources, promptBody]) {
      expect(preceding.compareDocumentPosition(following)
        & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      preceding = following;
    }
  });

  it("shows Prepared and unverified use even when the execution completed", async () => {
    setup(); await openPrompt(); await loaded(receipt(2));
    expect(within(panel()).getByText("Prepared", { exact: true })).toBeVisible();
    expect(within(panel()).getByText(/agent execution and source use have not been verified/i)).toBeVisible();
    expect(within(panel()).queryByText(/^(Sent|Used|Executed|Completed)$/i)).not.toBeInTheDocument();
    expect(panel().textContent).not.toMatch(/\d+%/);
    expect(within(panel()).queryByText("execution-last-provider")).not.toBeInTheDocument();
    const options = within(panel()).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringMatching(/Invocation 2.*Latest/), expect.stringMatching(/Invocation 1/),
    ]);
    // Each option must expose the receipt's retained timestamp rather than execution.start.
    for (const [index, row] of [receipt(2), receipt(1)].entries()) {
      expect(options[index]?.textContent).toMatch(/2026/);
      expect(options[index]?.textContent).toMatch(/Oct(?:ober)? 2|10\/2|02\/10|2026-10-02/);
      expect(options[index]?.textContent).not.toContain(EXECUTION.started_at);
      expect(row.created_at).not.toBe(EXECUTION.started_at);
    }
  });

  it("preserves ordered repeated note occurrences and source-only evidence without reading current bodies", async () => {
    const { calls } = setup(); await openPrompt(); await loaded(receipt(2));
    const disclosure = ALIASES.map((alias) => within(panel()).getByRole("button", { name: new RegExp(alias) }));
    expect(disclosure[0]!.compareDocumentPosition(disclosure[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(disclosure[1]!.compareDocumentPosition(disclosure[2]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    for (const button of disclosure) fireEvent.click(button);
    const links = within(panel()).getAllByRole("link", { name: new RegExp(TITLE) });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute("href", `/${SLUG}/boards/board-47/notes?note=${NOTE_ID}`);
    const orderedNotes = within(panel()).getAllByRole("link").filter((link) => link.getAttribute("href")?.includes("?note="));
    expect(orderedNotes.map((link) => link.textContent)).toEqual([
      expect.stringContaining(TITLE), expect.stringContaining("Second retained note"), expect.stringContaining(TITLE),
    ]);
    expect(panel().textContent).toMatch(/user_note|User note/i);
    expect(within(panel()).getByText(/source snapshot only; individual records were not traced/i)).toBeVisible();
    expect(calls.other).toEqual([]);
    expect(within(panel()).queryByText(receipt(2).context_revision)).not.toBeInTheDocument();
    fireEvent.click(within(panel()).getByRole("button", { name: /Receipt evidence/i }));
    expect(within(panel()).getByText(receipt(2).context_revision)).toBeVisible();
    expect(within(panel()).getByText(receipt(2).prompt_sha256)).toBeVisible();
  });

  it("uses 20-row summary pages and server ordinals while fetching only explicitly selected details", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => receipt(25 - index));
    const { calls } = setup(rows); await openPrompt(); await loaded(receipt(25));
    expect(within(panel()).getAllByRole("option")).toHaveLength(20);
    expect(within(panel()).getByRole("button", { name: "Newer" })).toBeDisabled();
    fireEvent.click(within(panel()).getByRole("button", { name: "Older" }));
    await waitFor(() => expect(calls.lists).toEqual([{ limit: 20, offset: 0 }, { limit: 20, offset: 20 }]));
    await within(panel()).findByRole("option", { name: /Invocation 1\b/ });
    expect(calls.details).toEqual(["receipt-25"]);
    await choose(1); await loaded(receipt(1));
    expect(calls.details).toEqual(["receipt-25", "receipt-1"]);
    expect(within(panel()).getByRole("button", { name: "Older" })).toBeDisabled();
    expect(within(panel()).getAllByRole("option").length).toBeLessThanOrEqual(6);
  });

  it("evicts retained bodies on a cached detail 403 and never falls back to the legacy prompt", async () => {
    const { state, queryClient } = setup(); await openPrompt(); await loaded(receipt(2));
    await choose(1); await loaded(receipt(1));
    state.detailStatus.set("receipt-1", 403);
    await act(async () => {
      await queryClient.invalidateQueries({ predicate: (query) => {
        const data = query.state.data as Partial<Receipt> | undefined;
        return data?.id === "receipt-1";
      } });
    });
    await within(panel()).findByText(/access|authoriz/i);
    expect(screen.queryByTestId("execution-prompt-body")).not.toBeInTheDocument();
    expect(panel().textContent).not.toContain(LEGACY);
    for (const button of within(panel()).queryAllByRole("button", { name: /^Copy (prompt|system prompt)$/ })) expect(button).toBeDisabled();
    const cached = JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data));
    for (const row of [receipt(1), receipt(2)]) {
      expect(cached).not.toContain(JSON.stringify(row.input_prompt).slice(1, -1));
      expect(cached).not.toContain(JSON.stringify(row.system_prompt).slice(1, -1));
    }
  });

  it("keeps a 404 receipt selected, offers retry, and never substitutes another snapshot", async () => {
    const { state, calls } = setup(); await openPrompt(); await loaded(receipt(2));
    state.detailStatus.set("receipt-1", 404);
    await choose(1);
    await within(panel()).findByText(/invocation snapshot is unavailable/i);
    const select = within(panel()).getByRole("combobox", { name: "Invocation" }) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toMatch(/Invocation 1\b/);
    expect(screen.queryByTestId("execution-prompt-body")).not.toBeInTheDocument();
    expect(panel().textContent).not.toContain(LEGACY);
    state.detailStatus.delete("receipt-1");
    fireEvent.click(within(panel()).getByRole("button", { name: "Retry" }));
    await loaded(receipt(1));
    expect(calls.details.filter((id) => id === "receipt-1")).toHaveLength(2);
  });

  it("retains historical selection for its own events and ignores another execution's event", async () => {
    const { state, calls } = setup(); await openPrompt(); await loaded(receipt(2));
    await choose(1); await loaded(receipt(1));
    const previousLists = calls.lists.length;
    emit("other-execution", receipt(3)); await settleEvents();
    expect(calls.lists).toHaveLength(previousLists);
    state.rows.unshift(receipt(3));
    emit(EXECUTION_ID, receipt(3)); emit(EXECUTION_ID, receipt(3));
    await waitFor(() => expect(calls.lists).toHaveLength(previousLists + 1));
    await loaded(receipt(1));
    expect(calls.details).not.toContain("receipt-3");
    fireEvent.click(await within(panel()).findByRole("button", { name: "View latest" }));
    await loaded(receipt(3));
    expect(calls.details.filter((id) => id === "receipt-2")).toHaveLength(1);
  });

  it("does not add polling while disconnected and provides manual and focus revalidation", async () => {
    transport.status = "disconnected";
    const { calls } = setup(); await openPrompt(); await loaded(receipt(2));
    expect(within(panel()).getByText(/disconnected|live updates.*unavailable/i)).toBeVisible();
    const before = { lists: calls.lists.length, details: calls.details.length };
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    vi.useRealTimers();
    expect(calls.lists).toHaveLength(before.lists);
    expect(calls.details).toHaveLength(before.details);
    fireEvent.click(within(panel()).getByRole("button", { name: /Refresh/i }));
    await waitFor(() => expect(calls.lists.length).toBeGreaterThan(before.lists));
    const detailCount = calls.details.length;
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(calls.details.length).toBeGreaterThan(detailCount));
  });

  it("distinguishes an empty retained system prompt from an unavailable snapshot", async () => {
    const row = receipt(1);
    row.system_prompt = ""; row.system_prompt_bytes = 0; row.system_prompt_sha256 = sha("");
    setup([row]); await openPrompt(); await loaded(row);
    fireEvent.click(within(panel()).getByRole("button", { name: /^System prompt/ }));
    expect(within(panel()).getByText(/No system prompt retained/i)).toBeVisible();
    expect(within(panel()).queryByText(/snapshot is unavailable/i)).not.toBeInTheDocument();
  });

  it("does not report a failed summary request as no receipt recorded", async () => {
    const { state } = setup(); state.listStatus = 503;
    await openPrompt();
    await within(panel()).findByRole("button", { name: "Retry" });
    expect(within(panel()).queryByText(/Context receipt not recorded/i)).not.toBeInTheDocument();
    expect(panel().textContent).not.toContain(LEGACY);
    state.listStatus = 200;
    fireEvent.click(within(panel()).getByRole("button", { name: "Retry" }));
    await loaded(receipt(2));
  });

  it("labels zero-receipt legacy text without manufacturing an invocation", async () => {
    const { calls } = setup([], { legacy: LEGACY }); await openPrompt();
    expect(await within(panel()).findByText(/Context receipt not recorded/i)).toBeVisible();
    expect(within(panel()).getByText("Legacy prompt", { exact: true })).toBeVisible();
    expect(screen.getByTestId("execution-prompt-body").textContent).toBe(LEGACY);
    expect(within(panel()).queryByRole("combobox")).not.toBeInTheDocument();
    expect(calls.details).toEqual([]);
  });

  it("does not probe receipt routes on older servers with no additive count", async () => {
    const { calls } = setup([], { count: "missing", legacy: LEGACY }); await openPrompt();
    expect(screen.getByTestId("execution-prompt-body").textContent).toBe(LEGACY);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.click(screen.getByRole("tab", { name: "Prompt" }));
    expect(calls.lists).toEqual([]); expect(calls.details).toEqual([]);
    expect(within(panel()).queryByText("Prepared", { exact: true })).not.toBeInTheDocument();
  });

  it("preserves the existing exact legacy-copy path when receipt capability is absent", async () => {
    const legacy = "  legacy café 🧭\r\nkept spaces  \r\n";
    setup([], { count: "missing", legacy });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await openPrompt();
    expect(screen.getByTestId("execution-prompt-body").textContent).toBe(legacy);
    fireEvent.click(within(panel()).getByRole("button", { name: /^Copy(?: prompt)?$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(legacy));
  });

  it("states the absence of a retained prompt without guessing its age", async () => {
    setup([], { legacy: null }); await openPrompt();
    expect(await within(panel()).findByText(/No prompt was retained for this execution/i)).toBeVisible();
    expect(panel().textContent).not.toMatch(/predates|before prompt logging/i);
  });

  it("distinguishes an authorized binding from an invocation snapshot", async () => {
    setup([], { legacy: null, bound: true }); await openPrompt();
    expect(await within(panel()).findByText(/No invocation snapshot yet/i)).toBeVisible();
    expect(within(panel()).queryByText("Prepared", { exact: true })).not.toBeInTheDocument();
  });
});
