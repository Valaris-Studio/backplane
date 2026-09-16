// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Intentionally English-only for Wave 2 per phase4-documentation-page.md §2.

import type { ToolDoc } from "./types";

// Author slice — categories: loop-templates. Every *_loop_template* tool lands
// here; fit/preview/lint/profile are views of get_loop_template, export/import close the file.
export const LOOP_TEMPLATES_TOOL_DOCS: ToolDoc[] = [
  {
    name: "list_loop_templates",
    category: "loop-templates",
    kind: "read",
    description:
      "Browse the loop template catalog: system templates then workspace ones, as summaries. Prompts and slots live behind get_loop_template.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "q",
        required: false,
        description: "Free-text filter over name and slug. Omit for the full catalog.",
      },
      {
        name: "sort",
        required: false,
        description: '"name" (default), "updated_at", or "boards_using".',
      },
      {
        name: "include_archived",
        required: false,
        description: "True to also list soft-archived workspace templates.",
      },
    ],
    gotchas: [
      "Entries are summaries on purpose — a catalog that inlined every prompt pair would ship tens of kilobytes per call.",
      "meta.runner_vars carries the runner's Go-template variable vocabulary, so a prompt editor never has to hardcode it.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list the loop templates in <workspace> sorted by how many boards use them.",
    related: ["get_loop_template", "set_board_loop"],
  },
  {
    name: "get_loop_template",
    category: "loop-templates",
    kind: "read",
    description:
      "Read one loop template. view picks the read: full (default), profile with track record, preview render, fit pre-flight against a board, or lint for repo facts.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "ref",
        required: true,
        description: "A system template slug, or a workspace template's row UUID.",
      },
      {
        name: "view",
        required: false,
        description:
          '"full" (default), "profile", "preview", "fit" or "lint" — which read this is. Anything else is rejected before a request is made.',
      },
      {
        name: "draft",
        required: false,
        description:
          "Select draft text with true or published text with false; rehearsals default to draft and full reads default to published.",
      },
      {
        name: "include_archived",
        required: false,
        description:
          'view="full" only: true also resolves a soft-archived workspace template. A board bound before the archive still runs it, so reading that board\'s loop needs this.',
      },
      {
        name: "board_id",
        required: false,
        description:
          'UUID (or slug) of a board. Required for view="fit"; optional for view="preview", where the board\'s autofill values and rails participate in the render.',
      },
      {
        name: "slot_values",
        required: false,
        description:
          "For fit or preview: proposed slot values. Explicit values take precedence over board autofill and template defaults.",
      },
      {
        name: "include_prompts",
        required: false,
        description:
          'view="preview" only: false omits the rendered prompt bodies and keeps the findings, slot and rails data.',
      },
      {
        name: "loop_config",
        required: false,
        description: "Proposed unsaved loop rails for fit or preview.",
      },
      {
        name: "version",
        required: false,
        description: "Exact published template version; use with draft=false.",
      },
    ],
    gotchas: [
      'view="full" returns everything — profile, system/loop prompts, slot specs, rails defaults and tool grants. A ref is a system slug OR a workspace row UUID: the namespaces never mix, and there is no slug@version form.',
      'view="profile" is the track record — boards using it, iterations, spend and outcome tallies — that makes "does this loop actually work?" answerable before binding a board. Archived templates are included here.',
      'view="preview" renders the prompts without binding or storing anything. include_prompts defaults to true and returns three full bodies — tens of kilobytes — so an agent already running inside a loop should not call it; false keeps findings, missing_required, used_values, rails and tools.',
      'view="fit" is a read-only board pre-flight: each check reports ok, missing or warn with its evidence, and carries a fix_id only when apply_loop_template_fixes can close it. autofill proposes slot values derived from the board, so binding never starts from an empty form.',
      'view="lint" flags repo-specific facts — URLs, org/repo names, commit SHAs, machine paths — left in the kernel prompts that belong in slots before sharing. Hints only, false positives expected: publish and export succeed regardless.',
      "Before binding, rehearse with draft=false and the exact published version. Unavailable versions conflict before writes. Lint reads the draft.",
      'A view-specific param passed outside its view, an unknown view, or view="fit" without board_id is rejected before any request. Archived templates are excluded from view="full" by default, exactly as the REST route excludes them — pass include_archived to read one a board is still bound to.',
    ],
    examplePrompt:
      'Using the Backplane MCP, show me the coding-loop template in <workspace> including its slot specs, then read it again with view="fit" to check whether it fits the <board> board.',
    related: [
      "list_loop_templates",
      "set_board_loop",
      "apply_loop_template_fixes",
      "export_loop_template",
      "get_board_loop_binding_raw",
    ],
  },
  {
    name: "create_loop_template",
    category: "loop-templates",
    kind: "write",
    description:
      "Create a workspace loop template as a draft (version 0, nothing published). Admin only; runner keys are refused.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "slug",
        required: true,
        description: "URL-safe identifier, unique within the workspace.",
      },
      { name: "name", required: true, description: "Human-readable display name." },
      {
        name: "content",
        required: false,
        description:
          "Prompt/slot/rails body — {system_prompt, loop_prompt, slots, tools, rails_defaults}. Omit to start empty.",
      },
      {
        name: "profile",
        required: false,
        description: "Presentation identity — {emoji, tagline, tags}. Omit for none.",
      },
    ],
    gotchas: [
      "Deliberately NOT idempotent: a repeated slug returns 409 rather than the existing row, so your content is never silently discarded.",
      "Large prompt bodies are better authored in the UI or over REST — MCP transports have garbled multi-kilobyte strings before.",
      "Template mutations are admin + runner-caller-banned: a runner editing the prompt that governs it is the escalation this surface refuses.",
    ],
    examplePrompt:
      "Using the Backplane MCP, create a loop template called <name> with slug <slug> in <workspace>.",
    related: ["duplicate_loop_template", "update_loop_template", "publish_loop_template"],
  },
  {
    name: "update_loop_template",
    category: "loop-templates",
    kind: "write",
    description:
      "Autosave the draft half of a workspace template. Publishing is a separate step. Admin only; runner keys are refused.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "ref",
        required: true,
        description: "The workspace template's row UUID (or slug).",
      },
      {
        name: "content",
        required: false,
        description: "Full replacement prompt/slot/rails body — not a deep merge.",
      },
      {
        name: "profile",
        required: false,
        description: "Full replacement presentation identity.",
      },
      { name: "name", required: false, description: "New display name." },
      {
        name: "expected_updated_at",
        required: false,
        description:
          "Optimistic lock — the draft_updated_at you last read. A concurrent edit makes this 409 instead of clobbering.",
      },
    ],
    gotchas: [
      "content and profile REPLACE their whole object when sent: read the template first and send the full object back, never a fragment.",
      "System templates are code-defined and cannot be edited — duplicate one into the workspace first.",
      "Passing no field at all returns an error rather than bumping the draft timestamp for nothing.",
    ],
    examplePrompt:
      "Using the Backplane MCP, rename the loop template <ref> in <workspace> to <new name>.",
    related: ["get_loop_template", "publish_loop_template", "create_loop_template"],
  },
  {
    name: "publish_loop_template",
    category: "loop-templates",
    kind: "write",
    description:
      "Validate the draft, snapshot it as a new version, and bump the published version. Boards bound to it then see drift.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "ref",
        required: true,
        description: "The workspace template's row UUID (or slug).",
      },
      {
        name: "expected_version",
        required: false,
        description: "Optimistic lock — the version you believe is current.",
      },
      {
        name: "note",
        required: false,
        description: "Short changelog line stored with the version (<= 500 chars).",
      },
    ],
    gotchas: [
      "A draft that fails validation returns 422 with findings attached, each naming the offending field.",
      "Publishing does not touch bound boards — they keep their rendered prompts until someone re-renders.",
    ],
    examplePrompt:
      "Using the Backplane MCP, publish the loop template <ref> in <workspace> with the note <note>.",
    related: ["update_loop_template", "list_loop_template_versions", "restore_loop_template_version"],
  },
  {
    name: "duplicate_loop_template",
    category: "loop-templates",
    kind: "write",
    description:
      "Fork any template — system or workspace — into a new workspace draft, recording lineage back to the source.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "ref",
        required: true,
        description: "The template to fork — a system slug or a workspace row UUID.",
      },
      {
        name: "new_slug",
        required: false,
        description: "Slug for the copy. Omit to let the backend derive a unique one.",
      },
    ],
    gotchas: [
      "This is how a system template gets customized: system templates are immutable, so editing one means duplicating it first.",
    ],
    examplePrompt:
      "Using the Backplane MCP, duplicate the coding-loop template into <workspace> so I can customize it.",
    related: ["get_loop_template", "update_loop_template", "list_loop_templates"],
  },
  {
    name: "archive_loop_template",
    category: "loop-templates",
    kind: "write",
    description:
      "Soft-archive a workspace template, or restore it to the listing with archived=false. There is no hard delete.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "ref",
        required: true,
        description: "The workspace template's row UUID (or slug).",
      },
      {
        name: "archived",
        required: false,
        description: "True to archive (default), false to restore to the listing.",
      },
    ],
    gotchas: [
      "Archiving removes it from the catalog listing but keeps it serving boards already bound to it.",
      "There is no hard delete on purpose — a board bound to a deleted template would render nothing on its next iteration.",
    ],
    examplePrompt:
      "Using the Backplane MCP, archive the loop template <ref> in <workspace>.",
    related: ["list_loop_templates", "get_loop_template"],
  },
  {
    name: "list_loop_template_versions",
    category: "loop-templates",
    kind: "read",
    description:
      "The template's published history, newest first: version number, publish timestamp, and changelog note.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "ref",
        required: true,
        description: "A system template slug, or a workspace template's row UUID.",
      },
    ],
    examplePrompt:
      "Using the Backplane MCP, show the version history of the loop template <ref> in <workspace>.",
    related: ["restore_loop_template_version", "publish_loop_template"],
  },
  {
    name: "restore_loop_template_version",
    category: "loop-templates",
    kind: "write",
    description:
      "Stage a published snapshot as the current draft. It does NOT republish — review, then publish separately.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "ref",
        required: true,
        description: "The workspace template's row UUID (or slug).",
      },
      {
        name: "version",
        required: true,
        description: "The published version number to stage as the draft.",
      },
    ],
    gotchas: [
      "Restoring is a draft edit, not a rollback: the published version stays put until you publish the restored draft.",
    ],
    examplePrompt:
      "Using the Backplane MCP, restore version 2 of the loop template <ref> in <workspace> as a draft.",
    related: ["list_loop_template_versions", "publish_loop_template"],
  },
  {
    name: "get_board_loop_binding_raw",
    category: "loop-templates",
    kind: "read",
    description:
      "Raw view of a board's template binding: template, version, rendered slot values, and drift — the authoring state behind get_board_loop, the effective loop config.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "include_diff",
        required: false,
        description:
          "True to also fetch the unified prompt diff and slot delta between the bound version and the current one.",
      },
    ],
    gotchas: [
      "get_board_loop carries only the slim template ref — enough to render \"bound to X\", not enough to re-render. This is the read that answers \"what would I edit?\".",
      "Returns 404 not_bound when the board's prompts are raw rather than template-rendered.",
      "include_diff costs a second round-trip and is skipped entirely when the binding reports diff_available: false — a board with no drift has nothing to diff.",
    ],
    examplePrompt:
      "Using the Backplane MCP, call get_board_loop_binding_raw for the <board> board in <workspace> to see which template and slot values its loop renders from.",
    related: ["get_board_loop", "set_board_loop", "get_loop_template"],
  },
  {
    name: "apply_loop_template_fixes",
    category: "loop-templates",
    kind: "write",
    description:
      "Apply the named setup fixes from a fit report (create a missing column, add a label) and return the freshly recomputed report.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board; the board's slug also works.",
      },
      {
        name: "template_ref",
        required: true,
        description: "A system template slug, or a workspace template's row UUID.",
      },
      {
        name: "fix_ids",
        required: true,
        description:
          'The fix_id values from get_loop_template(view=\'fit\'), e.g. "create_column:done". Only these are applied — nothing implicit.',
      },
    ],
    gotchas: [
      "Admin + human keys only — the backend 403s runner callers, because a loop runner reshaping the board that governs it is a privilege escalation.",
      "Idempotent per fix: an already-satisfied requirement returns skipped_already_satisfied, never an error.",
      "Unknown fix ids are rejected wholesale (422) before anything is applied; a frozen board 409s.",
      "Acts on the DRAFT half, like the report it consumes: a board can be prepared for a contract that has not been published yet. A column is inert until something binds to it.",
    ],
    danger:
      "This mutates board structure — it can create columns and labels. Run get_loop_template(view='fit') first and pass only the fix_ids you intend.",
    examplePrompt:
      "Using the Backplane MCP, apply the create_column:done fix from the <template> fit report to the <board> board in <workspace>.",
    related: ["get_loop_template", "set_board_loop"],
  },
  {
    name: "export_loop_template",
    category: "loop-templates",
    kind: "composite",
    description:
      "Export one loop template as a portable envelope — profile, prompts, slots, rails. Feed it to import_loop_template to promote a proven loop elsewhere.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the SOURCE workspace.",
      },
      {
        name: "template_ref",
        required: true,
        description: "A system template slug, or a workspace template's row UUID.",
      },
    ],
    gotchas: [
      "Exports the DRAFT half, so work in progress is shareable — publish first if you mean to share the runnable version.",
      "Exporting a SYSTEM template is allowed and marked data.is_system_origin: it is the supported way to fork a shipped loop.",
      "data.leak_findings carries the same repo-fact hints get_loop_template(view='lint') reports, as warnings only — the export always succeeds. _hint counts them.",
      "Member-gated, not admin-gated: anyone who can read the template in the manager can export it.",
    ],
    examplePrompt:
      "Export the <template> loop template from <workspace> with export_loop_template and tell me whether any repo-specific facts would travel with it.",
    related: ["import_loop_template", "get_loop_template"],
  },
  {
    name: "import_loop_template",
    category: "loop-templates",
    kind: "composite",
    description:
      "Import a loop_template envelope as a DRAFT in this workspace. Previews by default; dry_run=false commits. Admin/human keys only — runners get 403.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the TARGET workspace.",
      },
      {
        name: "bundle",
        required: true,
        description: "The full envelope exactly as returned by export_loop_template.",
      },
      {
        name: "dry_run",
        required: false,
        description:
          "Defaults to true: report action, findings and diff_summary, and write nothing. Set false to apply.",
      },
    ],
    gotchas: [
      "`dry_run` defaults to TRUE — nothing is written until you re-call with dry_run=false, which adds template_id.",
      "A commit always lands UNPUBLISHED, so an import can never change what a running board executes; publish_loop_template stays a separate act.",
      "A matching slug in the target makes this action=updated — the existing DRAFT is overwritten. Check diff_summary in the dry run first.",
      "Runner callers are refused with 403 by design: a runner must not import the prompt that governs it. Envelope mismatch → 400; unrenderable template → 422.",
      "Bundles over ~64 KB are better sent to POST /loop-templates/import directly — large JSON bodies through MCP have been seen to garble.",
    ],
    danger:
      "With dry_run=false a slug collision OVERWRITES the target workspace's existing draft for that slug. Export a backup bundle from the target first.",
    examplePrompt:
      "Import this loop template bundle into <workspace> with import_loop_template. Dry run first, show me the diff_summary and any findings, and only apply after I confirm.",
    related: ["export_loop_template", "publish_loop_template", "list_loop_templates"],
  },
];
