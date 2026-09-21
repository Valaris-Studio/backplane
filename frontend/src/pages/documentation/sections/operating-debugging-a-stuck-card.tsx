// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content verified against computeStuckReasons, CardDetailSheet, and Runner tabs.

import { SectionPage } from "../shell/SectionPage";
import { ProTip, Screenshot } from "../callouts";

export function OperatingDebuggingAStuckCard() {
  return (
    <SectionPage
      title="Debugging a Stuck Card"
      eyebrow="Operating the Platform"
    >
      <p>
        Open the card detail sheet before guessing why work stopped. Its Stuck
        Reasons panel derives operator-facing signals from the current column,
        participants, recent card executions, latest review decision, skipped
        prompt stages, and live pipeline configuration. Done cards suppress the
        panel because they are already terminal.
      </p>

      <Screenshot
        aspectRatio="16:9"
        alt="Card detail sheet with current stuck reasons and execution history"
        caption="Stuck reasons are evidence to investigate, not a second scheduler."
        description={[
          "Card detail sheet with a Stuck Reasons section below pull-request context.",
          "Possible rows include Blocked column, No hero assigned, Awaiting prompt, Changes requested, Recent failures, and Stale card.",
          "Stages awaiting prompt appears separately with role, stage, and an Author prompt link.",
          "The card's latest execution history remains visible below the diagnostic sections.",
        ]}
      />

      <h2 id="reasons">The six current reasons</h2>
      <ul>
        <li>
          <strong>Blocked column.</strong> The current column has{" "}
          <code>column_type=blocked</code>; discovery skips it until an operator
          moves the card to a non-blocked column.
        </li>
        <li>
          <strong>No hero assigned.</strong> No participant has role{" "}
          <code>hero</code>, and at least one visible pipeline stage claims as a
          hero. Pipelines that use only another participant role do not get this
          false warning.
        </li>
        <li>
          <strong>Awaiting prompt.</strong> One or more distinct{" "}
          <code>(role, stage)</code> pairs produced a skipped execution for this
          card. Author the missing prompt and let a later tick try again.
        </li>
        <li>
          <strong>Changes requested.</strong> The latest parsed review decision
          is <code>request_changes</code>; rework and a newer approval are needed.
        </li>
        <li>
          <strong>Recent failures.</strong> At least two card executions failed
          during the last 24 hours. Inspect their execution errors before
          retrying a deterministic failure.
        </li>
        <li>
          <strong>Stale card.</strong> This fallback appears only when no more
          specific reason applies, the card has not changed for at least seven
          days, and no execution touched it recently.
        </li>
      </ul>

      <h2 id="evidence">Follow the owning surfaces</h2>
      <ol>
        <li>
          Use the board's <em>History</em> tab for mutations and its{" "}
          <em>Timeline</em> tab when replaying board state will clarify the
          sequence.
        </li>
        <li>
          Open the Runner Console's <em>Runners</em> tab for last heartbeat,
          liveness, inactive state, and <code>health_config_errors</code>.
        </li>
        <li>
          Open its <em>Activity</em> tab for the execution feed, then follow an
          execution into status, error, tool, duration, token, and cost detail.
        </li>
        <li>
          For a skipped prompt, use the card sheet's <em>Author prompt</em> link;
          it opens Pipeline with the relevant role and stage in the URL.
        </li>
      </ol>

      <ProTip title="A skipped execution means the runner respected platform authority">
        The pause icon on a kanban card and the Awaiting prompt reason are not
        proof that the runner is broken. They record that the runner found the
        card but did not receive authored prompt content for that role and
        stage. Fix the prompt in Pipeline, then verify the next execution in
        Activity.
      </ProTip>
    </SectionPage>
  );
}
