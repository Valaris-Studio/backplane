// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useId, useState } from "react";

import { AgentTile } from "../../components/AgentTile";
import { agentDisplayName } from "../../components/agent-identity";
import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { CommandChip } from "../../components/CommandChip";
import { Group } from "../../components/Group";
import { Pill } from "../../components/Pill";
import { Spinner } from "../../components/Spinner";
import { Quote, StepList } from "../../components/StepList";
import { Switch } from "../../components/Switch";
import { commands, type AgentEntry, type AgentId } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import type { CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";
import { agentsResource } from "../../stores/agents";
import { useStoreSelector } from "../../stores/external-store";
import { codexRestart, DAEMON_RESTART, RESTART_STEPS, RESTART_STEPS_LABEL } from "../shared/codex-restart";
import { useDisplayPath } from "../shared/display-path";
import { DaemonDownPanel } from "./DaemonDownPanel";
import { adoptInto } from "./store-feed";
import { errorSentence, isDaemonDown } from "./daemon-messages";
import { goToStep } from "./onboarding-store";
import { OnboardingFrame } from "./OnboardingFrame";

const INSTALLABLE_AGENTS: readonly string[] = ["claude_code", "codex_cli", "pi_cli"] satisfies AgentId[];
const CODEX = "codex_cli";
const TRUST_PENDING = new Set(["needs_trust", "modified"]);

function isOn(agent: AgentEntry): boolean {
  return agent.integration !== null && agent.integration.state !== "not_installed";
}

function needsTrust(agent: AgentEntry): boolean {
  const integration = agent.integration;
  return integration !== null && (integration.state === "needs_trust" || TRUST_PENDING.has(integration.trust ?? ""));
}

/** Codex's hooks went in while the Codex app (or its background server) was already running. */
function RestartGuidance({ agent }: { agent: AgentEntry }) {
  const restart = codexRestart(agent.integration?.problems);
  if (!restart) return null;
  return (
    <>
      <p className="ob-detail">
        {restart === DAEMON_RESTART
          ? "Codex’s background app server was already running, so restart it to start capturing its sessions."
          : "The Codex app was already open, so restart it to start capturing its sessions."}
      </p>
      <StepList className="ob-steps" label={RESTART_STEPS_LABEL[restart]} steps={RESTART_STEPS[restart]} />
    </>
  );
}

// Pairing never adds hooks, so an agent already on when the step opens was set up earlier; the daemon
// repoints the Companion's own hooks at this app (reconcileAgents), which is why its switch is on.
const ALREADY_ON = "Already on from an earlier setup. The Companion keeps its hook pointed at this app.";
const TURNED_ON = "On. Sessions in bound projects are captured.";

function AgentDetail({ agent, name, wasOnAtStart }: { agent: AgentEntry; name: string; wasOnAtStart: boolean }) {
  const configFolder = useDisplayPath(agent.presence?.installed ? agent.presence.config_path : null);
  if (!agent.presence?.installed) return <p className="ob-detail">Install {name} and it will show up in Agents.</p>;
  if (needsTrust(agent)) {
    if (agent.id !== CODEX) return <p className="ob-detail">{agent.action ?? `${name} needs one approval before it runs the hook.`}</p>;
    return (
      <>
        <p className="ob-detail">Hook added. One more step, inside Codex:</p>
        <StepList
          className="ob-steps"
          label={`Trust the hooks in ${name}`}
          steps={[
            <>
              Start <CommandChip command="codex" /> in a terminal.
            </>,
            <>
              At <Quote>Hooks need review</Quote>, choose <Quote>Trust all and continue</Quote>.
            </>,
            "You can do this later. Agents shows a reminder until it’s done.",
          ]}
        />
        <RestartGuidance agent={agent} />
      </>
    );
  }
  const state = agent.integration?.state;
  if (state === "broken" || state === "invalid_config") return <p className="ob-detail">{agent.action ?? "Needs attention. Agents has the details."}</p>;
  if (codexRestart(agent.integration?.problems)) return <RestartGuidance agent={agent} />;
  const foundIn = configFolder ? (
    <>
      Found in <code>{configFolder}</code>.{" "}
    </>
  ) : null;
  return (
    <p className="ob-detail">
      {foundIn}
      {isOn(agent) ? (wasOnAtStart ? ALREADY_ON : TURNED_ON) : agent.id === CODEX ? "Needs one approval inside Codex after you turn it on." : "Ready as soon as it’s on."}
    </p>
  );
}

function AgentRow({ agent, wasOnAtStart, onChanged }: { agent: AgentEntry; wasOnAtStart: boolean; onChanged: () => Promise<void> }) {
  const name = agentDisplayName(agent.id);
  const nameId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installed = agent.presence?.installed ?? false;
  const on = isOn(agent);

  const toggle = async (turnOn: boolean) => {
    setBusy(true);
    setError(null);
    const agentId = agent.id as AgentId;
    const result = await callDaemon(() => (turnOn ? commands.agentInstall(agentId) : commands.agentUninstall(agentId)));
    if (result.ok) await onChanged();
    else setError(`Couldn’t turn ${name} ${turnOn ? "on" : "off"}. ${errorSentence(result.error)}`);
    setBusy(false);
  };

  return (
    <li className="ob-agent" aria-labelledby={nameId}>
      <div className="ob-agent-head">
        <AgentTile agent={agent.id} />
        <b id={nameId} className="ob-grow">
          {name}
        </b>
        {installed ? null : <Pill>Not installed</Pill>}
        <Switch
          checked={on}
          label={`Capture ${name} sessions`}
          disabled={!installed || busy || !INSTALLABLE_AGENTS.includes(agent.id)}
          aria-busy={busy || undefined}
          onCheckedChange={(next) => void toggle(next)}
        />
      </div>
      <AgentDetail agent={agent} name={name} wasOnAtStart={wasOnAtStart} />
      {error ? (
        <p className="ob-detail ob-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function AgentsStep() {
  const agents = useStoreSelector(agentsResource.store, (list) => list);
  const [loadError, setLoadError] = useState<CompanionError | null>(null);
  const [loadRequest, setLoadRequest] = useState(0);
  const [loading, setLoading] = useState(true);
  const [onAtStart, setOnAtStart] = useState<ReadonlySet<string> | null>(null);
  // Fixed the first time the list shows (React's "derive from props" pattern): what the owner found, not what they changed.
  if (onAtStart === null && agents !== null) setOnAtStart(new Set(agents.filter(isOn).map((agent) => agent.id)));

  const loadAgents = async () => {
    const result = await callDaemon(() => commands.agents());
    if (result.ok) {
      adoptInto(agentsResource, result.value);
      setLoadError(null);
    } else {
      setLoadError(result.error);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void callDaemon(() => commands.agents()).then((result) => {
      if (cancelled) return;
      if (result.ok) adoptInto(agentsResource, result.value);
      setLoadError(result.ok ? null : result.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadRequest]);

  const retryLoad = () => {
    setLoading(true);
    setLoadRequest((request) => request + 1);
  };

  let body;
  if (loadError && isDaemonDown(loadError)) body = <DaemonDownPanel retrying={loading} onRetry={retryLoad} />;
  else if (loadError)
    body = (
      <Banner
        tone="error"
        role="alert"
        title={`Couldn’t read the agents on ${platformCopy().thisDevice}`}
        actions={
          <Button size="sm" loading={loading} onClick={retryLoad}>
            Try again
          </Button>
        }
      >
        {errorSentence(loadError)}
      </Banner>
    );
  else if (agents === null)
    body = (
      <p className="ob-loading">
        <Spinner />
        Looking for agents…
      </p>
    );
  else if (agents.length === 0) body = <p className="ob-detail">{`No agents found on ${platformCopy().thisDevice} yet.`}</p>;
  else
    body = (
      <Group label="Agents">
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} wasOnAtStart={onAtStart?.has(agent.id) ?? true} onChanged={loadAgents} />
        ))}
      </Group>
    );

  return (
    <OnboardingFrame
      step="agents"
      title="Capture from these agents"
      lede={`We found these on ${platformCopy().thisDevice}. Turning one on adds a small hook to its settings; you can turn it off later.`}
      actions={
        <Button variant="primary" onClick={() => goToStep("projects", "push")}>
          Continue
        </Button>
      }
    >
      {body}
    </OnboardingFrame>
  );
}
