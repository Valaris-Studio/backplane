// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getServerSurface, PROMPT_DOCS, TOOL_DOCS } from "../index";

interface ParameterContract {
  name: string;
  required: boolean;
}

interface FunctionContract {
  name: string;
  params: ParameterContract[];
}

const MCP_SOURCE_ROOT = resolve(
  process.cwd(),
  "../mcp-server/src/valaris_mcp",
);

function matchingDelimiter(source: string, openingIndex: number): number {
  const closingByOpening = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]);
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;

  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === undefined) break;

    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    const closing = closingByOpening.get(character);
    if (closing !== undefined) {
      stack.push(closing);
      continue;
    }
    if (character === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }

  throw new Error(`Unclosed Python signature at byte ${openingIndex}`);
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  const closingByOpening = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]);
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  let partStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) break;

    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    const closing = closingByOpening.get(character);
    if (closing !== undefined) {
      stack.push(closing);
      continue;
    }
    if (character === stack.at(-1)) {
      stack.pop();
      continue;
    }
    if (character === separator && stack.length === 0) {
      parts.push(value.slice(partStart, index));
      partStart = index + 1;
    }
  }

  parts.push(value.slice(partStart));
  return parts;
}

function pythonParameters(signature: string): ParameterContract[] {
  return splitTopLevel(signature, ",").flatMap((rawParameter) => {
    const parameter = rawParameter.trim();
    if (parameter === "" || parameter === "/" || parameter === "*") return [];

    const declaration = splitTopLevel(parameter, "=")[0]?.trim() ?? "";
    const name = declaration.split(":", 1)[0]?.replace(/^\*{1,2}/, "").trim();
    if (!name || name === "ctx") return [];

    return [{ name, required: splitTopLevel(parameter, "=").length === 1 }];
  });
}

function decoratedFunctions(
  source: string,
  decorator: "tool" | "prompt",
): FunctionContract[] {
  const startPattern = new RegExp(
    `@mcp\\.${decorator}\\(\\)\\s*\\n(?:@[^\\n]+\\s*\\n)*(?:async\\s+)?def\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(`,
    "g",
  );

  return [...source.matchAll(startPattern)].map((match) => {
    const name = match[1];
    const openingIndex = (match.index ?? 0) + match[0].length - 1;
    const closingIndex = matchingDelimiter(source, openingIndex);
    if (name === undefined) throw new Error("Decorated function has no name");

    return {
      name,
      params: pythonParameters(source.slice(openingIndex + 1, closingIndex)),
    };
  });
}

function toolContracts(): FunctionContract[] {
  const toolsDirectory = resolve(MCP_SOURCE_ROOT, "tools");
  return readdirSync(toolsDirectory)
    .filter((fileName) => fileName.endsWith(".py") && !fileName.startsWith("_"))
    .sort()
    .flatMap((fileName) =>
      decoratedFunctions(
        readFileSync(resolve(toolsDirectory, fileName), "utf8"),
        "tool",
      ),
    );
}

function promptContracts(): FunctionContract[] {
  return decoratedFunctions(
    readFileSync(resolve(MCP_SOURCE_ROOT, "prompts.py"), "utf8"),
    "prompt",
  );
}

function documentedParameters(
  params: ReadonlyArray<{ name: string; required: boolean }>,
): ParameterContract[] {
  return params.map(({ name, required }) => ({ name, required }));
}

describe("MCP reference signature parity", () => {
  it("documents every tool parameter in signature order with exact requiredness", () => {
    const signatures = new Map(
      toolContracts().map(({ name, params }) => [name, params]),
    );

    // Derived, never typed: the live tool count comes from the exported
    // surface (deprecated aliases are registered through deprecated_tool(),
    // not @mcp.tool(), so neither side counts them).
    const liveToolCount = getServerSurface().tool_count;
    expect(signatures.size).toBe(liveToolCount);
    expect(TOOL_DOCS).toHaveLength(liveToolCount);
    for (const tool of TOOL_DOCS) {
      expect(signatures.get(tool.name), tool.name).toEqual(
        documentedParameters(tool.params),
      );
    }
  });

  it("documents every prompt parameter in signature order with exact requiredness", () => {
    const signatures = new Map(
      promptContracts().map(({ name, params }) => [name, params]),
    );

    expect(signatures.size).toBe(10);
    expect(PROMPT_DOCS).toHaveLength(10);
    for (const prompt of PROMPT_DOCS) {
      expect(signatures.get(prompt.name), prompt.name).toEqual(
        documentedParameters(prompt.params),
      );
    }
  });
});
