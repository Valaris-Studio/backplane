// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { DiscoveredProject } from "../../ipc/bindings";
import type { CompanionError } from "../../ipc/errors";
import { pickProjectFolder } from "../../ipc/native";

export type AddFolderOutcome = { status: "added"; project: DiscoveredProject } | { status: "cancelled" } | { status: "failed"; message: string };

// Fixed templates keyed on the daemon's code: its own `message` is free text this build hasn't reviewed.
const REFUSALS: Record<string, string> = {
  already_mapped: "That folder is already bound. It’s listed under Bound in Projects.",
  ignored_path: "That folder is on your Ignored list. Stop ignoring it in Projects to add it.",
  excluded_path: "That folder matches one of your never-capture rules, so it can’t be added.",
  home_or_root: "Choose a project’s own folder, not your home folder or the whole disk.",
  temp_dir: "Temporary folders are never captured. Choose a project folder.",
  not_a_directory: "That folder no longer exists. Choose another one.",
  too_many_projects: "Too many folders are waiting. Bind or ignore some in Projects first.",
};

function failureMessage(error: CompanionError): string {
  switch (error.kind) {
    case "local":
      return "Couldn’t open the folder picker. Try again.";
    case "unreachable":
      return "Couldn’t add the folder. The Companion service isn’t running.";
    case "api":
      return REFUSALS[error.code] ?? "Couldn’t add the folder. Try again in a moment.";
    default:
      return "Couldn’t add the folder. Try again in a moment.";
  }
}

/** Opens the native folder picker; Rust hands the choice to the daemon, which records it as found. */
export async function addProjectFolder(): Promise<AddFolderOutcome> {
  const picked = await pickProjectFolder();
  if (!picked.ok) return { status: "failed", message: failureMessage(picked.error) };
  return picked.value === null ? { status: "cancelled" } : { status: "added", project: picked.value };
}
