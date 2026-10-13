// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { AgentEntry, AgentStatus, CompanionStatus_Deserialize } from "../../ipc/bindings";
import statusFixture from "../../../src-tauri/tests/fixtures/status.json";

export const AGENTS_NOW = new Date("2026-09-28T12:00:00Z");

const SECOND_MS = 1_000;
const HOUR_MS = 3_600_000;
const HOME = "/home/tester";

const CONFIG_PATHS: Record<string, string> = {
  claude_code: `${HOME}/.claude/settings.json`,
  codex_cli: `${HOME}/.codex/hooks.json`,
  pi_cli: `${HOME}/.pi/agent/extensions/backplane.ts`,
};

export type Status = CompanionStatus_Deserialize;
export const baseStatus = statusFixture as unknown as Status;

const ago = (ms: number) => new Date(AGENTS_NOW.getTime() - ms).toISOString();

function agent(id: string, patch: Partial<AgentStatus> = {}, integration: Partial<AgentStatus["integration"]> = {}): AgentStatus {
  return {
    id,
    state: "idle",
    installed: true,
    configured: true,
    receiving: false,
    uploading: false,
    paused: false,
    broken: false,
    last_observation_at: null,
    last_upload_at: null,
    ...patch,
    integration: { state: "installed", config_path: CONFIG_PATHS[id] ?? `${HOME}/.${id}/config`, trust: null, ...integration },
  };
}

export const capturingAgent = (id: string) =>
  agent(id, { state: "uploading", receiving: true, uploading: true, last_observation_at: ago(20 * SECOND_MS), last_upload_at: ago(8 * SECOND_MS) });
export const quietCapturingAgent = (id: string) =>
  agent(id, { state: "receiving", receiving: true, last_observation_at: ago(2 * HOUR_MS), last_upload_at: ago(2 * HOUR_MS) });
export const idleAgent = (id: string) => agent(id, { state: "idle", last_observation_at: ago(3 * 24 * HOUR_MS) });
export const neverSeenAgent = (id: string) => agent(id, { state: "idle" });
export const notInstalledAgent = (id: string) =>
  agent(id, { state: "not_installed", installed: false, configured: false }, { state: "not_installed" });
export const notConfiguredAgent = (id: string) => agent(id, { state: "not_configured", configured: false }, { state: "not_installed" });
export const needsTrustAgent = (id: string) =>
  agent(id, { state: "needs_trust", configured: false }, { state: "needs_trust", trust: "needs_trust" });
export const brokenAgent = (id: string, problems: string[] = ["PreToolUse:missing"]) =>
  agent(id, { state: "broken", configured: false, broken: true }, { state: "broken", problems });
export const invalidConfigAgent = (id: string, config_path?: string) =>
  agent(id, { state: "invalid_config", configured: false }, { state: "invalid_config", problems: ["hooks_invalid"], ...(config_path === undefined ? {} : { config_path }) });
export const otelConflictAgent = (id: string) => brokenAgent(id, ["conflict_existing_otel"]);
/** Hooks installed and trusted, but the app that runs them started before the install (DK-12f). */
export const restartRequiredAgent = (id: string, problem: "restart_required" | "daemon_restart_required" = "restart_required") =>
  agent(id, { state: "idle", last_observation_at: ago(3 * 24 * HOUR_MS) }, { state: "installed", trust: "trusted", problems: [problem] });

/** Hooks just added: not yet trusted, and the Codex app was already open. */
export const trustAndRestartAgent = (id: string) => {
  const untrusted = needsTrustAgent(id);
  return { ...untrusted, integration: { ...untrusted.integration, problems: ["restart_required"] } };
};

export function withAgents(agents: AgentStatus[], enabledAgents: string[] | null = null): Status {
  return { ...baseStatus, agents, capture: { ...baseStatus.capture, enabled_agents: enabledAgents } };
}

/** The daemon's `GET /v1/agents` entry for a status agent, as Check again sees it. */
export function entryFor(status: AgentStatus, patch: Partial<AgentEntry["integration"] & object> = {}, installed = status.installed): AgentEntry {
  return {
    id: status.id,
    presence: { installed, version: null, config_path: status.integration.config_path },
    integration: { ...status.integration, ...patch },
    action: null,
    telemetry: null,
  };
}

/** Codex telemetry out of date in config.toml, as the Windows QA machine reported it (DK-12p B4). */
const codexTelemetryStale = () => {
  const codex = brokenAgent("codex_cli", ["otel:stale"]);
  return { ...codex, integration: { ...codex.integration, problem_config_paths: { "otel:stale": `${HOME}/.codex/config.toml` } } };
};

/** The three DK-0 Agents scenarios, plus DK-12f's restart states and DK-12p's broken causes, by name. */
export const AGENTS_SCENARIOS = {
  healthy: withAgents([capturingAgent("claude_code"), needsTrustAgent("codex_cli"), notInstalledAgent("pi_cli")]),
  trouble: withAgents([brokenAgent("claude_code"), invalidConfigAgent("codex_cli"), notConfiguredAgent("pi_cli")], ["claude_code", "codex_cli"]),
  idle: withAgents([idleAgent("claude_code"), quietCapturingAgent("codex_cli"), idleAgent("pi_cli")]),
  restart: withAgents([capturingAgent("claude_code"), restartRequiredAgent("codex_cli"), notInstalledAgent("pi_cli")]),
  trustRestart: withAgents([capturingAgent("claude_code"), trustAndRestartAgent("codex_cli"), notInstalledAgent("pi_cli")]),
  daemonRestart: withAgents([capturingAgent("claude_code"), restartRequiredAgent("codex_cli", "daemon_restart_required"), notInstalledAgent("pi_cli")]),
  brokenCauses: withAgents([brokenAgent("claude_code", ["settings_invalid"]), codexTelemetryStale(), brokenAgent("pi_cli", ["extension_not_owned"])]),
} as const;

export type AgentsScenario = keyof typeof AGENTS_SCENARIOS;
