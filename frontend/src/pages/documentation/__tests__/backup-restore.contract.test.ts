// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../sections/installing-backup-and-restore.tsx"), "utf8");
const restore = source.split('title="Restore database and local resources"')[1]?.split("</CodeExample>")[0];
if (!restore) throw new Error("Restore procedure is missing");
const restoreScript = restore.match(/\{`([\s\S]*?)`\}/)?.[1]?.replaceAll("\\${", "${");
if (!restoreScript) throw new Error("Restore script is missing");

describe("cold restore procedure", () => {
  it("waits for PostgreSQL and stops after any restore failure", () => {
    expect(restore).toContain("set -euo pipefail");
    expect(restore).toContain("up -d --wait --wait-timeout 60 postgres");
    expect(restore).toContain("--exit-on-error");
    expect(restore.indexOf("--wait-timeout")).toBeLessThan(restore.indexOf("pg_restore"));
  });

  it("creates the explicitly named resource volume before extracting the archive", () => {
    expect(restore).toContain("export COMPOSE_PROJECT_NAME=backplane-restore");
    expect(restore).toContain('docker volume create "$BACKPLANE_RESOURCE_VOLUME"');
    expect(restore.indexOf("docker volume create")).toBeLessThan(restore.indexOf("tar xzf"));
    expect(restore).toContain("COMPOSE_PROJECT_NAME}_backplane-storage");
  });

  it.each(["--wait-timeout", "pg_restore"])("aborts the copied script when %s fails", (failedCommand) => {
    const directory = mkdtempSync(join(tmpdir(), "backplane-restore-"));
    try {
      writeFileSync(join(directory, "backplane-2026-07-25.dump"), "test dump");
      const result = spawnSync("bash", ["-c", `
        git() { return 0; }
        cp() { return 0; }
        docker() {
          printf '%s\\n' "$*" >> commands.log
          case "$*" in *${failedCommand}*) return 1 ;; esac
        }
        ${restoreScript}
      `], { cwd: directory, encoding: "utf8" });
      expect(result.status).toBe(1);
      const commands = readFileSync(join(directory, "commands.log"), "utf8");
      expect(commands).toContain(failedCommand);
      expect(commands).not.toContain("volume create");
      expect(commands).not.toContain("--build");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
