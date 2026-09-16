// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");
const sharedFormatterPath = resolve(sourceRoot, "lib/format.ts");

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionSourceFiles(path);
    }
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (/\.(?:test|spec)\.[^.]+$/.test(entry.name)) return [];
    return [path];
  });
}

function directLocaleFormatterCalls(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: string[] = [];

  function inspect(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].includes(
        node.expression.name.text,
      )
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      findings.push(
        `${relative(sourceRoot, filePath)}:${line + 1} ${node.expression.name.text}`,
      );
    }

    if (
      ts.isNewExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Intl" &&
      ["DateTimeFormat", "NumberFormat", "RelativeTimeFormat"].includes(
        node.expression.name.text,
      )
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      findings.push(
        `${relative(sourceRoot, filePath)}:${line + 1} Intl.${node.expression.name.text}`,
      );
    }

    ts.forEachChild(node, inspect);
  }

  inspect(sourceFile);
  return findings;
}

describe("locale formatting boundary", () => {
  it("routes production locale formatting through the Backplane locale helpers", () => {
    const findings = productionSourceFiles(sourceRoot)
      .filter((filePath) => filePath !== sharedFormatterPath)
      .flatMap(directLocaleFormatterCalls);

    expect(
      findings,
      `Direct browser-locale formatting bypasses src/lib/format.ts:\n${findings.join("\n")}`,
    ).toEqual([]);
  });
});
