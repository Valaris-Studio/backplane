// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { AgentAccess, BoardsOverview_Deserialize, CompanionStatus_Deserialize, DiscoveredProject } from "../../ipc/bindings";
import type { RawMapping } from "../../stores/projects";
import { fixtureStatus } from "../../test/daemon-ipc";

export type Status = CompanionStatus_Deserialize;

// The shared fixture's data_dir puts HOME at /home/tester.
export const HOME = "/home/tester";
export const baseStatus = fixtureStatus as Status;

export function withRules(rules: { auto_match_repos: boolean; exclude_globs: string[] }, status: Status = baseStatus): Status {
  return { ...status, capture: { ...status.capture, ...rules } };
}

/** No cached policy yet: the daemon reports false and [] then, which are not the real rules. */
export const withoutPolicy: Status = { ...baseStatus, capture: { ...baseStatus.capture, policy_cached: false, auto_match_repos: false, exclude_globs: [] } };

export const boards: BoardsOverview_Deserialize = {
  workspaces: [
    {
      id: "w-internal",
      slug: "internal",
      name: "Internal projects",
      boards: [
        { id: "b-backplane", name: "Backplane", repos: ["github.com/valaris/backplane"] },
        { id: "b-marketing", name: "Marketing site", repos: ["github.com/valaris/marketing-site"] },
        { id: "b-docs", name: "Docs", repos: ["github.com/valaris/docs-site"] },
        { id: "b-companion", name: "Companion desktop", repos: [] },
      ],
    },
    {
      id: "w-acme",
      slug: "acme",
      name: "Acme",
      boards: [
        { id: "b-storefront", name: "Storefront", repos: ["github.com/acme/storefront-api"] },
        { id: "b-mobile", name: "Mobile app", repos: ["github.com/acme/mobile-app"] },
        { id: "b-mobile-qa", name: "Mobile app QA", repos: ["github.com/acme/mobile-app"] },
      ],
    },
    { id: "w-northwind", slug: "northwind", name: "Northwind", boards: [{ id: "b-fleet", name: "Fleet portal", repos: [] }] },
  ],
};

const explicit = { origin: "explicit", enabled: true } as const;

export const backplaneMapping: RawMapping = {
  ...explicit,
  id: "m1",
  workspace_id: "w-internal",
  board_id: "b-backplane",
  root_path: `${HOME}/code/valaris/backplane`,
  repo_url_normalized: "github.com/valaris/backplane",
  content_level: "standard",
};
export const storefrontMapping: RawMapping = {
  ...explicit,
  id: "m2",
  workspace_id: "w-acme",
  board_id: "b-storefront",
  root_path: `${HOME}/code/acme/storefront-api`,
  repo_url_normalized: null,
  content_level: "metadata",
};
export const docsMapping: RawMapping = {
  ...explicit,
  id: "m3",
  workspace_id: "w-internal",
  board_id: "b-docs",
  root_path: `${HOME}/code/valaris/docs-site`,
  repo_url_normalized: null,
  enabled: false,
  content_level: "full",
};
export const mappings: RawMapping[] = [backplaneMapping, storefrontMapping, docsMapping];

const FIRST_SEEN = "2026-09-27T12:00:00Z";

export const marketingProject: DiscoveredProject = {
  root: `${HOME}/code/valaris/marketing-site`,
  repo_url: "github.com/valaris/marketing-site",
  first_seen: FIRST_SEEN,
  reason: "auto_match_off",
  candidates: [{ workspace_id: "w-internal", workspace_name: "Internal projects", board_id: "b-marketing", board_name: "Marketing site" }],
};
export const mobileProject: DiscoveredProject = {
  root: `${HOME}/code/acme/mobile-app`,
  repo_url: "github.com/acme/mobile-app",
  first_seen: FIRST_SEEN,
  reason: "ambiguous",
  candidates: [
    { workspace_id: "w-acme", workspace_name: "Acme", board_id: "b-mobile", board_name: "Mobile app" },
    { workspace_id: "w-acme", workspace_name: "Acme", board_id: "b-mobile-qa", board_name: "Mobile app QA" },
  ],
};
export const dotfilesProject: DiscoveredProject = { root: `${HOME}/dotfiles`, repo_url: "github.com/ada/dotfiles", first_seen: FIRST_SEEN, reason: "not_bound", candidates: [] };
export const scratchProject: DiscoveredProject = { root: `${HOME}/scratch`, repo_url: null, first_seen: FIRST_SEEN, reason: "no_origin", candidates: [] };
export const excludedProject: DiscoveredProject = {
  root: `${HOME}/clients/northwind/contract-work`,
  repo_url: "gitlab.com/northwind/app",
  first_seen: FIRST_SEEN,
  reason: "excluded",
  candidates: [],
};
export const discovered: DiscoveredProject[] = [marketingProject, mobileProject, dotfilesProject, scratchProject, excludedProject];

export const ignored = [`${HOME}/Downloads/tmp-repo`, `${HOME}/code/forks/tiptap`];

export const overview = { mappings, discovered, ignored };

export const RULES = { auto_match_repos: false, exclude_globs: ["~/clients/**", "~/personal/**"] };

export function createdMapping(overrides: Partial<RawMapping> = {}) {
  return {
    id: "m-new",
    workspace_id: "w-internal",
    board_id: "b-marketing",
    root_path: null,
    repo_url_normalized: "github.com/valaris/marketing-site",
    origin: "explicit",
    enabled: true,
    content_level: "standard",
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

export const apiError = (status: number, code: string, detail: unknown = null) => ({ kind: "api", status, code, message: "raw daemon message", detail });
export const SERVER_UNREACHABLE = apiError(502, "server_unreachable");
export const DAEMON_DOWN = { kind: "unreachable", reason: "connection refused" };

const offFor = (mapping_id: string) => ({ mapping_id, enabled: false, agents: [] });

/** Nothing turned on yet: no key, every bound folder off. */
export const accessOff: AgentAccess = {
  key: { present: false, key_prefix: null, server_state: "unknown" },
  prerequisites: { uvx: true },
  mappings: mappings.map((mapping) => offFor(mapping.id)),
  warnings: [],
};

/** backplane is on: Claude Code set up there, Codex waiting for a restart, Pi without its MCP add-on. */
export const accessOn: AgentAccess = {
  key: { present: true, key_prefix: "vlr_ab12", server_state: "active" },
  prerequisites: { uvx: true },
  mappings: [
    {
      mapping_id: "m1",
      enabled: true,
      agents: [
        { agent_id: "claude_code", scope: "folder", state: "configured", problem: null },
        { agent_id: "codex_cli", scope: "global", state: "configured", problem: "restart_required" },
        { agent_id: "pi_cli", scope: "global", state: "unsupported", problem: "mcp_adapter_missing" },
      ],
    },
    offFor("m2"),
    offFor("m3"),
  ],
  warnings: [{ agent_id: "claude_code", entry_name: "valaris", reason: "same_endpoint" }],
};

export function withAgents(agents: AgentAccess["mappings"][number]["agents"], overrides: Partial<AgentAccess> = {}): AgentAccess {
  const [, ...rest] = accessOn.mappings;
  return { ...accessOn, mappings: [{ mapping_id: "m1", enabled: true, agents }, ...rest], ...overrides };
}
