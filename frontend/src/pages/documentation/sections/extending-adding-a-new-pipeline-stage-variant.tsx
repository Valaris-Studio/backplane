// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/research/runner-pipeline-internals.md §10 and
// docs/platform-source-of-truth.md §5-6.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  ImportantNote,
  ProTip,
} from "../callouts";

export function ExtendingAddingANewPipelineStageVariant() {
  return (
    <SectionPage
      title="Adding a New Pipeline Stage Variant"
      eyebrow="Extending Backplane"
    >
      <p>
        A pipeline stage is a ticking function the runner invokes once per
        heartbeat against a discovered card. Adding a new stage variant —
        whether a genuinely new role like <code>linter</code> or a
        differently-configured copy of an existing one — is a pure
        configuration change. No backend code, no Go code, no redeploy. You
        patch <code>pipeline_config.stages[]</code>, optionally author a
        prompt, and the next runner tick picks it up.
      </p>

      <h2 id="when-to-add-a-stage">When to add a stage</h2>
      <p>
        Reach for a new stage when a role's discover filter, claim shape, git
        action, or output post-processing differs from every existing stage.
        If the only change is the prompt text, you don't need a new stage —
        override the prompt at the workspace level instead. If the only change
        is which column a stage moves cards to on success, edit the existing
        stage's <code>on_success</code> block. A new stage earns its keep when
        the pipeline needs a genuinely new step.
      </p>

      <h2 id="a-worked-example">A worked example: a linter role</h2>
      <p>
        Suppose the pipeline has a backlog column, and you want a lightweight
        role that picks up every new card, runs a linter prompt against its
        description, attaches a <code>linted</code> label, and moves on. The
        linter runs before the implementer so the human operator sees a clean
        description by the time they triage. No git action, no branch, just a
        prompt and a label.
      </p>

      <CodeExample
        language="json"
        title="New stage appended to pipeline_config.stages[]"
      >
        {`{
  "role": "linter",
  "discover": {
    "strategy": "column_scan",
    "column_type": "backlog",
    "filters": {
      "require_git_repo": false,
      "exclude_label": "linted",
      "skip_if_participant_role": "linter"
    }
  },
  "claim": { "participant_role": "helper", "execution_action": "lint_card" },
  "git":   { "action": "none" },
  "llm":   {
    "enabled": true,
    "stage": "lint",
    "post_process_kind": "produces_note",
    "tools": [
      "mcp__valaris__get_card",
      "mcp__valaris__update_card",
      "mcp__valaris__add_card_label"
    ],
    "inject_directives": true,
    "approval_enabled": false
  },
  "sensors": [],
  "on_success": { "add_label": "linted" },
  "on_failure": { "add_label": "lint-failed" }
}`}
      </CodeExample>

      <p>
        Submit this via the pipeline builder (the UI saves an optimistic
        {" "}<code>PATCH</code> to <code>workspace_configs.pipeline_config</code>)
        or via the MCP <code>set_pipeline_config</code> tool. Append{" "}
        <code>&quot;linter&quot;</code> to <code>priority_order</code> so the
        scheduler considers it — the{" "}
        <code>appendMissingRoles</code> seatbelt in the Go runner will cover
        you if you forget, but explicit ordering is friendlier to the
        operator reading the config.
      </p>

      <h2 id="authoring-a-prompt">Authoring a prompt</h2>
      <p>
        For brand-new roles not in the platform registry, the backend
        synthesizes a minimal placeholder prompt so the stage runs without
        hand-authoring. The synthesis stitches together a role identity, the
        card context, and a post-process imperative matched to your{" "}
        <code>post_process_kind</code> — <code>produces_note</code>{" "}
        synthesizes "emit a review note via MCP," <code>writes_code</code>{" "}
        synthesizes "commit and push your changes."
      </p>

      <p>
        A synthesized prompt is a starting point, not a destination. Open
        Runner → Prompts → your custom role, and override the
        synthesized prompt with one that actually specifies what "lint" means
        for your project: what fields to check, what severity to flag, what
        label-color scheme to follow. The override saves as a prompt_config
        row scoped to the workspace; the synthesis machinery only fires when
        no override exists.
      </p>

      <HonestRemark title="The prompt editor is a plain textarea">
        <p>
          Custom-role prompts render in a plain monospace <code>textarea</code>.
          No markdown preview, no variable autocomplete, no diff against the
          synthesized default. The engine treats prompts as opaque strings with
          a handful of <code>{"{{"}template{"}}"}</code> placeholders the
          runner substitutes before sending to the LLM. A richer editor with
          variable lookup and a live preview is on the backlog. For now: draft
          in your editor of choice, paste in, save. If you break it, the
          runner returns <code>status: skipped</code> rather than executing a
          malformed prompt.
        </p>
      </HonestRemark>

      <h2 id="testing-the-stage">Testing the stage</h2>
      <p>
        Register a runner with the workspace (see Getting Started → Registering
        a runner) and drop a card in the backlog column. Within one tick of
        the runner's heartbeat, the card should gain the <code>linted</code>{" "}
        label. Watch the activity feed — every stage invocation emits{" "}
        <code>agent.execution.completed</code> with the role and{" "}
        <code>execution_action</code> you set, so you can confirm the linter
        fired without reaching for logs.
      </p>

      <ImportantNote title="Exclude yourself from rediscovery">
        <p>
          A stage that adds a label on success must also exclude cards with
          that label in its discover filter, or it claims the same card every
          tick forever. The example above does both — <code>add_label: &quot;linted&quot;</code>{" "}
          on success and <code>exclude_label: &quot;linted&quot;</code> in
          discover. A second guard is{" "}
          <code>skip_if_participant_role: &quot;linter&quot;</code>, which
          uses the participant record as a second idempotency key. Use both;
          they cover different failure modes.
        </p>
      </ImportantNote>

      <ProTip title="Scope new stages to a test board first">
        <p>
          The pipeline config is workspace-scoped, but discover filters can
          reference labels. A pragmatic rollout: require a{" "}
          <code>lint-enabled</code> label, apply it only to cards on your
          test board, and watch the new stage run against a curated set
          before flipping the filter off. It's slower than a global rollout
          and it catches more mistakes.
        </p>
      </ProTip>
    </SectionPage>
  );
}
