// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { expect } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useExecution } from "@/features/agents/hooks/useAgentMetrics";
import { useReceiptHistoryState } from "@/features/agents/hooks/useExecutionContextReceipts";
import type { ContextReceipt, Execution } from "@/features/agents/api/agents";
import { ExecutionPromptPanel } from "@/features/agents/components/ExecutionPromptPanel";
import { useWebSocket } from "@/hooks/use-websocket";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import { createTestQueryClient, renderWithProviders } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";

export const SLUG = "receipt-live-reader";
export const EXECUTION_ID = "execution-live-reader";
export const RECEIPT_EVENT = "execution.context_receipt_created";
export const BASE = `/api/workspaces/${SLUG}/executions/${EXECUTION_ID}`;

export class ReceiptWireSocket {
  static instances: ReceiptWireSocket[] = [];
  static observer = false;
  static readonly OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  sent: { subscribe: string[] }[] = [];
  accepted: string[] = [];

  constructor(public url: string) { ReceiptWireSocket.instances.push(this); }

  send(data: string) {
    const frame = JSON.parse(data) as { subscribe: string[] };
    this.sent.push(frame);
    // This double enforces only the accepted receipt/observer policy seam;
    // production WebSocketService still creates, sends and routes every frame.
    this.accepted = frame.subscribe.filter((pattern) =>
      pattern === RECEIPT_EVENT || ReceiptWireSocket.observer);
    const denied = frame.subscribe.filter((pattern) => !this.accepted.includes(pattern));
    if (denied.length) queueMicrotask(() => this.deny(denied));
  }

  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  open() { this.readyState = 1; this.onopen?.(); }

  control(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  deny(patterns: string[]) {
    this.accepted = this.accepted.filter((pattern) => !patterns.includes(pattern));
    this.control({ type: "subscription_denied", patterns, error_code: "admin_required" });
  }

  publish(ordinal: number, executionId = EXECUTION_ID) {
    const frame: WebSocketEvent = {
      event: RECEIPT_EVENT, event_id: `event-${executionId}-${ordinal}`,
      timestamp: "2026-10-13T12:00:00Z",
      payload: { workspace_id: "workspace-live-reader", execution_id: executionId,
        receipt_id: `receipt-${ordinal}`, ordinal },
    };
    if (this.readyState !== 1) return false;
    const matches = this.accepted.some((pattern) => pattern === frame.event || pattern === "*" ||
      (pattern.endsWith(".*") && frame.event.startsWith(pattern.slice(0, -1))));
    if (matches) this.control(frame);
    return matches;
  }
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export function receipt(ordinal: number): ContextReceipt {
  const input = `Private historical invocation ${ordinal} — café 🧭\r\n`;
  const system = `Private system ${ordinal}`;
  return {
    id: `receipt-${ordinal}`, execution_id: EXECUTION_ID, ordinal,
    client_request_id: `request-${ordinal}`, context_revision: sha(`context-${ordinal}`),
    prompt_sha256: sha(input), prompt_bytes: Buffer.byteLength(input),
    system_prompt_sha256: sha(system), system_prompt_bytes: Buffer.byteLength(system),
    provider: "operator-provider", model: "operator-model", status: "prepared",
    use_verification: "not_verified", created_at: `2026-10-13T12:00:0${ordinal}Z`,
    context_manifest: { schema_version: 1, renderer_version: "context-v1", sources: [] },
    input_prompt: input, system_prompt: system,
  };
}

const EXECUTION: Execution = {
  id: EXECUTION_ID, workspace_id: "workspace-live-reader", agent_id: "agent-live-reader",
  board_id: "board-live-reader", session_id: null, action: "custom-stage", status: "completed",
  started_at: "2026-10-13T10:00:00Z", completed_at: "2026-10-13T10:01:00Z",
  input_summary: "Synthetic receipt event", output_summary: null, tools_used: [],
  cards_affected: [], cards_affected_detail: [], error_message: null, tool_calls_count: 0,
  tokens_used: 0, cost_usd: 0, duration_seconds: 60, parent_execution_id: null,
  role: "custom-stage", prompt_slug: "custom-stage", provider: "operator-provider",
  model: "operator-model", input_prompt: "Legacy unrelated prompt", tool_invocations: [],
};

function PromptReader() {
  const execution = useExecution(SLUG, EXECUTION_ID);
  const history = useReceiptHistoryState(`${SLUG}/${EXECUTION_ID}`);
  const { status } = useWebSocket();
  return <>
    <output data-testid="socket-status">{status}</output>
    {execution.data && <ExecutionPromptPanel slug={SLUG} execution={execution.data} history={history} />}
  </>;
}

export function renderReceiptReader() {
  const calls = { executions: 0, lists: 0, details: [] as string[] };
  const state = { rows: [receipt(2), receipt(1)], detailStatus: 200, listStatus: 200 };
  server.use(
    http.get(BASE, () => {
      calls.executions++;
      return HttpResponse.json({ ...EXECUTION, context_receipt_count: state.rows.length });
    }),
    http.get(`${BASE}/context-receipts`, ({ request }) => {
      calls.lists++;
      if (state.listStatus !== 200) return HttpResponse.json({ detail: "Denied" }, { status: state.listStatus });
      const params = new URL(request.url).searchParams;
      const offset = Number(params.get("offset"));
      const limit = Number(params.get("limit"));
      const summaries = state.rows.slice(offset, offset + limit).map((row) => {
        const summary: Partial<ContextReceipt> = { ...row };
        delete summary.input_prompt;
        delete summary.system_prompt;
        delete summary.context_manifest;
        return summary;
      });
      return HttpResponse.json(summaries, { headers: { "X-Total-Count": String(state.rows.length) } });
    }),
    http.get(`${BASE}/context-receipts/:receiptId`, ({ params }) => {
      calls.details.push(String(params.receiptId));
      if (state.detailStatus !== 200) return HttpResponse.json({ detail: "Denied" }, { status: state.detailStatus });
      return HttpResponse.json(state.rows.find((row) => row.id === params.receiptId));
    }),
  );
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 60_000, refetchOnWindowFocus: false } });
  const view = renderWithProviders(<WebSocketProvider><PromptReader /></WebSocketProvider>, {
    queryClient, routerProps: { initialEntries: [`/${SLUG}/agents/executions/${EXECUTION_ID}`] },
  });
  return { calls, state, queryClient, ...view };
}

export async function openSocket() {
  await waitFor(() => expect(ReceiptWireSocket.instances.length).toBeGreaterThan(0));
  const socket = ReceiptWireSocket.instances.at(-1)!;
  await act(async () => socket.open());
  return socket;
}

export async function loaded(ordinal: number) {
  await waitFor(() => expect(screen.getByTestId("execution-prompt-body").textContent)
    .toBe(receipt(ordinal).input_prompt));
}

export async function chooseEarlier() {
  const selector = screen.getByRole("combobox", { name: "Invocation" });
  const option = within(selector).getByRole("option", { name: /Invocation 1\b/ });
  fireEvent.change(selector, { target: { value: (option as HTMLOptionElement).value } });
  await loaded(1);
}

export async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
}
