// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BoardBaseline,
  CardSnapshot,
  EntitySnapshot,
  ParticipantSnapshot,
  TimelineEvent,
} from "../types";

// Resolves WHICH runner role acted on a step. The role string is a user-defined
// config (ANY value), humanized by the UI — never enumerated, never mapped to a
// fixed icon/color set.
//
// CORRECTNESS over coverage: the runner uses ONE agent for ALL roles, so the
// agent_id alone can't tell us the acting role of an arbitrary event — a card's
// participant snapshot only holds whoever is attached NOW (typically the last
// role, e.g. reviewer). The ONLY per-event role signal is the runner's own
// summary, which stamps the acting role on the lifecycle actions that have one,
// e.g. "reserved card '…' for role implementer" / "… for role reviewer". So we
// show the chip ONLY when the summary names a role — that's exactly the moment
// the role matters — and stay silent (no misleading guess) otherwise. The
// board-wide agent index is used purely to enrich the chip's name/avatar.

export interface StepRole {
  role: string; // OPAQUE — verbatim
  name: string;
  avatarUrl: string | null;
}

export type AgentRoleIndex = Map<string, StepRole>;

function cardParticipants(state: EntitySnapshot | null): ParticipantSnapshot[] {
  if (state && typeof state === "object" && Array.isArray((state as CardSnapshot).participants)) {
    return (state as CardSnapshot).participants;
  }
  return [];
}

function indexParticipant(index: AgentRoleIndex, p: ParticipantSnapshot): void {
  if (p.agent_id && p.role) {
    index.set(p.agent_id, { role: p.role, name: p.name, avatarUrl: p.avatar_url });
  }
}

// agent_id -> role/name/avatar from every participant snapshot we can see: the
// baseline's current cards first (always present, even for legacy runs), then
// each event's before/after snapshots (later wins).
export function buildAgentRoleIndex(
  events: TimelineEvent[],
  baseline?: BoardBaseline | null,
): AgentRoleIndex {
  const index: AgentRoleIndex = new Map();
  for (const card of baseline?.cards ?? []) {
    for (const p of card.participants ?? []) indexParticipant(index, p);
  }
  for (const event of events) {
    for (const state of [event.before_state, event.after_state]) {
      for (const p of cardParticipants(state)) indexParticipant(index, p);
    }
  }
  return index;
}

// The runner stamps the acting role into the summary for the actions that have
// one, e.g. "reserved card '…' for role implementer" / "… for role reviewer".
// Capture the trailing role token after "for role ". Role is opaque — we take
// whatever word(s) follow, trimmed; never matched against a fixed set.
const SUMMARY_ROLE_RE = /\bfor role\s+([a-z0-9][a-z0-9 _-]*?)\s*$/i;

export function roleFromSummary(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const match = summary.match(SUMMARY_ROLE_RE);
  return match ? match[1]!.trim() : null;
}

// Resolve the acting runner role for a step. We show a role ONLY when the event
// summary explicitly names one (the sole trustworthy per-event signal); the
// board-wide index only enriches the chip's name/avatar. null for humans,
// non-card events, and events whose summary names no role.
export function resolveStepRole(
  event: { entity_type: string; agent_id: string | null; summary?: string | null },
  agentRoleIndex?: AgentRoleIndex,
): StepRole | null {
  if (event.entity_type !== "card" || !event.agent_id) return null;

  const summaryRole = roleFromSummary(event.summary);
  if (!summaryRole) return null;

  const indexed = agentRoleIndex?.get(event.agent_id);
  return {
    role: summaryRole,
    name: indexed?.name ?? "",
    avatarUrl: indexed?.avatarUrl ?? null,
  };
}

// WHO acted on this step — broader than resolveStepRole so the spotlighted card
// can always name its actor: an agent shows its indexed identity plus the role
// ONLY when the summary names one (same correctness-over-coverage rule — one
// agent serves all roles, so an indexed role is NOT the acting role and is
// never shown); a human shows their actor_name. null when there is nothing
// truthful to display.
export interface StepActor {
  name: string;
  avatarUrl: string | null;
  role: string | null; // OPAQUE — verbatim from the summary, never guessed
}

export function resolveStepActor(
  event: {
    agent_id: string | null;
    actor_name: string | null;
    summary?: string | null;
  },
  agentRoleIndex?: AgentRoleIndex,
): StepActor | null {
  if (event.agent_id) {
    const indexed = agentRoleIndex?.get(event.agent_id);
    const role = roleFromSummary(event.summary);
    if (!indexed && !role) return null;
    return {
      name: indexed?.name ?? "",
      avatarUrl: indexed?.avatarUrl ?? null,
      role,
    };
  }
  if (event.actor_name) {
    return { name: event.actor_name, avatarUrl: null, role: null };
  }
  return null;
}
