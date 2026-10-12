// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fixture = resolve("src/features/resources/components/preview/__tests__/fixtures/javascript-link.docx");
const mammothPath = require.resolve("mammoth");
const cli = resolve(dirname(mammothPath), "../bin/mammoth");

describe("document and diagram dependency compatibility", () => {
  it("does not inherit permission to render executable math links", () => {
    const katex = createRequire(require.resolve("mermaid"))("katex");
    const html = katex.renderToString(String.raw`\href{javascript:alert(1)}{x}`, Object.create({ trust: true }));
    expect(html).not.toContain('href="javascript:');
  });

  it("preserves DOCX conversion through both library and CLI argument parsing", async () => {
    const mammoth = require(mammothPath);
    const result = await mammoth.convertToHtml({ buffer: readFileSync(fixture) });
    expect(result.value).toContain("Ordinary paragraph");
    const output = execFileSync(process.execPath, [cli, fixture, "--output-format", "html"], { encoding: "utf8", timeout: 5000 });
    expect(output.trim()).toBe(result.value);
    const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 5000 });
    expect(help).toContain("--style-map");
    const invalid = spawnSync(process.execPath, [cli, fixture, "--output-format", "invalid"], { encoding: "utf8", timeout: 5000 });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toMatch(/invalid choice/i);
  });
});
