// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content verified against RunnerConsoleOverview and AnalyticsDashboard.

import { SectionPage } from "../shell/SectionPage";
import { HonestRemark, Screenshot } from "../callouts";

export function OperatingReadingTheRunnerOverview() {
  return (
    <SectionPage
      title="Reading the Runner Overview"
      eyebrow="Operating the Platform"
    >
      <p>
        The Runner Console at <code>/{`{slug}`}/runner</code> has four tabs:{" "}
        <em>Overview</em>, <em>Pipeline</em>, <em>Runners</em>, and{" "}
        <em>Activity</em>. Overview is deliberately health-first. It summarizes
        active-runner metrics, configuration warnings, pending approvals, and
        execution analytics; runner management and teams live in Runners, while
        the execution feed lives in Activity.
      </p>

      <Screenshot
        aspectRatio="16:9"
        alt="Runner overview with five headline metrics, pending approvals, and analytics"
        caption="Overview is a health summary. Its metric cards link to the tabs that own the detail."
        description={[
          "Runner Console tabs: Overview, Pipeline, Runners, and Activity, with Overview active.",
          "An optional configuration-error alert links to Runners; a no-runners hint does the same.",
          "Five metric cards: Total runners, Success rate, Average duration, Total tokens, and Total cost.",
          "Pending approvals appears below the metrics, followed by the Analytics dashboard.",
          "Analytics includes outcome metrics, execution totals, 30-day daily activity, and distribution by role or action.",
        ]}
      />

      <h2 id="headline-metrics">The five headline metrics</h2>
      <p>
        <strong>Total runners</strong> is the count returned by the active-runner
        metrics query. Inactive runners are excluded from this Overview request.
        Clicking the card opens the Runners tab.
      </p>
      <p>
        <strong>Success rate</strong> is completed executions divided by total
        executions across the returned runners. The denominator is the full
        execution count exposed by each runner metric, so it is not limited to
        completed plus failed outcomes.
      </p>
      <p>
        <strong>Average duration</strong> is the arithmetic mean of each active
        runner's reported average duration. It is therefore an unweighted mean
        across runners, not one global average over all execution rows.
      </p>
      <p>
        <strong>Total tokens</strong> and <strong>Total cost</strong> sum the
        cumulative values returned for all active runners. Overview does not
        expose a selectable time window for these five cards. The four
        execution-oriented cards link to Activity.
      </p>

      <h2 id="below-the-metrics">Warnings, approvals, and analytics</h2>
      <p>
        A zero-runner hint directs setup to the Runners tab. If any active
        runner reports <code>health_config_errors</code>, a destructive-colored
        alert links to the same tab so the configuration can be inspected.
        Pending approvals are listed next, with a direct path to the approval
        queue.
      </p>
      <p>
        The lazy-loaded Analytics dashboard adds success and rework rates,
        average cost per card, average duration, execution totals, daily
        successes and failures for the latest 30 data points, and a role or
        action distribution. Those analytics are server-derived and are not the
        same aggregation as the five runner cards above.
      </p>

      <HonestRemark title="Use the owning tab for diagnosis">
        Overview no longer embeds the runner table, team roster, or execution
        timeline. Open <em>Runners</em> for liveness, inactive runners, teams,
        launch configuration, and reported config errors. Open <em>Activity</em>{" "}
        for individual execution history and links to execution detail.
      </HonestRemark>
    </SectionPage>
  );
}
