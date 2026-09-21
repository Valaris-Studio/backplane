// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §1.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  Screenshot,
  WhatThisIsNot,
} from "../callouts";

export function IntroductionWhatBackplaneIs() {
  return (
    <SectionPage title="What Backplane Is" eyebrow="Introduction">
      <p>
        Backplane is four things that turn out to be one thing: a
        context-management system for LLM agents, a project-management suite, a
        coordination platform for teams and agents working the same board, and
        a workflow automation engine built on pipelines and loops. Agents lose
        their memory between sessions; Backplane is where the memory lives —
        boards, cards, notes, definitions, and a full activity history that any
        agent can read back in a single call.
      </p>
      <p>
        Humans shape the system — they define pipelines, author prompts, set
        budgets, approve risky actions. Agents do the work, whether that is an
        autonomous runner claiming cards inside a separate Git branch or a coding
        session you are driving yourself. The platform arbitrates: it stores
        the canonical pipeline shape, moves cards through columns, records
        every execution and its cost, coordinates approvals, and broadcasts
        everything to observers in real time.
      </p>

      <h2 id="the-players">The players</h2>
      <p>
        Three kinds of actors share a workspace. <strong>Operators</strong> are
        humans with UI access; they configure pipelines, write prompts, and
        approve high-risk actions. <strong>Runners</strong> are credentialed Go
        processes that execute configured roles with Claude Code or Codex CLI.
        They use the platform API to coordinate work and provide MCP tools to
        the coding-agent session. <strong>Observers</strong> are anyone watching
        the activity stream: a teammate following a live run, a dashboard
        aggregating cost, a webhook forwarding events to Slack.
      </p>

      <Screenshot
        aspectRatio="16:9"
        alt="Kanban board with a live pipeline run in progress"
        caption="The board view is the operator's primary surface — every runner action lands here as a card movement or note."
        description={[
          "Kanban board titled 'Platform Polish' at the top.",
          "Five columns: Backlog (3 cards), Ready (2), In Progress (1), Review (1), Done (4).",
          "The In Progress card is titled 'Wire useDomainSync for activity fan-out' and shows a green runner avatar plus a 'claimed 2m ago' timestamp.",
          "A toast in the bottom-right reads 'claude-sonnet-4 opened PR #214'.",
          "Sidebar shows Documentation highlighted as the current page would appear for a first-time reader.",
        ]}
      />

      <h2 id="what-the-platform-coordinates">What the platform coordinates</h2>
      <p>
        A kanban app built for human users can assume the page occasionally
        refreshes. Backplane can't. The primary operators are LLMs that retry on
        every error, work concurrently across pipeline stages, read fields by
        name from tool responses, and pay for every token. Those four
        properties reshape every layer:
      </p>
      <ul>
        <li>
          <strong>Idempotent mutations.</strong> Every create/add endpoint
          returns the existing entity if it already exists, never a 409. This
          is why <code>add_card_participant</code> is safe to call from four
          pipeline stages in a row.
        </li>
        <li>
          <strong>WebSocket-first event bus.</strong> Any mutation fans out on
          the workspace bus so every observer — UI, dashboard, other runner —
          stays coherent without polling.
        </li>
        <li>
          <strong>Composite MCP tools.</strong>{" "}
          <code>get_project_context</code> collapses what would be five REST
          calls into one round-trip. The agent pays once.
        </li>
        <li>
          <strong>Schema as contract.</strong> Runners read tool responses by
          field name, so drift between the database, the API schema, and the
          MCP docstring is a real bug — not cosmetic.
        </li>
      </ul>

      <HonestRemark title="The agents table is still called 'agents'">
        We renamed the concept to <em>Runner</em> in the UI in April 2026. The
        database table, SQLAlchemy model, API routes, and MCP tool names all
        stayed as <code>agents</code>. This is deliberate — breaking every
        integration for a cosmetic win isn't worth it. If you see{" "}
        <code>create_agent</code> in the MCP catalog, that's a runner. Ask us
        how we know.
      </HonestRemark>

      <h2 id="a-minimal-pipeline">A minimal pipeline, in the shape you'll configure</h2>
      <p>
        Every workspace has a <code>pipeline_config</code> — a declarative
        description of the stages a card moves through, what role executes at
        each stage, what column types trigger it, and what sensors veto or
        gate the work. Here's the smallest one that does something real: a
        single implementer role that picks up cards from the <em>Ready</em>{" "}
        column and moves them to <em>Review</em> when done.
      </p>

      <CodeExample
        language="json"
        title="Minimal pipeline_config — one implementer stage"
      >
        {`{
  "version": 1,
  "stages": [
    {
      "role": "implementer",
      "discover": { "strategy": "by_column_type", "column_type": "ready" },
      "claim": { "participant_role": "hero", "execution_action": "implement_run" },
      "git": { "action": "commit_and_pr", "branch_prefix": "impl/", "create_pr": true },
      "llm": { "enabled": true, "stage": "implementer", "tools": ["mcp"] },
      "on_success": { "move_to_column_type": "review" }
    }
  ],
  "scheduling": { "mode": "priority", "priority_order": ["implementer"] }
}`}
      </CodeExample>

      <WhatThisIsNot title="Backplane is not autonomous by default, and not model-locked">
        <p>
          Runners execute pipelines you configured — they don't invent
          objectives and they stop at the approval gates you defined. The
          runner supports Claude Code and Codex CLI, with provider and model
          routing configured by the operator.
        </p>
      </WhatThisIsNot>

      <p>
        From here, the rest of the documentation walks you through the core
        concepts (workspaces, runners, roles, prompts, approvals), a hands-on
        getting-started path, and the configuration surfaces where operators
        actually shape runner behavior.
      </p>
    </SectionPage>
  );
}
