// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useId, useState, type ReactNode } from "react";

import { AgentTile } from "../../components/AgentTile";
import { agentDisplayName } from "../../components/agent-identity";
import { Banner } from "../../components/Banner";
import { CommandChip } from "../../components/CommandChip";
import { Button } from "../../components/Button";
import { Pill } from "../../components/Pill";
import { StepList } from "../../components/StepList";
import { Switch } from "../../components/Switch";
import { commands, type AgentAccess, type AgentAccessAgent, type AgentAccessWarning } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { showToast } from "../../shell/layers";
import { setAgentAccess, useAgentAccessRequested } from "../../stores/agent-access";
import { APP_RESTART, RESTART_STEPS, RESTART_STEPS_LABEL } from "../shared/codex-restart";
import {
  AGENT_ACCESS_NOT_CONNECTED,
  AGENT_ACCESS_ROOT_UNKNOWN,
  AGENT_ACCESS_TITLE,
  AGENT_PILL,
  AGENT_PROBLEM_REASON,
  AGENT_SCOPE,
  AGENT_STATE_REASON,
  AGENT_UNKNOWN_REASON,
  AGENT_WARNING,
  AGENT_WARNING_UNKNOWN,
  AGENT_WARNINGS_LABEL,
  AGENT_WARNINGS_TITLE,
  KEY_DELETED,
  NAME_TAKEN,
  PI_ADAPTER,
  UV_MISSING,
  agentAccessExplain,
  agentAccessFailureReason,
  agentAccessListLabel,
  agentAccessSwitchLabel,
  agentAccessToggleFailed,
} from "./copy";

type MappingAccess = AgentAccess["mappings"][number];

const DEFAULT_ENTRY_NAME = "backplane";

function pillFor({ state, problem }: AgentAccessAgent): keyof typeof AGENT_PILL {
  switch (state) {
    case "configured":
      if (problem === "restart_required") return "restart";
      if (problem === "uvx_missing") return "needs_uv";
      return "ready";
    case "pending":
      return "setting_up";
    case "conflict":
      return "needs_you";
    case "unsupported":
      if (problem === "agent_not_installed") return "not_installed";
      if (problem === "mcp_adapter_missing") return "optional";
      return "not_available";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

function reasonFor(agent: AgentAccessAgent, name: string, warnings: readonly AgentAccessWarning[]): ReactNode {
  const { state, problem } = agent;
  if (problem === "mcp_adapter_missing") {
    return (
      <>
        {PI_ADAPTER.reason} {PI_ADAPTER.howTo} <CommandChip command={PI_ADAPTER.command} punctuation="." />
      </>
    );
  }
  if (problem) return AGENT_PROBLEM_REASON[problem]?.(name) ?? AGENT_UNKNOWN_REASON;
  if (state === "conflict") {
    const taken = warnings.find((warning) => warning.agent_id === agent.agent_id && warning.reason === "mcp_name_taken");
    return (
      <>
        {NAME_TAKEN.lead(name)} <code>{taken?.entry_name ?? DEFAULT_ENTRY_NAME}</code>
        {NAME_TAKEN.tail}
      </>
    );
  }
  if (state === "configured" || state === "pending") return null;
  return AGENT_STATE_REASON[state]?.(name) ?? AGENT_UNKNOWN_REASON;
}

function AgentItem({ agent, warnings }: { agent: AgentAccessAgent; warnings: readonly AgentAccessWarning[] }) {
  const name = agentDisplayName(agent.agent_id);
  const pill = AGENT_PILL[pillFor(agent)];
  const reason = reasonFor(agent, name, warnings);
  const scope = AGENT_SCOPE[agent.scope];
  return (
    <li className="projects-agent">
      <div className="projects-agent-head">
        <AgentTile agent={agent.agent_id} size="sm" />
        <div className="projects-agent-name">
          <b>{name}</b>
          {scope ? <small>{scope}</small> : null}
        </div>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>
      {reason ? <p className="projects-agent-reason">{reason}</p> : null}
      {agent.problem === APP_RESTART ? (
        <StepList className="projects-agent-steps" label={RESTART_STEPS_LABEL[APP_RESTART]} steps={RESTART_STEPS[APP_RESTART]} />
      ) : null}
    </li>
  );
}

interface AgentAccessRowProps {
  mappingId: string;
  folder: string;
  access: MappingAccess | undefined;
  warnings: readonly AgentAccessWarning[];
  connected: boolean;
}

/** One bound folder's "Let your agents work on this board" switch, and each agent's state once it is on. */
export function AgentAccessRow({ mappingId, folder, access, warnings, connected }: AgentAccessRowProps) {
  const requested = useAgentAccessRequested(mappingId);
  const helpId = useId();
  // Only the daemon can find a repository mapping's folder, so the switch asks and this remembers a refusal.
  const [rootUnknown, setRootUnknown] = useState(false);
  const enabled = requested ?? access?.enabled ?? false;
  const help = !connected ? AGENT_ACCESS_NOT_CONNECTED() : rootUnknown ? AGENT_ACCESS_ROOT_UNKNOWN() : agentAccessExplain();
  const agents = access?.enabled && requested === undefined ? access.agents : [];

  const toggle = async (next: boolean) => {
    const result = await setAgentAccess(mappingId, next);
    if (result) setRootUnknown(!result.ok && result.error.kind === "api" && result.error.code === "mapping_root_unknown");
    if (result && !result.ok) showToast(agentAccessToggleFailed(next, folder, agentAccessFailureReason(result.error)), { tone: "error" });
  };

  return (
    <div className="projects-agents">
      <div className="projects-agents-head">
        <div className="projects-agents-text">
          <b>{AGENT_ACCESS_TITLE}</b>
          <small id={helpId}>{help}</small>
        </div>
        <Switch
          checked={enabled}
          label={agentAccessSwitchLabel(folder)}
          aria-describedby={helpId}
          disabled={!connected || requested !== undefined}
          aria-busy={requested !== undefined ? true : undefined}
          onCheckedChange={(next) => void toggle(next)}
        />
      </div>
      {agents.length > 0 ? (
        <ul className="projects-agent-list" aria-label={agentAccessListLabel(folder)}>
          {agents.map((agent) => (
            <AgentItem key={agent.agent_id} agent={agent} warnings={warnings} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function warningKey(warning: AgentAccessWarning): string {
  return `${warning.agent_id}\n${warning.entry_name}`;
}

/** Name-taken shows on its agent; an entry that is also this server's only needs saying once. */
function overlapWarnings(warnings: readonly AgentAccessWarning[]): AgentAccessWarning[] {
  const sameEndpoint = new Set(warnings.filter((warning) => warning.reason === "same_endpoint").map(warningKey));
  const shown = new Set<string>();
  return warnings.filter((warning) => {
    if (warning.reason === "mcp_name_taken") return false;
    if (warning.reason === "other_backplane_entry" && sameEndpoint.has(warningKey(warning))) return false;
    const key = `${warningKey(warning)}\n${warning.reason}`;
    if (shown.has(key)) return false;
    shown.add(key);
    return true;
  });
}

function WarningLine({ warning }: { warning: AgentAccessWarning }) {
  const copy = AGENT_WARNING[warning.reason] ?? AGENT_WARNING_UNKNOWN;
  return (
    <li>
      {copy.lead} <code>{warning.entry_name}</code> {copy.tail(agentDisplayName(warning.agent_id))}
    </li>
  );
}

async function openUvInstallPage() {
  const result = await callDaemon(() => commands.openUvInstallPage());
  if (!result.ok) showToast(UV_MISSING.openFailed, { tone: "error" });
}

async function turnBackOn(mappingId: string) {
  const result = await setAgentAccess(mappingId, true);
  if (result && !result.ok) showToast(KEY_DELETED.failed(agentAccessFailureReason(result.error)), { tone: "error" });
}

/** What every folder with agents on shares: the deleted key, uv, and other Backplane servers. */
export function AgentAccessNotes({ access }: { access: AgentAccess }) {
  const firstEnabled = access.mappings.find((mapping) => mapping.enabled);
  if (!firstEnabled) return null;
  const warnings = overlapWarnings(access.warnings);
  return (
    <div className="projects-agent-notes">
      {access.key.server_state === "missing" ? (
        <Banner
          tone="warning"
          title={KEY_DELETED.title}
          actions={
            <Button size="sm" onClick={() => void turnBackOn(firstEnabled.mapping_id)}>
              {KEY_DELETED.action}
            </Button>
          }
        >
          {KEY_DELETED.body}
        </Banner>
      ) : null}
      {access.prerequisites.uvx ? null : (
        <Banner
          tone="warning"
          title={UV_MISSING.title}
          actions={
            <Button size="sm" trailingIcon="external" onClick={() => void openUvInstallPage()}>
              {UV_MISSING.action}
            </Button>
          }
        >
          {UV_MISSING.body}
        </Banner>
      )}
      {warnings.length > 0 ? (
        <Banner tone="info" title={AGENT_WARNINGS_TITLE}>
          <ul className="projects-agent-warnings" aria-label={AGENT_WARNINGS_LABEL}>
            {warnings.map((warning) => (
              <WarningLine key={`${warningKey(warning)}\n${warning.reason}`} warning={warning} />
            ))}
          </ul>
        </Banner>
      ) : null}
    </div>
  );
}
