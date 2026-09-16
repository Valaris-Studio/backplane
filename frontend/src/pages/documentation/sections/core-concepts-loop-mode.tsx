// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/loop-operator-playbook.md and the operator-facing
// half of docs/loop-mode-contract.md §§2-6.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, HonestRemark, ImportantNote, ProTip } from "../callouts";

export function CoreConceptsLoopMode() {
  return (
    <SectionPage title="Loop Mode" eyebrow="Core Concepts">
      <p>
        <strong>Loop mode</strong> points a single agent session at a board and
        lets it work the backlog unattended, one card per iteration. Where a
        pipeline run is a runner playing configured roles against cards the
        scheduler hands it, a loop is one prompt executed over and over — each
        iteration a fresh session with no memory of the last one, re-reading the
        board to decide what to do next.
      </p>
      <p>
        That amnesia is the design, not a limitation. The board is the loop's
        only durable memory: run-log notes, card descriptions, and the board
        definition are what one iteration leaves for the next. Anything an
        iteration learns but does not write down is gone when its session ends.
      </p>

      <p>
        Pipeline mode uses next_assignment for atomic reservation. Loop mode
        follows the configured prompt for scoped search_cards, dependency
        checks and move_card, with no atomic reservation. completion_query is
        a stop condition, not a selection filter.
      </p>
      <p>
        completion_policy selects the landing actor, independent source review, forge checks, exact merged-commit validation, evidence-only approval, dependency release at accepted or Done, and automatic or manual completion. A board policy replaces the workspace policy as a whole; null inherits. With no effective policy, legacy enforce_done_merge_gate behavior remains. Only a human workspace administrator may change policy or select evidence_only mode.
      </p>
      <p>
        Under an explicit policy, submit_completion_candidate records the real open PR and source execution before landing. Independent source review and validation of the frozen merge SHA are separate phases. get_completion_status shows current acceptance and failures; retry_completion schedules a fresh attempt. Later main advancement does not invalidate that exact accepted SHA. Evidence-only candidates require source SHA, artifact digests and named checks. Report blocked_on_human when a human decision is required; never invent a PR or bypass acceptance.
      </p>

      <p>
        Completion attempts freeze their input context. Editors warn when active work uses a note, definition, prompt or configuration. Policy preview and save enforce the same 128 KiB mandatory-context limit; the separate 256 KiB execution limit also includes the role prompt and evidence. A rejected result records changed inputs when available. Retry completion preserves the candidate and starts a fresh attempt; Recheck completion context can release an older stale attempt immediately while leaving an unchanged active lease intact.
      </p>
      <p>
        Restarting a runner reports pending review, merge, validation and accepted work with its next action. Doctor inspects this state without claiming work, retrying attempts or enabling the loop. A card in a Blocked column can still need a separate source-work decision after a setup problem is repaired; completion review and validation remain independent of that column.
      </p>

      <h2 id="tuning">The tuning loop</h2>
      <p>
        The runner re-fetches the board's loop config at the top of{" "}
        <strong>every</strong> iteration. That single property turns the loop
        into a live instrument — you edit the prompt mid-run and the next
        iteration picks it up with no restart and no redeploy.
      </p>
      <ol>
        <li>An iteration writes a run-log note on the board.</li>
        <li>
          You read it and fold the lesson into <code>loop_prompt</code> — one{" "}
          <code>set_board_loop</code> call; every operator field is editable.
        </li>
        <li>The next iteration runs the new method.</li>
      </ol>
      <p>
        Treat the prompt as versioned method, the board's notes as the loop's
        memory, and the config as the only knob you need mid-run. The most
        valuable thing an iteration produces is often not its diff but its
        report of what the prompt got wrong.
      </p>

      <h2 id="config">Operator config fields</h2>
      <p>
        The board's Loop dialog is the human control surface. It keeps the
        enable switch disabled until the first valid save, requires a non-empty
        loop prompt before enabling, warns before discarding unsaved edits, and
        explains structured disabled reasons. Templates can fill the prompt and
        tool allowlist with an overwrite confirmation; prompt-variable chips,
        provider and model controls, the Tool picker, recent telemetry, the
        paginated iteration log, and stop transitions are available in the same
        dialog.
      </p>
      <p>
        Saving config and changing state are separate operations. The dialog
        saves the operator-owned fields below, while its switch enables or
        disables the saved loop. The <code>set_board_loop</code> MCP tool covers
        the same policy surface for agents; omitted fields retain their current
        values, and the runner re-fetches changes on its next cycle.
      </p>
      <ul>
        <li>
          Core execution fields: <code>provider</code>, <code>model</code>,{" "}
          <code>system_prompt</code>, <code>loop_prompt</code>, and{" "}
          <code>tools</code>.
        </li>
        <li>
          Time and money rails: <code>max_iterations</code>,{" "}
          <code>iteration_delay_seconds</code>,{" "}
          <code>iteration_timeout_seconds</code>, <code>budget_usd</code>, and{" "}
          <code>completion_query</code>.
        </li>
        <li>
          Failure and human-block rails: <code>max_consecutive_failures</code>{" "}
          and <code>max_blocked_on_human</code>.
        </li>
        <li>
          <code>starvation_policy</code> — <code>park</code> (default) or{" "}
          <code>always_run</code>. Under <code>park</code> the runner pre-flights
          readiness each cycle and idles for free when nothing is actionable.
          Use <code>always_run</code> for loops whose prompt does non-card work,
          such as triage or documentation sweeps.
        </li>
        <li>
          <code>loop_landing</code> — <code>human</code> (default) or{" "}
          <code>self_merge</code>/<code>merge_queue</code>. A person lands the
          PR, the loop agent lands its own with plain git, or the platform merge
          queue lands it — the last is the per-board opt-in for autonomous
          landing. See the posture matrix below.
        </li>
        <li>
          <code>merge_gate</code> — <code>forge_ci</code> (default) or{" "}
          <code>none</code>. What the merge executor requires before landing this
          board's queued PRs. Resolved live per tick, so flipping it unsticks
          already-queued entries without re-enqueueing. Fail-closed: an
          unrecognized policy behaves as <code>forge_ci</code>.
        </li>
        <li>
          <code>budget_epoch</code> — server-owned, stamped on every
          disabled→enabled transition. It defines the budget window, which makes{" "}
          <strong>re-enabling the loop your budget reset lever</strong>. Config
          edits while enabled preserve it.
        </li>
      </ul>

      <ImportantNote title="budget_epoch is not writable">
        Like <code>version</code> and <code>updated_at</code>, it is set by the
        server. A save that carries it back is rejected. To reset the spend
        window, disable the loop and enable it again.
      </ImportantNote>

      <h2 id="run-model">Choose a model for this run</h2>
      <p>
        In the runner's loop setup, keep Follow board settings or choose Choose a model for this run. Select the coding agent and enter the exact model ID accepted by its CLI and your account. The review shows the board request and your selection, even when the board pins a concrete model.
      </p>
      <CodeExample language="bash" title="Use a custom model for one loop process">
        {`backplane-runner -profile my-runner -loop -loop-board my-board \\
  -run-provider codex-cli -run-model your-model-id`}
      </CodeExample>
      <p>
        Both flags are required for a non-interactive loop launch. The choice lasts for this process, including later iterations and keep-alive resumption. It does not change the board or saved profile defaults. Restart without the choice to follow board settings again. Board prompts, tools, budgets and stop conditions still apply.
      </p>
      <p>
        Use a concrete model ID rather than a tier alias. Startup checks the selected agent binary, not model access for your account. If the CLI rejects the model, the session fails without substituting another model. Execution records show the effective provider and model. Pipeline stages and subagents launched by the coding agent keep their own model selection.
      </p>

      <h2 id="parking">Parking — the readiness, reconcile, wake chain</h2>
      <p>
        A loop whose cards are all blocked used to burn a full session
        discovering it had nothing to do. Under the default{" "}
        <code>starvation_policy: "park"</code> it does not:
      </p>
      <ol>
        <li>
          <strong>Readiness.</strong> Before spending anything, the runner asks
          the backend what is actionable right now — how many cards are workable,
          blocked, or waiting on a merge.
        </li>
        <li>
          <strong>Reconcile.</strong> The merged-PR reconciler moves cards whose
          PRs have landed into Done, which is what unblocks their dependents.
          It runs on merge events and on a periodic poll.
        </li>
        <li>
          <strong>Wake.</strong> When reconciliation makes something workable,
          the next cycle starts a real iteration. Until then the loop idles at
          zero cost, logging its parked state with blocked and awaiting-merge
          counts each cycle.
        </li>
      </ol>
      <p>
        So a parked loop is healthy and cheap, not stuck. The way to tell the
        difference is the parked log line and the readiness endpoint — both
        report what the runner currently sees.
      </p>

      <h2 id="keep-alive">Disabled, parked, and keep-alive</h2>
      <p>
        These states answer different questions. <code>parked</code> means the
        loop is enabled but has no actionable work under its starvation policy.
        It remains eligible to work and waits at zero session spend. By
        contrast, <code>idle_waiting</code> means the board loop is disabled but
        the runner was configured to stay resident with{" "}
        <code>loop_mode.keep_alive: true</code> or the explicit{" "}
        <code>-keep-alive</code> flag. It starts no agent session while disabled.
      </p>
      <p>
        A resident runner wakes on <code>board.loop_updated</code> through the
        workspace WebSocket when possible and falls back to checking at most
        once per minute. That socket is a wake channel only: control Loop with{" "}
        <code>set_board_loop</code>, not <code>poll_agent</code> or{" "}
        <code>restart_agent</code>. If an older backend rejects{" "}
        <code>idle_waiting</code>, the runner reports the compatible{" "}
        <code>parked</code> heartbeat instead. Re-enabling creates a new budget
        epoch and starts fresh budget accounting.
      </p>
      <ImportantNote title="Keep-alive does not bypass stop conditions">
        Keep-alive changes only what happens after an operator disables the
        board loop. The safety rails still exit the process when a run reaches
        its budget, iteration ceiling, completion query, or another terminal
        guard. Use a process supervisor if those exits should be restarted.
      </ImportantNote>

      <h2 id="autonomy-posture">Autonomy posture</h2>
      <p>
        Two questions define how much rope the loop has: who merges the pull
        requests, and what has to be green first.
      </p>
      <h3 id="posture-human">Human landing (default)</h3>
      <p>
        PRs land when a person merges them on the forge. The reconciler still
        moves the card to Done, so the board stays accurate without anyone
        touching it. While work is blocked behind those merges the loop parks at
        zero cost and wakes when a merge unblocks dependencies. This posture
        needs nothing extra and works on any plan.
      </p>
      <h3 id="posture-merge-queue">Merge-queue landing (opt-in)</h3>
      <p>
        A board admin sets <code>loop_landing: "merge_queue"</code> and adds the
        enqueue tool to the loop's allowlist. Loop agents then hand finished PRs
        to the platform's merge executor, which rebases and lands them subject to{" "}
        <code>merge_gate</code>. A loop rarely parks under this posture because
        it lands its own green PRs. An agent enqueue on a board without the
        opt-in is rejected server-side.
      </p>
      <h3 id="posture-self-merge">Self-merge landing (prompt-directed)</h3>
      <p>
        <code>loop_landing: "self_merge"</code> is the honest name for what a
        prompt saying "merge it yourself" already does: the loop agent merges
        its own branch and moves its own card, with no reviewed PR by
        construction. The platform grants nothing here, but the board's
        done-merge gate would block every Done move under it — so a{" "}
        <strong>human</strong> save that chooses this landing relaxes the gate
        for that board in the same request. The dialog surfaces the trade as a
        notice you can decline, an explicitly enforced board is never softened
        implicitly, and moving the landing off <code>self_merge</code> re-arms
        the gate automatically. Agent-key saves never relax anything: a landing
        an agent stored does not count as consent, and an explicit relax from
        an agent key is refused.
      </p>
      <p>
        Every posture reports lifetime cost from provider reports or runner estimates, alongside spending and remaining allowance for the current budget epoch. Restarting preserves the epoch; disabling and re-enabling starts a new one. Session dollar settings are advisory unless the provider and billing mode support enforcement; subscription sessions do not have an enforced dollar cap. Missing required spending history stops execution. The early budget warning and shell deny floor still apply.
      </p>

      <HonestRemark title="Forge CI is desirable, never a dependency">
        Some repositories cannot run forge CI at all — a free-plan organization
        where Actions are unavailable, for instance. Rather than making those
        boards second-class, <code>merge_gate: "none"</code> skips the CI read
        entirely and lets the board's review flow be the quality gate. We would
        rather you land work with an honest gate than pretend a red-or-absent CI
        signal is green.
      </HonestRemark>

      <h2 id="authoring-cards">Authoring cards for a loop</h2>
      <p>
        Shared-file conflicts between parallel cards are structural, not
        incidental. Any two cards that append to the same status section,
        register into the same map, or edit the same barrel export{" "}
        <em>will</em> conflict when their PRs land. Author them so the collision
        never exists:
      </p>
      <ul>
        <li>
          Prefer <strong>per-card registration files</strong> plus a generated or
          union registry over one file every card edits.
        </li>
        <li>
          Prefer <strong>append-only logs</strong> over in-place status tables —
          two appends merge cleanly, two edits of the same row do not.
        </li>
        <li>
          File <strong>explicit integration cards</strong> for union merges, with
          dependency edges on the cards they integrate. Do not leave the last
          parallel card to implicitly merge everything.
        </li>
        <li>
          When a card needs an earlier card's unmerged interfaces, copy those
          interface files verbatim into its branch. They are identical at merge
          time and rebase away cleanly — which beats stacking branches.
        </li>
      </ul>

      <ProTip title="Write the general rule into the card, not the note">
        When an iteration hits a non-obvious constraint, have it write the rule
        into the affected card's description as an as-built block. The next
        iteration reads cards it is about to work; it may never read a note
        filed under a different card.
      </ProTip>

      <h2 id="skills">Skills in a loop</h2>
      <p>
        A loop session receives the board's bound{" "}
        <a href="../documentation/skills">skills</a> without any pipeline
        step: the runner re-fetches the board's effective skill set at the top
        of every iteration and materializes it into the working tree before
        the session starts. Bind, pin, or publish mid-run and the next
        iteration picks up the change — the same live-instrument property as
        the prompt. Unbinding stops updates but does not yet remove the
        already-materialized files from the loop working directory:
        materialization only ever adds, so a removed skill&apos;s directory
        lingers until that cleanup ships.
      </p>
      <p>
        The traffic also flows the other way. With{" "}
        <code>skills_proposal_enabled</code> — on by default in the loop
        config — a session that proved out a durable method can distill it
        into a proposed skill via <code>propose_skill</code>. Nothing
        publishes on its own: the proposal waits in the approvals queue for a
        human, and only approval makes it part of what future iterations are
        taught.
      </p>

      <h2 id="stopping">Knowing why it stopped</h2>
      <p>
        A loop should never spin on a state it cannot change. Instruct the prompt
        to disable the loop with a one-line reason whenever the objective is
        complete or a human decision is genuinely required — that reason is the
        first thing you see when you come back to the board.
      </p>

      <CodeExample language="text" title="Prompt fragment — disable with a reason">
        {`If the objective is complete, or you are blocked on something only a
human can resolve, call set_board_loop with enabled=false and a one-line
reason. Never spin on a blocked state.`}
      </CodeExample>

      <p>
        The rails write machine-readable reasons of their own when they stop a
        loop — budget exhausted, iteration ceiling reached, too many consecutive
        failures — so a stopped loop always explains itself in the same place.
      </p>

      <h2 id="which-component">Which component owns what</h2>
      <p>
        A recurring diagnosis mistake is looking for a loop feature in the wrong
        binary. Before concluding a build is stale, check who owns the feature:
      </p>
      <ul>
        <li>
          <strong>Backend</strong> — <code>loop_landing</code> and{" "}
          <code>merge_gate</code> enforcement, the merge queue worker, the
          merged-PR reconciler, readiness and history endpoints, and workspace
          git credentials. The runner never reads the first two.
        </li>
        <li>
          <strong>MCP server</strong> — the tools themselves. The runner passes
          tool <em>names</em> through to the agent allowlist verbatim.
        </li>
        <li>
          <strong>Runner</strong> — parking, budget caps, iteration continuity,
          and the outcome schema. It stores nothing; it reads{" "}
          <code>starvation_policy</code> and <code>budget_epoch</code> from the
          platform each iteration.
        </li>
      </ul>
      <p>
        Backend features arrive with deploys. When a runner meets an endpoint
        that is not there yet, it treats the feature as unsupported and degrades
        gracefully rather than failing the iteration.
      </p>

      <h2>Templates</h2>
      <p>
        Most loops should not start from a blank prompt. A <strong>loop
        template</strong> carries the prompts, the tool allowlist, and sensible
        rails, with the run-specific parts left as named <em>slots</em> you
        fill in. The maintained starting point is <strong>Coding Loop v2</strong>.
      </p>
      <p>
        Templates live in the Runner console under <code>/runner/loops</code>.
        Pick one, run <em>fit</em> against your board to see what the template
        expects that the board does not yet have, fill the slots (each carries
        help text explaining what a good value looks like), preview the fully
        rendered prompts, and save. Prompts are rendered at save time and stored
        as ordinary loop config, so the runner reads exactly what it always read
        — and enabling the loop stays a separate, deliberate act.
      </p>
      <p>
        A bound board refuses hand edits to its prompts rather than silently
        overwriting them on the next render; detach it first if you want raw
        text. Each iteration a bound board runs is stamped with the template it
        came from, which is what gives a template a track record.
      </p>
      <p>
        The catalog behind that page is{" "}
        <code>GET /api/workspaces/&#123;slug&#125;/loop-templates</code>. It
        lists system templates first — code-defined, versioned with the app,
        so an upgrade is what updates them — then templates authored in your
        workspace. Entries are summaries; prompts, slots, and tool grants live
        behind the per-template fetch. Retired system lineages disappear from
        the catalog but their slugs still resolve, so a board bound to one
        reports drift instead of breaking.
      </p>

      <p>
        The full operator playbook — templates and slots, forge sharp edges, and
        credential troubleshooting — lives at{" "}
        <code>docs/loop-operator-playbook.md</code> in the Backplane repository,
        with the contract of record in <code>docs/loop-mode-contract.md</code>.
      </p>
    </SectionPage>
  );
}
