// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Source: backend/app/services/agents/agent.py (trailing agent budget),
// backend/app/core/rate_limit.py (fixed process-local API buckets),
// backend/app/services/alerts/alert_threshold.py and services/agents/cost.py
// (the two COST_THRESHOLD_CROSSED producers),
// backend/app/services/webhooks/event_emitter.py (generic signed POST),
// runner/internal/workloop/strategy_generic.go (pre-claim budget gate),
// runner/internal/workloop/loop.go (local LLM-call pacing),
// frontend/src/features/agents/components/BudgetPanel.tsx.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  ImportantNote,
} from "../callouts";

export function ConfigurationBudgetAndCostControls() {
  return (
    <SectionPage title="Budget and Cost Controls" eyebrow="Configuration">
      <p>
        An agent's optional <code>budget_usd</code> is compared with the sum of
        its <code>AgentExecution.cost_usd</code> values from the trailing 30
        days. When <code>budget_usd</code> is null, there is no agent-level cap;
        Backplane does not substitute a workspace default. A configured budget
        is exceeded only when recorded spend is greater than the cap.
      </p>
      <p>
        After discovering a card and before claiming it, the Runner requests{" "}
        <code>/api/agents/me/budget-status</code>. It skips the claim when the
        budget is exceeded. If that request fails, including with a 429, the
        tick fails closed instead of proceeding without a budget decision. The
        check does not interrupt an execution that is already in flight.
      </p>

      <h2 id="the-cap-and-the-panel">The cap and the panel</h2>
      <p>
        The <code>BudgetPanel</code> on the Runner detail page shows Budget,
        Spent, and Remaining. With a configured cap it also shows percentage
        used, the spent-to-budget values, and a progress bar. An exceeded cap
        adds a warning badge; a null cap adds a No budget set badge. Editing
        the numeric field and selecting Save updates{" "}
        <code>budget_usd</code>.
      </p>

      <p>The panel reports the rolling budget status returned by the backend and lets an operator replace or clear the cap.</p>

      <CodeExample language="json" title="Stored Runner registration fields">
        {`{
  "name": "runner-prod",
  "agent_type": "coding",
  "allowed_workspaces": ["valaris"],
  "max_requests_per_minute": 100,
  "budget_usd": 50.0,
  "description": "Primary implementer runner on production."
}`}
      </CodeExample>

      <h2 id="rate-limiting">Rate limiting</h2>
      <p>
        <code>RateLimitMiddleware</code> applies fixed, 60-second API buckets:
        10 login attempts per client IP, 60 unauthenticated requests per
        client IP, 300 requests per authenticated user session, and 100
        requests for an API-key-shaped Authorization header. The API-key bucket
        is fixed at 100 requests per minute today. The middleware does not read{" "}
        <code>max_requests_per_minute</code>.
      </p>
      <p>
        <code>max_requests_per_minute</code> is stored on the Agent and returned
        in its configuration. The Go Runner uses it to pace local LLM provider
        executions; it does not tune the backend API bucket. An API request
        beyond its bucket returns 429 with rate-limit headers and{" "}
        <code>retry-after: 60</code>.
      </p>

      <ImportantNote title="API-key classification happens before authentication">
        Any Authorization header that starts exactly with{" "}
        <code>Bearer vlr_</code> receives the API-key tier before the credential
        is verified. Its bucket
        identity uses only the first 20 characters of that header. This shape
        is an implementation risk: different keys with the same prefix can
        share a bucket, while crafted, unverified values can enter the 100/min
        tier. Do not treat the middleware as an authorization boundary.
      </ImportantNote>

      <h2 id="alerts-and-webhooks">Alerts and webhooks</h2>
      <p>
        <code>cost.threshold_crossed</code> has two producers with two different
        payload shapes. User-defined workspace alert thresholds evaluate{" "}
        <code>cost_usd_7d</code> or <code>cost_usd_30d</code> and publish{" "}
        <code>{`{ threshold_id, metric, operator, target_value, current_value, workspace_id, board_id }`}</code>.
        An evaluation can publish again while its condition remains true; there
        is no durable once-per-period guarantee.
      </p>
      <p>
        The workspace cost circuit breaker compares the rolling 15-minute sum
        with <code>threshold_usd_per_15min</code> and publishes{" "}
        <code>{`{ workspace_id, current_usd, threshold_usd, action, window_seconds }`}</code>.
        Its 60-second suppression is process-local and is cleared by Resume.
        The supported action values are <code>alert</code>, <code>pause</code>,
        and <code>kill_runner</code>; today <code>kill_runner</code> follows the
        pause behavior because runner shutdown is not wired.
      </p>
      <p>
        Webhook subscribers receive either payload inside the standard{" "}
        <code>{`{ event, timestamp, payload }`}</code> envelope through a generic
        signed HTTP POST. Backplane does not provide destination-specific
        notification integrations on this path; the receiving endpoint decides
        how to route or format the event.
      </p>

      <HonestRemark title="API rate counters are per process, not per fleet">
        <code>RateLimitMiddleware</code> keeps counters in a process-local
        dictionary. With <code>N</code> backend instances, the effective API-key
        ceiling is approximately <code>N × 100 requests/min</code>, not{" "}
        <code>N × max_requests_per_minute</code>. Restarts also discard the
        counters. Use an external shared quota if a deployment needs a durable,
        fleet-wide enforcement boundary.
      </HonestRemark>
    </SectionPage>
  );
}
