// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDoc } from "./types";

// Author slice — categories: workspace-config, prompt-configs.
export const PIPELINE_CONFIG_TOOL_DOCS: ToolDoc[] = [
  // ---------------------------------------------------------------- workspace-config
  {
    name: "get_workspace_config",
    category: "workspace-config",
    kind: "read",
    description:
      "Read the workspace's full config: pipeline stages, rework/cooldown knobs, templates, pricing, and cost circuit breaker. Start here before any config edit.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
    ],
    gotchas: [
      "The response includes a `version` field — pass it as `expected_version` on update_workspace_config for conflict-safe edits.",
      "`pipeline_config` is never null in the response: an unconfigured workspace gets the platform-default multi-role pipeline (the read even seeds it onto a stored record whose pipeline is null).",
    ],
    examplePrompt:
      "Using the Backplane MCP, fetch the workspace config for <workspace> with get_workspace_config and summarize the pipeline stages, their roles, and the cost circuit breaker settings.",
    related: [
      "update_workspace_config",
      "export_pipeline_bundle",
      "get_pipeline_sensors",
    ],
  },
  {
    name: "update_workspace_config",
    category: "workspace-config",
    kind: "write",
    description:
      "Patch workspace config fields: pipeline stages, rework caps, templates, pricing, circuit breaker, role labels. Use to tune how runners process work.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "max_rework_attempts",
        required: false,
        description:
          "Per-card rework cap before the scheduler stops re-issuing the card.",
      },
      {
        name: "card_cooldown_hours",
        required: false,
        description: "Hours to wait before re-offering a card after release.",
      },
      {
        name: "commit_message_template",
        required: false,
        description: "Template for runner-authored commit messages.",
      },
      {
        name: "pr_description_template",
        required: false,
        description: "Template for runner-authored PR descriptions.",
      },
      {
        name: "model_pricing",
        required: false,
        description:
          "Per-model $/token overrides; merges over platform defaults.",
      },
      {
        name: "pipeline_config",
        required: false,
        description:
          "The full pipeline doc — `stages` (role, discover, claim, git, llm, on_success) plus scheduling. Replaces the stored doc wholesale.",
      },
      {
        name: "cost_circuit_breaker",
        required: false,
        description:
          "{enabled, threshold_usd_per_15min, action} with action one of alert, pause, kill_runner.",
      },
      {
        name: "role_labels",
        required: false,
        description:
          'Per-role display label overrides, e.g. {"implementer": "Coder"}.',
      },
      {
        name: "expected_version",
        required: false,
        description:
          "Optimistic concurrency: if set, the update is rejected with 409 when the stored config version differs.",
      },
    ],
    gotchas: [
      "Partial PATCH: omitted fields stay unchanged — but `pipeline_config` is replaced wholesale, not deep-merged.",
      "Pass `expected_version` from the last read to get a 409 instead of silently clobbering a concurrent edit.",
      "The backend validates `pipeline_config` and returns its structured 422 error list on malformed stages; the call requires workspace admin/owner role.",
      "Pipeline stages drive the backend scheduler behind next_assignment — changing a role's discover/claim rules changes which cards runners are offered.",
    ],
    danger:
      "Passing pipeline_config overwrites the workspace's ENTIRE stored pipeline in place — no history is kept beyond a version counter, and every runner's discover/claim behavior changes on its next poll. Read-modify-write: fetch with get_workspace_config, mutate locally, send back with expected_version (or export_pipeline_bundle first as a backup).",
    examplePrompt:
      "In the <workspace> workspace, read the current config with get_workspace_config, then use update_workspace_config to set max_rework_attempts to 3 and enable the cost circuit breaker at $60 per 15 minutes with action pause. Pass the expected_version you just read.",
    related: [
      "get_workspace_config",
      "get_pipeline_sensors",
      "import_pipeline_bundle",
    ],
  },
  {
    name: "export_pipeline_bundle",
    category: "workspace-config",
    kind: "composite",
    description:
      "Export a portable bundle of the workspace's pipeline, derived setup contract, and workspace prompts. Use to back up or promote a proven pipeline elsewhere.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the source workspace.",
      },
    ],
    gotchas: [
      "Only WORKSPACE-scoped prompt configs are included; platform defaults re-seed on the target and are deliberately excluded.",
      "`data.expected_pipeline_version` exports as null — fill it in (from the target's current version) only when round-tripping back into the same workspace.",
      "Team-scoped prompts are exported by team slug; the import fails with 422 if the target workspace lacks a team with that slug.",
      "Exports the STORED pipeline, not the effective default get_workspace_config shows — a workspace that never saved its config exports an empty pipeline_config, which import rejects with 400. Save the config once first.",
    ],
    examplePrompt:
      "Export the pipeline bundle from the <source> workspace with export_pipeline_bundle and show me what it contains — stages, setup contract, and which prompt configs are included — before we import it anywhere.",
    related: [
      "import_pipeline_bundle",
      "get_workspace_config",
      "list_prompt_configs",
    ],
  },
  {
    name: "import_pipeline_bundle",
    category: "workspace-config",
    kind: "composite",
    description:
      "Import an exported pipeline bundle into a workspace. Previews by default; applies pipeline + prompts atomically with dry_run=false. Use to clone a proven setup.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the TARGET workspace.",
      },
      {
        name: "bundle",
        required: true,
        description:
          "The full bundle envelope exactly as returned by export_pipeline_bundle.",
      },
      {
        name: "dry_run",
        required: false,
        description:
          "Defaults to true: return a validation + preview report and write nothing. Set false to apply.",
      },
    ],
    gotchas: [
      "`dry_run` defaults to TRUE — nothing is written until you re-call with dry_run=false. Always inspect the preview first.",
      "The version guard lives INSIDE the envelope (`bundle.data.expected_pipeline_version`); there is no top-level expected_version parameter on import. Stale version → 409, only relevant when re-importing into the source workspace.",
      "Envelope schema_version/entity_type mismatch → 400; invalid pipeline → 422. The commit is atomic — a validation failure leaves no partial state.",
      "Re-importing is idempotent: prompts with identical content are skipped, differing content updates in place. Requires workspace admin/owner role.",
    ],
    danger:
      "Applying with dry_run=false overwrites the target workspace's ENTIRE pipeline_config and creates/updates its prompt configs in one transaction. Export a backup bundle from the target first.",
    examplePrompt:
      "Import this pipeline bundle into the <target> workspace with import_pipeline_bundle. Do a dry run first, walk me through the validation results and prompt preview, and only apply with dry_run=false after I confirm.",
    related: [
      "export_pipeline_bundle",
      "get_workspace_config",
      "update_workspace_config",
    ],
  },
  {
    name: "get_pipeline_sensors",
    category: "workspace-config",
    kind: "read",
    description:
      "List the sensors runners have registered in a workspace. Use before wiring sensors into pipeline stages to see which sensor names are valid.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
    ],
    gotchas: [
      "The catalog is runner-reported: it stays empty until at least one runner in the workspace has reported a sensor manifest.",
      "On a name conflict across runners, the first reporter wins.",
      "This is the catalog `pipeline_config.stages[*].sensors[*].name` is validated against — but only once at least one runner has reported; with an empty catalog, sensor-name validation is skipped and unknown names pass.",
    ],
    examplePrompt:
      "List the pipeline sensors available in the <workspace> workspace with get_pipeline_sensors and tell me which ones are not yet referenced by any stage in the pipeline config.",
    related: [
      "get_workspace_config",
      "update_workspace_config",
      "get_agent_config",
    ],
  },
  {
    name: "resume_cost_breaker",
    category: "workspace-config",
    kind: "write",
    description:
      "Clear a tripped cost circuit breaker so runners can pick up work again. Use when next_assignment returns 423 for every runner because spend crossed the threshold.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
    ],
    gotchas: [
      "Acknowledgement, not a mute: it clears the dedupe state, so the next cost signal over the threshold trips the breaker again.",
      "Thresholds and the breaker action are untouched — change those with update_workspace_config's cost_circuit_breaker field.",
      "Admin-gated: a non-admin member gets a 403 straight from the backend.",
      "Runners resume on their next next_assignment poll, not instantly.",
    ],
    examplePrompt:
      "next_assignment keeps returning 423 in the <workspace> workspace — clear the cost breaker with resume_cost_breaker, then show me the current cost_circuit_breaker settings.",
    related: [
      "get_workspace_config",
      "update_workspace_config",
      "get_workspace_metrics",
    ],
  },
  // ---------------------------------------------------------------- prompt-configs
  {
    name: "list_prompt_configs",
    category: "prompt-configs",
    kind: "read",
    description:
      "List prompt configs visible to a workspace — its own plus platform defaults — optionally filtered by team role. Use to see which prompt overrides are in play.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "team_role",
        required: false,
        description:
          "Filter to configs for one team role, e.g. 'orchestrator' or 'reviewer'.",
      },
    ],
    gotchas: [
      "Returns workspace-scoped rows PLUS platform-level defaults (no workspace) in one list — check each row's workspace scope before editing.",
      "Each item carries `resolved_content` and wiring warnings computed against the live pipeline config, so you see what agents will actually receive.",
    ],
    examplePrompt:
      "Using the Backplane MCP, list the prompt configs in the <workspace> workspace with list_prompt_configs and flag any with wiring warnings or roles that no pipeline stage references.",
    related: [
      "get_prompt_config",
      "create_prompt_config",
      "get_workspace_config",
    ],
  },
  {
    name: "get_prompt_config",
    category: "prompt-configs",
    kind: "read",
    description:
      "Fetch one prompt config with its resolved content and pipeline wiring warnings. Use to inspect exactly what an agent role will receive at a stage.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "config_id",
        required: true,
        description:
          "Prompt config UUID; a slug also resolves (workspace-scoped).",
      },
    ],
    gotchas: [
      "`config_id` accepts a UUID or a slug — slug lookup is workspace-scoped and prefers workspace-owned rows over platform defaults.",
    ],
    examplePrompt:
      "Get the prompt config <config-id-or-slug> in the <workspace> workspace with get_prompt_config and show me its resolved content next to the raw template so I can see what the pipeline adds.",
    related: [
      "list_prompt_configs",
      "update_prompt_config",
      "delete_prompt_config",
    ],
  },
  {
    name: "create_prompt_config",
    category: "prompt-configs",
    kind: "write",
    description:
      "Create a per-role prompt override for a pipeline stage. Use to customize what an agent role is told at a stage without touching the pipeline config itself.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "name",
        required: true,
        description: "Display name for the prompt config.",
      },
      {
        name: "slug",
        required: true,
        description: "Slug identifier, unique within its (team, role, stage) scope.",
      },
      {
        name: "stage",
        required: true,
        description: "Pipeline stage it applies to, e.g. 'implement', 'review', 'plan'.",
      },
      {
        name: "content",
        required: true,
        description: "The prompt template content.",
      },
      {
        name: "agent_type",
        required: false,
        description:
          "Restrict to one agent type: 'coding', 'manager', 'reviewer', 'secretary', or 'improver'.",
      },
      {
        name: "team_role",
        required: false,
        description:
          "Restrict to one team role, e.g. 'orchestrator' or 'reviewer'.",
      },
      {
        name: "team_id",
        required: false,
        description: "Scope the config to a single team by UUID.",
      },
    ],
    gotchas: [
      "Idempotent: if a config already exists with the same (team, team_role, stage, slug) scope, it is returned unchanged instead of erroring — safe to retry.",
      "Slugs are unique per scope, not globally — several configs can share a slug across different stages or roles.",
      "Changes reach runners on their next config refresh, not instantly mid-run.",
    ],
    examplePrompt:
      "In the <workspace> workspace, create a prompt config with create_prompt_config for the reviewer role at the review stage, slug <slug>, that tells the reviewer to always check migration safety before approving.",
    related: [
      "list_prompt_configs",
      "update_prompt_config",
      "get_workspace_config",
    ],
  },
  {
    name: "update_prompt_config",
    category: "prompt-configs",
    kind: "write",
    description:
      "Update fields of an existing prompt config; content changes auto-bump its version. Use to iterate on what a role is told at a pipeline stage.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "config_id",
        required: true,
        description:
          "Prompt config UUID; a slug also resolves (workspace-scoped).",
      },
      { name: "name", required: false, description: "New display name." },
      { name: "slug", required: false, description: "New slug identifier." },
      { name: "stage", required: false, description: "New pipeline stage." },
      {
        name: "content",
        required: false,
        description: "New prompt template content.",
      },
      {
        name: "agent_type",
        required: false,
        description: "New agent type filter.",
      },
      {
        name: "team_role",
        required: false,
        description: "New team role filter.",
      },
      { name: "team_id", required: false, description: "New team UUID scope." },
    ],
    gotchas: [
      "PATCH semantics: omitted fields stay unchanged.",
      "Updating `content` bumps the stored version automatically; other fields don't.",
      "Changes reach runners on their next config refresh, not instantly mid-run.",
    ],
    danger:
      "Platform-level (NULL-workspace) rows pass the workspace guard: resolving one by slug or UUID rewrites the shared default for EVERY workspace, and prior content is not retained (only the version counter bumps). Verify the row's workspace scope in list_prompt_configs before updating.",
    examplePrompt:
      "Update the prompt config <config-id-or-slug> in the <workspace> workspace with update_prompt_config: append a rule to its content that PR descriptions must link the originating card.",
    related: [
      "get_prompt_config",
      "list_prompt_configs",
      "delete_prompt_config",
    ],
  },
  {
    name: "delete_prompt_config",
    category: "prompt-configs",
    kind: "write",
    description:
      "Delete a prompt config so matching runners fall back to default prompts on their next refresh. Use to retire an override you no longer want.",
    params: [
      {
        name: "workspace_slug",
        required: true,
        description: "URL slug identifying the workspace.",
      },
      {
        name: "config_id",
        required: true,
        description:
          "Prompt config UUID; a slug also resolves (workspace-scoped).",
      },
    ],
    gotchas: [
      "Permanent — there is no undo; recreate with create_prompt_config if needed.",
      "Runners that matched this config fall back to platform/stage defaults on their next config refresh.",
    ],
    danger:
      "Platform-level (NULL-workspace) configs pass the workspace guard: resolving one by slug or UUID hard-deletes the shared default for EVERY workspace. Verify the row's workspace scope in list_prompt_configs before deleting.",
    examplePrompt:
      "Delete the prompt config <config-id-or-slug> in the <workspace> workspace with delete_prompt_config, but first show me its content so I can archive it in a note.",
    related: ["list_prompt_configs", "create_prompt_config", "get_prompt_config"],
  },
];
