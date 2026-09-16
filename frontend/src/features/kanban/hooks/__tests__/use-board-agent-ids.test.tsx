// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBoardAgentIds } from "../use-board-agent-ids";

// Card db510916 symptom 1 — "0 active runners" while a runner is live.
//
// This hook is the SOLE input to both board-presence surfaces (BoardLayout's
// header chip and BoardView's AgentStatusBar), so whatever it says while the
// in-flight query is still loading is what both surfaces render. Coalescing an
// absent result to [] made "still loading" indistinguishable from "nobody is
// working" — the chip hid and the bar unmounted on every board mount. Absent
// data must stay absent (undefined) so callers can tell the two apart.

vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useInFlightExecutions: vi.fn(),
}));

import { useInFlightExecutions } from "@/features/agents/hooks/useAgentMetrics";

function mockInFlight(data: unknown) {
  (useInFlightExecutions as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    { data },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useBoardAgentIds — loading is not emptiness (card db510916)", () => {
  it("returns undefined while the in-flight query has no data yet", () => {
    mockInFlight(undefined);

    const { result } = renderHook(() => useBoardAgentIds("acme", "b1"));

    expect(result.current).toBeUndefined();
  });

  it("returns an empty array once the query resolves with nothing in flight", () => {
    mockInFlight([]);

    const { result } = renderHook(() => useBoardAgentIds("acme", "b1"));

    expect(result.current).toEqual([]);
  });

  it("returns the distinct agent ids attributed to THIS board", () => {
    mockInFlight([
      { agent_id: "a1", board_id: "b1" },
      { agent_id: "a1", board_id: "b1" },
      { agent_id: "a2", board_id: "b1" },
      { agent_id: "a3", board_id: "b2" },
      { agent_id: "a4", board_id: null },
    ]);

    const { result } = renderHook(() => useBoardAgentIds("acme", "b1"));

    expect(result.current).toEqual(["a1", "a2"]);
  });
});
