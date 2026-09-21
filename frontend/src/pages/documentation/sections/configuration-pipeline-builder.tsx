// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Source: frontend/src/pages/runner/RunnerPipelineTab.tsx,
// frontend/src/features/agents/hooks/useLifecycleDraft.ts,
// runner/internal/valaris/types.go, and runner/internal/lifecycle.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  ImportantNote,
  WhatThisIsNot,
} from "../callouts";

export function ConfigurationPipelineBuilder() {
  return (
    <SectionPage
      title="Pipeline Builder — Every Field Explained"
      eyebrow="Configuration"
    >
      <p>
        A workspace&apos;s <code>pipeline_config</code> is the platform-owned
        contract that tells a Runner which roles exist, which ordered steps
        each role executes, and how work is scheduled. The current builder
        exposes one shared lifecycle draft through three views: Graph, Tree,
        and the legacy Form. Switching views does not create a second config
        or discard unsaved edits.
      </p>
      <p>
        Graph is the default operational view. Advanced opens Tree by default;
        the legacy Form remains available as an escape hatch while Tree earns
        trust. All three views read and save through{" "}
        <code>useLifecycleDraft</code>, so they serialize the same{" "}
        <code>stages[].lifecycle</code> arrays back to the backend.
      </p>

      <p>Graph, Tree, and the legacy Form are three editors over one lifecycle draft, not three pipeline formats.</p>

      <span id="stage-anatomy" />
      <h2 id="canonical-lifecycle">The lifecycle is the canonical path</h2>
      <p>
        Each stage has a free-form, pipeline-unique <code>role</code> and an
        ordered <code>lifecycle</code> list. Every step has a role-local,
        unique <code>name</code>, a closed-set <code>kind</code>, optional{" "}
        <code>params</code>, and routing through <code>next</code>,{" "}
        <code>branches</code>, or <code>on_failure</code>. Step names are the
        graph addresses: every routing target must name another step in the
        same role.
      </p>

      <CodeExample
        language="json"
        title="A lifecycle-backed reviewer stage"
      >
        {`{
  "role": "reviewer",
  "lifecycle": [
    {
      "name": "find_review",
      "kind": "discover",
      "params": {
        "strategy": "column_scan",
        "column_type": "review",
        "preconditions": ["pr_is_open"]
      },
      "next": "claim_for_review"
    },
    {
      "name": "claim_for_review",
      "kind": "claim",
      "params": {
        "participant_role": "helper",
        "execution_action": "review_card"
      },
      "next": "checkout_pr_branch"
    },
    {
      "name": "checkout_pr_branch",
      "kind": "git_setup",
      "params": { "action": "checkout_pr_branch" },
      "next": "review_diff"
    },
    {
      "name": "review_diff",
      "kind": "llm",
      "params": {
        "stage": "review",
        "post_process_kind": "produces_decision"
      },
      "branches": {
        "approve": "merge_the_pr",
        "request_changes": "return_for_rework"
      },
      "on_failure": "review_failed"
    },
    {
      "name": "merge_the_pr",
      "kind": "merge_pr",
      "params": { "strategy": "squash" },
      "next": "move_done"
    },
    {
      "name": "move_done",
      "kind": "move_card",
      "params": { "to_column_type": "done" }
    },
    {
      "name": "return_for_rework",
      "kind": "move_card",
      "params": { "to_column_type": "active" }
    },
    {
      "name": "review_failed",
      "kind": "move_card",
      "params": { "to_column_type": "blocked" }
    }
  ]
}`}
      </CodeExample>

      <ImportantNote title="Lifecycle and legacy fields are not two active paths">
        When lifecycle is non-empty, the Runner executes the lifecycle walker
        and ignores the legacy flat <code>discover</code>, <code>claim</code>,{" "}
        <code>git</code>, <code>llm</code>, <code>sensors</code>,{" "}
        <code>on_success</code>, and <code>on_failure</code> blocks at runtime.
        When lifecycle is empty, the Runner uses those flat blocks for backward
        compatibility with older persisted configs. New pipelines should
        express execution in <code>lifecycle</code>.
      </ImportantNote>

      <h2 id="views">What each view is for</h2>
      <ul>
        <li>
          <strong>Graph</strong> is the primary visual surface. It shows Runner
          lanes, roles, step routing, branch decisions, terminals, and health
          findings. It can edit the same draft in place.
        </li>
        <li>
          <strong>Tree</strong> is the default Advanced editor. It expands
          configuration, scheduling, roles, steps, and property groups while
          keeping the lifecycle hierarchy visible.
        </li>
        <li>
          <strong>legacy Form</strong> is the nested lifecycle form kept as a
          secondary fallback. It does not switch execution back to the flat
          legacy stage model.
        </li>
      </ul>

      <span id="discover-strategies" />
      <span id="claim-git-and-llm" />
      <span id="actions-and-branching" />
      <h2 id="routing-and-validation">Routing and validation</h2>
      <p>
        A step may use <code>next</code> for an unconditional edge or{" "}
        <code>branches</code> for decision-dependent edges, but not both.
        <code>on_failure</code> is a separate error edge. The client catches
        duplicate step names, dangling targets, and the{" "}
        <code>next</code>-plus-<code>branches</code> conflict before save; the
        backend validates the complete pipeline against the lifecycle-kind
        registry.
      </p>
      <p>
        The closed kind catalog includes discovery, claims, git setup, skills
        setup, LLM and sensor work, labels and notes, explicit branches, PR
        operations, MCP calls, role wake-ups, card movement, shipping, and
        terminal steps. The builder fetches that catalog from{" "}
        <code>GET /api/config/lifecycle-kinds</code>; adding a new runtime kind
        requires backend, frontend, and Runner parity.
      </p>
      <p>
        One of those kinds is easy to miss on older boards:{" "}
        <code>skills_setup</code> materializes the board&apos;s bound{" "}
        <a href="../documentation/skills">skills</a> into the working tree
        before the LLM launches. A stored pipeline saved before the skills
        registry existed does not gain the step retroactively — add it after{" "}
        <code>git_setup</code> in each role that should receive skills, or
        nothing materializes.
      </p>

      <h2 id="scheduling">Scheduling</h2>
      <p>
        <code>scheduling.priority_order</code> names every role the scheduler
        may select. <code>priority</code> chooses the first role with claimable
        work; <code>round_robin</code> advances across roles and skips those in
        idle cooldown. Scheduling chooses which role runs next. The role&apos;s
        lifecycle decides what that role does.
      </p>

      <h2 id="saving-and-conflicts">Saving and conflicts</h2>
      <p>
        Saves use optimistic concurrency through{" "}
        <code>workspace_configs.version</code>. A stale save returns 409 and
        leaves the local draft intact. The conflict banner can reload the
        server version or deliberately overwrite it with the current draft;
        there is no automatic three-way merge.
      </p>

      <WhatThisIsNot title="The builder is not a separate pipeline authority">
        <p>
          The UI does not keep a private pipeline copy and the Runner does not
          prefer local defaults. A successful save updates the platform&apos;s{" "}
          <code>workspace_configs.pipeline_config</code>; the Runner fetches
          that platform-owned value. The same config can also be read or
          updated through MCP.
        </p>
      </WhatThisIsNot>

      <HonestRemark title="The legacy Form is intentionally still reachable">
        Tree is the default Advanced editor, but the older nested form remains
        available and its selection persists locally. That is a migration aid,
        not a second schema. Both surfaces serialize through the same draft and
        save path.
      </HonestRemark>
    </SectionPage>
  );
}
