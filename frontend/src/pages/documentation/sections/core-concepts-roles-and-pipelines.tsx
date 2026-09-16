// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §2.5 and
// docs/research/runner-pipeline-internals.md §3, §4.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ProTip } from "../callouts";

export function CoreConceptsRolesAndPipelines() {
  return (
    <SectionPage title="Roles and Pipelines" eyebrow="Core Concepts">
      <p>
        A <strong>role</strong> is a pipeline persona — a free-form string
        like <code>orchestrator</code> or <code>reviewer</code> or{" "}
        <code>Secretario</code>. A <strong>pipeline</strong> is the ordered
        shape of work: which roles run, in what order, against what columns,
        under what conditions. Both live in <code>pipeline_config</code> on
        the workspace. This is where a platform stops being a kanban app and
        starts being an agentic system.
      </p>

      <h2 id="roles">Roles</h2>
      <p>
        Backplane ships with five default roles, each with hand-written prompt
        templates in the registry:
      </p>
      <ul>
        <li>
          <code>orchestrator</code> — claims unassigned or rework cards,
          implements code, requests approval for destructive operations.
        </li>
        <li>
          <code>reviewer</code> — checks out the PR branch, emits structured
          approve / request-changes decisions.
        </li>
        <li>
          <code>documentator</code> — updates docs after merge, adds the{" "}
          <code>documented</code> label.
        </li>
        <li>
          <code>researcher</code> — investigates a card topic and produces a
          board note.
        </li>
        <li>
          <code>planner</code> — writes a single plan note for the existing card;
          the lifecycle saves its findings.
        </li>
      </ul>
      <p>
        These are not an enum. <code>stages[].role</code> is a string —
        operators declare any role they want and the platform picks it up
        end-to-end. The 2026-04-18 walkthrough defined a custom{" "}
        <code>Secretario</code> role and ran it to completion without a
        single line of platform code changing. The scheduler, the prompt
        synthesis layer, and the runner's generic strategy all handle
        arbitrary role names natively.
      </p>

      <h2 id="pipeline-shape">Pipeline shape</h2>
      <p>
        A pipeline is a version number, an array of stages, and a scheduling
        block. Each stage declares who runs it, how it finds cards, how it
        claims, what git it sets up, what LLM config it uses, what sensors
        gate it, and what to do on success or failure.
      </p>

      <CodeExample language="json" title="pipeline_config shape — the full DSL">
        {`{
  "version": 3,
  "stages": [
    {
      "role": "orchestrator",
      "unique": true,
      "discover": {
        "strategy": "unassigned_or_rework",
        "filter": { "column_type": "backlog" }
      },
      "claim": { "participant_role": "hero", "execution_action": "implement_run" },
      "git":   { "action": "create_branch", "branch_prefix": "impl/", "create_pr": true },
      "llm":   {
        "enabled": true,
        "stage": "implement",
        "tools": ["mcp"],
        "post_process_kind": "writes_code",
        "directives": { "inject_directives": true }
      },
      "sensors": [{ "kind": "pr_overlap" }, { "kind": "go_test" }],
      "on_success": { "move_to_column_type": "review", "wake_roles": ["reviewer"] },
      "on_failure": { "add_label": "needs-help" }
    }
  ],
  "scheduling": {
    "mode": "priority",
    "priority_order": ["orchestrator", "reviewer", "documentator"],
    "min_failure_backoff_seconds": 5
  }
}`}
      </CodeExample>

      <h2 id="stages-per-role">Multiple stages per role</h2>
      <p>
        One role commonly owns several stages. The default orchestrator is
        wired across four: <code>implement</code> for fresh cards,{" "}
        <code>implement_after_approval</code> for cards that just cleared an
        approval gate, <code>mediate_rework</code> for turning reviewer
        feedback into an action plan, and <code>rework_implement</code> for
        applying that plan. The scheduler picks one stage per tick; which one
        depends on the discover strategy's filter matching an available card.
      </p>

      <ProTip title="Stages are cheap. Reach for a new stage before a new role.">
        If the same runner needs to behave differently in two situations —
        first pass versus rework, pre-approval versus post-approval — author a
        second stage under the same role rather than inventing a new role.
        The scheduler handles the fanout; prompts are keyed on{" "}
        <code>(role, stage)</code>; the runner's identity stays clean. Four
        stages under <code>orchestrator</code> is the shipped default, not an
        anti-pattern.
      </ProTip>

      <h2 id="scheduling">Scheduling</h2>
      <p>
        The <code>scheduling.mode</code> is either <code>priority</code> or{" "}
        <code>round_robin</code>. In <code>priority</code> mode the runner
        walks <code>priority_order</code> left-to-right and picks the first
        stage with work; idle stages go on a 4-minute cooldown so they don't
        get polled every tick. In <code>round_robin</code> mode it rotates
        through the list, skipping any stage currently cooling. Scheduling is
        re-evaluated every tick against live platform config — add a role via
        the UI and the runner picks it up on the next poll, no restart.
      </p>
    </SectionPage>
  );
}
