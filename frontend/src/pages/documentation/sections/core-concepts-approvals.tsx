// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content verified against the approval service, UI, and runner park/resume path.

import { SectionPage } from "../shell/SectionPage";
import { DangerZone, ImportantNote } from "../callouts";

export function CoreConceptsApprovals() {
  return (
    <SectionPage title="Approvals" eyebrow="Core Concepts">
      <p>
        An <strong>approval</strong> gates a destructive or high-risk operation.
        An agent describes the intended action and payload, the backend records
        a scored request, and either policy or a human decides whether execution
        may continue. The durable approval record is part of the audit trail.
      </p>

      <h2 id="categories">Categories and scoring</h2>
      <p>
        The supported categories are <code>deletion</code>,{" "}
        <code>bulk_change</code>, <code>deployment</code>,{" "}
        <code>schema_change</code>, <code>permission_change</code>,{" "}
        <code>external_action</code>, and <code>skill_publication</code>. Each
        starts from a category base score;
        payload details such as item count, target environment, destructive
        schema work, privileged roles, or protected branches can raise or lower
        the result.
      </p>
      <p>
        A risk score less than or equal to <code>30</code> is auto-approved.
        Higher scores create a <code>pending</code> decision for a human. The
        current <code>AUTO_APPROVE_THRESHOLD</code> is a backend constant, not a
        workspace setting.
      </p>
      <p>
        One category exists specifically for the skills flywheel:{" "}
        <code>skill_publication</code> starts at a base score of 60, so an
        agent-proposed <a href="../documentation/skills">skill</a> can never
        auto-approve. Publishing what future agent sessions are taught is
        always a human decision.
      </p>

      <h2 id="park-and-resume">Park, continue, and resume</h2>
      <p>
        A pending approval does not make the runner wait inside an expensive
        agent session. The runner checkpoints the work in progress, adds the
        durable <code>awaiting-approval</code> label, parks that card, and
        continues with other cards. The label survives a runner restart even
        though the in-memory provider resume token does not.
      </p>
      <p>
        Approval WebSocket events wake the runner for a near-immediate check;
        HTTP reads remain the canonical state check and fallback on every poll
        cycle. An approved request resumes the parked work when its session
        token is still available. A pending request or a temporary fetch error
        stays parked instead of being treated as failure.
      </p>

      <p>The approvals page separates discovery from the decision dialog and keeps completed decisions readable.</p>

      <h2 id="states">Decision states</h2>
      <p>
        The data model exposes <code>pending</code>, <code>approved</code>,{" "}
        <code>rejected</code>, <code>auto_approved</code>, and{" "}
        <code>expired</code>. New requests receive an <code>expires_at</code>{" "}
        timestamp as age metadata. No current job changes the status
        automatically at that time, and the timestamp does not prevent a late
        human decision. If a request does have expired status, the runner leaves
        its card parked for explicit human recovery instead of treating it as a
        retry or failed stage.
      </p>

      <ImportantNote title="Approval wait is durable, provider continuation is not">
        After a runner restart, the <code>awaiting-approval</code> label still
        prevents accidental re-execution, but the provider resume token is gone
        by design. An operator must decide the request and deliberately
        retrigger or unpark the card as appropriate.
      </ImportantNote>

      <DangerZone title="Rejection is terminal">
        A rejection is not a retry signal. The runner marks the approval path as
        terminal and routes the card to its blocked failure outcome instead of
        asking again in a loop. The decision remains in history; recovery is a
        new, deliberate execution after the underlying concern is resolved.
      </DangerZone>
    </SectionPage>
  );
}
