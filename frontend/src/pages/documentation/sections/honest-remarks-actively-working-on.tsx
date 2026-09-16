// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { HonestRemark } from "../callouts";
import { SectionPage } from "../shell/SectionPage";

export function HonestRemarksActivelyWorkingOn() {
  return (
    <SectionPage title="What We're Actively Working On" eyebrow="Honest Remarks">
      <p>
        This route keeps its established title, but the repository cannot prove
        who is actively assigned to a topic or when it will ship. The sections
        below separate capabilities already present in the current revision
        from concrete validation gaps. They are not an implementation calendar
        or an ETA.
      </p>

      <h2 id="dependencies-shipped">Already landed: structured dependencies</h2>
      <p>
        Structured card dependencies are no longer future work. The{" "}
        <code>card_dependencies</code> model, migrations, CRUD and bulk-set
        endpoints, cycle checks, scheduler exclusions, frontend controls, and
        MCP tools are present. Any follow-up should start from that shipped
        contract rather than rescoping the feature from zero.
      </p>

      <h2 id="forge-shipped">Already landed: the forge abstraction</h2>
      <p>
        The Runner now routes change creation, review, status, comments, merge,
        branch protection, and open-change queries through{" "}
        <code>forge.Provider</code>. Backplane ships GitHub and Gitea/Forgejo
        drivers. GitLab is a documented coverage gap, not evidence that the
        provider seam itself is still hypothetical.
      </p>

      <h2 id="validation-gaps">Open validation gaps visible in source</h2>
      <p>
        The <code>codex-cli</code> provider needs a certified live run that
        exercises a real Valaris MCP tool call. The Gitea driver needs testing
        against the specific live Gitea or Forgejo version an operator plans to
        use. These are evidence gaps recorded by the implementations, not
        promises that a team is currently executing either validation.
      </p>

      <h2 id="coverage-gaps">Known coverage gaps are not roadmap commitments</h2>
      <p>
        A native Runner GitLab forge driver and a Redis event-bus backend are
        not implemented. The frontend <code>WorkspaceConfig</code> type also
        omits the backend's <code>model_pricing</code> field. This page records
        those facts so planning can begin from current code; it does not assign
        owners, priority, or delivery dates.
      </p>

      <HonestRemark title="Read code status separately from delivery status">
        “Implemented”, “tested”, and “live-certified” are different claims.
        Backplane should only advance a claim when the matching evidence exists
        in code, automated tests, or a recorded live validation.
      </HonestRemark>
    </SectionPage>
  );
}
