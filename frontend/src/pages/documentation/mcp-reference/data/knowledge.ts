// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDoc } from "./types";

// Author slice — categories: notes, definitions, resources, context, health.
export const KNOWLEDGE_TOOL_DOCS: ToolDoc[] = [
  // ── Context ──────────────────────────────────────────────────────────────
  {
    name: "get_project_context",
    category: "context",
    kind: "composite",
    description:
      "Get a full project briefing in one call: board summary, definition, notes, git repos, and recent activity. Make this the first call of any workflow.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board to brief on.",
      },
    ],
    gotchas: [
      "Heavy sections are capped (25 notes, 20 activity rows, definition ~8KB). Trimmed responses carry `_..._truncated` markers and an `_hint` naming the tool that returns the full data.",
      "The board section is always a compact per-column summary — never full cards. Use list_cards or search_cards for card detail.",
    ],
    examplePrompt:
      "Start by calling get_project_context for the <board> board in the <workspace> workspace and brief me on where the project stands.",
    related: ["get_definition", "list_notes", "get_board_health", "next_assignment"],
  },

  // ── Board health ─────────────────────────────────────────────────────────
  {
    name: "get_board_health",
    category: "health",
    kind: "read",
    description:
      "Check a board's computed health: 0-100 score, stale/overdue/unassigned cards, priority and column distribution, and velocity. Use for triage and standups.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board to score.",
      },
    ],
    gotchas: [
      "Complements get_project_context — health adds the stale/overdue/velocity signals the briefing does not include.",
    ],
    examplePrompt:
      "Run get_board_health on the <board> board and flag anything that needs attention in today's standup.",
    related: ["get_project_context", "validate_board_dependencies", "get_pipeline_sensors"],
  },

  // ── Notes ────────────────────────────────────────────────────────────────
  {
    name: "list_notes",
    category: "notes",
    kind: "read",
    description:
      "Browse a bounded page of workspace-level or board notes. Bodies are omitted by default; read one note with get_note(format=\"markdown\").",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID to list board-scoped notes instead of workspace-level ones.",
      },
      {
        name: "card_id",
        required: false,
        description: "Card UUID to filter to notes linked to that card (requires board_id).",
      },
      {
        name: "summary_only",
        required: false,
        description: "Omit content bodies (default: true). Set false only when the bounded page needs raw ProseMirror bodies.",
      },
      {
        name: "q",
        required: false,
        description: "Case-insensitive substring in title and plain-text body, applied before paging.",
      },
      {
        name: "pinned_only",
        required: false,
        description: "Only pinned notes when true (default: false).",
      },
      {
        name: "kinds",
        required: false,
        description: "Match any listed note kind, such as plan or review_verdict.",
      },
      {
        name: "limit",
        required: false,
        description: "Page size, 1–100 (default: 25).",
      },
      {
        name: "offset",
        required: false,
        description: "Zero-based offset (default: 0); reuse next_offset with the same filters.",
      },
    ],
    gotchas: [
      "Returns {notes, total, limit, offset, has_more, next_offset, _hint}, not a bare list. Follow next_offset with unchanged filters until has_more=false.",
      "Pages are a live view, not a snapshot: restart at offset=0 if notes change during traversal. An older backend without pagination metadata fails explicitly.",
      "card_id requires board_id and combines with q, pinned_only and kinds before pagination. Without board_id, only workspace-level notes are listed.",
    ],
    examplePrompt:
      "List the notes on the <board> board with summary_only enabled and tell me which ones look relevant to <topic>.",
    related: ["get_note", "create_note", "get_project_context"],
  },
  {
    name: "get_note",
    category: "notes",
    kind: "read",
    description:
      'Read a single note by id. Prefer format="markdown" for a readable, token-cheap body; the default returns raw ProseMirror JSON.',
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "note_id",
        required: true,
        description: "UUID of the note to read.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID if the note is board-scoped; omit for workspace notes.",
      },
      {
        name: "format",
        required: false,
        description: '"prosemirror" (default, raw JSON tree) or "markdown" (converted, readable).',
      },
    ],
    gotchas: [
      'format="markdown" converts the stored ProseMirror document to markdown — it round-trips with the markdown create_note accepts. Use it unless you need the JSON tree.',
      "board_id only selects the URL path — the lookup is by note_id within the workspace, so a board-scoped note is also retrievable without board_id.",
    ],
    examplePrompt:
      "Fetch note <note_id> from the <workspace> workspace as markdown with get_note and summarize its action items.",
    related: ["list_notes", "update_note", "create_note"],
  },
  {
    name: "create_note",
    category: "notes",
    kind: "write",
    description:
      "Create a note on a workspace or board, optionally linked to a card. Use for plans, briefs, decisions, or any prose worth keeping next to the work.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "title",
        required: true,
        description: "The note title.",
      },
      {
        name: "content",
        required: false,
        description:
          "Note body — send markdown (recommended); HTML, plain text, or ProseMirror JSON are also accepted and normalized.",
      },
      {
        name: "pinned",
        required: false,
        description: "Pin the note to the top of the list.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID to scope the note to a board instead of the workspace.",
      },
      {
        name: "card_id",
        required: false,
        description:
          "Card UUID to link the note to; the card must belong to the note's board (pass board_id alongside it — a workspace-level create with card_id is rejected).",
      },
      {
        name: "kind",
        required: false,
        description:
          'Note kind — "user_note" (default) for free-form prose; pipeline kinds like "plan", "rework_brief", "review_verdict" are structural notes consumed by runner stages.',
      },
    ],
    gotchas: [
      "Mutation receipts can contain raw ProseMirror JSON, identified by _content_format or _description_format and _hint. Do not reuse a receipt as editable markdown: read get_note(format=\"markdown\") or get_card, or preserve your original markdown before editing.",
      "Send content as markdown — the backend normalizes markdown, HTML, plain text, and ProseMirror JSON to canonical ProseMirror before storing (headings h1-h3, bold/italic, code, lists, links, blockquotes).",
      "kind is NOT validated — any string is stored verbatim (deliberately operator-extensible), so a typo silently creates an inert note. Only known kinds (plan, rework_brief, review_verdict, system) drive pipeline behavior.",
      'A note created with kind="review_verdict" is permanently immutable — update_note and delete_note are rejected on it.',
    ],
    examplePrompt:
      'Create a pinned note titled "<title>" on the <board> board summarizing today\'s decisions in markdown.',
    related: ["list_notes", "get_note", "update_note"],
  },
  {
    name: "update_note",
    category: "notes",
    kind: "write",
    description:
      "Edit a note's title, pinned flag, card link, or body. mode picks how content lands: replace the whole body, append at the end, or rewrite one section.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "note_id",
        required: true,
        description: "UUID of the note to update.",
      },
      {
        name: "title",
        required: false,
        description: "New title for the note.",
      },
      {
        name: "content",
        required: false,
        description:
          'Body blocks — markdown recommended, normalized like create_note. mode decides where they land: the whole body (mode="replace"), after the existing body (mode="append", where content is required), or under one heading (mode="section").',
      },
      {
        name: "mode",
        required: false,
        description:
          '"replace" (default) rewrites the whole body with content; "append" adds content blocks at the end; "section" rewrites only the body under anchor_heading.',
      },
      {
        name: "anchor_heading",
        required: false,
        description:
          'mode="section" only: heading text whose section is rewritten, without the leading # marks — "Cluster I", not "## Cluster I". Matching is trimmed and case-insensitive.',
      },
      {
        name: "pinned",
        required: false,
        description: "Whether the note should be pinned.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID if the note is board-scoped.",
      },
      {
        name: "card_id",
        required: false,
        description:
          "Card UUID to link the note to; the card must belong to the note's board. Omit to leave any existing link untouched.",
      },
      {
        name: "detach_card",
        required: false,
        description:
          "Pass true to clear the note's card link (sends an explicit null). Wins over card_id if both are passed.",
      },
    ],
    gotchas: [
      "Mutation receipts can contain raw ProseMirror JSON, identified by _content_format or _description_format and _hint. Do not reuse a receipt as editable markdown: read get_note(format=\"markdown\") or get_card, or preserve your original markdown before editing.",
      'mode="replace" (the default) swaps the whole body, not a merge. For logs and journals use mode="append", which adds blocks after the existing body and leaves the rest untouched.',
      'mode="append" is additive, not idempotent — calling it twice appends twice, and empty content is rejected. If a call\'s result was lost, read the note back before retrying.',
      'mode="section" is the idempotent way to edit a status inside a long tracker: only the body under anchor_heading changes, the heading itself stays, and empty or omitted content clears the section. Replaying the same call converges.',
      "A section runs to the next heading of the same or higher level, so rewriting a ## section also rewrites the ### subsections nested under it.",
      'In mode="section" a heading that does not exist is a not-found error, not an insert (use mode="append" to add a new section), and a heading that appears more than once is a conflict — disambiguate the headings in the note first.',
      "title, pinned, card_id and detach_card apply in every mode and are saved before the body operation, so a rejected append or section edit can still have changed the metadata.",
      'Notes with kind="review_verdict" are append-only audit records — updates are rejected with a permission error.',
    ],
    examplePrompt:
      'Add a "Session <n>" entry to the end of note <note_id> on the <board> board, then mark its "Cluster I" section done with a one-line summary.',
    related: ["get_note", "create_note", "list_notes", "delete_note"],
  },
  {
    name: "delete_note",
    category: "notes",
    kind: "write",
    description: "Delete a note permanently. Use when a note is obsolete or was created by mistake.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "note_id",
        required: true,
        description: "UUID of the note to delete.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID if the note is board-scoped.",
      },
    ],
    gotchas: [
      "Permanent — there is no trash or undo.",
      'Notes with kind="review_verdict" cannot be deleted — the backend rejects it with a permission error (append-only audit record).',
      "Runner pipeline stages read structural notes (e.g. kind=plan) — deleting one can strand an in-flight card's context.",
    ],
    examplePrompt:
      "Delete note <note_id> from the <workspace> workspace — it's an outdated draft we no longer need.",
    related: ["list_notes", "get_note", "update_note"],
  },

  // ── Definitions ──────────────────────────────────────────────────────────
  {
    name: "get_definition",
    category: "definitions",
    kind: "read",
    description:
      "Read a board's definition document — the scope, goals, conventions, and structured context to load before working on the board.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
    ],
    gotchas: [
      "get_project_context embeds the definition too but truncates large fields — this call returns the full text.",
      "Returns a 404 if the board has no definition yet — create one with update_definition (it upserts).",
    ],
    examplePrompt:
      "Read the definition of the <board> board with get_definition and check whether <feature> is in scope before I start.",
    related: ["get_project_context", "update_definition"],
  },
  {
    name: "update_definition",
    category: "definitions",
    kind: "write",
    description:
      "Create or update a board's definition (idempotent upsert). Fields you pass are merged over the existing content; everything else is preserved.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "scope",
        required: false,
        description: "High-level scope/summary paragraph for the project.",
      },
      {
        name: "objectives",
        required: false,
        description: 'Goals, as [{"text", "priority"?}].',
      },
      {
        name: "exclusions",
        required: false,
        description: "Out-of-scope items, as a list of strings.",
      },
      {
        name: "milestones",
        required: false,
        description: 'Milestones, as [{"title", "date", "type"?}].',
      },
      {
        name: "tech_stack",
        required: false,
        description: "Technologies/tools, as a list of strings.",
      },
      {
        name: "stakeholders",
        required: false,
        description: 'Stakeholders, as [{"name", "role"?, "member_id"?, "channel_id"?}].',
      },
      {
        name: "constraints",
        required: false,
        description: "Hard constraints, as a list of strings.",
      },
      {
        name: "decisions",
        required: false,
        description: 'Recorded decisions, as [{"decision", "rationale"?}].',
      },
      {
        name: "references",
        required: false,
        description: 'Links and docs, as [{"url", "label"?}].',
      },
      {
        name: "custom_fields",
        required: false,
        description: 'Arbitrary key/values, as [{"key", "value"?}].',
      },
      {
        name: "coding_standards",
        required: false,
        description: "Free-text coding standards and conventions.",
      },
      {
        name: "content",
        required: false,
        description:
          "Raw content dict for keys not yet exposed as dedicated params; explicit params win on conflict.",
      },
    ],
    gotchas: [
      "Upsert — creates the definition if the board has none yet.",
      "Merge is shallow and per-key: sending a list field replaces that whole list, so read-modify-write when appending.",
      "Explicit structured params override the same key passed inside content.",
    ],
    examplePrompt:
      'Update the <board> board definition: add <technology> to the tech stack and record the decision "<decision>" with its rationale.',
    related: ["get_definition", "get_project_context", "create_board"],
  },

  // ── Resources ────────────────────────────────────────────────────────────
  {
    name: "list_resources",
    category: "resources",
    kind: "read",
    description:
      "Browse files and folders in a workspace or board, or search them by name, type, or tag. Use before downloading or organizing attachments.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID to list board-scoped resources instead of workspace-level ones.",
      },
      {
        name: "parent_id",
        required: false,
        description: "Folder UUID to list that folder's children.",
      },
      {
        name: "search",
        required: false,
        description: "Filter resources by name.",
      },
      {
        name: "resource_type",
        required: false,
        description: 'Filter by type — "file" or "folder".',
      },
      {
        name: "tag",
        required: false,
        description: "Filter by metadata tag.",
      },
    ],
    gotchas: [
      "Without filters it returns only root-level resources — pass parent_id to descend into a folder.",
      "When search/resource_type/tag filters are set, parent_id is ignored — filtered queries search the whole scope.",
    ],
    examplePrompt:
      'List the resources on the <board> board tagged "<tag>" and tell me which files were updated most recently.',
    related: ["get_resource", "create_resource", "get_download_url"],
  },
  {
    name: "get_resource",
    category: "resources",
    kind: "read",
    description:
      "Fetch one resource's record — name, type, size, MIME type, storage path, tags, description. Use before updating or downloading it.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "resource_id",
        required: true,
        description: "UUID of the resource.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID if the resource is board-scoped.",
      },
    ],
    gotchas: [
      "Returns the metadata record only — use get_download_url to fetch the file's contents.",
    ],
    examplePrompt:
      "Show me the details of resource <resource_id> in the <workspace> workspace, including its tags and size.",
    related: ["list_resources", "get_download_url", "update_resource"],
  },
  {
    name: "create_resource",
    category: "resources",
    kind: "write",
    description:
      "Register a file or folder in the resource library. For uploads: call get_upload_url, PUT the file, then pass the returned gcs_path here.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "name",
        required: true,
        description: "The resource name.",
      },
      {
        name: "resource_type",
        required: false,
        description: '"file" (default) or "folder".',
      },
      {
        name: "parent_id",
        required: false,
        description: "Parent folder UUID for nesting.",
      },
      {
        name: "description",
        required: false,
        description: "Optional description of the resource.",
      },
      {
        name: "metadata",
        required: false,
        description: 'Metadata dict — only {"tags": [...]} is kept (max 20 tags, 50 chars each).',
      },
      {
        name: "gcs_path",
        required: false,
        description: "Storage path returned by get_upload_url; required to link an uploaded file.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID to scope the resource to a board instead of the workspace.",
      },
    ],
    gotchas: [
      'metadata is validated to a closed shape — only the "tags" key survives; any other key is silently dropped.',
      "parent_id must reference a folder-type resource in the same workspace.",
      "A file created without gcs_path gets a generated storage path with no uploaded bytes behind it — get_download_url on it will not serve a file.",
    ],
    examplePrompt:
      'Upload <file> to the <board> board: get an upload URL, PUT the file, then register it with create_resource tagged "<tag>".',
    related: ["get_upload_url", "list_resources", "update_resource"],
  },
  {
    name: "update_resource",
    category: "resources",
    kind: "write",
    description:
      "Rename, re-describe, re-tag, or move a resource to another folder. Only fields you pass are changed.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "resource_id",
        required: true,
        description: "UUID of the resource to update.",
      },
      {
        name: "name",
        required: false,
        description: "New resource name.",
      },
      {
        name: "description",
        required: false,
        description: "New description.",
      },
      {
        name: "metadata",
        required: false,
        description: "Metadata dict, shallow-merged over the existing one; only tags are kept.",
      },
      {
        name: "parent_id",
        required: false,
        description: "Folder UUID to move the resource into.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID if the resource is board-scoped.",
      },
    ],
    gotchas: [
      "metadata is shallow-merged per key, then validated — only the tags key survives, and a tags array you send replaces the ENTIRE existing list. To append a tag, read the resource first and send old + new tags together.",
      "Moves are cycle-checked: the new parent must be a folder and cannot sit inside the resource being moved.",
    ],
    examplePrompt:
      'Move resource <resource_id> into the <folder> folder and add the tag "<tag>" without touching its other fields.',
    related: ["get_resource", "list_resources", "delete_resource"],
  },
  {
    name: "get_upload_url",
    category: "resources",
    kind: "write",
    description:
      "Mint a signed URL for uploading a file. PUT the file bytes to the URL, then register it with create_resource using the returned gcs_path.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "filename",
        required: true,
        description: 'File name, e.g. "report.pdf".',
      },
      {
        name: "content_type",
        required: true,
        description: 'MIME type, e.g. "application/pdf" or "image/png".',
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID to scope the upload to a board.",
      },
    ],
    gotchas: [
      "The signed URL expires after 15 minutes — upload promptly.",
      "Your PUT must send the same Content-Type the URL was signed for, or storage rejects it.",
      "Uploading alone does not create a resource — the file is invisible to the platform until create_resource registers the gcs_path.",
    ],
    examplePrompt:
      'Get an upload URL for "<filename>" (<mime type>) in the <workspace> workspace, then walk me through uploading and registering it.',
    related: ["create_resource", "get_download_url"],
  },
  {
    name: "get_download_url",
    category: "resources",
    kind: "read",
    description:
      "Mint a signed URL (valid 1 hour) to download a file resource's contents. Use after list_resources or get_resource identifies the file.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "resource_id",
        required: true,
        description: "UUID of the file resource.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID if the resource is board-scoped.",
      },
    ],
    gotchas: [
      "Errors only when the resource has no storage path — in practice, folders. A file registered without an actual upload still returns a URL; the download itself then fails because no bytes were ever written.",
      "The URL expires after 1 hour.",
    ],
    examplePrompt: "Get me a download link for resource <resource_id> on the <board> board.",
    related: ["list_resources", "get_resource", "get_upload_url"],
  },
  {
    name: "delete_resource",
    category: "resources",
    kind: "write",
    description: "Delete a resource record permanently. Use for obsolete files or folders.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug of the workspace.",
      },
      {
        name: "resource_id",
        required: true,
        description: "UUID of the resource to delete.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID if the resource is board-scoped.",
      },
    ],
    gotchas: [
      "Permanent — no trash or undo.",
      "Deletes only the platform record; the uploaded file stays in cloud storage.",
      "Deleting a folder that still has children fails — move or delete its contents first.",
    ],
    examplePrompt:
      "Delete resource <resource_id> from the <workspace> workspace — it's an outdated draft.",
    related: ["list_resources", "get_resource", "update_resource"],
  },
];
