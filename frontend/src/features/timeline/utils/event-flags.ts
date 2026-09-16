// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { roleFromSummary, type AgentRoleIndex } from "./step-role";
import type { BoardBaseline, TimelineEvent } from "../types";

// Flags never filter the log: replay must consume the full contiguous prefix.

export interface FlagQuery {
  text: string;
  // "agent:<agent_id>" | "user:<actor_id>" | "role:<role lowercase>"
  actorKeys: ReadonlySet<string>;
  entityTypes?: ReadonlySet<string>;
  actions?: ReadonlySet<string>;
  cardId?: string;
}

export const EMPTY_FLAG_QUERY: FlagQuery = { text: "", actorKeys: new Set() };

export function isFlagQueryActive(query: FlagQuery): boolean {
  return query.text.trim().length > 0
    || query.actorKeys.size > 0
    || (query.entityTypes?.size ?? 0) > 0
    || (query.actions?.size ?? 0) > 0
    || (query.cardId?.trim().length ?? 0) > 0;
}

export interface ActorFacet {
  key: string;
  kind: "agent" | "user" | "role";
  label: string; // role labels are OPAQUE — verbatim from the summary
}

export interface CardFacet {
  id: string;
  title: string;
}

export interface EventFacet {
  value: string;
  count: number;
}

function primitiveText(value: unknown): string {
  const parts: string[] = [];
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "string" || typeof entry === "boolean") {
      parts.push(String(entry));
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      parts.push(String(entry));
    } else if (entry && typeof entry === "object" && !seen.has(entry)) {
      seen.add(entry);
      if (Array.isArray(entry)) {
        pending.push(...entry);
      } else {
        for (const [key, child] of Object.entries(entry)) {
          parts.push(key);
          pending.push(child);
        }
      }
    }
  }
  return parts.join(" ");
}

function snapshotText(state: TimelineEvent["after_state"]): string {
  if (!state || typeof state !== "object") return "";
  const fields = state as Record<string, unknown>;
  return ["title", "name", "labels", "status", "priority", "card_type"]
    .map((field) => primitiveText(fields[field]))
    .join(" ");
}

function changedIds(value: unknown): string[] {
  const ids: string[] = [];
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "string" && entry) {
      ids.push(entry);
    } else if (entry && typeof entry === "object" && !seen.has(entry)) {
      seen.add(entry);
      if (Array.isArray(entry)) pending.push(...entry);
      else {
        const pair = entry as Record<string, unknown>;
        pending.push(pair.old, pair.new);
      }
    }
  }
  return ids;
}

function eventCardIds(event: TimelineEvent): string[] {
  const ids = new Set<string>();
  if (event.entity_type === "card") {
    ids.add(event.entity_id);
    if (event.action.startsWith("dependency") || event.action === "dependencies_replaced") {
      for (const field of ["depends_on_card_id", "depends_on_card_ids", "depends_on", "blocks", "from", "to"]) {
        for (const id of changedIds(event.changes?.[field])) ids.add(id);
      }
    }
  } else if (event.entity_type === "note") {
    for (const state of [event.changes, event.before_state, event.after_state]) {
      const cardId = (state as Record<string, unknown> | null)?.card_id;
      for (const id of changedIds(cardId)) ids.add(id);
    }
  }
  return [...ids];
}

function eventHaystack(
  event: TimelineEvent,
  cardTitles: Record<string, string>,
  cardIds: string[],
): string {
  return [
    event.summary ?? "",
    event.entity_id,
    event.entity_title ?? "",
    ...cardIds.map((id) => `${id} ${cardTitles[id] ?? ""}`),
    snapshotText(event.after_state),
    snapshotText(event.before_state),
    primitiveText(event.changes),
    primitiveText(event.message_params),
  ]
    .join(" ")
    .toLowerCase();
}

function matchesActors(event: TimelineEvent, actorKeys: ReadonlySet<string>): boolean {
  if (event.agent_id) {
    if (actorKeys.has(`agent:${event.agent_id}`)) return true;
  } else if (actorKeys.has(`user:${event.actor_id}`)) {
    // Humans key on actor_id ONLY when no agent acted — an agent event's
    // actor_id is the agent's backing user, not a human choice.
    return true;
  }
  const role = roleFromSummary(event.summary);
  return role !== null && actorKeys.has(`role:${role.toLowerCase()}`);
}

export function computeFlaggedIndices(
  events: TimelineEvent[],
  query: FlagQuery,
  cardTitles: Record<string, string>,
): number[] {
  if (!isFlagQueryActive(query)) return [];
  const tokens = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const cardId = query.cardId?.trim();
  const flags: number[] = [];
  events.forEach((event, index) => {
    if (query.entityTypes?.size && !query.entityTypes.has(event.entity_type)) return;
    if (query.actions?.size && !query.actions.has(event.action)) return;
    if (query.actorKeys.size > 0 && !matchesActors(event, query.actorKeys)) return;
    const cardIds = eventCardIds(event);
    if (cardId && !cardIds.includes(cardId)) return;
    if (tokens.length > 0) {
      const haystack = eventHaystack(event, cardTitles, cardIds);
      if (!tokens.every((token) => haystack.includes(token))) return;
    }
    flags.push(index);
  });
  return flags;
}

export function buildCardFacets(
  events: TimelineEvent[],
  baseline?: BoardBaseline | null,
): CardFacet[] {
  const titles = new Map<string, string>();
  const remember = (id: string, title: unknown) => {
    if (typeof title === "string" && title.trim()) titles.set(id, title);
    else if (!titles.has(id)) titles.set(id, "");
  };
  for (const card of baseline?.cards ?? []) remember(card.id, card.title);
  for (const event of events) {
    const cardIds = eventCardIds(event);
    for (const id of cardIds) remember(id, null);
    if (event.entity_type !== "card") continue;
    remember(event.entity_id, event.message_params?.card_title);
    remember(event.entity_id, event.entity_title);
    for (const state of [event.before_state, event.after_state]) {
      remember(event.entity_id, (state as Record<string, unknown> | null)?.title);
    }
    const relatedId = event.message_params?.depends_on_card_id;
    if (typeof relatedId === "string" && cardIds.includes(relatedId)) {
      remember(relatedId, event.message_params?.depends_on_title);
    }
  }
  return [...titles].map(([id, title]) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function buildEventFacets(events: TimelineEvent[]): {
  entityTypes: EventFacet[];
  actions: EventFacet[];
} {
  const entityTypes = new Map<string, number>();
  const actions = new Map<string, number>();
  for (const event of events) {
    entityTypes.set(event.entity_type, (entityTypes.get(event.entity_type) ?? 0) + 1);
    actions.set(event.action, (actions.get(event.action) ?? 0) + 1);
  }
  const facets = (counts: Map<string, number>): EventFacet[] => [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
  return { entityTypes: facets(entityTypes), actions: facets(actions) };
}

// Distinct actors seen across the log, in stable display order: agents, then
// humans, then the runner roles summaries name — each group alphabetical.
export function buildActorFacets(
  events: TimelineEvent[],
  agentRoleIndex?: AgentRoleIndex,
): ActorFacet[] {
  const agents = new Map<string, string>();
  const users = new Map<string, string>();
  const roles = new Map<string, string>();
  for (const event of events) {
    if (event.agent_id) {
      if (!agents.has(event.agent_id)) {
        const name = agentRoleIndex?.get(event.agent_id)?.name;
        agents.set(event.agent_id, name || "Agent");
      }
    } else if (event.actor_name && !users.has(event.actor_id)) {
      users.set(event.actor_id, event.actor_name);
    }
    const role = roleFromSummary(event.summary);
    if (role) {
      const lower = role.toLowerCase();
      if (!roles.has(lower)) roles.set(lower, role);
    }
  }
  const byLabel = (a: ActorFacet, b: ActorFacet) => a.label.localeCompare(b.label);
  return [
    ...[...agents].map(([id, label]): ActorFacet => ({ key: `agent:${id}`, kind: "agent", label })).sort(byLabel),
    ...[...users].map(([id, label]): ActorFacet => ({ key: `user:${id}`, kind: "user", label })).sort(byLabel),
    ...[...roles].map(([lower, label]): ActorFacet => ({ key: `role:${lower}`, kind: "role", label })).sort(byLabel),
  ];
}

// Wrapping playhead navigation over the (ascending) flag indices.
export function nextFlag(flags: number[], current: number): number | null {
  if (flags.length === 0) return null;
  return flags.find((i) => i > current) ?? flags[0]!;
}

export function prevFlag(flags: number[], current: number): number | null {
  if (flags.length === 0) return null;
  for (let i = flags.length - 1; i >= 0; i -= 1) {
    if (flags[i]! < current) return flags[i]!;
  }
  return flags[flags.length - 1]!;
}
