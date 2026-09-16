// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import i18n from "@/i18n/config";
import { renderWithProviders, screen, within } from "@/test/test-utils";

// gsap-driven opacity/visibility zeroes accessible names in jsdom; force the
// reduced-motion short-circuit like McpToolReference.test.tsx does.
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

import { DetailPane } from "@/pages/documentation/mcp-reference/DetailPane";
import { TOOL_DOCS } from "@/pages/documentation/mcp-reference/data";
import type { ToolDoc } from "@/pages/documentation/mcp-reference/data";
import { getDocumentationCopy } from "@/pages/documentation/content";

// The export fixture is read from disk rather than imported so a missing file
// fails with a regen hint instead of a module-resolution error.
const FIXTURE_PATH = resolve(
  process.cwd(),
  "src/pages/documentation/mcp-reference/data/server-surface.json",
);
const REGEN_HINT =
  "server-surface.json is missing — regenerate: cd mcp-server && .venv/bin/python scripts/export-tool-catalog.py";

interface ServerSurfaceTool {
  title: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  description: string;
}

interface ServerSurfaceFixture {
  tools: Record<string, ServerSurfaceTool>;
  default_toolset?: { tools: string[] };
}

function loadSurface(): ServerSurfaceFixture {
  expect(existsSync(FIXTURE_PATH), REGEN_HINT).toBe(true);
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ServerSurfaceFixture;
}

function loadWireTool(name: string): ServerSurfaceTool {
  const wire = loadSurface().tools[name];
  expect(wire, `${name} missing from server-surface.json`).toBeDefined();
  return wire as ServerSurfaceTool;
}

function loadDefaultHand(): string[] {
  const hand = loadSurface().default_toolset?.tools;
  expect(hand, "server-surface.json has no default_toolset — regenerate the fixture").toBeDefined();
  return hand as string[];
}

function findToolDoc(name: string): ToolDoc {
  const doc = TOOL_DOCS.find((tool) => tool.name === name);
  expect(doc, `${name} missing from TOOL_DOCS`).toBeDefined();
  return doc as ToolDoc;
}

function collapseWhitespace(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

// Labels come from the documentation copy pack so the assertions stay
// locale-agnostic; the keys are the contract the implementation must add.
const copy = getDocumentationCopy("en").mcpReference;

function copyLabel(key: string): string {
  const value = (copy as unknown as Record<string, unknown>)[key];
  expect(value, `copy.mcpReference.${key} is not defined`).toBeTypeOf("string");
  expect((value as string).trim().length, `copy.mcpReference.${key} is blank`).toBeGreaterThan(0);
  return value as string;
}

function renderToolDetail(tool: ToolDoc) {
  renderWithProviders(
    <DetailPane resolved={{ kind: "tool", tool }} onSelectTool={vi.fn()} />,
    {
      routerProps: {
        initialEntries: ["/test-ws/documentation/mcp-tool-catalog"],
      },
    },
  );
  return screen.getByTestId("mcp-detail");
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

// The pill mirrors default_toolset.tools from the fixture: it renders only for
// a tool the interactive default hand serves, in the documentation locale.
describe("DetailPane 'In default hand' pill", () => {
  it("renders the pill with the en copy for get_card", () => {
    expect(loadDefaultHand(), "fixture: get_card should be in the default hand").toContain("get_card");

    const detail = renderToolDetail(findToolDoc("get_card"));

    const pill = within(detail).getByTestId("tool-in-default-hand");
    expect(pill).toHaveTextContent(copyLabel("inDefaultHand"));
    expect(pill).toHaveTextContent("In default hand");
  });

  it("renders no pill for delete_board", () => {
    expect(loadDefaultHand(), "fixture: delete_board must stay out of the default hand").not.toContain("delete_board");

    const detail = renderToolDetail(findToolDoc("delete_board"));

    expect(within(detail).queryByTestId("tool-in-default-hand")).toBeNull();
  });

  it("follows the documentation locale (es)", async () => {
    await i18n.changeLanguage("es");

    const detail = renderToolDetail(findToolDoc("get_card"));

    expect(within(detail).getByTestId("tool-in-default-hand")).toHaveTextContent(
      "En la mano predeterminada",
    );
  });

  it("styles the pill with theme tokens, never a hard-coded palette colour", () => {
    const detail = renderToolDetail(findToolDoc("get_card"));

    const className = within(detail).getByTestId("tool-in-default-hand").className;
    expect(className).not.toMatch(/emerald|green|lime|teal|sky|blue|amber|red/);
    expect(className).toMatch(/primary|foreground|border|muted|accent|success/);
  });
});

describe("DetailPane server-surface annotations", () => {
  it("shows the read-only badge and no destructive badge for get_card", () => {
    const wire = loadWireTool("get_card");
    expect(wire.annotations.readOnlyHint, "fixture: get_card should be read-only").toBe(true);
    expect(wire.annotations.destructiveHint, "fixture: get_card should not be destructive").toBe(false);

    const detail = renderToolDetail(findToolDoc("get_card"));

    expect(within(detail).getByText(copyLabel("annotationReadOnly"))).toBeInTheDocument();
    expect(within(detail).queryByText(copyLabel("annotationDestructive"))).not.toBeInTheDocument();
  });

  it("shows the destructive badge and no read-only badge for delete_board", () => {
    const wire = loadWireTool("delete_board");
    expect(wire.annotations.destructiveHint, "fixture: delete_board should be destructive").toBe(true);
    expect(wire.annotations.readOnlyHint, "fixture: delete_board should not be read-only").toBe(false);

    const detail = renderToolDetail(findToolDoc("delete_board"));

    expect(within(detail).getByText(copyLabel("annotationDestructive"))).toBeInTheDocument();
    expect(within(detail).queryByText(copyLabel("annotationReadOnly"))).not.toBeInTheDocument();
  });

  it.each(["get_card", "delete_board", "update_card", "create_card"])(
    "mirrors the fixture idempotentHint as the idempotent badge for %s",
    (name) => {
      const wire = loadWireTool(name);
      const detail = renderToolDetail(findToolDoc(name));
      const idempotentBadge = within(detail).queryByText(copyLabel("annotationIdempotent"));

      if (wire.annotations.idempotentHint) {
        expect(idempotentBadge, `${name}: idempotent badge missing`).toBeInTheDocument();
      } else {
        expect(idempotentBadge, `${name}: idempotent badge rendered for a non-idempotent tool`).not.toBeInTheDocument();
      }
    },
  );
});

describe("DetailPane 'What the model sees' block", () => {
  it.each(["get_card", "delete_board"])(
    "renders the wire description from the fixture for %s",
    (name) => {
      const wire = loadWireTool(name);
      expect(wire.description.trim().length, `fixture: ${name} has an empty description`).toBeGreaterThan(0);

      const detail = renderToolDetail(findToolDoc(name));

      expect(within(detail).getByText(copyLabel("wireDescriptionTitle"))).toBeInTheDocument();
      expect(collapseWhitespace(detail.textContent)).toContain(
        collapseWhitespace(wire.description),
      );
    },
  );

  it("keeps the ToolDoc prose alongside the wire description", () => {
    const doc = findToolDoc("get_card");
    const wire = loadWireTool("get_card");

    const detail = renderToolDetail(doc);

    const rendered = collapseWhitespace(detail.textContent);
    expect(rendered).toContain(collapseWhitespace(doc.description));
    expect(rendered).toContain(collapseWhitespace(wire.description));
  });
});
