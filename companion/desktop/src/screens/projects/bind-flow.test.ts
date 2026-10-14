// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { confirmActiveDialog, layersStore, settleDialog } from "../../shell/layers";
import type { ProjectMapping } from "../../stores/projects";
import { resetProjectsForTests } from "../../stores/projects";
import { mockDaemonIpc } from "../../test/daemon-ipc";
import { bind, type BindTarget } from "./bind-flow";
import { UNKNOWN_CONFLICT } from "./copy";
import { HOME, SERVER_UNREACHABLE, apiError, backplaneMapping, createdMapping } from "./projects-fixtures";

const fleet = { workspaceId: "w-northwind", boardId: "b-fleet", boardName: "Fleet portal" };
const joined = (mapping: Partial<ProjectMapping> & { id: string }): ProjectMapping => ({
  ...backplaneMapping,
  board_name: "Docs",
  workspace_name: "Internal projects",
  workspace_slug: "internal",
  ...mapping,
});

const folder: BindTarget = { kind: "folder", root: `${HOME}/dotfiles`, name: "dotfiles", linkedBoardIds: [] };
const repo: BindTarget = { kind: "repo", root: `${HOME}/dotfiles`, repo: "github.com/ada/dotfiles", name: "dotfiles", linkedBoardIds: [] };
const oldFolderBinding = joined({ id: "m-old", root_path: `${HOME}/dotfiles`, repo_url_normalized: null });

type Step = "ok" | "conflict" | "unreachable" | "not_found";

function daemon({ creates, deletes = ["ok"] }: { creates: Step[]; deletes?: Step[] }) {
  const calls: string[] = [];
  const answer = (steps: Step[], ok: () => unknown) => {
    const step = steps.shift() ?? "ok";
    if (step === "conflict") throw apiError(409, "conflict");
    if (step === "unreachable") throw SERVER_UNREACHABLE;
    if (step === "not_found") throw apiError(404, "not_found");
    return ok();
  };
  mockDaemonIpc({
    mapping_create: () => {
      calls.push("create");
      return answer(creates, () => createdMapping());
    },
    mapping_delete: (args) => {
      calls.push(`delete ${String(args.id)}`);
      return answer(deletes, () => ({ deleted: args.id }));
    },
    projects: () => ({ mappings: [], discovered: [], ignored: [] }),
    boards: () => ({ workspaces: [] }),
  });
  return calls;
}

const dialogError = () => layersStore.get().dialog?.error ?? null;

/** Starts a bind and waits until it either asks (the dialog is up) or finishes. */
async function startConflict(target: BindTarget, mappings: ProjectMapping[]) {
  let finished = false;
  const outcome = bind(target, fleet, "standard", mappings, null).finally(() => {
    finished = true;
  });
  await waitFor(() => expect(finished || layersStore.get().dialog !== null).toBe(true));
  // Wrapped: an async function returning the promise itself would wait for it.
  return { outcome };
}

beforeEach(() => {
  resetProjectsForTests();
});

describe("bind, on a conflict", () => {
  it("deletes the old binding once and binds here", async () => {
    const calls = daemon({ creates: ["conflict", "ok"] });
    const { outcome } = await startConflict(folder, [oldFolderBinding]);
    expect(layersStore.get().dialog?.options.title).toBe("Already bound elsewhere");
    await act(() => confirmActiveDialog());
    expect(await outcome).toEqual({ status: "bound" });
    expect(calls).toEqual(["create", "delete m-old", "create"]);
  });

  it("says honestly that the old binding is gone when binding here then fails, and a retry skips the delete", async () => {
    const calls = daemon({ creates: ["conflict", "unreachable", "ok"] });
    const { outcome } = await startConflict(folder, [oldFolderBinding]);
    await act(() => confirmActiveDialog());
    expect(dialogError()).toBe("The old binding to Docs was removed, but binding here failed. Backplane can’t be reached right now.");
    expect(layersStore.get().dialog?.options.confirmLabel).toBe("Bind here");
    await act(() => confirmActiveDialog());
    expect(await outcome).toEqual({ status: "bound" });
    expect(calls).toEqual(["create", "delete m-old", "create", "create"]);
  });

  it("reports the removed binding to the sheet when the dialog is cancelled after the delete", async () => {
    const calls = daemon({ creates: ["conflict", "unreachable"] });
    const { outcome } = await startConflict(folder, [oldFolderBinding]);
    await act(() => confirmActiveDialog());
    act(() => settleDialog(false));
    expect(await outcome).toEqual({ status: "failed", message: "The old binding to Docs was removed, but binding here failed. Backplane can’t be reached right now." });
    expect(calls).toEqual(["create", "delete m-old", "create"]);
  });

  it("retries the delete itself when the delete failed, and never deletes twice once it worked", async () => {
    const calls = daemon({ creates: ["conflict", "ok"], deletes: ["unreachable", "ok"] });
    const { outcome } = await startConflict(folder, [oldFolderBinding]);
    await act(() => confirmActiveDialog());
    expect(dialogError()).toBe("Backplane can’t be reached right now. Nothing was bound; try again in a moment.");
    await act(() => confirmActiveDialog());
    expect(await outcome).toEqual({ status: "bound" });
    expect(calls).toEqual(["create", "delete m-old", "delete m-old", "create"]);
  });

  it("treats an old binding that is already gone as deleted", async () => {
    const calls = daemon({ creates: ["conflict", "ok"], deletes: ["not_found"] });
    const { outcome } = await startConflict(folder, [oldFolderBinding]);
    await act(() => confirmActiveDialog());
    expect(await outcome).toEqual({ status: "bound" });
    expect(calls).toEqual(["create", "delete m-old", "create"]);
  });

  it("cancelling before confirming deletes nothing", async () => {
    const calls = daemon({ creates: ["conflict"] });
    const { outcome } = await startConflict(folder, [oldFolderBinding]);
    act(() => settleDialog(false));
    expect(await outcome).toEqual({ status: "cancelled" });
    expect(calls).toEqual(["create"]);
  });

  it("for a repository, offers only a rootless binding of that same repository", async () => {
    const calls = daemon({ creates: ["conflict", "ok"] });
    const rootless = joined({ id: "m-repo", root_path: null, repo_url_normalized: "github.com/ada/dotfiles" });
    const { outcome } = await startConflict(repo, [rootless]);
    await act(() => confirmActiveDialog());
    expect(await outcome).toEqual({ status: "bound" });
    expect(calls).toEqual(["create", "delete m-repo", "create"]);
  });

  it("for a repository, never offers to delete a folder binding at the same path", async () => {
    const calls = daemon({ creates: ["conflict"] });
    const sameFolder = joined({ id: "m-folder", root_path: `${HOME}/dotfiles`, repo_url_normalized: "github.com/ada/dotfiles" });
    const { outcome } = await startConflict(repo, [sameFolder]);
    expect(layersStore.get().dialog).toBeNull();
    expect(await outcome).toEqual({ status: "failed", message: UNKNOWN_CONFLICT });
    expect(calls).toEqual(["create"]);
  });

  it("for a repository, never offers to delete a rootless binding of another repository", async () => {
    daemon({ creates: ["conflict"] });
    const other = joined({ id: "m-other", root_path: null, repo_url_normalized: "github.com/ada/other" });
    const { outcome } = await startConflict(repo, [other]);
    expect(await outcome).toEqual({ status: "failed", message: UNKNOWN_CONFLICT });
  });
});
