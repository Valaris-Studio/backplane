// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDoc } from "./types";

// Author slice — categories: teams, channels, git-repos, webhooks.
export const COLLABORATION_TOOL_DOCS: ToolDoc[] = [
  // ── Teams ──────────────────────────────────────────────────────────────
  {
    name: "list_teams",
    category: "teams",
    kind: "read",
    description:
      "List the teams in a workspace with their members and board assignments. Use to see which runner crews exist before staffing or binding one to a board.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug to list teams for.",
      },
      {
        name: "include_inactive",
        required: false,
        description: "Include deactivated teams (default false).",
      },
    ],
    gotchas: [
      "Deactivated teams are hidden unless include_inactive is true.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list the teams in the <workspace> workspace and tell me which runners are on each and which board every team is scoped to.",
    related: ["get_team", "create_team", "add_team_member"],
  },
  {
    name: "get_team",
    category: "teams",
    kind: "read",
    description:
      "Fetch one team's full profile: members, their roles, and board scope. Use before changing membership so you know each member's current roles.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug the team belongs to.",
      },
      {
        name: "team_id",
        required: true,
        description: "The UUID of the team to retrieve.",
      },
    ],
    gotchas: [
      "Read the current roles here before calling add_team_member — a re-add replaces a member's roles rather than appending.",
    ],
    examplePrompt:
      "Get the <team name> team in the <workspace> workspace with get_team and summarize who holds the planner and reviewer roles.",
    related: ["list_teams", "add_team_member", "update_team"],
  },
  {
    name: "create_team",
    category: "teams",
    kind: "write",
    description:
      "Create a team of runners in a workspace, optionally scoped to one board. Use when setting up a runner crew before assigning members and roles.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug.",
      },
      { name: "name", required: true, description: "Team name." },
      {
        name: "description",
        required: false,
        description: "What this team does (default empty).",
      },
      {
        name: "board_id",
        required: false,
        description:
          "Board UUID to scope the team to one board; omit for a workspace-wide team.",
      },
    ],
    gotchas: [
      "The team starts empty — follow up with add_team_member to give it runners and roles.",
    ],
    examplePrompt:
      "Create a team called <name> scoped to the <board> board in the <workspace> workspace, then add runner <agent> with the implementer role.",
    related: ["add_team_member", "list_teams", "update_team"],
  },
  {
    name: "update_team",
    category: "teams",
    kind: "write",
    description:
      "Rename a team, change its description, or re-scope it to a different board. Only the fields you pass are changed.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug.",
      },
      {
        name: "team_id",
        required: true,
        description: "The UUID of the team to update.",
      },
      { name: "name", required: false, description: "New team name." },
      {
        name: "description",
        required: false,
        description: "New description.",
      },
      {
        name: "board_id",
        required: false,
        description: "New board UUID to scope the team to.",
      },
    ],
    gotchas: [
      "You cannot un-scope a team back to workspace-wide here — a null board_id is dropped by the tool; use the UI/REST for that.",
      "Reactivating a deactivated team is also not exposed here (no is_active field) — use the UI/REST.",
    ],
    examplePrompt:
      "Rename the team <team id> in the <workspace> workspace to <new name> and point it at the <board> board instead.",
    related: ["get_team", "create_team", "deactivate_team"],
  },
  {
    name: "deactivate_team",
    category: "teams",
    kind: "write",
    description:
      "Soft-disable a team so it drops out of active listings. Use to retire a crew without losing its membership history — this is the off switch, not a delete.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug.",
      },
      {
        name: "team_id",
        required: true,
        description: "The UUID of the team to deactivate.",
      },
    ],
    gotchas: [
      "Not a delete: the team and its member records remain, hidden from list_teams unless include_inactive is true.",
      "No MCP reactivation path — update_team does not expose is_active, so re-enabling the team needs the UI/REST.",
    ],
    examplePrompt:
      "The <team name> crew is done for this quarter — deactivate that team in the <workspace> workspace, but confirm its members first so we can restore it later.",
    related: ["update_team", "list_teams", "remove_team_member"],
  },
  {
    name: "add_team_member",
    category: "teams",
    kind: "write",
    description:
      "Add a runner to a team with one or more roles, or change an existing member's roles. Use when staffing a team for pipeline work.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug.",
      },
      { name: "team_id", required: true, description: "The UUID of the team." },
      {
        name: "agent_id",
        required: true,
        description: "The UUID of the runner to add.",
      },
      {
        name: "roles",
        required: false,
        description:
          "Roles to grant, matched against the workspace's pipeline roles (default pipeline: planner, implementer, reviewer, rework_mediator, documentator, ui_validator, board_reconciler). Free-form strings are accepted; roles not in the pipeline are flagged not_in_pipeline in the response.",
      },
      {
        name: "role",
        required: false,
        description: "Single role (legacy backward-compat — prefer roles).",
      },
    ],
    gotchas: [
      "Re-adding an existing member REPLACES their roles — send the union of old and new roles, not just the addition.",
      "Role uniqueness is pipeline-config-driven: roles whose stage is marked unique (all seven default pipeline roles) allow one runner per team; roles not flagged unique allow several.",
      "Omitting both roles and role defaults the member to [\"custom\"] — that is NOT role-agnostic (custom is not a pipeline role). The backend treats an empty roles list as claim-every-pipeline-role, but this tool never sends one; pass explicit roles for pipeline members.",
    ],
    examplePrompt:
      "Add runner <agent> to the <team name> team in <workspace> as reviewer — but first fetch the team with get_team and keep any roles they already hold.",
    related: ["get_team", "remove_team_member", "create_team"],
  },
  {
    name: "remove_team_member",
    category: "teams",
    kind: "write",
    description:
      "Remove a runner from a team. Use when unstaffing a crew or freeing a unique pipeline role (planner, reviewer, ...) for another runner.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug.",
      },
      { name: "team_id", required: true, description: "The UUID of the team." },
      {
        name: "agent_id",
        required: true,
        description: "The UUID of the runner to remove.",
      },
    ],
    gotchas: [
      "Only the team membership is removed — the runner itself keeps existing and stays on its other teams.",
    ],
    examplePrompt:
      "Remove runner <agent> from the <team name> team in the <workspace> workspace so I can hand its planner role to <other agent>.",
    related: ["add_team_member", "get_team", "deactivate_team"],
  },

  // ── Channels ───────────────────────────────────────────────────────────
  {
    name: "list_channels",
    category: "channels",
    kind: "read",
    description:
      "List a workspace's contact channels (email, Slack, phone, and more). Use to find out how to reach the humans behind a project.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
    ],
    examplePrompt:
      "List the contact channels in the <workspace> workspace and tell me the best way to reach the project stakeholders.",
    related: ["create_channel", "update_channel", "get_workspace"],
  },
  {
    name: "create_channel",
    category: "channels",
    kind: "write",
    description:
      "Register a contact point (email, Slack, WhatsApp, phone, website, other) in a workspace. Use during project setup so agents know how to reach people.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "name",
        required: true,
        description: "Display name for the channel.",
      },
      {
        name: "channel_type",
        required: true,
        description:
          "One of: email, slack, whatsapp, phone, website, other.",
      },
      {
        name: "contact_value",
        required: true,
        description:
          "The contact address or identifier (e.g. email address, phone number).",
      },
      {
        name: "description",
        required: false,
        description: "What this channel is for (default empty).",
      },
      {
        name: "metadata_json",
        required: false,
        description: "Dict of extra metadata to attach to the channel.",
      },
    ],
    examplePrompt:
      "Create an email channel named <name> with address <email> in the <workspace> workspace, described as the client's main contact.",
    related: ["list_channels", "update_channel", "delete_channel"],
  },
  {
    name: "update_channel",
    category: "channels",
    kind: "write",
    description:
      "Change a channel's name, type, contact address, description, or metadata. Only the fields you pass are changed.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "channel_id",
        required: true,
        description: "The UUID of the channel to update.",
      },
      {
        name: "name",
        required: false,
        description: "New display name for the channel.",
      },
      {
        name: "channel_type",
        required: false,
        description:
          "New type (email, slack, whatsapp, phone, website, other).",
      },
      {
        name: "contact_value",
        required: false,
        description: "New contact address or identifier.",
      },
      { name: "description", required: false, description: "New description." },
      {
        name: "metadata_json",
        required: false,
        description:
          "Metadata dict, shallow-merged key by key with the existing metadata.",
      },
    ],
    gotchas: [
      "metadata_json is shallow-merged — only the keys you send are replaced; set a key to null to remove it.",
    ],
    examplePrompt:
      "The client changed their Slack — update channel <channel id> in the <workspace> workspace so its contact_value is <new handle>.",
    related: ["list_channels", "create_channel", "delete_channel"],
  },
  {
    name: "delete_channel",
    category: "channels",
    kind: "write",
    description:
      "Delete a contact channel from a workspace. Use when a contact point is obsolete or was created by mistake.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      {
        name: "channel_id",
        required: true,
        description: "The UUID of the channel to delete.",
      },
    ],
    gotchas: [
      "Permanent — there is no undo or soft-delete for channels.",
    ],
    examplePrompt:
      "List the channels in the <workspace> workspace, then delete the one named <name> — it points at a mailbox that no longer exists.",
    related: ["list_channels", "create_channel", "update_channel"],
  },

  // ── Git Repos ──────────────────────────────────────────────────────────
  {
    name: "list_git_repos",
    category: "git-repos",
    kind: "read",
    description:
      "List the git repositories linked to a board, with URLs, slugs, and branch settings. Use to see which repos cards can target before assigning work.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "The UUID of the board." },
    ],
    gotchas: [
      "On multi-repo boards, each repo's slug is what cards reference through their git_repo_slug field.",
    ],
    examplePrompt:
      "List the git repos linked to the <board> board in the <workspace> workspace and tell me each one's slug and default branch.",
    related: ["create_git_repo", "update_git_repo", "get_project_context"],
  },
  {
    name: "create_git_repo",
    category: "git-repos",
    kind: "write",
    description:
      "Link a git repository to a board so cards and runners can target real branches and PRs. Use during board setup, before launching autonomous work.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "The UUID of the board." },
      {
        name: "name",
        required: true,
        description: "Display name for the repository.",
      },
      {
        name: "url",
        required: true,
        description: "The repository URL (e.g. https://github.com/org/repo).",
      },
      {
        name: "provider",
        required: true,
        description:
          "Hosting provider: github, gitlab, bitbucket, gitea, or other.",
      },
      {
        name: "default_branch",
        required: false,
        description: "The default branch name (default \"main\").",
      },
      {
        name: "description",
        required: false,
        description: "What this repository holds (default empty).",
      },
      {
        name: "require_branch_protection",
        required: false,
        description:
          "When true (default), the runner ensures branch protection on default_branch at first clone.",
      },
      {
        name: "slug",
        required: false,
        description:
          "Explicit URL slug (lowercase alphanum + hyphens); derived from name when omitted.",
      },
    ],
    gotchas: [
      "require_branch_protection defaults to true so runner auto-merge has protection to arm against — set false for legacy or human-owned repos where flipping protection would disrupt workflows.",
      "On multi-repo boards, slug is the per-card selector (card.git_repo_slug); pick it deliberately.",
      "integration_branch cannot be set at creation — link the repo first, then set it with update_git_repo.",
    ],
    examplePrompt:
      "Link the GitHub repo <url> to the <board> board in the <workspace> workspace, default branch main, and name it <name>.",
    related: ["list_git_repos", "update_git_repo", "delete_git_repo"],
  },
  {
    name: "update_git_repo",
    category: "git-repos",
    kind: "write",
    description:
      "Change a linked repo's URL, branches, protection policy, or slug. Only the fields you pass are changed — and this is where integration_branch is set.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "The UUID of the board." },
      {
        name: "repo_id",
        required: true,
        description: "The UUID of the git repo to update.",
      },
      {
        name: "name",
        required: false,
        description: "New display name for the repository.",
      },
      { name: "url", required: false, description: "New repository URL." },
      {
        name: "provider",
        required: false,
        description: "New provider (github, gitlab, bitbucket, gitea, other).",
      },
      {
        name: "default_branch",
        required: false,
        description: "New default branch name.",
      },
      {
        name: "integration_branch",
        required: false,
        description:
          "Staging branch parallel runners base new work on instead of default_branch.",
      },
      { name: "description", required: false, description: "New description." },
      {
        name: "require_branch_protection",
        required: false,
        description: "Toggle the branch-protection policy.",
      },
      {
        name: "slug",
        required: false,
        description:
          "New URL slug (lowercase alphanum + hyphens, unique within the board).",
      },
    ],
    gotchas: [
      "integration_branch only takes effect for pipeline stages configured with git.base_ref=\"integration_branch\"; leave it unset to keep forking from default_branch.",
      "Re-slugging a repo on a multi-repo board changes which cards' git_repo_slug resolve to it — update affected cards too.",
    ],
    examplePrompt:
      "On the <board> board in <workspace>, set the <repo> repo's integration_branch to <branch> so parallel runners base their work there.",
    related: ["create_git_repo", "list_git_repos", "delete_git_repo"],
  },
  {
    name: "delete_git_repo",
    category: "git-repos",
    kind: "write",
    description:
      "Unlink a git repository from a board. Use when the board should stop targeting a repo — the repository itself is never touched.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The URL slug identifying the workspace.",
      },
      { name: "board_id", required: true, description: "The UUID of the board." },
      {
        name: "repo_id",
        required: true,
        description: "The UUID of the git repo to unlink.",
      },
    ],
    gotchas: [
      "Removes only the board binding — the remote repository, its branches, and PRs are untouched.",
      "Cards whose git_repo_slug pointed at this repo stop being schedulable: on next pickup the scheduler parks them with the repo-slug-unresolved label. Re-link a repo with the same slug (or fix the cards) and remove the label to recover.",
    ],
    examplePrompt:
      "Unlink the <repo name> repo from the <board> board in the <workspace> workspace — we migrated that code elsewhere.",
    related: ["list_git_repos", "create_git_repo", "update_git_repo"],
  },

  // ── Webhooks ───────────────────────────────────────────────────────────
  {
    name: "create_webhook",
    category: "webhooks",
    kind: "write",
    description:
      "Subscribe an external URL to workspace events (card moves, executions, approvals, cost alerts). Use to wire Backplane into CI, chat, or monitoring systems.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug.",
      },
      {
        name: "url",
        required: true,
        description: "Delivery URL for webhook payloads (https in production).",
      },
      {
        name: "events",
        required: true,
        description:
          "Events to subscribe to: approval.created, approval.updated, execution.started, execution.completed, agent.status_changed, config.changed, cost.threshold_crossed, plus the activity.* namespace (activity.card.moved, activity.note.updated, ...). Bare card.*/column.* names still work but are deprecated aliases of activity.card.*/activity.column.*.",
      },
      {
        name: "secret",
        required: true,
        description: "HMAC signing secret used to sign every delivery.",
      },
    ],
    gotchas: [
      "Payloads are signed HMAC-SHA256 with your secret: the X-Webhook-Signature-256 header carries sha256=<hex> and X-Webhook-Event names the event — verify on the receiver.",
      "The URL is SSRF-guarded at registration: https-only outside development, and hosts resolving to private/internal addresses are rejected.",
    ],
    examplePrompt:
      "Create a webhook in the <workspace> workspace that posts activity.card.moved and execution.completed events to <url>, signed with the secret <secret>.",
    related: ["list_webhooks", "update_webhook", "get_webhook", "list_activity"],
  },
  {
    name: "list_webhooks",
    category: "webhooks",
    kind: "read",
    description:
      "List the webhooks registered in a workspace with their URLs, subscribed events, and active state. Use to audit existing subscriptions before adding one.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug.",
      },
      {
        name: "is_active",
        required: false,
        description:
          "Filter by state: true for active only, false for inactive only; omit for all.",
      },
    ],
    gotchas: [
      "Secrets are never returned — read a webhook's id here, then use update_webhook to rotate the secret if you need to.",
    ],
    examplePrompt:
      "List the active webhooks in the <workspace> workspace and summarize which events each one subscribes to.",
    related: ["create_webhook", "get_webhook", "update_webhook", "list_activity"],
  },
  {
    name: "get_webhook",
    category: "webhooks",
    kind: "read",
    description:
      "Read one webhook's URL, subscribed events, active state, and delivery health (last delivery, failure count) by id.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug that owns the webhook.",
      },
      {
        name: "webhook_id",
        required: true,
        description: "The UUID of the webhook to read.",
      },
    ],
    gotchas: [
      "Workspace-scoped: a webhook belonging to another workspace reads as not-found, so the slug must be the one it was created under.",
      "A climbing failure_count means the receiver is rejecting deliveries — check the URL and the signature verification on their side.",
    ],
    examplePrompt:
      "Show me the details and delivery health of webhook <id> in the <workspace> workspace.",
    related: ["list_webhooks", "update_webhook", "create_webhook"],
  },
  {
    name: "update_webhook",
    category: "webhooks",
    kind: "write",
    description:
      "Change a webhook's URL, events, signing secret, or active state; only passed fields change. delete=true removes the registration for good instead.",
    danger:
      "delete=true is permanent. Deliveries stop at once and the registration cannot be restored — pause with is_active=false when you may want it back.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "The workspace slug that owns the webhook.",
      },
      {
        name: "webhook_id",
        required: true,
        description: "The UUID of the webhook to update.",
      },
      {
        name: "url",
        required: false,
        description:
          "New delivery URL, re-validated against the same SSRF guard as create_webhook.",
      },
      {
        name: "events",
        required: false,
        description:
          "Replacement event list — see create_webhook for the vocabulary. This replaces the subscription wholesale.",
      },
      {
        name: "secret",
        required: false,
        description: "New HMAC signing secret.",
      },
      {
        name: "is_active",
        required: false,
        description: "False pauses deliveries without deleting the registration; true resumes.",
      },
      {
        name: "delete",
        required: false,
        description:
          "True permanently removes the webhook (no undo); must be the only field besides the ids. Prefer is_active=false to pause.",
      },
    ],
    gotchas: [
      "events REPLACES the current list, it does not merge — read the webhook first and pass the full set you want.",
      "Rotating the secret invalidates signatures the receiver was verifying with the old one; update both sides together.",
      "Workspace-scoped: a webhook belonging to another workspace reads as not-found.",
      "delete=true accepts no other field — a call mixing edits with the delete is rejected before any request is sent.",
      "Idempotent: deleting an already-gone webhook reports so calmly instead of erroring, so a retried call converges.",
    ],
    examplePrompt:
      "Pause webhook <id> in the <workspace> workspace — the receiver is down for maintenance.",
    related: ["get_webhook", "list_webhooks", "create_webhook"],
  },
];
