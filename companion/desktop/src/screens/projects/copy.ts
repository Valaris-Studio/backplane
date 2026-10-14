// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";

// Every message here is a fixed template keyed on the error envelope's code or
// kind: the daemon's own `message` is free text this build hasn't reviewed.

export type FailureKind =
  | "daemon_down"
  | "server_unreachable"
  | "unauthorized_device"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "invalid_request"
  | "rich_unavailable"
  | "other";

function upstreamStatus(detail: unknown): number | null {
  if (typeof detail !== "object" || detail === null || !("status" in detail)) return null;
  return typeof detail.status === "number" ? detail.status : null;
}

function upstreamCode(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null || !("error_code" in detail)) return null;
  return typeof detail.error_code === "string" ? detail.error_code : null;
}

export function failureKind(error: CompanionError): FailureKind {
  switch (error.kind) {
    case "unreachable":
      return "daemon_down";
    case "timeout":
      return "server_unreachable";
    case "api":
      break;
    default:
      return "other";
  }
  // The server's own code wins over the envelope the daemon wrapped it in
  // (409 conflict or 502 server_rejected), so a refused rich level is never
  // taken for a binding conflict.
  if (upstreamCode(error.detail) === "rich_capture_unavailable") return "rich_unavailable";
  switch (error.code) {
    case "server_unreachable":
    case "unauthorized_device":
    case "not_found":
    case "conflict":
    case "invalid_request":
    case "forbidden":
      return error.code as FailureKind;
    case "server_rejected":
      // The daemon forwards a server 403 as server_rejected with the upstream status (proxy.go).
      return upstreamStatus(error.detail) === 403 ? "forbidden" : "other";
    default:
      return "other";
  }
}

// The server refused the rich level: it was offered, then turned off.
const RICH_CAPTURE_OFF = "Rich capture isn’t enabled on this Backplane.";

/** One short sentence saying why, for toasts that start "Couldn’t …". */
export function failureReason(error: CompanionError): string {
  switch (failureKind(error)) {
    case "daemon_down":
      return "The Companion service isn’t running.";
    case "server_unreachable":
      return "Backplane can’t be reached right now.";
    case "unauthorized_device":
      return `Backplane disconnected ${platformCopy().thisDevice}.`;
    case "forbidden":
      return "Backplane refused the change.";
    case "not_found":
      return "Backplane no longer has it.";
    case "rich_unavailable":
      return RICH_CAPTURE_OFF;
    default:
      return "Try again in a moment.";
  }
}

/** What went wrong with a bind, and what to do next. Conflicts are handled by the caller. */
export function bindFailureMessage(error: CompanionError, folder: string): string {
  switch (failureKind(error)) {
    case "rich_unavailable":
      return `${RICH_CAPTURE_OFF} Nothing was bound; pick another level.`;
    case "not_found":
      return "That board no longer exists, or you can no longer open it. Pick another board.";
    case "forbidden":
      return "You no longer have access to that workspace. Pick a board you can open.";
    case "server_unreachable":
      return "Backplane can’t be reached right now. Nothing was bound; try again in a moment.";
    case "daemon_down":
      return "The Companion service isn’t running, so nothing was bound. Try again once it starts.";
    case "unauthorized_device":
      return `Backplane disconnected ${platformCopy().thisDevice}. Connect it again to bind folders.`;
    case "invalid_request":
      return "Backplane didn’t accept this binding. Pick another board or try again.";
    case "conflict":
      return UNKNOWN_CONFLICT;
    default:
      return `Couldn’t bind ${folder}. Try again.`;
  }
}

export const UNKNOWN_CONFLICT = "It’s already bound to another board, so it can’t be bound here too.";

export const BOUND_TOAST = (folder: string, board: string) => `Bound ${folder} to ${board}. New sessions there are captured.`;

export const NO_BOARDS_REACH = "You can only bind to boards you can open in Backplane.";

export const RULE_REFUSED = "Backplane didn’t accept that pattern. Use a folder path with * or ** wildcards, like ~/clients/**.";

interface ReasonChip {
  label: (candidates: number) => string;
  warn: boolean;
}

const NOT_BOUND_CHIP: ReasonChip = { label: () => "Not bound", warn: false };

export const REASON_CHIP: Record<string, ReasonChip> = {
  not_bound: NOT_BOUND_CHIP,
  auto_match_off: { label: () => "Auto-match off", warn: false },
  ambiguous: { label: (candidates) => `Matches ${Math.max(candidates, 2)} boards`, warn: true },
  excluded: { label: () => "Excluded", warn: true },
  no_origin: { label: () => "No git remote", warn: false },
};

export function reasonChip(reason: string): ReasonChip {
  return REASON_CHIP[reason] ?? NOT_BOUND_CHIP;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function countWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

// Agents on this board (DK-12e): every string the agent access UI shows. Codes
// this build doesn't know get the generic words, never the code itself.

export const AGENT_ACCESS_TITLE = "Let your agents work on this board";

export const agentAccessSwitchLabel = (folder: string) => `Let your agents work on this board from ${folder}`;

export const agentAccessListLabel = (folder: string) => `Agents working from ${folder}`;

export const agentAccessExplain = () => `Your coding agents get Backplane tools for this board. The key stays in ${platformCopy().credentialStoreName}.`;

export const AGENT_ACCESS_NOT_CONNECTED = () => `Connect ${platformCopy().thisDevice} to Backplane to turn this on.`;

export const AGENT_ACCESS_ROOT_UNKNOWN = () => `${platformCopy().ThisDevice} hasn’t found this repository’s folder yet. Run an agent in it once, then come back.`;

export const AGENT_SCOPE: Record<string, string> = {
  folder: "This folder",
  global: "Follows the folder you’re in",
};

export type AgentPillTone = "neutral" | "success" | "warning" | "error";

export const AGENT_PILL = {
  ready: { tone: "success", label: "Ready" },
  setting_up: { tone: "neutral", label: "Setting up" },
  needs_you: { tone: "warning", label: "Needs you" },
  not_available: { tone: "neutral", label: "Not available" },
  not_installed: { tone: "neutral", label: "Not installed" },
  optional: { tone: "neutral", label: "Optional" },
  failed: { tone: "error", label: "Couldn’t set up" },
  restart: { tone: "warning", label: "Restart needed" },
  needs_uv: { tone: "warning", label: "Needs uv" },
  unknown: { tone: "neutral", label: "Not ready" },
} satisfies Record<string, { tone: AgentPillTone; label: string }>;

/** One short reason per daemon problem code; `agent` is the agent's display name. */
export const AGENT_PROBLEM_REASON: Record<string, (agent: string) => string> = {
  agent_not_installed: () => `Not installed on ${platformCopy().thisDevice}.`,
  agent_config_invalid: (agent) => `${agent}’s config file can’t be read, so it was left alone. Fix it in your editor.`,
  agent_config_changed: (agent) => `${agent} was changing its config. Trying again shortly.`,
  agent_config_symlink: (agent) => `${agent}’s config file is a link, so the Companion leaves it alone.`,
  uvx_missing: () => "Starts once uv is installed.",
  restart_required: (agent) => `Restart the ${agent} app to pick up Backplane tools. It was already open when they were set up.`,
  folder_bound_to_other_mapping: (agent) => `Another bound folder in this repository already has ${agent}’s Backplane tools.`,
  worktree_link_untrusted: () => "Set up for this folder only, not its other worktrees.",
};

/** Reasons for a state that comes without a problem code. */
export const AGENT_STATE_REASON: Record<string, (agent: string) => string> = {
  unsupported: (agent) => `Turn ${agent} on under Agents to give it Backplane tools.`,
  error: (agent) => `Couldn’t update ${agent}’s config. The Companion will try again.`,
};

export const AGENT_UNKNOWN_REASON = "This version of the app can’t explain this yet.";

export const PI_ADAPTER = {
  reason: "Pi gets Backplane tools through the optional pi-mcp-adapter package.",
  howTo: "To add it, run",
  command: "pi install npm:pi-mcp-adapter",
};

/** "Codex already has a server named <backplane>. Rename yours…", split around the entry's name. */
export const NAME_TAKEN = {
  lead: (agent: string) => `${agent} already has a server named`,
  tail: ". Rename yours so the Companion can add its own.",
};

export const AGENT_WARNINGS_TITLE = "Your agents have other Backplane servers";
export const AGENT_WARNINGS_LABEL = "Other Backplane servers your agents have";

/** Each overlap warning, split around the entry's name, which is shown as code. */
export const AGENT_WARNING: Record<string, { lead: string; tail: (agent: string) => string }> = {
  same_endpoint: { lead: "You also have", tail: (agent) => `set up for this server in ${agent} — your agent will see the tools twice.` },
  // The daemon reports this both for an entry pointing at another server and for one it can't tell (no API URL), so no claim about doubling.
  other_backplane_entry: { lead: "You also have", tail: (agent) => `set up as another Backplane server in ${agent}. Your agent will see its tools next to this board’s.` },
};
export const AGENT_WARNING_UNKNOWN = { lead: "You also have", tail: (agent: string) => `in ${agent}, which may overlap with Backplane’s tools.` };

export const UV_MISSING = {
  title: "Install uv to let agents use Backplane",
  body: "Your agents start Backplane’s tools with uv. It’s free and quick to install.",
  action: "How to install uv",
  openFailed: "Couldn’t open uv’s install page in your browser.",
};

export const KEY_DELETED = {
  title: "The key was deleted on the web — turn it back on",
  body: "Until then, your agents can’t reach Backplane.",
  action: "Turn it back on",
  failed: (reason: string) => `Couldn’t turn agent access back on. ${reason}`,
};

export const agentAccessToggleFailed = (enabled: boolean, folder: string, reason: string) =>
  `Couldn’t turn ${enabled ? "on" : "off"} agent access for ${folder}. ${reason}`;

/** Why agent_access_set failed: the daemon's own codes first, then the shared reasons. */
export function agentAccessFailureReason(error: CompanionError): string {
  if (error.kind === "api" && error.code === "not_connected") return `Connect ${platformCopy().thisDevice} to Backplane first.`;
  if (error.kind === "api" && error.code === "mapping_root_unknown") return `${platformCopy().ThisDevice} hasn’t found this repository’s folder yet.`;
  return failureReason(error);
}
