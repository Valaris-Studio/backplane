// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { createElement } from "react";

import { commands, type BoardsOverview, type DiscoveredProject, type MappingCreate_Deserialize } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import type { PrivacyLevel } from "../../components/privacy-levels";
import { confirmDialog, showToast } from "../../shell/layers";
import { refreshAfterPolicyChange, type ProjectMapping } from "../../stores/projects";
import { BOUND_TOAST, REASON_CHIP, UNKNOWN_CONFLICT, bindFailureMessage, failureKind, failureReason } from "./copy";
import { folderName } from "./paths";
import { safeRepo } from "./repo";

/** What a bind is for: a repository (bound by its remote) or a plain folder (bound by its path). */
export type BindTarget =
  | { kind: "repo"; root: string | null; repo: string; name: string; linkedBoardIds: readonly string[] }
  | { kind: "folder"; root: string; name: string; linkedBoardIds: readonly string[] };

/** The daemon's reason, or not_bound for one this build does not know. */
export function reasonOf(project: DiscoveredProject): string {
  return project.reason && project.reason in REASON_CHIP ? project.reason : "not_bound";
}

/** A repo binds by its remote only when that is a plain host/owner/repo; anything else binds the folder. */
export function bindTargetFor(project: DiscoveredProject, catalog: BoardsOverview | null): BindTarget {
  const name = folderName(project.root);
  const repo = safeRepo(project.repo_url);
  if (reasonOf(project) === "no_origin" || !repo) return { kind: "folder", root: project.root, name, linkedBoardIds: [] };
  const listed = catalog?.workspaces.flatMap((workspace) => workspace.boards.filter((board) => board.repos.includes(repo)).map((board) => board.id)) ?? [];
  const linkedBoardIds = [...new Set([...(project.candidates ?? []).map((candidate) => candidate.board_id), ...listed])];
  return { kind: "repo", root: project.root, repo, name, linkedBoardIds };
}

export interface BoardChoice {
  workspaceId: string;
  boardId: string;
  boardName: string;
}

export type BindOutcome = { status: "bound" } | { status: "failed"; message: string } | { status: "cancelled" };

function createRequest(target: BindTarget, choice: BoardChoice, level: PrivacyLevel): MappingCreate_Deserialize {
  const where = target.kind === "repo" ? { repo_url: target.repo } : { root_path: target.root };
  return { workspace_id: choice.workspaceId, board_id: choice.boardId, ...where, content_level: level };
}

/** The binding a conflict is about: the same folder, or for a repository only a rootless binding of that repository. */
function existingBinding(target: BindTarget, mappings: readonly ProjectMapping[]): ProjectMapping | undefined {
  if (target.kind === "folder") return mappings.find((mapping) => mapping.root_path === target.root);
  return mappings.find((mapping) => !mapping.root_path && mapping.repo_url_normalized === target.repo);
}

async function create(target: BindTarget, choice: BoardChoice, level: PrivacyLevel) {
  return callDaemon(() => commands.mappingCreate(createRequest(target, choice, level)));
}

/**
 * Binds, and on a conflict (DK-3: the repository or folder is bound to another
 * board already) asks before deleting that binding and binding here. Nothing is
 * deleted without the explicit confirm.
 */
export async function bind(
  target: BindTarget,
  choice: BoardChoice,
  level: PrivacyLevel,
  mappings: readonly ProjectMapping[],
  returnFocusTo: HTMLElement | null,
): Promise<BindOutcome> {
  const first = await create(target, choice, level);
  if (first.ok) return bound(target, choice);
  if (failureKind(first.error) !== "conflict") return { status: "failed", message: bindFailureMessage(first.error, target.name) };

  const old = existingBinding(target, mappings);
  if (!old) return { status: "failed", message: UNKNOWN_CONFLICT };

  const oldBoard = old.board_name ?? "another board";
  // Once the old binding is deleted, a retry must not delete again, and every
  // later failure has to say it is gone.
  let oldDeleted = false;
  let failedAfterDelete: string | null = null;
  const confirmed = await confirmDialog({
    title: "Already bound elsewhere",
    body: createElement(
      "p",
      null,
      `${target.name} is already bound to ${oldBoard}. Deleting that binding stops capture there; sessions already uploaded stay in Backplane.`,
    ),
    confirmLabel: "Delete the old binding and bind here",
    tone: "danger",
    returnFocusTo,
    onConfirm: async (dialog) => {
      if (!oldDeleted) {
        const deleted = await callDaemon(() => commands.mappingDelete(old.id));
        // Already gone (deleted elsewhere, or by an earlier try) is what the delete was for.
        if (!deleted.ok && failureKind(deleted.error) !== "not_found") throw new Error(bindFailureMessage(deleted.error, target.name));
        oldDeleted = true;
        refreshAfterPolicyChange();
      }
      const retried = await create(target, choice, level);
      if (!retried.ok) {
        failedAfterDelete = `The old binding to ${oldBoard} was removed, but binding here failed. ${failureReason(retried.error)}`;
        // Nothing is left to delete, so the button only binds now.
        dialog.update({ confirmLabel: "Bind here" });
        throw new Error(failedAfterDelete);
      }
    },
  });
  if (confirmed) return bound(target, choice);
  return failedAfterDelete ? { status: "failed", message: failedAfterDelete } : { status: "cancelled" };
}

function bound(target: BindTarget, choice: BoardChoice): BindOutcome {
  refreshAfterPolicyChange();
  showToast(BOUND_TOAST(target.name, choice.boardName));
  return { status: "bound" };
}
