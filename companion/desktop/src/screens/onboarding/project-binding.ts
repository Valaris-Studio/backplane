// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type DiscoveredProject } from "../../ipc/bindings";
import type { PrivacyLevel } from "../../components/privacy-levels";
import { callDaemon } from "../../ipc/daemon";
import type { CompanionError } from "../../ipc/errors";

export function projectName(project: DiscoveredProject): string {
  return project.root.split("/").filter(Boolean).at(-1) ?? project.root;
}

/** Binds a folder to a board; the daemon refreshes its policy right after. Resolves to the error, or null. */
export async function bindProject(
  project: DiscoveredProject,
  board: { workspace_id: string; board_id: string },
  level: PrivacyLevel,
): Promise<CompanionError | null> {
  const result = await callDaemon(() =>
    commands.mappingCreate({
      workspace_id: board.workspace_id,
      board_id: board.board_id,
      root_path: project.root,
      ...(project.repo_url ? { repo_url: project.repo_url } : {}),
      content_level: level,
    }),
  );
  return result.ok ? null : result.error;
}
