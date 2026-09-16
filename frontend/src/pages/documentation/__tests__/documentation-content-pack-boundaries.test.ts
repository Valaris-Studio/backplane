// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { ES_REFERENCE } from "../content/sections/es/reference";

const DOCUMENTATION_CONTENT_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../content",
);
const DOCUMENTATION_LOCALES = ["es", "pt-BR"] as const;

type DocumentationLocale = (typeof DOCUMENTATION_LOCALES)[number];

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

function localeOwningPath(filePath: string): DocumentationLocale | undefined {
  const pathWithoutTypeScriptExtension = filePath.replace(/\.tsx?$/, "");

  return DOCUMENTATION_LOCALES.find(
    (locale) =>
      pathWithoutTypeScriptExtension ===
        join(DOCUMENTATION_CONTENT_DIRECTORY, locale) ||
      filePath.includes(`${sep}content${sep}sections${sep}${locale}${sep}`),
  );
}

function importedModuleSpecifiers(filePath: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const moduleSpecifiers: string[] = [];

  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      moduleSpecifiers.push(node.moduleSpecifier.text);
    }

    const importedExpression = ts.isCallExpression(node)
      ? node.arguments[0]
      : undefined;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      importedExpression &&
      ts.isStringLiteralLike(importedExpression)
    ) {
      moduleSpecifiers.push(importedExpression.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return moduleSpecifiers;
}

function importedLocale(
  importingFile: string,
  moduleSpecifier: string,
): DocumentationLocale | undefined {
  if (moduleSpecifier.startsWith(".")) {
    return localeOwningPath(resolve(dirname(importingFile), moduleSpecifier));
  }

  const contentPath = moduleSpecifier.replaceAll("\\", "/").split("/content/")[1];
  if (!contentPath) return undefined;

  const [firstSegment, secondSegment] = contentPath.split("/");
  return DOCUMENTATION_LOCALES.find(
    (locale) =>
      firstSegment === locale ||
      (firstSegment === "sections" && secondSegment === locale),
  );
}

describe("documentation content-pack boundaries", () => {
  it("does not let one locale import another locale's content pack", () => {
    const violations = listTypeScriptFiles(DOCUMENTATION_CONTENT_DIRECTORY)
      .flatMap((filePath) => {
        const owner = localeOwningPath(filePath);
        if (!owner) return [];

        return importedModuleSpecifiers(filePath).flatMap((moduleSpecifier) => {
          const target = importedLocale(filePath, moduleSpecifier);
          return target && target !== owner
            ? [
                `${relative(DOCUMENTATION_CONTENT_DIRECTORY, filePath)} imports ${moduleSpecifier}`,
              ]
            : [];
        });
      })
      .sort();

    expect(violations).toEqual([]);
  });

  it("localizes the done-column merge gate parameter without translating its enum values", () => {
    const translations: Readonly<Record<string, string>> =
      ES_REFERENCE["mcp-tool-catalog"];

    expect(
      translations[
        "Per-board done merge gate: 'inherit' clears the override and uses the workspace enforce_done_merge_gate setting; 'enforced' enables it; 'off' disables it. The gate applies to runner moves into done, not human moves."
      ],
    ).toBe(
      "Control de merge hacia done por tablero: 'inherit' elimina el override y usa enforce_done_merge_gate del espacio de trabajo; 'enforced' lo activa y 'off' lo desactiva. Se aplica a movimientos de runners hacia done, no a movimientos humanos.",
    );
  });
});
