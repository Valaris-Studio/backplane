// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";

export type AgentAction = "repair" | "enable" | "enable_setting" | "enable_setting_hook_left" | "disable" | "remove_hook" | "recheck" | "reveal";

export interface ErrorCopy {
  title: string;
  body: string;
}

const RETRY_BODY = "Try again. If it keeps failing, save a diagnostics file from Settings.";

function actionTitle(action: AgentAction, name: string): string {
  switch (action) {
    case "repair":
      return `Couldn’t repair ${name}’s hook.`;
    case "enable":
      return `Couldn’t add ${name}’s hook.`;
    case "enable_setting":
    case "enable_setting_hook_left":
      return `Couldn’t turn ${name} on.`;
    case "disable":
      return `Couldn’t turn ${name} off.`;
    case "remove_hook":
      return `Capture is off, but ${name}’s hook couldn’t be removed.`;
    case "recheck":
      return `Couldn’t check ${name} again.`;
    case "reveal":
      return platformCopy().fileManagerFailed;
  }
}

interface Cause {
  title: string;
  detail: string;
  /** Only true when the failed call was the whole action, so nothing else ran. */
  unchanged: boolean;
}

/** Where a failure came from, as fixed copy; the daemon's own message text is never shown, since it can carry paths. */
function cause(error: CompanionError): Cause | null {
  switch (error.kind) {
    case "unreachable":
    case "timeout":
      return { title: "Couldn’t reach the Companion.", detail: "It may be restarting. Try again in a moment.", unchanged: false };
    case "api":
      switch (error.code) {
        case "server_unreachable":
          return { title: "Can’t reach Backplane right now.", detail: `Try again when ${platformCopy().thisDevice} is back online.`, unchanged: true };
        case "unauthorized_device":
          return { title: `${platformCopy().ThisDevice} is no longer connected to Backplane.`, detail: "Connect it again from Settings.", unchanged: false };
        case "server_rejected":
          return { title: "Backplane didn’t accept the change.", detail: "Try again in a moment.", unchanged: true };
        default:
          return null;
      }
    default:
      return null;
  }
}

// Actions where something did change before the failure, so the copy must not say otherwise.
const PARTIAL_OUTCOME: Partial<Record<AgentAction, string>> = {
  remove_hook: "Its sessions aren’t captured.",
  enable_setting_hook_left: "Its hook is installed, but capture is off.",
};

export function describeAgentError(error: CompanionError, action: AgentAction, name: string): ErrorCopy {
  const known = cause(error);
  const outcome = PARTIAL_OUTCOME[action];
  if (outcome) return { title: actionTitle(action, name), body: `${outcome} ${known ? known.detail : RETRY_BODY}` };
  if (known) return { title: known.title, body: known.unchanged ? `Nothing was changed. ${known.detail}` : known.detail };
  if (action === "reveal") return { title: actionTitle(action, name), body: "Open it from your editor instead." };
  return { title: actionTitle(action, name), body: RETRY_BODY };
}
