// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ServerSurface, ServerSurfaceTool, ToolDoc } from "./types";
import serverSurfaceJson from "./server-surface.json";
import { AGENTS_OBSERVABILITY_TOOL_DOCS } from "./agents-observability";
import { CARDS_WORK_TOOL_DOCS } from "./cards-work";
import { COLLABORATION_TOOL_DOCS } from "./collaboration";
import { FLOW_CONTROL_TOOL_DOCS } from "./flow-control";
import { KNOWLEDGE_TOOL_DOCS } from "./knowledge";
import { LOOP_TEMPLATES_TOOL_DOCS } from "./loop-templates";
import { PIPELINE_CONFIG_TOOL_DOCS } from "./pipeline-config";
import { SKILLS_TOOL_DOCS } from "./skills";
import { WORKSPACES_BOARDS_TOOL_DOCS } from "./workspaces-boards";

import { DOCUMENTATION_TOOL_DOCS } from "./documentation";

export const TOOL_DOCS: ToolDoc[] = [
  ...DOCUMENTATION_TOOL_DOCS,
  ...FLOW_CONTROL_TOOL_DOCS,
  ...WORKSPACES_BOARDS_TOOL_DOCS,
  ...CARDS_WORK_TOOL_DOCS,
  ...KNOWLEDGE_TOOL_DOCS,
  ...COLLABORATION_TOOL_DOCS,
  ...AGENTS_OBSERVABILITY_TOOL_DOCS,
  ...PIPELINE_CONFIG_TOOL_DOCS,
  ...LOOP_TEMPLATES_TOOL_DOCS,
  ...SKILLS_TOOL_DOCS,
];

export const TOOL_DOCS_BY_NAME: ReadonlyMap<string, ToolDoc> = new Map(
  TOOL_DOCS.map((doc) => [doc.name, doc]),
);

const SERVER_SURFACE = serverSurfaceJson as ServerSurface;

export function getServerSurface(): ServerSurface {
  return SERVER_SURFACE;
}

// Undefined only if the fixture drifted from TOOL_DOCS (serverSurface.parity
// guards that); callers render nothing rather than crash.
export function getServerSurfaceTool(
  name: string,
): ServerSurfaceTool | undefined {
  return SERVER_SURFACE.tools[name];
}

export { PROMPT_DOCS, PROMPT_NAMES, RESOURCE_DOCS } from "./prompts-resources";
export { CATEGORIES, CATEGORIES_BY_ID, GROUP_IDS, GROUPS, slugifyGroup } from "./categories";
export type { GroupId, GroupName } from "./categories";
export type {
  CategoryDef,
  CategoryId,
  PromptDoc,
  ResourceDoc,
  ServerSurface,
  ServerSurfaceAnnotations,
  ServerSurfaceDefaultToolset,
  ServerSurfaceTool,
  ServerSurfaceToolset,
  ToolDoc,
  ToolKind,
  ToolParamDoc,
} from "./types";
