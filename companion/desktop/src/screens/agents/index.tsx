// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useRef, useState } from "react";

import { agentDisplayName, agentIntegrationId } from "../../components/agent-identity";
import { SectionHead } from "../../components/SectionHead";
import { StatePanel } from "../../components/StatePanel";
import { commands, type AgentId, type AgentStatus, type CompanionStatus } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import type { CompanionError } from "../../ipc/errors";
import { revealAgentConfig } from "../../ipc/native";
import { platformCopy } from "../../platform/copy";
import { useToast } from "../../shell/layers";
import { useAgents } from "../../stores/agents";
import { useConnectionState } from "../../stores/daemon-hooks";
import { statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";
import { useLiveSessions } from "../../stores/sessions";
import { describeAgentError, type AgentAction, type ErrorCopy } from "./agent-errors";
import {
  agentRowKind,
  applyAgentEntry,
  isKnownAgentId,
  orderedAgents,
  TOGGLEABLE_KINDS,
  type AgentRowKind,
} from "./agent-model";
import { agentEntriesNewerThan, pushAgentEntries, pushAgentEntry } from "./agent-entries";
import { AgentRow, type RowBusy } from "./AgentRow";
import { knownEnabledAgents, setAgentEnabled } from "./settings-queue";
import "./agents.css";

/**
 * The capture switch the user just set, held until the daemon's next status
 * says otherwise. `source` is the status it was set against (null while the
 * change is still running); any newer status replaces it.
 */
interface Overlay<T> {
  source: CompanionStatus | null;
  value: T;
}

type ByAgent<T> = Readonly<Record<string, T>>;

interface FailedStep {
  action: AgentAction;
  error: CompanionError;
}

function withoutKey<T>(record: ByAgent<T>, key: string): ByAgent<T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

function useByAgent<T>() {
  const [values, setValues] = useState<ByAgent<T>>({});
  const set = (id: string, value: T | null) => setValues((current) => (value === null ? withoutKey(current, id) : { ...current, [id]: value }));
  return [values, set] as const;
}

/** Still current while it is pending (null source) or no newer status has arrived. */
const isCurrent = <T,>(overlay: Overlay<T> | undefined, status: CompanionStatus): overlay is Overlay<T> =>
  overlay !== undefined && (overlay.source === null || overlay.source === status);

export function AgentsScreen() {
  const status = useStoreSelector(statusStore, (current) => current);
  const connection = useConnectionState();
  const liveSessions = useLiveSessions();
  // Subscribes (and loads the list once); which entries apply is decided by their arrival stamp.
  useAgents();
  const freshEntries = agentEntriesNewerThan(status);
  const [announcement, setAnnouncement] = useState("");
  const [focusRequests, setFocusRequest] = useByAgent<number>();
  const focusCounter = useRef(0);
  const toast = useToast();
  const [busy, setBusy] = useByAgent<RowBusy>();
  const [errors, setError] = useByAgent<ErrorCopy>();
  const [switched, setSwitched] = useByAgent<Overlay<boolean>>();

  if (!status) {
    return connection === "unreachable" ? (
      <div data-testid="screen-agents" className="agents-screen">
        <StatePanel tone="warning" icon="alert" title="Can’t reach the Companion">
          Agents show up here once the Companion is running again.
        </StatePanel>
      </div>
    ) : (
      <div data-testid="screen-agents" className="agents-screen" />
    );
  }

  const enabledAgents = knownEnabledAgents();
  const agents = orderedAgents(status.agents);

  const effectiveAgent = (agent: AgentStatus): AgentStatus => {
    const entry = freshEntries.find((candidate) => candidate.id === agent.id);
    return entry ? applyAgentEntry(agent, entry) : agent;
  };

  const kindOf = (agent: AgentStatus): AgentRowKind => {
    const kind = agentRowKind(agent, enabledAgents);
    const overlay = switched[agent.id];
    if (!isCurrent(overlay, status) || !TOGGLEABLE_KINDS.has(kind)) return kind;
    if (!overlay.value) return "disabled";
    return kind === "disabled" ? "idle" : kind;
  };

  const fail = (id: string, action: AgentAction, error: CompanionError) =>
    setError(id, describeAgentError(error, action, agentDisplayName(id)));

  const toggle = async (id: string, enable: boolean) => {
    if (!isKnownAgentId(id)) return;
    setBusy(id, "toggle");
    setError(id, null);
    setAnnouncement("");
    setSwitched(id, { source: null, value: enable });
    const failedStep = await (enable ? turnOn(id) : turnOff(id));
    if (failedStep) fail(id, failedStep.action, failedStep.error);
    else setAnnouncement(`${agentDisplayName(id)} capture is ${enable ? "on" : "off"}.`);
    // Only a failed hook removal leaves the change in place: capture is off, the hook just stayed.
    const changed = !failedStep || failedStep.action === "remove_hook";
    setSwitched(id, changed ? { source: statusStore.get(), value: enable } : null);
    setBusy(id, null);
  };

  const install = async (id: AgentId) => {
    const requestedUnder = statusStore.get();
    const result = await callDaemon(() => commands.agentInstall(id));
    if (result.ok) pushAgentEntry(result.value, requestedUnder);
    return result;
  };

  const uninstall = async (id: AgentId) => {
    const requestedUnder = statusStore.get();
    const result = await callDaemon(() => commands.agentUninstall(id));
    if (result.ok) pushAgentEntry(result.value, requestedUnder);
    return result;
  };

  // Hook first: an agent listed as on without a hook would capture nothing.
  const turnOn = async (id: AgentId): Promise<FailedStep | null> => {
    const installed = await install(id);
    if (!installed.ok) return { action: "enable", error: installed.error };
    const saved = await setAgentEnabled(id, true);
    if (saved.ok) return null;
    // Capture stays off, so the hook just added comes back out.
    const rolledBack = await uninstall(id);
    return { action: rolledBack.ok ? "enable_setting" : "enable_setting_hook_left", error: saved.error };
  };

  // Setting first: capture stops even if the hook then can't be removed.
  const turnOff = async (id: AgentId): Promise<FailedStep | null> => {
    const saved = await setAgentEnabled(id, false);
    if (!saved.ok) return { action: "disable", error: saved.error };
    const removed = await uninstall(id);
    return removed.ok ? null : { action: "remove_hook", error: removed.error };
  };

  const repair = async (id: string) => {
    if (!isKnownAgentId(id)) return;
    setBusy(id, "repair");
    setError(id, null);
    const result = await install(id);
    setBusy(id, null);
    if (!result.ok) return fail(id, "repair", result.error);
    // The Repair button goes away with the problem; focus lands on the row instead of the page.
    focusCounter.current += 1;
    setFocusRequest(id, focusCounter.current);
    toast.show(`${agentDisplayName(id)} hook repaired.`, { tone: "success" });
  };

  const recheck = async (agent: AgentStatus) => {
    const id = agent.id;
    setBusy(id, "recheck");
    setError(id, null);
    const before = kindOf(effectiveAgent(agent));
    const requestedUnder = statusStore.get();
    const result = await callDaemon(() => commands.agents());
    setBusy(id, null);
    if (!result.ok) return fail(id, "recheck", result.error);
    pushAgentEntries(result.value, requestedUnder);
    const statusNow = statusStore.get();
    // A status that landed mid-flight is newer than this answer, so it decides.
    const latest = statusNow === requestedUnder ? result.value.find((candidate) => candidate.id === id) : undefined;
    const current = statusNow?.agents.find((candidate) => candidate.id === id) ?? agent;
    const after = latest ? kindOf(applyAgentEntry(agent, latest)) : kindOf(current);
    toast.show(recheckMessage(agentDisplayName(id), before, after), { tone: after === before ? "info" : "success" });
  };

  const reveal = async (id: string) => {
    if (!isKnownAgentId(id)) return;
    setBusy(id, "reveal");
    setError(id, null);
    const result = await revealAgentConfig(id);
    setBusy(id, null);
    if (!result.ok) fail(id, "reveal", result.error);
  };

  return (
    <div data-testid="screen-agents" className="agents-screen">
      <SectionHead title={`Coding agents on ${platformCopy().thisDevice}`} />
      <ul className="bp-group" aria-label={`Coding agents on ${platformCopy().thisDevice}`}>
        {agents.map((reported) => {
          const agent = effectiveAgent(reported);
          return (
            <AgentRow
              key={agent.id}
              agent={agent}
              kind={kindOf(agent)}
              liveSessionCount={liveSessions.filter((session) => agentIntegrationId(session.harness) === agent.id).length}
              now={new Date()}
              busy={busy[agent.id] ?? null}
              error={errors[agent.id] ?? null}
              focusHeadingRequest={focusRequests[agent.id] ?? 0}
              onToggle={(enable) => void toggle(agent.id, enable)}
              onRepair={() => void repair(agent.id)}
              onRecheck={() => void recheck(reported)}
              onReveal={() => void reveal(agent.id)}
            />
          );
        })}
      </ul>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <p className="bp-help">Turning an agent on adds a small hook to its settings; turning it off removes it. Capture only runs in bound projects.</p>
    </div>
  );
}

function recheckMessage(name: string, before: AgentRowKind, after: AgentRowKind): string {
  if (before === "needs_trust" && (after === "idle" || after === "capturing")) return `${name} approved the hooks. Its sessions will be captured.`;
  if ((before === "restart_required" || before === "daemon_restart_required") && (after === "idle" || after === "capturing")) {
    return `${name} restarted with the hooks. Its sessions will be captured.`;
  }
  if (after === before) return before === "not_installed" ? "Still not installed. Nothing changed." : "Still the same. Nothing changed.";
  if (before === "not_installed") return `${name} is installed. Turn it on to capture its sessions.`;
  return `${name} checked again. Its status is up to date.`;
}
