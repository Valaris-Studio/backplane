// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §1 "What the platform is NOT".

import { SectionPage } from "../shell/SectionPage";
import { WhatThisIsNot } from "../callouts";

export function IntroductionWhatItIsNot() {
  return (
    <SectionPage title="What It Is NOT" eyebrow="Introduction">
      <p>
        The previous page described what Backplane is. This one draws the fence.
        Operators arriving with expectations shaped by other tools — autonomous
        agent frameworks, general-purpose task platforms, one-model-forever
        wrappers — deserve to know up front what this platform does not try to
        be. Bounded expectations prevent the specific disappointment of asking
        a tool to do something it was never designed to do.
      </p>

      <h2 id="not-autonomous">Not autonomous</h2>
      <p>
        Runners execute pipelines that operators configure. They don't invent
        their own objectives, they don't pick new tasks outside the ones you've
        defined, and they stop at the approval gates you declared. If a card
        requires a destructive action — a deletion, a deployment, a schema
        change — the runner pauses and asks a human. Autonomy stops where your
        configuration stops.
      </p>

      <WhatThisIsNot title="Backplane is not an autonomous agent platform">
        <p>
          Runners are not goal-seeking. They claim cards from columns you've
          set up, execute the role and stage defined in your pipeline config,
          and report back. If you leave the pipeline empty, nothing happens.
          If you leave the board empty, nothing happens. The operator remains
          the source of direction.
        </p>
      </WhatThisIsNot>

      <h2 id="not-general-purpose">Not domain-locked, but opinionated</h2>
      <p>
        Backplane is opinionated about shape, not about domain. The primitives
        — boards, cards, roles, prompts, approvals, notes — organize any work
        an LLM agent can be pointed at: an autonomous coding loop, a plain
        kanban board your team runs by hand, an MCP-assisted session where you
        drive and the agent keeps the board honest, or the renovation you're
        project-managing on a Sunday. Role configs are yours to write; nothing
        in them assumes a compiler.
      </p>
      <p>
        What is tuned for software is the git-coupled machinery: the merge
        queue, PR-overlap sensors, and the done-merge gate only mean something
        on a board with a repo linked. Boards without a repo simply skip them.
      </p>

      <WhatThisIsNot title="Not a hosted agent, and not a chat wrapper">
        <p>
          Backplane does not run your agent for you. You bring the agent — a
          runner process, a Claude Code session, any MCP client — and
          Backplane gives it a place to keep state, take direction, and be
          watched. If you want a turnkey hosted agent that thinks up its own
          work, that is a different product.
        </p>
      </WhatThisIsNot>

      <h2 id="not-model-locked">Not model-locked — but not model-free either</h2>
      <p>
        Today most stages route through Claude via the <code>claude</code> CLI
        subprocess. Per-role provider and model configuration — implementer on
        Sonnet, reviewer on GPT-5, documentator on Gemini, all from the same
        runner — is the declared north star. The scoping document exists. The
        plumbing is partial. The platform is not structurally locked to one
        vendor, but the day you can route each role to its own model is still
        ahead, tracked under the LLM abstraction milestone.
      </p>

      <WhatThisIsNot title="Not yet per-role LLM selection">
        <p>
          The <code>pipeline_config.stages[*].llm</code> field exists and
          accepts provider and model hints. The runner today passes them to
          Claude CLI regardless. Wiring alternative providers end-to-end is
          the next big structural work stream, not a configuration flag you
          can flip today.
        </p>
      </WhatThisIsNot>

      <h2 id="not-a-replacement">Not a replacement for developer judgement</h2>
      <p>
        Approval gates, review cycles, and the human-authored pipeline config
        are where judgement lives. The runner executes; the operator decides
        what executing looks like. If a pipeline ships a bug, the pipeline is
        wrong — not the runner. If a reviewer role rubber-stamps everything,
        the prompt or the model selection is wrong. The platform gives you
        the levers; pulling them is still your job.
      </p>

      <h2 id="so-what-is-it">So what is it, then?</h2>
      <p>
        A coordination layer for LLM runners doing real engineering work on
        real git repositories, with the controls operators need to keep the
        work honest. The previous section — What Backplane Is — covers the
        shape of that in more detail. Between the two pages you should have
        a useful mental model before you start clicking.
      </p>
    </SectionPage>
  );
}
