// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDoc } from "./types";

// Author slice — categories: card-dependencies, approvals, merge-queue.
export const FLOW_CONTROL_TOOL_DOCS: ToolDoc[] = [
  {
    name: "get_completion_policy",
    category: "merge-queue",
    kind: "read",
    description: "Read the effective completion policy, inheritance, capabilities and incompatibilities.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
    ],
    examplePrompt: "Use get_completion_policy for the current card on <board> in <workspace>.",
    related: ["get_completion_policy", "get_completion_status"],
  },
  {
    name: "get_completion_status",
    category: "merge-queue",
    kind: "read",
    description: "Read the current candidate, exact source and merge revisions, and public completion history.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description: "Full UUID of the card.",
      },
    ],
    examplePrompt: "Use get_completion_status for the current card on <board> in <workspace>.",
    related: ["get_completion_policy", "get_completion_status"],
  },
  {
    name: "submit_completion_candidate",
    category: "merge-queue",
    kind: "write",
    description: "Submit current execution provenance for source or operator-selected evidence-only completion.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description: "Full UUID of the card.",
      },
      {
        name: "source_execution_id",
        required: true,
        description: "This iteration's execution UUID, supplied by the runner.",
      },
      {
        name: "source_sha",
        required: false,
        description: "Full source commit SHA for evidence-only work.",
      },
      {
        name: "artifacts",
        required: false,
        description: "Exact artifact records: [{name, uri, sha256}].",
      },
      {
        name: "checks",
        required: false,
        description: "Named check results: [{id, source_sha, exit_code, output}].",
      },
    ],
    examplePrompt: "Use submit_completion_candidate for the current card on <board> in <workspace>.",
    related: ["get_completion_policy", "get_completion_status"],
  },
  {
    name: "request_landing",
    category: "merge-queue",
    kind: "write",
    description: "Request policy-authorized merge-queue landing for the current candidate.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description: "Full UUID of the card.",
      },
    ],
    examplePrompt: "Use request_landing for the current card on <board> in <workspace>.",
    related: ["get_completion_policy", "get_completion_status"],
  },
  {
    name: "retry_completion",
    category: "merge-queue",
    kind: "write",
    description: "Retry a failed resumable completion phase on the current candidate.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description: "Full UUID of the card.",
      },
    ],
    examplePrompt: "Use retry_completion for the current card on <board> in <workspace>.",
    related: ["get_completion_policy", "get_completion_status"],
  },
  // ── Card Dependencies ──────────────────────────────────────────────
  {
    name: "add_card_dependency",
    category: "card-dependencies",
    kind: "write",
    description:
      "Declare that one card must finish before another can start. Use when ordering work — the scheduler will not assign a card until all its prerequisites are done.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board (URL scope, resolved for routing).",
      },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card that depends on another, or a unique id prefix (≥4 chars).",
      },
      {
        name: "depends_on_card_id",
        required: true,
        description:
          "Full UUID of the prerequisite card, or a unique id prefix (≥4 chars).",
      },
    ],
    gotchas: [
      "Idempotent: re-adding an existing edge returns the existing row instead of erroring.",
      "Both card ids accept a short id prefix (≥4 chars), resolved against this board. An ambiguous prefix returns an error listing the candidates.",
      "Cycles and self-dependencies are rejected with a 422 error — the graph stays acyclic.",
      "Prerequisites follow the effective completion policy: accepted or Done release. Legacy boards still use the done-type column.",
      "Edges are workspace-scoped, not board-checked: linking cards on different boards succeeds, but validate_board_dependencies flags such edges as orphans.",
    ],
    examplePrompt:
      "On the <board> board in <workspace>, make the '<Deploy>' card depend on '<CI setup>' so it can't be picked up until CI setup is done.",
    related: [
      "remove_card_dependency",
      "bulk_set_card_dependencies",
      "get_card_dependency_status",
      "validate_board_dependencies",
    ],
  },
  {
    name: "remove_card_dependency",
    category: "card-dependencies",
    kind: "write",
    description:
      "Remove a depends-on edge between two cards. Use to unblock a card when a prerequisite no longer applies.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the dependent card, or a unique id prefix (≥4 chars).",
      },
      {
        name: "depends_on_card_id",
        required: true,
        description:
          "Full UUID of the prerequisite card to unlink, or a unique id prefix (≥4 chars).",
      },
    ],
    gotchas: [
      "Idempotent: removing an edge that does not exist succeeds as a no-op.",
      "Both card ids accept a short id prefix (≥4 chars), resolved against this board.",
    ],
    examplePrompt:
      "The '<API v2>' card on the <board> board no longer needs '<schema migration>' first — remove that dependency so it unblocks.",
    related: [
      "add_card_dependency",
      "list_card_dependencies",
      "get_card_dependency_status",
    ],
  },
  {
    name: "list_card_dependencies",
    category: "card-dependencies",
    kind: "read",
    description:
      "List a card's dependency edges in both directions: the cards it depends on and the cards it blocks. Use to inspect wiring before adding or removing edges.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description: "Full UUID of the card, or a unique id prefix (≥4 chars).",
      },
    ],
    gotchas: [
      "depends_on = this card's prerequisites; blocks = cards waiting on this one.",
      "card_id accepts a short id prefix (≥4 chars), resolved against this board.",
      "Edges carry the other card's title, status, and column type — often enough without fetching each card.",
    ],
    examplePrompt:
      "Show me everything the '<Release>' card on the <board> board depends on and every card it blocks.",
    related: [
      "get_card_dependency_status",
      "add_card_dependency",
      "remove_card_dependency",
      "validate_board_dependencies",
    ],
  },
  {
    name: "validate_board_dependencies",
    category: "card-dependencies",
    kind: "read",
    description:
      "Check a whole board's dependency graph for cycles, conflicts, and dangling edges. Use before sprint planning or when cards seem stuck for no clear reason.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board to validate.",
      },
    ],
    gotchas: [
      "Read-only: reports faults but fixes nothing — repair with add/remove/bulk_set_card_dependencies or by moving cards.",
      "Cards trapped in a cycle can never become eligible for pickup until the loop is broken.",
      "conflicts = done cards whose prerequisites are not done; orphans = edges pointing at cards not on this board.",
    ],
    examplePrompt:
      "Run validate_board_dependencies on the <board> board in <workspace> and explain any cycles, conflicts, or orphan edges it finds.",
    related: [
      "list_card_dependencies",
      "bulk_set_card_dependencies",
      "get_card_dependency_status",
      "get_board_health",
    ],
  },
  {
    name: "get_card_dependency_status",
    category: "card-dependencies",
    kind: "read",
    description:
      "Answer whether a card is unblocked in one call: is every prerequisite done, and if not, exactly which cards still block it. Use before scheduling or picking up work.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card to check, or a unique id prefix (≥4 chars).",
      },
    ],
    gotchas: [
      "satisfied mirrors the exact condition the scheduler gates pickup on: every prerequisite in a done-type column.",
      "blocking lists only the unfinished prerequisites, each with title, status, and column type — the finish-first list.",
      "card_id accepts a short id prefix (≥4 chars); the returned card_id is always the resolved full UUID.",
    ],
    examplePrompt:
      "Check with get_card_dependency_status whether card <card id> on the <board> board is unblocked, and if not, tell me which cards to finish first.",
    related: [
      "list_card_dependencies",
      "validate_board_dependencies",
      "next_assignment",
    ],
  },
  {
    name: "get_card_verdict",
    category: "card-dependencies",
    kind: "read",
    description:
      "Fetch the latest review verdict on a card — the decision and the reviewer's reasoning. Use during rework to learn why the card was approved or rejected.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card whose verdict you want, or a unique id prefix (≥4 chars).",
      },
    ],
    gotchas: [
      "Returns a structured 404 error when the card has never been reviewed — expect it for un-reviewed cards.",
      "card_id accepts a short id prefix (≥4 chars), resolved against this board.",
    ],
    examplePrompt:
      "Card <card id> on the <board> board bounced back from review — fetch its verdict with get_card_verdict and summarize why it was rejected.",
    related: ["get_card", "move_card", "next_assignment"],
  },
  {
    name: "bulk_set_card_dependencies",
    category: "card-dependencies",
    kind: "composite",
    description:
      "Replace a card's entire depends-on set atomically in one call. Use when planning to declare a card's full prerequisite list instead of adding edges one by one.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "board_id",
        required: true,
        description: "UUID of the board.",
      },
      {
        name: "card_id",
        required: true,
        description:
          "Full UUID of the card whose dependencies you are replacing, or a unique id prefix (≥4 chars).",
      },
      {
        name: "depends_on_card_ids",
        required: true,
        description:
          "Full replacement list of prerequisite cards, each a full UUID or a unique id prefix (≥4 chars). An empty list clears every dependency.",
      },
    ],
    gotchas: [
      "REPLACES the whole set: edges missing from the list are removed, and an empty list clears every dependency.",
      "All-or-nothing: the proposed set is validated for cycles before any change — on rejection existing edges are untouched.",
      "Every id accepts a short prefix (≥4 chars), each costing one resolve round-trip — pass full UUIDs for large sets.",
    ],
    examplePrompt:
      "Using bulk_set_card_dependencies, set the '<Release v2>' card on the <board> board to depend on exactly these cards: <card A>, <card B>, <card C>.",
    related: [
      "add_card_dependency",
      "bulk_create_cards",
      "validate_board_dependencies",
    ],
  },

  // ── Approvals ──────────────────────────────────────────────────────
  {
    name: "request_approval",
    category: "approvals",
    kind: "write",
    description:
      "Ask a human to approve a high-impact action (deletion, deployment, bulk change) before running it. Use when about to do something risky, then wait for the decision.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "category",
        required: true,
        description:
          "Risk category: deletion, bulk_change, deployment, schema_change, permission_change, or external_action.",
      },
      {
        name: "action_description",
        required: true,
        description: "Human-readable description of what will happen if approved.",
      },
      {
        name: "action_payload",
        required: true,
        description: "JSON payload of the action to execute once approved.",
      },
      {
        name: "agent_id",
        required: true,
        description: "UUID of the requesting agent.",
      },
      {
        name: "board_id",
        required: false,
        description: "Board UUID if the action is board-scoped.",
      },
    ],
    gotchas: [
      "Do not proceed after calling — poll get_approval_status until the request is approved or rejected.",
      "Low-risk requests can come back auto_approved immediately, with no human involved.",
      "expires_at is stamped 24 hours out, but nothing ever flips the stored status to expired — a stale undecided request still reads pending; compare expires_at yourself.",
    ],
    examplePrompt:
      "Before deleting the archived boards in <workspace>, file a request_approval describing exactly what will be removed, then wait for my decision.",
    related: ["get_approval_status", "list_approvals", "decide_approval"],
  },
  {
    name: "list_approvals",
    category: "approvals",
    kind: "read",
    description:
      "List approval requests in a workspace, optionally filtered by status. Use to discover what is waiting on a decision when you have no approval id in hand.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "status",
        required: false,
        description:
          "Filter: pending, approved, rejected, expired, or auto_approved. Approvers usually want pending.",
      },
    ],
    gotchas: [
      "status is the only filter — there is no board, agent, or category filter; scan the results yourself.",
      "Discover-then-decide: find pending requests here, then act on each with decide_approval.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list pending approvals in the <workspace> workspace with list_approvals and summarize what each one is asking, then wait for my decisions.",
    related: ["decide_approval", "get_approval_status", "request_approval"],
  },
  {
    name: "get_approval_status",
    category: "approvals",
    kind: "read",
    description:
      "Check where one approval request stands: pending, approved, rejected, expired, or auto_approved. Use to poll after request_approval before acting.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "approval_id",
        required: true,
        description: "Approval id returned by request_approval.",
      },
    ],
    gotchas: [
      "auto_approved means policy granted it without a human — treat it as approved.",
      "The expired status exists in the enum but the backend never sets it — a past-deadline request still reads pending. Compare expires_at yourself; if it has passed, treat the request as dead and file a fresh one.",
    ],
    examplePrompt:
      "Check the status of approval <approval id> in <workspace>; if it's still pending, wait a bit and poll again before doing anything.",
    related: ["request_approval", "decide_approval", "list_approvals"],
  },
  {
    name: "decide_approval",
    category: "approvals",
    kind: "write",
    description:
      "Approve or reject a pending approval request as the human in the loop. Use after reviewing what a request asks, typically discovered via list_approvals.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "approval_id",
        required: true,
        description: "UUID of the approval request to decide.",
      },
      {
        name: "decision",
        required: true,
        description: "Either 'approved' or 'rejected'.",
      },
      {
        name: "reason",
        required: false,
        description: "Reason recorded alongside the decision.",
      },
    ],
    gotchas: [
      "Only pending requests can be decided — an already-decided one returns a 409 conflict.",
      "Expiry is not enforced here: a request past its expires_at still reads pending and can still be decided.",
      "A decision is final: there is no un-approve or un-reject; the requester must file a new request.",
    ],
    examplePrompt:
      "Approve approval <approval id> in <workspace> with the reason '<reviewed the payload, safe to run>'.",
    related: ["list_approvals", "get_approval_status", "request_approval"],
  },

  // ── Merge Queue ────────────────────────────────────────────────────
  {
    name: "list_merge_queue",
    category: "merge-queue",
    kind: "read",
    description:
      "List a workspace's in-flight merge queue entries — queued, merging, conflict, failed, or blocked. Use to see what is waiting to land or wedged.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "merged_within_hours",
        required: false,
        description:
          "Also return entries merged within this many hours, 1..720. Omitted, merged entries are excluded.",
      },
    ],
    gotchas: [
      "Only merged is terminal and it is excluded by default — pass merged_within_hours to see recently landed work.",
      "blocked_pending_consolidation entries DO show up: they are still in flight, parked until their consolidator card lands.",
      "Entry state is a closed enum: queued, merging, merged, conflict, failed, blocked_pending_consolidation (conflict with a consolidator card on the board).",
    ],
    examplePrompt:
      "List the merge queue for <workspace> and tell me which entries are in conflict or failed and which cards they belong to.",
    related: [
      "get_merge_queue_entry",
      "enqueue_for_merge",
      "cancel_merge_queue_entry",
    ],
  },
  {
    name: "get_merge_queue_entry",
    category: "merge-queue",
    kind: "read",
    description:
      "Fetch one merge queue entry by id to inspect its state, branch, and attempt history. Use when triaging a specific stuck or failed merge.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "entry_id",
        required: true,
        description: "UUID of the merge queue entry.",
      },
    ],
    gotchas: [
      "Entry state is a closed enum: queued, merging, merged, conflict, failed, blocked_pending_consolidation (conflict with a consolidator card on the board).",
    ],
    examplePrompt:
      "Fetch merge queue entry <entry id> in <workspace> and explain what state it's in and how many merge attempts it has made.",
    related: [
      "list_merge_queue",
      "enqueue_for_merge",
      "cancel_merge_queue_entry",
    ],
  },
  {
    name: "enqueue_for_merge",
    category: "merge-queue",
    kind: "write",
    description:
      "Re-queue a card's existing merge-queue entry so the merge is retried, typically after a conflict was resolved. Use when a failed or conflicted merge is now fixable.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "card_id",
        required: true,
        description:
          "UUID of the original (parent) card whose merge entry should be retried.",
      },
    ],
    gotchas: [
      "Despite the name, this calls the RE-enqueue endpoint: it 404s unless a merge-queue entry already exists for the card — initial enqueueing happens inside the merge worker.",
      "Idempotent: if the entry is already queued, the existing row is returned with no side effects.",
      "The retry happens on the merge worker's next tick, not immediately; each retry increments the entry's attempt count.",
      "No state guard: an entry in ANY non-queued state — including one already merged — is reset to queued, and the worker will attempt the merge again.",
    ],
    examplePrompt:
      "I resolved the merge conflict for card <card id> in <workspace> — re-queue its merge entry with enqueue_for_merge so the worker retries.",
    related: [
      "list_merge_queue",
      "get_merge_queue_entry",
      "cancel_merge_queue_entry",
    ],
  },
  {
    name: "enqueue_pr_for_merge",
    category: "merge-queue",
    kind: "write",
    description:
      "Enqueue a card's pull request for the platform merge queue: the executor rebases and lands it once CI is green, and the reconciler moves the card to Done.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "card_id",
        required: true,
        description: "UUID of the card the pull request belongs to.",
      },
      {
        name: "git_repo_id",
        required: true,
        description: "UUID of the board's git repo (see list_git_repos).",
      },
      {
        name: "pr_url",
        required: true,
        description: "The pull request's URL.",
      },
      {
        name: "pr_branch",
        required: true,
        description: "The pull request's head branch name.",
      },
      {
        name: "integration_branch",
        required: false,
        description:
          "Target branch; defaults to the repo's integration branch, then its default branch.",
      },
    ],
    gotchas: [
      "This is the INITIAL enqueue — distinct from enqueue_for_merge, which only RE-queues an existing entry after conflict consolidation.",
      "Runner callers on a loop-configured board need the board's loop config to opt in with loop_landing=\"merge_queue\" — otherwise the backend rejects with loop_landing_not_enabled (per-board owner decision; humans are never gated).",
      "A red or pending CI blocks the merge (retryable ci_not_green state) until checks go green; repos with no CI at all merge as before.",
      "Idempotent: an already-queued card returns its existing entry.",
    ],
    examplePrompt:
      "Card <card id>'s PR <pr url> is green and self-review passed — enqueue it for merge in <workspace> so the platform lands it.",
    related: [
      "list_merge_queue",
      "get_merge_queue_entry",
      "enqueue_for_merge",
      "cancel_merge_queue_entry",
    ],
  },
  {
    name: "cancel_merge_queue_entry",
    category: "merge-queue",
    kind: "write",
    description:
      "Remove a merge queue entry so a wedged conflict or failure stops holding the card. Use when human triage needs to take a merge out of the automated path.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "entry_id",
        required: true,
        description: "UUID of the merge queue entry to cancel.",
      },
    ],
    gotchas: [
      "Admin/owner only — regular workspace members get a 403.",
      "Deletes the entry row permanently — there is no undo; re-queueing later requires the worker to create a fresh entry.",
      "Only queued/merging entries hide a card from next_assignment — cancelling one of those un-hides it (other eligibility gates still apply); a conflict or failed entry was not hiding the card in the first place.",
    ],
    examplePrompt:
      "Merge entry <entry id> in <workspace> is wedged in conflict — cancel it with cancel_merge_queue_entry so I can handle the card manually.",
    related: [
      "list_merge_queue",
      "get_merge_queue_entry",
      "enqueue_for_merge",
      "next_assignment",
    ],
  },
];
