// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
// `agentKeys.boardLoopIterations` doesn't exist yet — this import is the RED.
// Card ea43b848's locked design: BoardLoopDialog's iterations query moves from
// the workspace-wide `agentKeys.executions(slug)` (filtered client-side) to a
// BOARD-SCOPED key so React Query caches/invalidates per board, matching the
// `boardLoopKeys.detail` precedent of NOT living under a shared prefix that
// would churn on unrelated invalidations.
import { agentKeys } from "../query-keys";

describe("agentKeys.boardLoopIterations — board-scoped query key", () => {
  it("scopes by slug, board id, AND action so it never collides with the workspace-wide executions cache", () => {
    const key = agentKeys.boardLoopIterations("acme", "board-1");
    expect(key).toContain("acme");
    expect(key).toContain("board-1");
    // Must encode that this is the loop-iteration-scoped slice, not a bare
    // executions list — otherwise it silently aliases agentKeys.executions
    // and the two caches fight over the same key.
    expect(key.join(":")).toMatch(/loop/i);
  });

  it("is referentially stable for the same slug + board id", () => {
    expect(agentKeys.boardLoopIterations("acme", "board-1")).toEqual(
      agentKeys.boardLoopIterations("acme", "board-1"),
    );
  });

  it("produces a DIFFERENT key per board id, so two boards' loop dialogs never share a cache entry", () => {
    const a = agentKeys.boardLoopIterations("acme", "board-1");
    const b = agentKeys.boardLoopIterations("acme", "board-2");
    expect(a).not.toEqual(b);
  });

  it("is distinct from the workspace-wide executions key (no accidental aliasing)", () => {
    const boardScoped = agentKeys.boardLoopIterations("acme", "board-1");
    const workspaceWide = agentKeys.executions("acme");
    expect(boardScoped).not.toEqual(workspaceWide);
  });
});
