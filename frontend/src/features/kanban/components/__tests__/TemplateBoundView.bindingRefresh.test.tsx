// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  act, createTestQueryClient, renderWithProviders, screen,
  stubReducedMotion, userEvent, waitFor,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { boardLoopKeys } from "@/lib/query-keys";
import { useBoardLoop, useBoardLoopSync, type BoardLoopConfig } from "../../api/use-board-loop";
import type { CompletionPolicy } from "@/types/completion";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { TemplateBoundView } from "../loop-template/TemplateBoundView";

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({ isAdmin: true, role: "admin", isLoading: false, isError: false }),
}));

const SLUG = "acme";
const BOARD = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";
const TEMPLATE = "48d0938d-a2a2-493e-a634-8db8fb81ee74";
const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD}/loop`;
const POLICY_URL = `/api/workspaces/${SLUG}/boards/${BOARD}/completion/policy`;
const APPLY = "Apply policy and refresh binding";
type Action = "slots" | "update";
type TemplateWrite = { source: "workspace"; ref: string; version: number; slot_values: Record<string, string> };
type LoopWrite = Partial<Omit<BoardLoopConfig, "template">> & { expected_version?: number; template?: TemplateWrite };

// The real parent passes the GET /loop result back into the bound view. Keeping
// that subscription here catches a new config version paired with stale slots.
function LiveBoundView() {
  const { data: config } = useBoardLoop(SLUG, BOARD, true);
  useBoardLoopSync(SLUG, BOARD, BOARD);
  if (!config?.template) return null;
  return <>
    <output data-testid="loaded-config-version">{config.version}</output>
    <TemplateBoundView slug={SLUG} boardUuid={BOARD} template={config.template}
      config={config} expectedVersion={config.version} onDetached={() => {}} onChangeTemplate={() => {}} />
  </>;
}

function fixture(refresh: "ready" | "pending" | "error" = "ready") {
  let slots = { DEFAULT_BRANCH: "release", INTEGRATION_BRANCH: "staging" };
  let policy: CompletionPolicy | null = null;
  let config: BoardLoopConfig = {
    enabled: false, provider: "operator-provider", model: "operator-exact-model",
    system_prompt: "Published system", loop_prompt: "Published loop", tools: [],
    max_iterations: 37, iteration_delay_seconds: 30, iteration_timeout_seconds: 3600,
    budget_usd: 20, max_consecutive_failures: 3, max_blocked_on_human: 3,
    starvation_policy: "park", loop_landing: "human", merge_gate: "none",
    completion_query: null, disabled_reason: null, version: 2,
    updated_at: "2026-09-13T00:00:00Z",
    template: { source: "workspace", ref: TEMPLATE, version: 1, drift: { kind: "template_newer", current_version: 2 } },
  };
  const puts: LoopWrite[] = [];
  let bindingReads = 0;
  let diffReads = 0;
  let refreshMode = refresh;
  const pending: Array<(response: Response) => void> = [];
  const resolution = (value = policy) => ({
    override: value, workspace_policy: null, effective_policy: value,
    origin: value ? "board" : "legacy", policy_hash: value ? "policy-hash" : null,
    capabilities: {}, incompatibilities: [],
  });
  const binding = () => ({
    template: config.template, slot_values: { ...slots },
    rendered_at: config.updated_at, rendered_hash: `binding-${config.version}`,
    drift: { kind: config.template!.version === 1 ? "template_newer" : "none",
      bound_version: config.template!.version, current_version: 2,
      new_required_slots: [], removed_slots: [], prompt_changed: config.template!.version === 1 },
    diff_available: config.template!.version === 1,
  });
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(config)),
    http.get(`${LOOP_URL}/binding`, () => {
      bindingReads++;
      if (puts.length && refreshMode === "pending") return new Promise<Response>((resolve) => pending.push(resolve));
      if (puts.length && refreshMode === "error") return HttpResponse.json({ detail: "Binding refresh unavailable" }, { status: 503 });
      return HttpResponse.json(binding());
    }),
    http.get(`${LOOP_URL}/binding/diff`, () => {
      diffReads++;
      return HttpResponse.json({ system_prompt: config.template!.version === 1 ? "@@ -1 +1 @@\n-old\n+new" : "", loop_prompt: "", slots_delta: { added: [], removed: [] } });
    }),
    http.get(`${LOOP_URL}/status`, () => HttpResponse.json({ state: "off", enabled: false })),
    http.get(`/api/workspaces/${SLUG}/loop-templates/${TEMPLATE}`, () => HttpResponse.json({
      id: TEMPLATE, slug: "operator-loop", name: "Operator loop", source: "workspace",
      version: 2, is_system: false, is_draft: false, profile: {}, content: {}, lineage: null,
    })),
    http.get(POLICY_URL, () => HttpResponse.json(resolution())),
    http.post(`${POLICY_URL}/preview`, async ({ request }) => {
      const body = await request.json() as { policy: CompletionPolicy | null; template?: TemplateWrite };
      return HttpResponse.json({ ...resolution(body.policy), template_preview: {
        system_prompt: `Published version ${body.template?.version}`,
        loop_prompt: `Branch ${body.template?.slot_values.DEFAULT_BRANCH}`,
        tools: [], findings: [],
      } });
    }),
    http.put(LOOP_URL, async ({ request }) => {
      const body = await request.json() as LoopWrite;
      puts.push(body);
      if (body.expected_version !== config.version) return HttpResponse.json({ detail: "Stale config" }, { status: 409 });
      const { template, completion_policy, ...fields } = body;
      delete fields.expected_version;
      if (template) {
        slots = { ...slots, ...template.slot_values };
        config = { ...config, template: { source: template.source, ref: template.ref, version: template.version,
          drift: { kind: template.version === 1 ? "template_newer" : "none", current_version: 2 } } };
      }
      if (completion_policy !== undefined) policy = completion_policy;
      config = { ...config, ...fields, version: config.version + 1 };
      return HttpResponse.json(config);
    }),
  );
  return {
    puts,
    get bindingReads() { return bindingReads; },
    get diffReads() { return diffReads; },
    get slots() { return slots; },
    recover() { refreshMode = "ready"; },
    resolveBinding() { refreshMode = "ready"; pending.splice(0).forEach((resolve) => resolve(HttpResponse.json(binding()))); },
    externalBinding(branch: string) {
      slots = { ...slots, DEFAULT_BRANCH: branch };
      config = { ...config, version: config.version + 1 };
    },
  };
}

function renderLive(withEvents = false) {
  const client = createTestQueryClient();
  renderWithProviders(withEvents ? <WebSocketProvider><LiveBoundView /></WebSocketProvider> : <LiveBoundView />, {
    queryClient: client, routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD}`] },
  });
  return client;
}

async function editPolicyAndRail() {
  await userEvent.click(await screen.findByRole("button", { name: "Agent-managed" }));
  fireEvent.change(screen.getByLabelText("Max iterations", { exact: true }), { target: { value: "41" } });
}

async function saveBinding(action: Action) {
  fireEvent.change(await screen.findByTestId("bound-slot-DEFAULT_BRANCH"), { target: { value: "release-v2" } });
  if (action === "update") await userEvent.click(screen.getByTestId("bound-drift-review"));
  const button = await screen.findByTestId(action === "slots" ? "bound-save-slots" : "bound-update");
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

// Stub only the network transport: production provider, subscription routing,
// board filters, debounce and React Query invalidation all run unchanged.
class EventSocket {
  static readonly OPEN = 1;
  static latest: EventSocket;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor() { EventSocket.latest = this; }
  send() {}
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ event: "board.loop_updated", timestamp: "2026-09-13T00:00:00Z", event_id: "update", payload }) } as MessageEvent);
  }
}

beforeEach(() => stubReducedMotion(true));
afterEach(() => { stubReducedMotion(false); vi.unstubAllGlobals(); });

describe("TemplateBoundView — authoritative binding after mutation", () => {
  it.each(["slots", "update"] as const)("keeps %s results in the next atomic policy/rail Apply", async (action) => {
    const state = fixture();
    renderLive();
    await saveBinding(action);
    await waitFor(() => expect(screen.getByTestId("loaded-config-version")).toHaveTextContent("3"));
    await editPolicyAndRail();
    await waitFor(() => expect(screen.getByRole("button", { name: APPLY })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: APPLY }));
    await waitFor(() => expect(state.puts).toHaveLength(2));
    expect(state.puts[1]).toMatchObject({
      expected_version: 3, max_iterations: 41, completion_policy: { landing_actor: "agent" },
      template: { source: "workspace", ref: TEMPLATE, version: action === "update" ? 2 : 1,
        slot_values: { DEFAULT_BRANCH: "release-v2", INTEGRATION_BRANCH: "staging" } },
    });
    expect(state.slots.DEFAULT_BRANCH).toBe("release-v2");
    expect(state.bindingReads).toBeGreaterThanOrEqual(2);
    if (action === "update") expect(state.diffReads).toBeGreaterThanOrEqual(2);
  });

  it.each(["slots", "update"] as const)("blocks Apply until the binding GET after %s settles", async (action) => {
    const state = fixture("pending");
    renderLive();
    try {
      await editPolicyAndRail();
      await saveBinding(action);
      await waitFor(() => expect(state.bindingReads).toBeGreaterThanOrEqual(2));
      await waitFor(() => expect(screen.getByTestId("loaded-config-version")).toHaveTextContent("3"));
      expect(screen.getByRole("button", { name: APPLY })).toBeDisabled();
      expect(screen.getByTestId("bound-slot-DEFAULT_BRANCH")).toHaveValue("release-v2");
      await userEvent.click(screen.getByRole("button", { name: APPLY }));
      expect(state.puts).toHaveLength(1);
      await act(async () => state.resolveBinding());
      await waitFor(() => expect(screen.getByRole("button", { name: APPLY })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: APPLY }));
      await waitFor(() => expect(state.puts).toHaveLength(2));
      expect(state.puts[1]).toMatchObject({ expected_version: 3, max_iterations: 41,
        template: { version: action === "update" ? 2 : 1, slot_values: { DEFAULT_BRANCH: "release-v2" } } });
    } finally { await act(async () => state.resolveBinding()); }
  });

  it("keeps Apply blocked and the saved slot visible when binding refresh fails, then reloads", async () => {
    const state = fixture("error");
    const client = renderLive();
    await editPolicyAndRail();
    await saveBinding("slots");
    await waitFor(() => expect(client.getQueryState(boardLoopKeys.binding(SLUG, BOARD))?.status).toBe("error"));
    expect(screen.getByRole("button", { name: APPLY })).toBeDisabled();
    expect(screen.getByTestId("bound-slot-DEFAULT_BRANCH")).toHaveValue("release-v2");
    await userEvent.click(screen.getByRole("button", { name: APPLY }));
    expect(state.puts).toHaveLength(1);
    state.recover();
    await userEvent.click(await screen.findByRole("button", { name: "Retry loading" }));
    await waitFor(() => expect(screen.getByRole("button", { name: APPLY })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: APPLY }));
    await waitFor(() => expect(state.puts).toHaveLength(2));
    expect(state.puts[1]).toMatchObject({ expected_version: 3,
      template: { version: 1, slot_values: { DEFAULT_BRANCH: "release-v2" } } });
  });

  it("refreshes binding and open diff only for this board's loop event before the next Apply", async () => {
    vi.stubGlobal("WebSocket", EventSocket);
    const state = fixture();
    renderLive(true);
    await screen.findByTestId("bound-slot-DEFAULT_BRANCH");
    await userEvent.click(screen.getByTestId("bound-drift-review"));
    await waitFor(() => expect(state.diffReads).toBe(1));
    await act(async () => {
      EventSocket.latest.emit({ board_id: "another-board" });
      EventSocket.latest.emit({ board_id: null });
      EventSocket.latest.emit({ entity_id: BOARD });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(state.bindingReads).toBe(1);
    expect(state.diffReads).toBe(1);

    state.externalBinding("teammate-branch");
    await act(async () => {
      EventSocket.latest.emit({ board_id: BOARD, entity_id: BOARD });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await waitFor(() => expect(screen.getByTestId("loaded-config-version")).toHaveTextContent("3"));
    await waitFor(() => expect(state.bindingReads).toBeGreaterThanOrEqual(2));
    expect(state.diffReads).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("bound-slot-DEFAULT_BRANCH")).toHaveValue("teammate-branch");
    await editPolicyAndRail();
    await waitFor(() => expect(screen.getByRole("button", { name: APPLY })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: APPLY }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(state.puts[0]).toMatchObject({ expected_version: 3, max_iterations: 41,
      template: { version: 1, slot_values: { DEFAULT_BRANCH: "teammate-branch" } } });
  });
});
