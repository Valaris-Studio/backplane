// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { actorAccent, buildActorAccents, eventActorKey } from "../actor-colors";
import type { TimelineEvent } from "../../types";

describe("observed actor accents", () => {
  it("disambiguates actors whose fallback hashes collide", () => {
    expect(actorAccent("user:u1")).toBe(actorAccent("user:u9"));
    const accents = buildActorAccents(["user:u1", "user:u9"]);
    expect(accents["user:u1"]).not.toBe(accents["user:u9"]);
    expect(accents["user:u1"]).toBe(actorAccent("user:u1"));
  });

  it("gives up to eight observed identities distinct colors even when every hash collides", () => {
    const keys = Array.from({ length: 8 }, (_, index) => `user:${String.fromCharCode(65 + index * 8)}`);
    expect(new Set(keys.map(actorAccent)).size).toBe(1);
    expect(new Set(Object.values(buildActorAccents(keys))).size).toBe(8);
  });

  it("is stable for reordered, repeated keys and accepts iterable inputs", () => {
    const keys = ["user:u9", "agent:a1", "user:u1", "agent:a9"];
    const expected = buildActorAccents(keys);
    expect(buildActorAccents(new Set([...keys].reverse()))).toEqual(expected);
    expect(buildActorAccents([...keys, ...keys])).toEqual(expected);
  });

  it("keeps every identity when the palette is exhausted", () => {
    const keys = Array.from({ length: 12 }, (_, index) => `user:${index}`);
    const accents = buildActorAccents(keys);
    expect(Object.keys(accents).sort()).toEqual([...keys].sort());
    expect(new Set(Object.values(accents)).size).toBe(8);
    expect(Object.values(accents).every((accent) => /^var\(--color-data-[1-8]\)$/.test(accent))).toBe(true);
    expect(buildActorAccents([])).toEqual({});
  });

  it("keys agent actions separately from their backing human", () => {
    expect(eventActorKey({ agent_id: "ag1", actor_id: "u1" } as TimelineEvent)).toBe("agent:ag1");
    expect(eventActorKey({ agent_id: null, actor_id: "u1" } as TimelineEvent)).toBe("user:u1");
  });
});
