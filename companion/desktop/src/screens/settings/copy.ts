// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { UpdateFailed } from "../../ipc/bindings";
import type { CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";
import type { UpdateFailure } from "./updater";

export const DEVICE_NAME_MAX_LENGTH = 80;

/** Counts code points, so an emoji is one character, not two UTF-16 units. */
export function characterCount(text: string): number {
  return [...text].length;
}

export function validateDeviceName(name: string): string | null {
  const length = characterCount(name);
  if (length === 0) return "The name can’t be empty.";
  if (length > DEVICE_NAME_MAX_LENGTH) return `Keep it to ${DEVICE_NAME_MAX_LENGTH} characters or fewer.`;
  return null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const SHORT_ID_EDGE = 4;

/** "7c1e…a94f", as the mockup shows device ids. */
export function shortId(id: string): string {
  if (id.length <= SHORT_ID_EDGE * 2 + 2) return id;
  return `${id.slice(0, SHORT_ID_EDGE)}…${id.slice(-SHORT_ID_EDGE)}`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

export function formatCheckedAt(date: Date): string {
  return `checked today at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

const DAEMON_DOWN = "Companion isn’t running";

/** For a daemon command that changes nothing on failure; the raw message never reaches the UI. */
export function renameFailure(error: CompanionError): string {
  if (error.kind === "unreachable") return `${DAEMON_DOWN}, so the name didn’t change. Try again in a moment.`;
  if (error.kind === "api") {
    switch (error.code) {
      case "server_unreachable":
        return "Couldn’t reach Backplane, so the name didn’t change. Try again.";
      case "unauthorized_device":
      case "not_connected":
        return `${platformCopy().ThisDevice} isn’t connected, so it can’t be renamed.`;
      case "invalid_request":
      case "server_rejected":
        return "Backplane didn’t accept that name. Try another.";
    }
  }
  return `Couldn’t rename ${platformCopy().thisDevice}. Try again.`;
}

export function exportFailure(error: CompanionError): string {
  switch (error.kind) {
    case "unreachable":
      return `${DAEMON_DOWN}, so there’s nothing to export. Try again in a moment.`;
    case "local":
      return "Couldn’t save the file there. Try another folder.";
    case "timeout":
      return "Exporting took too long. Try again.";
    default:
      return "Companion couldn’t put the diagnostics together. Try again.";
  }
}

export function disconnectFailure(error: CompanionError): string {
  if (error.kind === "unreachable") return `${DAEMON_DOWN}, so nothing changed. Try again in a moment.`;
  return `${platformCopy().ThisDevice} couldn’t be signed out. Try again.`;
}

/**
 * Upload failure codes the daemon records in `queue.last_error` (internal/daemon errorCode).
 * Getters name the device only once the platform is known.
 */
const LAST_ERROR_COPY: Record<string, string> = {
  unavailable: "Server unreachable",
  get device_revoked() {
    return `${platformCopy().ThisDevice} was signed out`;
  },
  get unauthorized() {
    return `${platformCopy().ThisDevice} was signed out`;
  },
  forbidden: "Backplane refused the upload",
  get not_found() {
    return `Backplane didn’t recognize ${platformCopy().thisDevice}`;
  },
  conflict: "Backplane refused a duplicate upload",
  payload_too_large: "A session was too large to upload",
  unprocessable: "Backplane rejected an upload",
  unexpected_status: "Unexpected answer from Backplane",
  invalid_response: "Unexpected answer from Backplane",
  malformed_acknowledgement: "Unexpected answer from Backplane",
  ack_settled_nothing: "Unexpected answer from Backplane",
  invalid_policy: "Capture settings from Backplane were invalid",
  unsafe_storage_path: "The local storage folder isn’t safe to use",
  agent_config_invalid: "An agent’s settings file couldn’t be read",
  agent_config_symlink: "An agent’s settings file couldn’t be read",
  agent_config_not_owned: "An agent’s settings file couldn’t be read",
  "context canceled": "An upload was interrupted",
  "context deadline exceeded": "An upload timed out",
};

export function lastErrorCopy(code: string | null): string {
  if (!code) return "None";
  return LAST_ERROR_COPY[code] ?? "Unexpected error";
}

const UPDATES_BY_INSTALLER = "This version updates by installing the new release. Checking here isn’t available yet.";
// A build without an updater key never checks: nothing it downloaded could be verified.
const UPDATES_OFF_IN_BUILD = "Updates are off in this build. Install a newer release to update.";

export function updateCheckFailure(error: UpdateFailure): string {
  switch (error.kind) {
    case "updates_unavailable_on_platform":
      return UPDATES_BY_INSTALLER;
    case "updates_not_configured":
      return UPDATES_OFF_IN_BUILD;
    case "not_bundled":
      return "Updates work only in the installed app.";
    case "busy":
      return "An update is already installing.";
    case "check":
      return "Couldn’t reach the update server. Check your connection.";
    default:
      return "Couldn’t check for updates. Try again.";
  }
}

export function installFailure(error: UpdateFailure, runningVersion: string): string {
  const unchanged = `You’re still on ${runningVersion}.`;
  switch (error.kind) {
    case "download":
      return "The download didn’t finish. Check your connection and try again.";
    case "signature":
      return `The update’s signature didn’t check out, so it wasn’t installed. ${unchanged}`;
    case "capture":
      return `Capture couldn’t be paused for the update, so nothing changed. ${unchanged}`;
    case "keep_previous":
      return `The current version couldn’t be kept as a fallback, so the update wasn’t installed. ${unchanged}`;
    case "no_update":
      return "That update isn’t offered any more. Check again.";
    case "busy":
      return "An update is already installing.";
    case "not_bundled":
      return "Updates work only in the installed app.";
    case "updates_unavailable_on_platform":
      return UPDATES_BY_INSTALLER;
    case "updates_not_configured":
      return UPDATES_OFF_IN_BUILD;
    default:
      return `The update couldn’t be installed. ${unchanged}`;
  }
}

export interface RolledBackCopy {
  title: string;
  body: string;
}

export function rolledBackCopy(failure: UpdateFailed): RolledBackCopy {
  const restored = "The last update didn’t work, so the previous version was restored.";
  const back = `so you’re back on ${failure.from_version}.`;
  switch (failure.reason) {
    case "app_version_mismatch":
      return { title: restored, body: `Companion ${failure.to_version} started as the wrong version, ${back}` };
    case "refresh_failed":
      return { title: restored, body: `Companion ${failure.to_version} couldn’t restart the background service, ${back}` };
    case "unhealthy":
      return { title: restored, body: `Companion ${failure.to_version} didn’t start up healthy, ${back}` };
    case "rollback_copy_untrusted":
      return {
        title: "The last update didn’t work, and the previous version couldn’t be restored.",
        body: `Its backup copy wasn’t signed by Backplane, so Companion ${failure.to_version} was kept. Export diagnostics and contact support.`,
      };
  }
}
