// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { buildTimeline } from "../timeline";
import { makeCall, makeSession, minutesAgo } from "../../__tests__/fixtures";

const prompt = (key: string, turn_index: number, minutes: number) =>
  makeCall({ key, kind: "prompt", turn_index, started_at: minutesAgo(minutes), ended_at: minutesAgo(minutes), outcome: null });

describe("buildTimeline idle stretches", () => {
  it("marks a silence longer than five minutes inside a turn", () => {
    const [turn] = buildTimeline(
      [
        prompt("p", 1, 60),
        makeCall({ key: "a", started_at: minutesAgo(59), ended_at: minutesAgo(59) }),
        makeCall({ key: "b", started_at: minutesAgo(40), ended_at: minutesAgo(40) }),
      ],
      [],
    );
    expect(turn?.entries.map((entry) => entry.type)).toEqual(["call", "idle", "call"]);
  });

  it("does not call the wait on a subagent or a long call idle", () => {
    const turns = buildTimeline(
      [
        prompt("p", 1, 70),
        makeCall({ key: "task", name: "Task", started_at: minutesAgo(69), ended_at: minutesAgo(69), duration_ms: 8 * 60_000 }),
        makeCall({
          key: "sub",
          kind: "subagent",
          outcome: null,
          started_at: minutesAgo(68),
          ended_at: minutesAgo(68),
          subagent: makeSession({ id: "child", started_at: minutesAgo(68), last_event_at: minutesAgo(61) }),
        }),
        makeCall({ key: "after", started_at: minutesAgo(60), ended_at: minutesAgo(60) }),
      ],
      [],
    );
    expect(turns[0]?.entries.some((entry) => entry.type === "idle")).toBe(false);
  });

  it("closes the previous turn with the silence before the next prompt", () => {
    const turns = buildTimeline(
      [
        prompt("p1", 1, 60),
        makeCall({ key: "a", turn_index: 1, started_at: minutesAgo(59), ended_at: minutesAgo(59) }),
        prompt("p2", 2, 30),
      ],
      [],
    );
    expect(turns[0]?.entries.at(-1)?.type).toBe("idle");
    expect(turns[1]?.entries).toEqual([]);
  });
});
