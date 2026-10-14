// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";

// The daemon answers a locked or missing OS credential store with this code (503).
export const KEYCHAIN_UNAVAILABLE = "secure_credential_store_unavailable";

export interface Explanation {
  title: string;
  body: string;
}

export function isDaemonDown(error: CompanionError): boolean {
  return error.kind === "unreachable";
}

export function errorCode(error: CompanionError): string | null {
  return error.kind === "api" ? error.code : null;
}

// Every sentence is a fixed template keyed by the stable code: the daemon's
// message can carry CLI stderr or decoder text, which never reaches the screen.
// Getters name the device only once the platform is known.
const SENTENCE_FOR_CODE: Record<string, string> = {
  agent_config_invalid: "Its settings file isn’t valid, so Companion left it alone. Fix the file, then try again.",
  agent_config_symlink: "Its settings file is a link to another file, so Companion left it alone.",
  agent_config_changed: "Its settings file changed while Companion was editing it. Try again.",
  agent_config_not_owned: "Its settings already have a hook Companion didn’t add, so Companion left it alone.",
  unknown_agent: "Companion doesn’t know this agent.",
  get auto_match_disabled() {
    return `Automatic matching is off for ${platformCopy().thisDevice} in Backplane.`;
  },
  no_matching_board: "No board you can open in Backplane is linked to this repository.",
  not_found: "That’s no longer there. Refresh and try again.",
  conflict: "That changed somewhere else at the same time. Try again.",
  invalid_request: "Companion couldn’t understand that request.",
  get not_connected() {
    return `${platformCopy().ThisDevice} isn’t connected to Backplane.`;
  },
  server_unreachable: "Backplane can’t be reached right now. Check your connection and try again.",
  server_rejected: "Backplane turned the request down.",
  get unauthorized_device() {
    return `Backplane no longer accepts ${platformCopy().thisDevice}’s sign-in.`;
  },
  get [KEYCHAIN_UNAVAILABLE]() {
    return platformCopy().credentialStore.body;
  },
};

const GENERIC_SENTENCE = "Something went wrong in Companion. Try again.";

export function errorSentence(error: CompanionError): string {
  switch (error.kind) {
    case "api":
      return SENTENCE_FOR_CODE[error.code] ?? GENERIC_SENTENCE;
    case "timeout":
      return "Companion took too long to answer. Try again.";
    case "unreachable":
      return "Companion isn’t answering.";
    default:
      return GENERIC_SENTENCE;
  }
}

export const PAIRING_FAILED_EXPLANATION: Explanation = {
  title: "Pairing didn’t finish",
  body: "Nothing was connected. Get a new code and try again.",
};

export function pairingStartExplanation(error: CompanionError, host: string): Explanation {
  switch (errorCode(error)) {
    case "server_unreachable":
      return { title: `Can’t reach ${host}`, body: "No Backplane server answered at this address. Check it and your connection, then try again." };
    case "server_rejected":
      return { title: `${host} didn’t accept ${platformCopy().thisDevice}`, body: "The server answered but wouldn’t start pairing. Check that this is the address your team signs in to." };
    case KEYCHAIN_UNAVAILABLE:
      return platformCopy().credentialStore;
    case "unauthorized_device":
      return { title: `${platformCopy().ThisDevice}’s old connection was revoked`, body: "Backplane no longer accepts its previous sign-in. Start again to connect it with a new code." };
    default:
      return { title: "Couldn’t start pairing", body: errorSentence(error) };
  }
}
