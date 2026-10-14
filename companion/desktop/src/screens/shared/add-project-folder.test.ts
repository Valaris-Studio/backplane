// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { mockDaemonIpc } from "../../test/daemon-ipc";
import { addProjectFolder } from "./add-project-folder";

const FOUND = { root: "/home/me/code/app", repo_url: "github.com/acme/app", first_seen: "2026-09-29T09:00:00Z", reason: "not_bound", candidates: [] };

const refusal = (status: number, code: string) => ({ kind: "api", status, code, message: "raw daemon message", detail: null });

describe("addProjectFolder", () => {
  it("answers the found project the daemon recorded", async () => {
    mockDaemonIpc({ pick_project_folder: () => FOUND });
    await expect(addProjectFolder()).resolves.toEqual({ status: "added", project: FOUND });
  });

  it("answers cancelled when the picker is dismissed", async () => {
    mockDaemonIpc({ pick_project_folder: () => null });
    await expect(addProjectFolder()).resolves.toEqual({ status: "cancelled" });
  });

  const refusals: Array<[string, unknown, string]> = [
    ["already bound", refusal(409, "already_mapped"), "That folder is already bound. It’s listed under Bound in Projects."],
    ["ignored", refusal(409, "ignored_path"), "That folder is on your Ignored list. Stop ignoring it in Projects to add it."],
    ["excluded", refusal(409, "excluded_path"), "That folder matches one of your never-capture rules, so it can’t be added."],
    ["home or disk root", refusal(400, "home_or_root"), "Choose a project’s own folder, not your home folder or the whole disk."],
    ["temporary", refusal(400, "temp_dir"), "Temporary folders are never captured. Choose a project folder."],
    ["gone", refusal(400, "not_a_directory"), "That folder no longer exists. Choose another one."],
    ["list full", refusal(409, "too_many_projects"), "Too many folders are waiting. Bind or ignore some in Projects first."],
    ["daemon down", { kind: "unreachable", reason: "socket_unavailable" }, "Couldn’t add the folder. The Companion service isn’t running."],
    ["picker failed", { kind: "local", message: "no window" }, "Couldn’t open the folder picker. Try again."],
    ["anything else", refusal(500, "internal"), "Couldn’t add the folder. Try again in a moment."],
  ];

  it.each(refusals)("explains a %s refusal in its own words, never the daemon's", async (_label, error, message) => {
    mockDaemonIpc({
      pick_project_folder: () => {
        throw error;
      },
    });
    await expect(addProjectFolder()).resolves.toEqual({ status: "failed", message });
  });
});
