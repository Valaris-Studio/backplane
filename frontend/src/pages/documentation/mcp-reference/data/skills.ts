// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Intentionally English-only for Wave 2 per phase4-documentation-page.md §2.

import type { ToolDoc } from "./types";

// Author slice — categories: skills. The workspace skill library and its
// per-board bindings; skill files are served verbatim (open SKILL.md standard).
export const SKILLS_TOOL_DOCS: ToolDoc[] = [
  {
    name: "list_skills",
    category: "skills",
    kind: "read",
    description:
      "List the workspace skill library, or a board's effective skill set, with each skill's declared toolsets. Metadata only — file contents live behind get_skill.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: false,
        description:
          "Board UUID or slug (backend-resolved). When given, returns the board's effective skill set instead of the full workspace library.",
      },
      {
        name: "include_archived",
        required: false,
        description:
          "Workspace listings hide archived skills by default; pass true to include them. Ignored when board_id is given.",
      },
    ],
    gotchas: [
      "Listings never inline file contents — install a skill by calling get_skill and writing each returned file verbatim into your local skills dir.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list the skills available on the <board> board in <workspace>.",
    related: ["get_skill", "set_skill_binding"],
  },
  {
    name: "get_skill",
    category: "skills",
    kind: "read",
    description:
      "Fetch a skill version's files verbatim (SKILL.md plus support files) and its declared toolsets. Omitting version resolves the latest published one.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "slug",
        required: true,
        description: "The skill slug.",
      },
      {
        name: "version",
        required: false,
        description:
          "Explicit version number. Omit to fetch the latest published version; pass explicitly to fetch a specific version or a draft.",
      },
      {
        name: "file_path",
        required: false,
        description:
          "Path of a single file to return in full, bypassing the per-file truncation cap.",
      },
    ],
    gotchas: [
      "Files longer than 6000 chars are truncated in the multi-file response (flagged via _files_truncated) — re-fetch each one in full with file_path.",
      "A skill with no published version returns empty files; pass version explicitly to read a draft.",
    ],
    examplePrompt:
      "Using the Backplane MCP, fetch the pdf-tools skill from <workspace> and install its files locally.",
    related: ["list_skills", "set_skill_binding"],
  },
  {
    name: "propose_skill",
    category: "skills",
    kind: "write",
    description:
      "Propose a new skill (or version) for the workspace library. Lands as a draft pending human approval; idempotent — re-proposing returns the existing pending proposal.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "slug",
        required: true,
        description: "The skill slug the proposal creates or versions.",
      },
      {
        name: "files",
        required: true,
        description:
          'The skill\'s files as [{"path": ..., "content": ...}] — SKILL.md plus any support files, contents sent verbatim.',
      },
      {
        name: "name",
        required: false,
        description:
          "Display name. Omit to let the backend take it from the SKILL.md frontmatter, which is authoritative.",
      },
      {
        name: "description",
        required: false,
        description:
          "Description. Omit to let the backend take it from the SKILL.md frontmatter, which is authoritative.",
      },
      {
        name: "board_id",
        required: false,
        description:
          "Board UUID or slug (backend-resolved) to associate the proposal with — e.g. the board whose loop produced it.",
      },
    ],
    gotchas: [
      "Nothing is published until a human approves — poll get_approval_status with the returned approval_id before relying on the skill.",
      "File contents are sent verbatim on this write path — the 6000-char truncation cap only applies to reads via get_skill.",
    ],
    examplePrompt:
      "Using the Backplane MCP, propose a pdf-tools skill for <workspace> from the files in my local skills directory.",
    related: ["list_skills", "get_skill", "get_approval_status"],
  },
  {
    name: "set_skill_binding",
    category: "skills",
    kind: "write",
    description:
      "Enable or disable a workspace skill on a board, optionally pinning a version. Idempotent — re-binding updates in place.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "The board UUID or slug (backend-resolved).",
      },
      {
        name: "skill_slug",
        required: true,
        description: "The slug of the workspace skill to bind.",
      },
      {
        name: "enabled",
        required: false,
        description:
          "Whether the skill is active on the board. Omit to leave an existing binding's state unchanged; a newly created binding defaults to enabled.",
      },
      {
        name: "pinned_version",
        required: false,
        description:
          "Version number to pin the board to. Omit to leave any existing pin unchanged; an unpinned board tracks the latest published version.",
      },
      {
        name: "clear_pin",
        required: false,
        description:
          "Pass true to remove an existing version pin, returning the board to tracking the latest published version. Mutually exclusive with pinned_version.",
      },
    ],
    gotchas: [
      "Omitting pinned_version leaves an existing pin as-is (PUT semantics of an omitted field) — it does not clear the pin; unpin with clear_pin: true.",
      "pinned_version and clear_pin together is an error — pin or unpin, not both.",
    ],
    examplePrompt:
      "Using the Backplane MCP, enable the pdf-tools skill on the <board> board in <workspace>, pinned to version 2.",
    related: ["list_skills", "get_skill", "next_assignment"],
  },
  {
    name: "list_skill_bindings_raw",
    category: "skills",
    kind: "read",
    description:
      "Raw view of a board's skill binding rows, disabled ones included. list_skills(board_id) is the effective set callers actually get.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "The board UUID or slug (backend-resolved).",
      },
    ],
    gotchas: [
      "Rows are configuration, not what agents get: a disabled binding or one resolving to no published version appears here but never in the board's effective set (list_skills with board_id).",
    ],
    examplePrompt:
      "Using the Backplane MCP, call list_skill_bindings_raw on the <board> board in <workspace> to show every configured skill binding, including disabled ones.",
    related: ["list_skills", "set_skill_binding", "remove_skill_binding"],
  },
  {
    name: "remove_skill_binding",
    category: "skills",
    kind: "write",
    description:
      "Unbind a skill from a board, deleting the binding row (enabled flag and pin included). Idempotent — removing a missing binding still succeeds.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "The board UUID or slug (backend-resolved).",
      },
      {
        name: "skill_slug",
        required: true,
        description: "The slug of the bound skill to remove.",
      },
    ],
    gotchas: [
      "Unbind destroys the row's configuration — any version pin is lost. To keep the pin but take the skill out of the effective set, disable it instead via set_skill_binding with enabled: false.",
    ],
    examplePrompt:
      "Using the Backplane MCP, unbind the pdf-tools skill from the <board> board in <workspace>.",
    related: ["set_skill_binding", "list_skill_bindings_raw"],
  },
  {
    name: "list_skill_catalog",
    category: "skills",
    kind: "read",
    description:
      "List the built-in skill catalog: platform-curated skills not yet in the workspace library, each with its declared toolsets, ready to activate.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
    ],
    gotchas: [
      "Catalog entries are not workspace skills yet — activate one (activate_catalog_skill) to copy it into the library before it can be bound to boards.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list the built-in skill catalog for <workspace>.",
    related: ["activate_catalog_skill", "list_skills"],
  },
  {
    name: "activate_catalog_skill",
    category: "skills",
    kind: "write",
    description:
      "Copy a catalog entry into the workspace library as a published v1. Idempotent — re-activation returns the existing copy untouched.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "catalog_id",
        required: true,
        description: "The catalog entry id, from list_skill_catalog.",
      },
    ],
    gotchas: [
      "Human sessions only: the backend rejects runner-bound callers (API keys linked to a runner identity) with a 403 — activation is a curation decision reserved for people.",
    ],
    examplePrompt:
      "Using the Backplane MCP, activate the tdd-discipline catalog skill into <workspace> and bind it to the <board> board.",
    related: ["list_skill_catalog", "set_skill_binding", "list_skills"],
  },
];
