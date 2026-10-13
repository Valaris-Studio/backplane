// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { AgentEntry, AgentId, AgentStatus } from "../../ipc/bindings";
import { codexRestart } from "../shared/codex-restart";

export const KNOWN_AGENT_IDS = ["claude_code", "codex_cli", "pi_cli"] as const satisfies readonly AgentId[];

export type AgentRowKind =
  | "capturing"
  | "idle"
  | "disabled"
  | "not_installed"
  | "broken"
  | "otel_conflict"
  | "hooks_disabled"
  | "foreign_extension"
  | "needs_trust"
  | "invalid_config"
  | "restart_required"
  | "daemon_restart_required"
  | "unknown";

export const TOGGLEABLE_KINDS: ReadonlySet<AgentRowKind> = new Set(["capturing", "idle", "disabled", "restart_required", "daemon_restart_required"]);

const CAPTURING_STATES = new Set(["receiving", "uploading"]);
// Connection and pause states are shown by the status header, not per agent.
const QUIET_STATES = new Set(["idle", "paused", "not_connected", "revoked"]);
const OTEL_CONFLICT = "conflict_existing_otel";

/**
 * The daemon's broken-integration problems Repair (agent_install) cannot fix,
 * because the agent's own file is at fault (DK-12p). Everything else — a hook
 * or telemetry block missing or stale, the Companion binary gone — Repair
 * rewrites. Codes: companion/internal/agent/problems.go.
 */
const UNREADABLE_FILE_PROBLEMS: ReadonlySet<string> = new Set(["settings_invalid", "hooks_invalid", "config_invalid", "config_unreadable", "extension_unreadable"]);
const HOOKS_DISABLED_IN_CODEX = "hook_disabled_in_codex";
const FOREIGN_EXTENSION = "extension_not_owned";
// "<hook event>:invalid": that event's hooks aren't a list, so no edit is safe.
const HOOK_ENTRY_INVALID = /^[A-Za-z]+:invalid$/;

export function isUnreadableFileProblem(problem: string): boolean {
  return UNREADABLE_FILE_PROBLEMS.has(problem) || HOOK_ENTRY_INVALID.test(problem);
}

// What Repair rewrites: a hook, telemetry block or extension missing or stale, or a moved Companion.
const REPAIRABLE_PROBLEM = /^(?:[A-Za-z]+:(?:missing|stale)|companion_executable_missing)$/;
// Codex restarts ride along with a broken state; they don't stop a repair.
const RESTART_PROBLEMS: ReadonlySet<string> = new Set(["restart_required", "daemon_restart_required"]);

/** The first problem decides, in order of what the user has to do before Repair could help. */
function brokenKind(problems: readonly string[]): AgentRowKind {
  if (problems.some(isUnreadableFileProblem)) return "invalid_config";
  if (problems.includes(OTEL_CONFLICT)) return "otel_conflict";
  if (problems.includes(FOREIGN_EXTENSION)) return "foreign_extension";
  if (problems.includes(HOOKS_DISABLED_IN_CODEX)) return "hooks_disabled";
  // A code this build doesn't know may be one Repair can't fix: never offer it then.
  if (problems.some((problem) => !REPAIRABLE_PROBLEM.test(problem) && !RESTART_PROBLEMS.has(problem))) return "unknown";
  return "broken";
}
// The id lands in the DOM as a name; anything but a plain identifier is skipped.
const PLAIN_AGENT_ID = /^[a-z][a-z0-9_-]{0,39}$/;

export function isKnownAgentId(id: string): id is AgentId {
  return (KNOWN_AGENT_IDS as readonly string[]).includes(id);
}

/** null enabled_agents means every agent is on. */
export function isAgentEnabled(id: string, enabledAgents: readonly string[] | null): boolean {
  return enabledAgents === null || enabledAgents.includes(id);
}

export function agentRowKind(agent: AgentStatus, enabledAgents: readonly string[] | null): AgentRowKind {
  if (agent.state === "not_installed") return "not_installed";
  if (agent.state === "not_configured" || !isAgentEnabled(agent.id, enabledAgents)) return "disabled";
  if (agent.state === "broken") return brokenKind(agent.integration.problems ?? []);
  if (agent.state === "needs_trust" || agent.state === "invalid_config") return agent.state;
  // The integration is fine; only the running app has not loaded it yet.
  const restart = codexRestart(agent.integration.problems);
  if (restart) return restart;
  if (CAPTURING_STATES.has(agent.state)) return "capturing";
  if (QUIET_STATES.has(agent.state)) return "idle";
  return "unknown";
}

/**
 * The next `enabled_agents` value, always an explicit list (contract v1.7: the
 * daemon rejects null). From null it starts with every id the daemon reports;
 * ids already listed are kept even when this build does not know them.
 */
export function nextEnabledAgents(current: readonly string[] | null, id: string, enable: boolean, reportedIds: readonly string[]): string[] {
  const listed = new Set(current ?? reportedIds);
  if (enable) listed.add(id);
  else listed.delete(id);
  const known = KNOWN_AGENT_IDS.filter((knownId) => listed.has(knownId));
  const others = [...listed].filter((listedId) => !isKnownAgentId(listedId));
  return [...known, ...others];
}

// Control and format characters (bidi overrides, zero-width marks), line and
// paragraph separators, and lone surrogates never reach the screen.
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

/**
 * Only the config file's base name, for sentences where the agent's name
 * already says which folder; a full path goes through display_path.
 */
export function configFileName(path: string | null | undefined): string | null {
  if (!path) return null;
  const baseName = (path.split(/[/\\]/).pop() ?? "").replace(INVISIBLE_CHARACTERS, "");
  return baseName === "" || baseName === "." || baseName === ".." ? null : baseName;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatAgo(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const elapsed = now.getTime() - at;
  if (elapsed < SECOND_MS) return "just now";
  if (elapsed < MINUTE_MS) return `${Math.floor(elapsed / SECOND_MS)} s ago`;
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}

const OK_STATES = new Set([...CAPTURING_STATES, ...QUIET_STATES]);

/**
 * Folds a fresh `GET /v1/agents` entry into the status agent, deriving the
 * state the daemon's status would report, until the next status replaces it.
 */
export function applyAgentEntry(agent: AgentStatus, entry: AgentEntry): AgentStatus {
  const integration = entry.integration;
  if (!integration) return agent;
  const installed = entry.presence?.installed ?? agent.installed;
  const configured = integration.state === "installed";
  let state: string;
  switch (integration.state) {
    case "broken":
    case "needs_trust":
    case "invalid_config":
      state = integration.state;
      break;
    case "not_installed":
      state = installed ? "not_configured" : "not_installed";
      break;
    default:
      state = OK_STATES.has(agent.state) ? agent.state : "idle";
  }
  return { ...agent, state, installed, configured, broken: integration.state === "broken", integration };
}

/** Known agents in their fixed order, then any extra the daemon reports. */
export function orderedAgents(agents: readonly AgentStatus[]): AgentStatus[] {
  const plain = agents.filter((agent) => PLAIN_AGENT_ID.test(agent.id));
  const known = KNOWN_AGENT_IDS.flatMap((id) => plain.filter((agent) => agent.id === id).slice(0, 1));
  const extras = plain.filter((agent) => !isKnownAgentId(agent.id));
  return [...known, ...extras];
}
