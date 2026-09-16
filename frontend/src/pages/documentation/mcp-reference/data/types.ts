// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CATEGORIES } from "./categories";

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export type ToolKind = "read" | "write" | "composite";

export interface ToolParamDoc {
  name: string;
  required: boolean;
  description: string;
}

export interface ToolDoc {
  name: string;
  category: CategoryId;
  kind: ToolKind;
  description: string;
  params: ToolParamDoc[];
  gotchas?: string[];
  danger?: string;
  examplePrompt: string;
  related?: string[];
}

export interface PromptDoc {
  name: string;
  role: "initializer" | "secretary" | "architect" | "coder";
  description: string;
  params: ToolParamDoc[];
  examplePrompt: string;
}

export interface ResourceDoc {
  uri: string;
  description: string;
}

export interface CategoryDef {
  id: CategoryId;
  title: string;
  group: string;
  blurb: string;
}

// Shape of data/server-surface.json — the MCP listing as the model receives
// it, exported by mcp-server/scripts/export-tool-catalog.py.
export interface ServerSurfaceAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export interface ServerSurfaceTool {
  title: string;
  category: string;
  kind: ToolKind;
  annotations: ServerSurfaceAnnotations;
  description: string;
  params: Record<string, string>;
}

// One selectable hand: a group (id slugified from its title) or a category.
export interface ServerSurfaceToolset {
  id: string;
  kind: "group" | "category";
  title: string;
  group: string;
  tools: string[];
}

// The pinned interactive default: the union of `ids` minus `exclusions` plus
// `inclusions` (both keyed by tool name, valued by the server's reason).
export interface ServerSurfaceDefaultToolset {
  ids: string[];
  exclusions: Record<string, string>;
  inclusions: Record<string, string>;
  tools: string[];
}

// A retired tool name still callable for one minor version, keyed by alias.
// Not part of `tools` — the documented surface excludes aliases.
export interface ServerSurfaceDeprecatedAlias {
  replacement: string;
  removed_in: string;
}

export interface ServerSurface {
  tool_count: number;
  listing_bytes: number;
  tools: Record<string, ServerSurfaceTool>;
  toolsets?: ServerSurfaceToolset[];
  default_toolset?: ServerSurfaceDefaultToolset;
  deprecated?: Record<string, ServerSurfaceDeprecatedAlias>;
}
