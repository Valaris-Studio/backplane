// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react";

import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { StatePanel } from "../../components/StatePanel";
import { commands, type AgentStatus, type AttentionItem } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { platformCopy } from "../../platform/copy";
import { showToast } from "../../shell/layers";
import { selectTab, startOnboarding } from "../../shell/navigation";
import { AGENT_PROBLEM_STATES } from "../../shell/status-model";
import { attentionStore, statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";
import { agentLabel } from "./agent-label";
import { openInBackplane } from "./open-backplane";

async function resumeCapture() {
  const result = await callDaemon(commands.resume);
  if (result.ok) showToast("Capture resumed.");
  else showToast("Couldn’t resume capture. Try again in a moment.", { tone: "error" });
}

interface AgentCopy {
  title: (name: string) => string;
  body?: (name: string) => string;
}

const NOT_CAPTURED_UNTIL_FIXED = (name: string) => `Until it is fixed, ${name} sessions are not captured. Other agents are fine.`;

// Keyed on the daemon's attention codes (controlapi.go attention(), the codes DK-4c's notifications
// use). The daemon's own message is never rendered: it is free text this build hasn't reviewed.
const AGENT_ATTENTION_COPY: Record<string, AgentCopy> = {
  needs_trust: { title: (name) => `${name} needs your approval before its sessions can be captured.`, body: NOT_CAPTURED_UNTIL_FIXED },
  invalid_config: { title: (name) => `${name}’s config file has an error.`, body: NOT_CAPTURED_UNTIL_FIXED },
  agent_broken: { title: (name) => `${name}’s capture hook stopped working.`, body: NOT_CAPTURED_UNTIL_FIXED },
  conflict_existing_otel: { title: (name) => `${name} already sends its telemetry elsewhere, so capture can’t turn on.` },
};
const GENERIC_AGENT_COPY: AgentCopy = { title: (name) => `${name} needs your attention.` };

// Getters name the device only once the platform is known.
const DEVICE_ATTENTION_TITLE: Record<string, string> = {
  get device_revoked() {
    return `${platformCopy().ThisDevice} was disconnected.`;
  },
  policy_stale: "Can’t reach Backplane right now.",
};
const GENERIC_DEVICE_TITLE = "Something needs your attention.";

// Status agent states and attention codes name the same problems differently.
const CODE_FOR_AGENT_STATE: Record<string, string> = {
  needs_trust: "needs_trust",
  invalid_config: "invalid_config",
  broken: "agent_broken",
};

interface AgentProblem {
  agent: string;
  code: string;
}

function agentProblems(agents: readonly AgentStatus[], attention: readonly AttentionItem[]): AgentProblem[] {
  const problems = new Map<string, string>();
  for (const agent of agents) {
    const code = CODE_FOR_AGENT_STATE[agent.state];
    if (code && AGENT_PROBLEM_STATES.has(agent.state)) problems.set(agent.id, code);
  }
  for (const item of attention) {
    if (item.agent && !problems.has(item.agent)) problems.set(item.agent, item.code);
  }
  return [...problems].map(([agent, code]) => ({ agent, code }));
}

const showAgents = () => selectTab("agents");

const NO_AGENTS: AgentStatus[] = [];

export function AttentionBanner() {
  const agents = useStoreSelector(statusStore, (status) => status?.agents ?? NO_AGENTS);
  const attention = useStoreSelector(attentionStore, (items) => items);
  const problems = agentProblems(agents, attention);
  const [firstProblem] = problems;
  const showMeHow = (
    <Button size="sm" onClick={showAgents}>
      Show me how
    </Button>
  );

  if (problems.length > 1) {
    return (
      <Banner title={`${problems.length} agents need your attention.`} actions={showMeHow}>
        Until they are fixed, their sessions may not be captured. Other agents are fine.
      </Banner>
    );
  }
  if (firstProblem) {
    const name = agentLabel(firstProblem.agent);
    const copy = AGENT_ATTENTION_COPY[firstProblem.code] ?? GENERIC_AGENT_COPY;
    return (
      <Banner title={copy.title(name)} actions={showMeHow}>
        {copy.body?.(name)}
      </Banner>
    );
  }
  const [deviceItem] = attention;
  return deviceItem ? <Banner title={DEVICE_ATTENTION_TITLE[deviceItem.code] ?? GENERIC_DEVICE_TITLE} /> : null;
}

export function PausedBanner() {
  return (
    <Banner
      tone="info"
      icon="pause"
      title="Capture is paused"
      actions={
        <Button size="sm" variant="primary" onClick={() => void resumeCapture()}>
          Resume
        </Button>
      }
    >
      Sessions you run now are not recorded, not even locally. Earlier sessions are unaffected.
    </Banner>
  );
}

function queuedSentence(queued: number): string {
  if (queued === 0) return "Nothing is waiting to upload.";
  return `${queued} ${queued === 1 ? "is" : "are"} ready to upload when the connection is back.`;
}

// The daemon skips its backoff at most once a second; pressing faster only queues no-ops.
const TRY_NOW_FLOOR_MS = 1_000;

// Keyed on QueueFlush.reason; the daemon's free text is never shown.
const NOT_SCHEDULED_SENTENCE: Record<string, string> = {
  queue_empty: "Nothing is waiting to upload.",
  get not_connected() {
    return `${platformCopy().ThisDevice} isn’t connected to Backplane, so there’s nothing to retry.`;
  },
  get device_revoked() {
    return `${platformCopy().ThisDevice} was disconnected in Backplane, so nothing can upload.`;
  },
  daemon_not_running: "Companion isn’t running, so it can’t retry right now.",
};
const RETRY_FAILED = "Couldn’t retry right now. Companion keeps trying on its own.";

async function flushQueue(): Promise<void> {
  const result = await callDaemon(commands.queueFlush);
  if (!result.ok) showToast(RETRY_FAILED, { tone: "error" });
  else if (result.value.scheduled) showToast("Trying to upload now.");
  else showToast(NOT_SCHEDULED_SENTENCE[result.value.reason ?? ""] ?? RETRY_FAILED, { tone: "info" });
}

function TryNowButton() {
  const [trying, setTrying] = useState(false);
  const floorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(floorTimer.current), []);

  const tryNow = async () => {
    setTrying(true);
    const floor = new Promise<void>((resolve) => {
      floorTimer.current = setTimeout(resolve, TRY_NOW_FLOOR_MS);
    });
    await Promise.all([flushQueue(), floor]);
    setTrying(false);
  };

  return (
    <Button size="sm" icon="refresh" loading={trying} onClick={() => void tryNow()}>
      {trying ? "Trying…" : "Try now"}
    </Button>
  );
}

export function UnreachableBanner({ host, queued }: { host: string | null; queued: number }) {
  return (
    <Banner icon="cloud-off" title={host ? `Can’t reach ${host}` : "Can’t reach Backplane"} actions={<TryNowButton />}>
      <p className="home-banner-line">
        {`Sessions keep being captured and wait on ${platformCopy().thisDevice}. `}
        {queuedSentence(queued)}
      </p>
      <p className="home-banner-line">Retrying automatically.</p>
    </Banner>
  );
}

export function RevokedPanel({ webRootUrl }: { webRootUrl: string | null }) {
  return (
    <StatePanel
      tone="error"
      icon="power"
      title={`${platformCopy().ThisDevice} was disconnected`}
      actions={
        <>
          <Button variant="primary" onClick={startOnboarding}>
            Connect again
          </Button>
          <Button trailingIcon="external" onClick={() => void openInBackplane(webRootUrl)}>
            Open Backplane
          </Button>
        </>
      }
      finePrint="If you didn’t remove it, ask a workspace admin who did."
    >
      Its access was removed in Backplane, so nothing is captured or uploaded. Sessions already uploaded stay in Backplane.
    </StatePanel>
  );
}

export function PausedByServerPanel({ webRootUrl }: { webRootUrl: string | null }) {
  return (
    <StatePanel
      icon="pause"
      title="Paused from Backplane"
      actions={
        <Button trailingIcon="external" onClick={() => void openInBackplane(webRootUrl)}>
          Open device page
        </Button>
      }
    >
      {`Capture for ${platformCopy().thisDevice} was paused on its device page in Backplane. Nothing is recorded until it is resumed there.`}
    </StatePanel>
  );
}

const AGENT_ON_STATES: ReadonlySet<string> = new Set(["receiving", "uploading", "idle"]);

export function EmptyPanel() {
  const boundProjects = useStoreSelector(statusStore, (status) => status?.capture.mappings ?? 0);
  const agents = useStoreSelector(statusStore, (status) => status?.agents ?? NO_AGENTS);
  const agentsOn = agents.filter((agent) => AGENT_ON_STATES.has(agent.state)).length;
  return (
    <StatePanel
      icon="terminal"
      title="No sessions yet"
      actions={<Button onClick={() => selectTab("projects")}>Review projects</Button>}
    >
      <p>Start Claude Code, Codex or Pi in a bound project. The session shows up here within a few seconds.</p>
      <dl className="home-kv">
        <dt>Bound projects</dt>
        <dd>{boundProjects}</dd>
        <dt>Agents on</dt>
        <dd>
          {agentsOn} of {agents.length}
        </dd>
      </dl>
    </StatePanel>
  );
}
