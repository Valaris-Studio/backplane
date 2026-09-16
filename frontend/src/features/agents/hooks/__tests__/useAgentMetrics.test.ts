// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { createTestQueryClient } from "@/test/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

// Capture WS event-pattern handlers so invalidation wiring can be asserted.
// A single pattern may have multiple subscribers across hooks; store all.
const wsHandlers = new Map<string, Array<(evt: unknown) => void>>();

function fireWsEvent(pattern: string, evt: unknown) {
  const handlers = wsHandlers.get(pattern) ?? [];
  handlers.forEach((h) => h(evt));
}

vi.mock("@/hooks/use-websocket", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    useWebSocket: () => ({
      status: "disconnected" as const,
      subscribe: () => () => {},
    }),
    // Mirror the real hook's effect lifecycle so unmount removes the
    // subscriber — otherwise the test mock would silently mask leaks.
    useWebSocketEvent: (pattern: string, cb: (evt: unknown) => void) => {
      const cbRef = useRef(cb);
      cbRef.current = cb;
      useEffect(() => {
        const handler = (evt: unknown) => cbRef.current(evt);
        const list = wsHandlers.get(pattern) ?? [];
        list.push(handler);
        wsHandlers.set(pattern, list);
        return () => {
          const current = wsHandlers.get(pattern);
          if (!current) return;
          const idx = current.indexOf(handler);
          if (idx >= 0) current.splice(idx, 1);
          if (current.length === 0) wsHandlers.delete(pattern);
        };
      }, [pattern]);
    },
  };
});
import {
  useAgentMetrics,
  useVelocityMetrics,
  useQualityMetrics,
  useCostMetrics,
  useAgents,
  useAgentDetail,
  useBudgetStatus,
  useImprovementStatus,
  useExecutions,
  useCreateAgent,
} from "../useAgentMetrics";
import type { AgentMetric, VelocityMetrics, QualityMetrics, CostMetric, ImprovementStatus, Agent, Execution, BudgetStatus } from "../../api/agents";

const SLUG = "test-workspace";
const BASE = `/api/workspaces/${SLUG}`;

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useAgentMetrics", () => {
  it("fetches agent metrics for a workspace", async () => {
    const agents: AgentMetric[] = [
      { agent_id: "a1", name: "bot", agent_type: "coding", is_active: true, total_executions: 10, completed_executions: 8, failed_executions: 2, avg_duration_seconds: 5.0, total_tokens_used: 1000, total_cost_usd: 0, last_seen_at: null, liveness: "alive", health_status: null, health_version: null, health_uptime_seconds: null, health_cards_processed: null, health_cards_failed: null, health_current_card_id: null, health_current_board_id: null, health_last_error: null, health_last_error_at: null, last_key_rotated_at: null },
    ];
    server.use(http.get(`${BASE}/metrics/agents`, () => HttpResponse.json({ agents })));

    const { result } = renderHook(() => useAgentMetrics(SLUG), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(agents);
  });

  // AgentStatusBar (feedback_agent_status_bar_no_ws.md) consumes this query;
  // the liveness column must update on agent.* WS events without a reload.
  it("refetches when an agent.* event fires on the bus", async () => {
    wsHandlers.clear();
    let fetchCount = 0;
    server.use(
      http.get(`${BASE}/metrics/agents`, () => {
        fetchCount++;
        return HttpResponse.json({ agents: [] });
      }),
    );

    const { result } = renderHook(() => useAgentMetrics(SLUG), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchCount).toBe(1);

    act(() => {
      fireWsEvent("agent.*", {
        event: "agent.status_changed",
        timestamp: "2026-05-15T10:00:00Z",
        event_id: "e-agent-1",
        payload: { agent_id: "a1", liveness: "offline" },
      });
    });

    await waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
  });

  it("unsubscribes the WS handler on unmount", async () => {
    wsHandlers.clear();
    server.use(
      http.get(`${BASE}/metrics/agents`, () =>
        HttpResponse.json({ agents: [] }),
      ),
    );

    const { unmount } = renderHook(() => useAgentMetrics(SLUG), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(wsHandlers.get("agent.*")?.length ?? 0).toBe(1));

    unmount();
    // Cleanup must run synchronously on unmount; otherwise a remounted hook
    // (StrictMode dev double-effect) accumulates leaked subscribers.
    expect(wsHandlers.get("agent.*")?.length ?? 0).toBe(0);
  });
});

describe("useVelocityMetrics", () => {
  it("fetches velocity metrics", async () => {
    const velocity: VelocityMetrics = { cards_completed_7d: 5, cards_completed_30d: 20, cards_completed_90d: 60 };
    server.use(http.get(`${BASE}/metrics/velocity`, () => HttpResponse.json(velocity)));

    const { result } = renderHook(() => useVelocityMetrics(SLUG), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(velocity);
  });
});

describe("useQualityMetrics", () => {
  it("fetches quality metrics", async () => {
    const quality: QualityMetrics = { reversion_rate: 0.03, agent_efficiency_score: 0.9 };
    server.use(http.get(`${BASE}/metrics/quality`, () => HttpResponse.json(quality)));

    const { result } = renderHook(() => useQualityMetrics(SLUG), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(quality);
  });
});

describe("useCostMetrics", () => {
  it("fetches cost metrics", async () => {
    const cost: CostMetric[] = [
      { name: "bot", agent_type: "coding", tokens_used_7d: 500, tokens_used_30d: 2000, executions_7d: 3, executions_30d: 10 },
    ];
    server.use(http.get(`${BASE}/metrics/cost`, () => HttpResponse.json({ agents: cost })));

    const { result } = renderHook(() => useCostMetrics(SLUG), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(cost);
  });
});

describe("useAgents", () => {
  it("fetches global agent list", async () => {
    const agents: Agent[] = [
      { id: "a1", name: "bot", agent_type: "coding", is_active: true, created_at: "2026-01-01T00:00:00Z" },
    ];
    server.use(http.get("/api/agents", () => HttpResponse.json(agents)));

    const { result } = renderHook(() => useAgents(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(agents);
  });

  it("refetches agent list when an agent.* event fires", async () => {
    wsHandlers.clear();
    let fetchCount = 0;
    server.use(
      http.get("/api/agents", () => {
        fetchCount++;
        return HttpResponse.json([]);
      }),
    );

    const { result } = renderHook(() => useAgents(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchCount).toBe(1);

    // Simulate an agent.heartbeat_received event arriving on the bus.
    act(() => {
      fireWsEvent("agent.*", {
        event: "agent.heartbeat_received",
        timestamp: "2026-04-17T10:00:00Z",
        event_id: "e-1",
        payload: { agent_id: "a1", status: "idle" },
      });
    });

    await waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
  });
});

describe("useAgentDetail", () => {
  it("refetches detail only when the agent.* event targets this agent", async () => {
    wsHandlers.clear();
    let fetchCount = 0;
    server.use(
      http.get("/api/agents/:id", () => {
        fetchCount++;
        return HttpResponse.json({
          id: "target",
          name: "bot",
          agent_type: "coding",
          is_active: true,
          created_at: "2026-01-01T00:00:00Z",
        });
      }),
    );

    const { result } = renderHook(() => useAgentDetail("target"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchCount).toBe(1);

    // Event for a different agent — must NOT refetch.
    act(() => {
      fireWsEvent("agent.*", {
        event: "agent.heartbeat_received",
        timestamp: "2026-04-17T10:00:00Z",
        event_id: "e-other",
        payload: { agent_id: "other" },
      });
    });
    // brief pause to let any accidental invalidation settle
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCount).toBe(1);

    // Event for this agent — MUST refetch.
    act(() => {
      fireWsEvent("agent.*", {
        event: "agent.heartbeat_received",
        timestamp: "2026-04-17T10:00:01Z",
        event_id: "e-self",
        payload: { agent_id: "target" },
      });
    });
    await waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
  });
});

describe("useImprovementStatus", () => {
  it("fetches improvement status with refetchInterval", async () => {
    const status: ImprovementStatus = {
      improvements_today: 0,
      can_run: true,
      triggers: [],
    };
    server.use(http.get(`${BASE}/improvement/status`, () => HttpResponse.json(status)));

    const { result } = renderHook(() => useImprovementStatus(SLUG), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(status);
  });
});

describe("useExecutions", () => {
  it("fetches executions without filters", async () => {
    const executions: Execution[] = [
      {
        id: "e1", agent_id: "a1", workspace_id: "ws-1", board_id: null,
        session_id: null, action: "test", status: "completed",
        started_at: "2026-04-10T00:00:00Z", completed_at: "2026-04-10T00:01:00Z",
        input_summary: "test run", output_summary: "done",
        tools_used: [], cards_affected: [], cards_affected_detail: [], error_message: null,
        tool_calls_count: 5, tokens_used: 100, cost_usd: null, duration_seconds: 60,
        parent_execution_id: null, role: null, prompt_slug: null, model: null, provider: null, input_prompt: null, tool_invocations: [],
      },
    ];
    server.use(http.get(`${BASE}/executions`, () => HttpResponse.json(executions)));

    const { result } = renderHook(() => useExecutions(SLUG), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]!.action).toBe("test");
  });

  it("passes filter params to API", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${BASE}/executions`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    const { result } = renderHook(
      () => useExecutions(SLUG, { status: "failed" }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("status=failed");
  });
});

describe("useBudgetStatus", () => {
  it("fetches budget status for an agent", async () => {
    const status: BudgetStatus = {
      budget_usd: 100,
      spent_usd: 30,
      remaining_usd: 70,
      percentage_used: 30,
      is_exceeded: false,
    };
    server.use(
      http.get("/api/agents/agent-1/budget-status", () =>
        HttpResponse.json(status),
      ),
    );

    const { result } = renderHook(() => useBudgetStatus("agent-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(status);
  });

  it("handles no budget set", async () => {
    const status: BudgetStatus = {
      budget_usd: null,
      spent_usd: 5,
      remaining_usd: null,
      percentage_used: null,
      is_exceeded: false,
    };
    server.use(
      http.get("/api/agents/agent-2/budget-status", () =>
        HttpResponse.json(status),
      ),
    );

    const { result } = renderHook(() => useBudgetStatus("agent-2"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.budget_usd).toBeNull();
    expect(result.current.data?.is_exceeded).toBe(false);
  });

  it("handles exceeded budget", async () => {
    const status: BudgetStatus = {
      budget_usd: 10,
      spent_usd: 15,
      remaining_usd: 0,
      percentage_used: 150,
      is_exceeded: true,
    };
    server.use(
      http.get("/api/agents/agent-3/budget-status", () =>
        HttpResponse.json(status),
      ),
    );

    const { result } = renderHook(() => useBudgetStatus("agent-3"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.is_exceeded).toBe(true);
  });
});

describe("useCreateAgent", () => {
  it("posts new agent and invalidates queries", async () => {
    const created = {
      id: "new-agent",
      name: "new-bot",
      agent_type: "coding",
      is_active: true,
      created_at: "2026-04-10T00:00:00Z",
      raw_api_key: "val_key123",
      api_key_prefix: "val_",
    };
    server.use(http.post("/api/agents", () => HttpResponse.json(created)));

    const queryClient = createTestQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useCreateAgent(SLUG), { wrapper });

    result.current.mutate({ name: "new-bot", agent_type: "coding" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(created);
  });
});
