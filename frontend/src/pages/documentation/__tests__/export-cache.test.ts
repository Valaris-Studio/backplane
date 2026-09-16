// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

it.each([false, true])("does not replace a running app's optimizer metadata (stale artifact: %s)", async (stale) => {
  const fixture = await mkdtemp(join(tmpdir(), "docs-cache-regression-"));
  try {
    const root = join(fixture, "frontend");
    const modules = join(root, "node_modules");
    const scratch = join(fixture, "scratch");
    const script = join(root, "scripts/export-documentation.mjs");
    const source = join(root, "src/pages/documentation/agent-export.tsx");
    const artifact = join(fixture, "backend/app/data/product-documentation.json");
    for (const path of [modules, scratch, dirname(script), dirname(source), dirname(artifact)]) {
      await mkdir(path, { recursive: true });
    }
    // Dependency packages are shared; the app's .vite directory stays local.
    for (const name of await readdir(join(frontend, "node_modules"))) {
      if (!name.startsWith(".")) await symlink(join(frontend, "node_modules", name), join(modules, name));
    }
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "vite.config.mjs"), 'export default { optimizeDeps: { include: ["react"], noDiscovery: true } };');
    await copyFile(join(frontend, "scripts/export-documentation.mjs"), script);
    const corpus = { schema_version: 1, locales: { en: [] } };
    // Leave the real optimizer enough time to commit, as it does during the
    // full corpus render. The client optimizer uses the real React package.
    await writeFile(source, `export async function exportDocumentation() { await new Promise(r => setTimeout(r, 700)); return ${JSON.stringify(corpus)}; }`);
    const version = createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
    await writeFile(artifact, JSON.stringify({ version: stale ? "stale" : version, ...corpus }, null, 2) + "\n");
    await run(process.execPath, ["--input-type=module", "-e", `
      import { optimizeDeps, resolveConfig } from "vite";
      const config = await resolveConfig({ root: ${JSON.stringify(root)} }, "serve");
      await optimizeDeps(config, true);
    `], { cwd: root, timeout: 30000 });
    const metadata = join(modules, ".vite/deps/_metadata.json");
    const before = await readFile(metadata, "utf8");
    const result = await run(process.execPath, [script, "--check"], {
      cwd: root,
      env: { ...process.env, TMPDIR: scratch },
      timeout: 30000,
    }).then(() => ({ passed: true, stderr: "" }), (error: { stderr: string }) => ({ passed: false, stderr: error.stderr }));
    expect(result.passed).toBe(!stale);
    if (stale) expect(result.stderr).toContain("artifact is stale");
    expect(await readFile(metadata, "utf8")).toBe(before);
    expect(await readdir(scratch)).toEqual([]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 30000);
