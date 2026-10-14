// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useRef, type ReactNode } from "react";

import { AgentTile } from "../../components/AgentTile";
import { agentDisplayName } from "../../components/agent-identity";
import { Banner } from "../../components/Banner";
import { CommandChip } from "../../components/CommandChip";
import { Button } from "../../components/Button";
import { Pill, type PillTone } from "../../components/Pill";
import { Quote, StepList } from "../../components/StepList";
import { Switch } from "../../components/Switch";
import type { AgentStatus } from "../../ipc/bindings";
import { platformCopy } from "../../platform/copy";
import { codexRestart, DAEMON_RESTART, RESTART_STEPS, RESTART_STEPS_LABEL } from "../shared/codex-restart";
import { useDisplayPath } from "../shared/display-path";
import type { ErrorCopy } from "./agent-errors";
import { configFileName, formatAgo, isKnownAgentId, isUnreadableFileProblem, TOGGLEABLE_KINDS, type AgentRowKind } from "./agent-model";

export type RowBusy = "toggle" | "repair" | "recheck" | "reveal" | null;

export interface AgentRowProps {
  agent: AgentStatus;
  kind: AgentRowKind;
  liveSessionCount: number;
  now: Date;
  busy: RowBusy;
  error: ErrorCopy | null;
  /** Each new value moves focus to this row's heading; 0 never does. */
  focusHeadingRequest: number;
  onToggle: (enable: boolean) => void;
  onRepair: () => void;
  onRecheck: () => void;
  onReveal: () => void;
}

const PILLS: Record<AgentRowKind, [PillTone, string]> = {
  capturing: ["success", "Capturing"],
  idle: ["neutral", "Idle"],
  disabled: ["neutral", "Off"],
  not_installed: ["neutral", "Not installed"],
  broken: ["error", "Needs repair"],
  otel_conflict: ["error", "Config conflict"],
  hooks_disabled: ["warning", "Off in Codex"],
  foreign_extension: ["error", "Extension replaced"],
  needs_trust: ["warning", "Needs your approval"],
  invalid_config: ["error", "Config has an error"],
  restart_required: ["warning", "Restart Codex"],
  daemon_restart_required: ["warning", "Restart needed"],
  unknown: ["neutral", "Unknown"],
};

/** "Claude Code’s settings.json": the agent's name says which folder, so a sentence needs only the file. */
const ConfigFile = ({ name, fileName }: { name: string; fileName: string }) => (
  <>
    {name}’s <code>{fileName}</code>
  </>
);

type Integration = AgentStatus["integration"];

/** The file a problem is about: Codex names it per problem; otherwise it is the agent's config file. */
function problemPath(integration: Integration, problem: string | undefined): string {
  return (problem ? integration.problem_config_paths?.[problem] : undefined) || integration.config_path;
}

const COMPONENT_PROBLEM = /^([A-Za-z]+):(missing|stale)$/;

/** The repairable problem a sentence is about: a removed hook first, then out-of-date parts. */
function leadingRepairProblem(problems: readonly string[]): { component: string; condition: "missing" | "stale"; problem: string } | null {
  const parsed = problems.flatMap((problem) => {
    const match = COMPONENT_PROBLEM.exec(problem);
    return match ? [{ component: match[1] ?? "", condition: match[2] as "missing" | "stale", problem }] : [];
  });
  const isHook = (component: string) => component !== "otel" && component !== "extension";
  return (
    parsed.find((part) => isHook(part.component) && part.condition === "missing") ??
    parsed.find((part) => isHook(part.component)) ??
    parsed.find((part) => part.component === "otel") ??
    parsed.find((part) => part.component === "extension") ??
    null
  );
}

const REPAIR_POINTS_HERE = "Repair points it at this app.";

function brokenDetail(agent: AgentStatus, name: string): ReactNode {
  const problems = agent.integration.problems ?? [];
  if (problems.includes("companion_executable_missing")) {
    return "The capture hook points at a Companion that is no longer there, so new sessions aren’t seen.";
  }
  const leading = leadingRepairProblem(problems);
  const fileName = configFileName(problemPath(agent.integration, leading?.problem));
  const file = fileName ? <ConfigFile name={name} fileName={fileName} /> : null;
  if (leading?.component === "otel" && file) {
    return leading.condition === "missing" ? (
      <>The Companion’s telemetry settings are missing from {file}, so new sessions aren’t seen.</>
    ) : (
      <>The Companion’s telemetry settings in {file} are out of date, so new sessions aren’t seen.</>
    );
  }
  if (leading?.component === "extension" && file) {
    return (
      <>
        The Companion’s extension in {file} is out of date. {REPAIR_POINTS_HERE}
      </>
    );
  }
  if (leading?.condition === "stale" && file) {
    return (
      <>
        The capture hook in {file} is out of date. {REPAIR_POINTS_HERE}
      </>
    );
  }
  return file ? (
    <>The capture hook in {file} was removed or changed, so new sessions aren’t seen.</>
  ) : (
    `${name}’s capture hook was removed or changed, so new sessions aren’t seen.`
  );
}

function foreignExtensionDetail(name: string, fileName: string | null): ReactNode {
  return (
    <>
      {fileName ? (
        <>
          Another extension took the Companion’s place in <ConfigFile name={name} fileName={fileName} />, so new sessions aren’t seen.
        </>
      ) : (
        "Another extension took the Companion’s place, so new sessions aren’t seen."
      )}{" "}
      Move that file out of the way, then check again.
    </>
  );
}

/** The unreadable file the user has to fix; null when the integration is invalid without saying which part. */
function unreadableProblem(integration: Integration): string | undefined {
  return (integration.problems ?? []).find(isUnreadableFileProblem);
}

function activityDetail(kind: "capturing" | "idle", agent: AgentStatus, liveSessionCount: number, now: Date): string {
  if (kind === "capturing" && liveSessionCount > 0) {
    const live = `${liveSessionCount} session${liveSessionCount === 1 ? "" : "s"} now`;
    const uploaded = formatAgo(agent.last_upload_at, now);
    return uploaded ? `${live} · last upload ${uploaded}` : live;
  }
  const lastSession = formatAgo(agent.last_observation_at, now);
  return lastSession ? `Ready · last session ${lastSession}` : "Ready. No sessions yet.";
}

/** `shownConfigPath` is the masked full path, for a file the user has to open; null until Rust answers. */
function detailFor(kind: AgentRowKind, agent: AgentStatus, liveSessionCount: number, now: Date, shownConfigPath: string | null): ReactNode {
  const name = agentDisplayName(agent.id);
  const fileName = configFileName(agent.integration.config_path);
  const unreadable = unreadableProblem(agent.integration);
  switch (kind) {
    case "capturing":
    case "idle":
      return activityDetail(kind, agent, liveSessionCount, now);
    case "disabled":
      return agent.integration.state === "not_installed"
        ? `Off. ${name} sessions on ${platformCopy().thisDevice} are not captured, and its hook is removed.`
        : `Off. ${name} sessions on ${platformCopy().thisDevice} are not captured.`;
    case "not_installed":
      return `${name} isn’t installed on ${platformCopy().thisDevice}. Install it, then check again.`;
    case "broken":
      return brokenDetail(agent, name);
    case "hooks_disabled":
      return `${name} has the Companion’s hooks turned off, so new sessions aren’t seen. Turn them back on in Codex, then check again.`;
    case "foreign_extension":
      return foreignExtensionDetail(name, fileName);
    case "otel_conflict":
      return `${name} already sends telemetry to another OpenTelemetry endpoint, so the Companion left its config alone and its sessions aren’t captured. Remove that exporter from config.toml, then check again.`;
    case "needs_trust":
      return `${name} only runs the Companion’s hooks after you approve them. Until then its sessions aren’t captured.`;
    case "invalid_config": {
      const problemFile = configFileName(problemPath(agent.integration, unreadable));
      // The file parses, but one event's hooks aren't in the shape the agent reads.
      const what = unreadable && /:invalid$/.test(unreadable) ? "has a hook entry the Companion can’t read." : "can’t be read.";
      return (
        <>
          {problemFile ? (
            <>
              <ConfigFile name={name} fileName={shownConfigPath ?? problemFile} /> {what}
            </>
          ) : (
            `${name}’s config file ${what}`
          )}{" "}
          The Companion never edits a file it can’t parse, so fix it in your editor first.
        </>
      );
    }
    case "restart_required":
      return `Restart the ${name} app to start capturing its sessions. It was already open when capture was set up.`;
    case "daemon_restart_required":
      return `Restart ${name}’s background app server to start capturing its sessions. It was already running when capture was set up.`;
    case "unknown":
      return "This version of the app can’t show this agent’s status yet.";
  }
}

const CLEARS_ON_ITS_OWN = "Come back here. This clears on its own.";

// The CLI's own wording (messages.go "needs_trust"), split into steps.
const CODEX_TRUST_STEPS: readonly ReactNode[] = [
  <>
    Open a terminal and start <CommandChip command="codex" punctuation="." />
  </>,
  <>
    At <Quote>Hooks need review</Quote>, choose <Quote>Trust all and continue</Quote>. To approve only Backplane’s hooks, choose <Quote>Review hooks</Quote>.
  </>,
  "Come back here. This updates on its own; Codex Desktop picks up the same approval.",
];

export function AgentRow({ agent, kind, liveSessionCount, now, busy, error, focusHeadingRequest, onToggle, onRepair, onRecheck, onReveal }: AgentRowProps) {
  const name = agentDisplayName(agent.id);
  const [pillTone, pillLabel] = PILLS[kind];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownConfigPath = useDisplayPath(kind === "invalid_config" ? problemPath(agent.integration, unreadableProblem(agent.integration)) || null : null);
  useEffect(() => {
    if (focusHeadingRequest > 0) headingRef.current?.focus();
  }, [focusHeadingRequest]);
  // Only the three agents the native commands accept get controls.
  const manageable = isKnownAgentId(agent.id);
  const toggleable = manageable && TOGGLEABLE_KINDS.has(kind);
  // Approval comes first; a Codex app already running then needs a restart too.
  const restartAfterTrust = kind === "needs_trust" ? codexRestart(agent.integration.problems) : null;

  const recheckButton = (
    <Button size="sm" icon="refresh" loading={busy === "recheck"} disabled={busy !== null && busy !== "recheck"} onClick={onRecheck}>
      {busy === "recheck" ? "Checking…" : "Check again"}
    </Button>
  );

  let actions: ReactNode = null;
  if (manageable) {
    switch (kind) {
      case "not_installed":
      case "otel_conflict":
        actions = recheckButton;
        break;
      case "broken":
        actions = (
          <Button size="sm" variant="primary" icon="wrench" loading={busy === "repair"} onClick={onRepair}>
            {busy === "repair" ? "Repairing…" : "Repair"}
          </Button>
        );
        break;
      case "hooks_disabled":
      case "unknown":
        actions = recheckButton;
        break;
      case "invalid_config":
      case "foreign_extension":
        actions = (
          <>
            <Button size="sm" icon="folder" loading={busy === "reveal"} disabled={busy === "recheck"} onClick={onReveal}>
              {platformCopy().showInFileManager}
            </Button>
            {recheckButton}
          </>
        );
        break;
      case "needs_trust":
      case "restart_required":
      case "daemon_restart_required":
        actions = recheckButton;
        break;
      default:
        break;
    }
  }

  return (
    <li className="agents-row" data-agent-row={agent.id}>
      <div className="agents-row-head">
        <AgentTile agent={agent.id} />
        <h4 ref={headingRef} tabIndex={-1} className="agents-row-name">
          {name}
        </h4>
        <Pill tone={pillTone}>{pillLabel}</Pill>
        {toggleable ? (
          <Switch
            checked={kind !== "disabled"}
            label={`Capture ${name} sessions`}
            disabled={busy !== null}
            aria-busy={busy === "toggle" ? true : undefined}
            onCheckedChange={onToggle}
          />
        ) : null}
      </div>
      <p className="agents-row-detail">{detailFor(kind, agent, liveSessionCount, now, shownConfigPath)}</p>
      {manageable && kind === "needs_trust" ? <StepList className="agents-row-indent" label={`How to approve ${name}’s hooks`} steps={CODEX_TRUST_STEPS} /> : null}
      {manageable && kind === "needs_trust" && restartAfterTrust ? (
        <>
          <p className="agents-row-detail">
            {restartAfterTrust === DAEMON_RESTART
              ? `Then restart ${name}’s background app server: it was already running when capture was set up.`
              : `Then restart the ${name} app: it was already open when capture was set up.`}
          </p>
          <StepList className="agents-row-indent" label={RESTART_STEPS_LABEL[restartAfterTrust]} steps={RESTART_STEPS[restartAfterTrust]} />
        </>
      ) : null}
      {kind === "restart_required" || kind === "daemon_restart_required" ? (
        <StepList className="agents-row-indent" label={RESTART_STEPS_LABEL[kind]} steps={[...RESTART_STEPS[kind], CLEARS_ON_ITS_OWN]} />
      ) : null}
      {error ? (
        <div className="agents-row-indent agents-row-error">
          <Banner tone="error" role="alert" title={error.title}>
            {error.body}
          </Banner>
        </div>
      ) : null}
      {actions ? <div className="bp-btn-row agents-row-indent agents-row-actions">{actions}</div> : null}
    </li>
  );
}
