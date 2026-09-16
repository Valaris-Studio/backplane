import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const checker = readFileSync(new URL("./check-mermaid-chunk.mjs", import.meta.url), "utf8");
const isolatedLibrary = 'export const diagrams = ["flowchart-v2", "sequenceDiagram"];';

function check(chunks) {
  const root = mkdtempSync(path.join(tmpdir(), "backplane-mermaid-chunk-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "dist", "assets"), { recursive: true });
    symlinkSync(path.resolve(import.meta.dirname, "..", "node_modules"), path.join(root, "node_modules"));
    writeFileSync(path.join(root, "scripts", "check-mermaid-chunk.mjs"), checker);
    writeFileSync(path.join(root, "dist", "index.html"), '<script type="module" src="/assets/index-entry.js"></script>');
    for (const [name, source] of Object.entries(chunks)) writeFileSync(path.join(root, "dist", "assets", name), source);
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "check-mermaid-chunk.mjs")], { encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("allows a directive example in a lazy documentation chunk", () => {
  const result = check({
    "index-entry.js": 'export const docs = () => import("./index-docs.js"); export const editor = () => import("./editor.js");',
    "index-docs.js": 'export const example = "%%{init}%%";',
    "editor.js": 'export const render = () => import("./mermaid.core-lib.js");',
    "mermaid.core-lib.js": isolatedLibrary,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("allows a directive example in the actual entry without loading Mermaid", () => {
  const result = check({
    "index-entry.js": 'export const example = "%%{init}%%"; export const render = () => import("./mermaid.core-lib.js");',
    "mermaid.core-lib.js": isolatedLibrary,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects Mermaid code bundled into the actual entry", () => {
  const result = check({
    "index-entry.js": isolatedLibrary + ' export const render = () => import("./mermaid.core-lib.js");',
    "mermaid.core-lib.js": isolatedLibrary,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /library markers/);
});

test("rejects Mermaid code bundled into a lazy editor before any diagram opens", () => {
  const result = check({
    "index-entry.js": 'export const editor = () => import("./editor.js");',
    "editor.js": isolatedLibrary + ' export const render = () => import("./mermaid.core-lib.js");',
    "mermaid.core-lib.js": isolatedLibrary,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /library markers/);
});

for (const declaration of ['import { diagrams } from "./mermaid.core-lib.js";', 'export { diagrams } from "./mermaid.core-lib.js";']) {
  test(`rejects an eager library dependency through ${declaration.startsWith("import") ? "import" : "re-export"}`, () => {
    const result = check({
      "index-entry.js": 'export const editor = () => import("./editor.js");',
      "editor.js": declaration,
      "mermaid.core-lib.js": isolatedLibrary,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /eager/);
  });
}

test("does not mistake documentation text for a dynamic import boundary", () => {
  const result = check({
    "index-entry.js": `export const example = ${JSON.stringify('import("./mermaid.core-lib.js")')};`,
    "mermaid.core-lib.js": isolatedLibrary,
  });
  assert.equal(result.status, 1);
});

test("still rejects missing Mermaid build output", () => {
  const result = check({ "index-entry.js": 'export const example = "Documentation";' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no dist\/assets\/\*mermaid\*\.js/);
});
// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
