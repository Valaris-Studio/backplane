// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/research/runner-pipeline-internals.md §3 + §10
// and the 2026-04-18 runner-launch walkthrough.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  FutureState,
  HonestRemark,
  ImportantNote,
} from "../callouts";

export function ConfigurationCustomRoles() {
  return (
    <SectionPage
      title="Custom Roles — the real payoff"
      eyebrow="Configuration"
    >
      <p>
        The design principle is blunt: any role with any rules and any
        prompts must be user-expressible end-to-end. If the platform only
        supports a closed set of roles, it's a software-delivery tool pretending
        to be extensible. The pipeline builder, the prompt registry, and the
        engine's post-process dispatch were built so that adding a{" "}
        <code>security-auditor</code>, a <code>designer</code>, or a Spanish
        <code>secretario</code> is a config change, not a code change.
      </p>
      <p>
        This page describes the three things that make that true: free-form
        role strings on stages, per-stage uniqueness flags, and automatic
        prompt synthesis for any role the registry hasn't heard of.
      </p>

      <h2 id="declare-a-custom-role">Declare a custom role</h2>
      <p>
        A stage's <code>role</code> field is a free-form string. There is no
        enum, no registration step, no "role catalog" to update. Paste the
        stage into your <code>pipeline_config</code>, wire the discover and
        LLM fields like any seeded role, and the next agent heartbeat starts
        ticking it.
      </p>

      <CodeExample
        language="json"
        title="A custom security-auditor stage"
      >
        {`{
  "role": "security-auditor",
  "discover": {
    "strategy": "column_scan",
    "column_type": "review",
    "filters": {
      "require_pr_url": true,
      "skip_if_participant_role": "security-auditor"
    }
  },
  "claim": { "participant_role": "helper", "execution_action": "audit_pr" },
  "git":   { "action": "checkout_pr_branch" },
  "llm":   {
    "enabled": true,
    "stage": "audit",
    "post_process_kind": "produces_decision",
    "tools": ["mcp__valaris__get_card", "mcp__valaris__create_review_note"]
  },
  "on_success": {
    "conditional": true,
    "branches": {
      "pass":  { "wake_roles": ["reviewer"] },
      "block": {
        "move_to_column_type": "active",
        "create_review_note": true,
        "unassign_self": true
      }
    }
  },
  "on_failure": { "move_to_column_type": "backlog", "unassign": true }
}`}
      </CodeExample>

      <p>
        The role string flows everywhere: it's the scheduler priority entry,
        the participant role stamped on the card, the filter key for{" "}
        <code>skip_if_participant_role</code>, and the partition key the
        prompt registry looks up.
      </p>

      <h2 id="uniqueness-flag">Uniqueness flag</h2>
      <p>
        Every stage carries an implicit uniqueness contract — one
        {" "}<code>hero</code> per card — and an optional per-stage{" "}
        <code>unique: bool</code>. When <code>unique</code> is true, a single
        agent at a time can hold the participant slot for that role on a
        given card; other agents skip the card until the holder releases or
        completes. When false (the default for custom roles), multiple agents
        can claim the same card in that role concurrently — useful for
        helper-style roles where parallelism helps and conflict is
        unlikely.
      </p>
      <p>
        The seeded personas set uniqueness conservatively: orchestrator is{" "}
        <code>hero</code> and therefore unique by construction; reviewer is
        {" "}<code>unique: true</code> so two reviewers don't race on the
        same PR; documentator is not unique. For a custom role, start with
        the default and turn uniqueness on if you observe races.
      </p>

      <ImportantNote title="priority_order must list every role you declare">
        Scheduling reads the full set of role strings from{" "}
        <code>stages[*].role</code> and compares them against{" "}
        <code>scheduling.priority_order</code>. A role that isn't in
        {" "}<code>priority_order</code> never gets offered a tick — the
        validator emits <code>priority_order_unknown_role</code> only for the
        inverse case (an entry with no matching stage). Adding a stage
        without also adding its role to the order list is silent starvation.
      </ImportantNote>

      <h2 id="synthesis-never-second-class">
        Synthesis — custom roles are never second-class
      </h2>
      <p>
        When a stage's <code>(role, stage)</code> pair isn't in the prompt
        registry, the platform doesn't fail — it synthesizes a minimal
        placeholder template. The placeholder contains the canonical template
        variables (<code>{`{{.CardID}}`}</code>, <code>{`{{.Title}}`}</code>,
        {" "}<code>{`{{.Description}}`}</code>,{" "}
        <code>{`{{.ProjectDirectives}}`}</code>,{" "}
        <code>{`{{.ReviewHistory}}`}</code>) and the post-process imperative
        inferred from <code>llm.post_process_kind</code>. The custom role ticks
        immediately with sensible defaults, and you edit the prompt through
        the normal authoring flow when you want to refine behavior.
      </p>
      <p>
        The "Prompts" page in the workspace config surface lists every{" "}
        <code>(role, stage)</code> pair the platform has seen — seeded,
        synthesized, or overridden — with a status badge so you can tell at
        a glance which are running against scaffolding and which have been
        shaped by an operator. Synthesis is a starting line, not a ceiling.
      </p>

      <HonestRemark title="The 2026-04-18 walkthrough defined 'Secretario' and it ran">
        Part of the end-to-end runner-launch walkthrough added a{" "}
        <code>secretario</code> role (a Spanish-named note-taking persona)
        with <code>post_process_kind: produces_note</code>, no git, and a
        minimal prompt. It ticked successfully on the second heartbeat after
        the pipeline save, produced a review note, and moved the card to Done
        without a code change anywhere in the stack. Eleven other bugs
        surfaced that day — but the extensibility contract held.
      </HonestRemark>

      <h2 id="what-still-gates-you">What still gates you</h2>
      <p>
        Custom roles are first-class on the pipeline side. A few things on
        the runtime side are not yet:
      </p>
      <ul>
        <li>
          <strong>Per-role LLM provider/model.</strong> Every role runs
          against whatever model the agent binary was compiled against —
          today, Claude via the <code>claude</code> CLI. A pipeline that
          wants a cheap role for triage and an expensive role for review
          can't express that yet. See{" "}
          <em>Under the Hood — Model-Agnostic Roles</em>.
        </li>
        <li>
          <strong>Skills as bundles.</strong> Procedural knowledge now ships
          as versioned <a href="../documentation/skills">skill bundles</a>{" "}
          a board binds and the runner materializes into the working tree.
          What still doesn't exist is the role-level bundle — tools plus
          prompt partials plus rules as a named unit a new role can inherit
          from an existing one. Every stage declares its tool list inline.
        </li>
        <li>
          <strong>Cross-stage context.</strong> A stage can't read another
          stage's raw LLM output (beyond what was persisted as participant
          state or a review note). A blackboard-pattern primitive would
          unlock richer handoffs; not built.
        </li>
      </ul>

      <FutureState title="Model-per-role independence is the declared next milestone">
        Decoupling the role from the runner binary's model identity is an
        explicit north-star item. The plumbing is partial today: prompt
        configs can carry a <code>model</code> hint, but the Go agent ignores
        it. The milestone wires that hint end-to-end so a{" "}
        <code>research</code> stage can run against Claude Haiku while{" "}
        <code>review</code> runs against Opus, in the same pipeline, from the
        same runner. Tracking issue and design notes live in the feedback
        archive under <code>feedback_llm_abstraction_north_star.md</code>.
      </FutureState>
    </SectionPage>
  );
}
