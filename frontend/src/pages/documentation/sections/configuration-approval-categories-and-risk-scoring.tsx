// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Source: backend/app/services/approvals/risk.py (BASE_SCORES, AUTO_APPROVE_THRESHOLD),
// backend/app/services/approvals/approval.py (create + decide + 24h expiry),
// docs/platform-source-of-truth.md §2.7, §4.8.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  DangerZone,
  HonestRemark,
  ImportantNote,
  Screenshot,
} from "../callouts";

export function ConfigurationApprovalCategoriesAndRiskScoring() {
  return (
    <SectionPage
      title="Approval Categories and Risk Scoring"
      eyebrow="Configuration"
    >
      <p>
        Approvals are the gate a runner crosses before it does something
        destructive or high-blast-radius. A stage with{" "}
        <code>llm.approval_enabled: true</code> allows its LLM to emit{" "}
        <code>request_approval(category, action_description, action_payload)</code>
        {" "}via MCP. The backend scores the request, auto-approves the cheap
        ones, and parks the risky ones in a queue the operator drains by hand.
      </p>
      <p>
        Seven categories exist, chosen to cover the action shapes that have
        cost real money to get wrong. The category is not free-form — an LLM
        request with an unknown category is rejected before it ever reaches
        the queue.
      </p>

      <h2 id="the-seven-categories">The seven categories</h2>
      <p>
        Each category carries a base risk score between 0 and 100. The score
        is bumped up or down by the action payload — a deletion of a single
        card scores differently from a bulk delete of forty. The full formula
        lives in <code>backend/app/services/approvals/risk.py</code>.
      </p>

      <CodeExample
        language="python"
        title="The category base scores (risk.py)"
      >
        {`BASE_SCORES = {
    ApprovalCategory.deletion:          60,  # destructive by default
    ApprovalCategory.bulk_change:       40,  # scales with item_count
    ApprovalCategory.deployment:        70,  # +20 for production, -20 for staging
    ApprovalCategory.schema_change:     80,  # +10 if destructive
    ApprovalCategory.permission_change: 50,  # +30 for admin/owner grants
    ApprovalCategory.external_action:   30,  # +20 for main/master/production branch
    ApprovalCategory.skill_publication: 60,  # never auto-approves; humans gate skills
}

AUTO_APPROVE_THRESHOLD = 30`}
      </CodeExample>

      <p>
        The threshold is an inclusive ceiling: a computed score of 30 or less
        becomes <code>auto_approved</code> at create time and never shows up
        in the queue. A score of 31 or more becomes <code>pending</code>, a
        row appears in <code>/{`{slug}`}/approvals</code>, and the owning
        runner sleeps on a WebSocket subscription until a human decides.
      </p>
      <p>
        The <code>skill_publication</code> base of 60 is deliberate policy,
        not a tuning accident: an agent-proposed{" "}
        <a href="../documentation/skills">skill</a> must always cross a human
        — no payload detail lowers it into auto-approve range.
      </p>

      <h2 id="the-queue-and-the-decision">The queue and the decision</h2>
      <p>
        The current API route checks workspace membership but no minimum role:
        an owner, admin, member, or viewer can approve or reject. The backend
        publishes{" "}
        <code>approval.updated</code>; the subscribed runner wakes the same
        tick and re-enters the stage via{" "}
        <code>implement_after_approval</code>. No HTTP polling, no retry
        gymnastics — the request and the continuation share an approval ID
        that the runner carries across the gate.
      </p>

      <Screenshot
        aspectRatio="16:9"
        alt="Approval queue row expanded to show action payload and decision buttons"
        caption="The risk score is shown next to the category so the operator can triage by blast radius, not arrival order."
        description={[
          "Page header 'Pending approvals' with a badge '3' next to it.",
          "First queue row expanded. Category pill 'deletion' on the left.",
          "Risk score '80' rendered as a red badge next to the category.",
          "Agent name 'runner-prod', board name 'alpha', created timestamp '2 minutes ago'.",
          "Expanded body shows 'Action: delete 14 cards tagged archive-2025' and a JSON payload preview.",
          "Two buttons at the bottom: green 'Approve', red 'Reject', with a small line 'Expires in 23h 57m'.",
        ]}
      />

      <DangerZone title="Reject is terminal, not a soft veto">
        Approving an approval sets status <code>approved</code>; rejecting
        sets <code>rejected</code>. Both are one-way transitions. A second
        call to <code>/decide</code> on an already-decided approval returns
        409 and mutates nothing. There is no "reject with chance to retry"
        flow — if you want the runner to try again with a different payload,
        reject, let the stage reach its on-failure action, and let the LLM
        re-request on its next tick.
      </DangerZone>

      <h2 id="expiry-and-drift">Expiry and drift</h2>
      <p>
        Approvals carry an <code>expires_at</code> that defaults to creation
        time plus 24 hours. Nothing in the backend mutates on expiry today —
        the row stays in the queue with status <code>pending</code> past the
        deadline; the runner's WebSocket subscription stays open; a late
        decision still wakes the runner. Operators should treat the 24-hour
        field as a staleness signal, not a guarantee of auto-rejection.
      </p>

      <ImportantNote title="Auto-approve runs before the row is written">
        Auto-approve is not a background job scanning the queue. The decision
        happens synchronously inside{" "}
        <code>ApprovalService.create_approval</code>: if the computed score
        is at or below <code>AUTO_APPROVE_THRESHOLD</code>, the row is
        inserted with status <code>auto_approved</code> and the event fires
        the same tick. This means tuning the threshold retroactively — by
        editing <code>risk.py</code> and redeploying — changes behavior for
        future requests only. Rows already in the queue keep the status they
        were written with.
      </ImportantNote>

      <HonestRemark title="The risk formula is an in-code heuristic, not a declarative model">
        The category base scores, the payload bumps, and the auto-approve
        threshold are Python constants. They are not workspace-configurable,
        not exposed through the pipeline builder, not tunable from the UI. A
        workspace that wants stricter deletion gating, or wants to auto-reject
        anything above a score of 70, edits <code>risk.py</code> and redeploys
        the backend. This is the sane starting point — the sample size of
        approvals-in-the-wild was zero when the model was written — and a
        workspace-level override is on the backlog for when the real data
        justifies the complexity.
      </HonestRemark>
    </SectionPage>
  );
}
