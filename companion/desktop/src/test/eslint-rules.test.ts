// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// @vitest-environment node
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: new URL("../..", import.meta.url).pathname });

// Fixtures linted as if they were app source, so the project config applies.
const FIXTURE_PATH = "src/components/__lint_fixture__.tsx";
const header = 'import { AnimatePresence } from "motion/react";\n';

async function popLayoutErrors(jsx: string): Promise<string[]> {
  const [result] = await eslint.lintText(`${header}export const Probe = () => ${jsx};\n`, { filePath: FIXTURE_PATH });
  return (result?.messages ?? []).filter((message) => message.ruleId === "no-restricted-syntax").map((message) => message.message);
}

describe("eslint: AnimatePresence popLayout ban (CSP style-src 'self')", () => {
  it("rejects mode=\"popLayout\"", async () => {
    expect(await popLayoutErrors('<AnimatePresence mode="popLayout">{null}</AnimatePresence>')).toHaveLength(1);
  });

  it("rejects mode={\"popLayout\"}", async () => {
    expect(await popLayoutErrors('<AnimatePresence mode={"popLayout"}>{null}</AnimatePresence>')).toHaveLength(1);
  });

  it("rejects mode={`popLayout`}", async () => {
    expect(await popLayoutErrors("<AnimatePresence mode={`popLayout`}>{null}</AnimatePresence>")).toHaveLength(1);
  });

  it("allows the other modes", async () => {
    expect(await popLayoutErrors('<AnimatePresence mode="wait">{null}</AnimatePresence>')).toEqual([]);
    expect(await popLayoutErrors('<AnimatePresence mode={"sync"}>{null}</AnimatePresence>')).toEqual([]);
  });
});
