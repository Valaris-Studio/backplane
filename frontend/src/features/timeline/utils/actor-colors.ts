// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TimelineEvent } from "../types";

const ACTOR_ACCENTS = [
  "--color-data-6", "--color-data-5", "--color-data-7", "--color-data-2",
  "--color-data-3", "--color-data-4", "--color-data-1", "--color-data-8",
];

function actorAccentIndex(key: string): number {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return hash % ACTOR_ACCENTS.length;
}

export function actorAccent(key: string): string {
  return `var(${ACTOR_ACCENTS[actorAccentIndex(key)]})`;
}

export function buildActorAccents(keys: Iterable<string>): Record<string, string> {
  const used = new Set<number>();
  const accents = new Map<string, string>();
  for (const key of [...new Set(keys)].sort()) {
    let index = actorAccentIndex(key);
    while (used.size < ACTOR_ACCENTS.length && used.has(index)) {
      index = (index + 1) % ACTOR_ACCENTS.length;
    }
    used.add(index);
    accents.set(key, `var(${ACTOR_ACCENTS[index]})`);
  }
  return Object.fromEntries(accents);
}

export function eventActorKey(event: TimelineEvent): string {
  return event.agent_id ? `agent:${event.agent_id}` : `user:${event.actor_id}`;
}
