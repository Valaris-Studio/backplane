// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §4 "What the Platform Does".

import { SectionPage } from "../shell/SectionPage";
import { ProTip } from "../callouts";

export function IntroductionQuickTour() {
  return (
    <SectionPage title="Quick Tour" eyebrow="Introduction">
      <p>
        Five minutes, one pass through the core loop. This tour follows a
        single card from the moment it lands on a board to the moment a
        runner ships a PR for it. No deep dives — each stop points at the
        dedicated section where you'll find the full treatment.
      </p>

      <h2 id="workspace-and-board">Workspace and board</h2>
      <p>
        Every URL in the platform lives under a workspace slug:{" "}
        <code>/{"{slug}"}/...</code>. Inside a workspace you have boards,
        members, teams, a pipeline config, budgets, and activity history.
        Inside a board you have columns, cards, definitions, resources, notes,
        git repos, and alerts. The board view is where operators spend most
        of their day.
      </p>

      <p>The board is the operator's primary surface. Column types — not column names — drive pipeline behavior.</p>

      <h2 id="a-card-enters-the-pipeline">A card enters the pipeline</h2>
      <p>
        Someone — a human operator or an architect runner following the
        <code> plan_work</code> prompt — creates a card in the Backlog column.
        The card has a title, a type (<code>task</code>, <code>bug</code>,{" "}
        <code>feature</code>, <code>issue</code>), a priority, a description,
        and optionally labels, a due date, and participants. Nothing happens
        yet. Backlog cards are waiting for a scheduler to notice them.
      </p>

      <h2 id="a-runner-claims">A runner claims</h2>
      <p>
        A runner polls the backend (via WebSocket, not HTTP interval) for work
        matching its team membership. Each runner executes one stage per tick.
        The backend answers: "claim card X for stage Y." The claim is atomic:
        the card's <em>hero</em> participant slot is filled in a single
        transaction. Two runners racing for the same card lose one cleanly;
        the loser backs off and the winner moves the card into the next
        column — typically <em>In Progress</em>.
      </p>

      <p>The runner overview shows who is working on what, what it cost, and how long it took.</p>

      <h2 id="the-stage-executes">The stage executes</h2>
      <p>
        The runner assembles a prompt — board definition, pinned notes, card
        description, prior review findings, platform-spliced post-process
        imperatives — and invokes the configured Claude Code or Codex CLI
        provider. If the board binds{" "}
        <a href="../documentation/skills">skills</a> — versioned procedural
        playbooks from the workspace library — the runner materializes them
        into the working tree first, so the agent discovers them like project
        files. Every tool call the LLM makes
        goes through the Backplane MCP server, which routes it back to the
        backend. Every mutation publishes an <code>activity.*</code> event on
        the WebSocket bus. Observers see the work happen live: cards move,
        comments appear, tokens and cost accumulate on the execution row.
      </p>

      <ProTip title="Watch the Observer panel during your first run">
        The floating Observer panel (admin-only, draggable, remembers its
        position) streams every card, agent, execution, and approval event in
        real time. The first time you run a pipeline end-to-end, open it. You
        will see more about what the platform is doing in thirty seconds of
        scrolling events than in any diagram we could draw for you.
      </ProTip>

      <h2 id="approval-if-needed">Approval, if the stage demands one</h2>
      <p>
        If the stage declares an approval gate — say, because the work
        category is <code>deploy</code> or the risk score crosses the
        auto-approve threshold — the runner pauses and emits a
        <code>request_approval</code> tool call. The backend creates a pending
        approval; a human sees it in the <em>Approvals</em> queue and decides.
        The runner is subscribed to <code>approval.updated</code> on the WS
        bus, so the moment the decision lands the runner wakes and continues.
        No polling, no wasted ticks.
      </p>

      <p>Approvals show the action description and payload the runner requested — enough context to decide without reopening the card.</p>

      <h2 id="ship-and-repeat">Ship and repeat</h2>
      <p>
        The runner pushes the branch, opens a PR, moves the card into the
        column configured in the stage's <code>on_success</code> action
        (typically <em>Review</em> for an implement stage, <em>Done</em> for a
        reviewer stage), records the execution's cost and duration, and enters
        its next tick. The next stage in the pipeline — a reviewer role, a
        documentator role, a custom role you defined — picks the card up from
        its new column and the loop continues.
      </p>

      <p>
        That's the shape. The rest of this documentation walks each piece in
        depth — what the pipeline builder accepts, how to author prompts, how
        to register a runner, how to read the runner overview, and where to
        look when a card gets stuck.
      </p>
    </SectionPage>
  );
}
