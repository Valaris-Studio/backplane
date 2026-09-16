// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { HonestRemark } from "../callouts";
import { SectionPage } from "../shell/SectionPage";

export function HonestRemarksKnownRoughEdges() {
  return (
    <SectionPage title="Known Rough Edges" eyebrow="Honest Remarks">
      <p>
        These limitations are visible in the current code. They are not a
        historical audit score, a staffing claim, or a promise that a fix is
        scheduled. Treat them as boundaries to verify before relying on the
        affected capability in a production workflow.
      </p>

      <h2 id="schema-drift">Cross-surface schemas still require vigilance</h2>
      <p>
        Earlier gaps in Runner identity are closed: <code>Board</code> and{" "}
        <code>GitRepo</code> include <code>slug</code>, and{" "}
        <code>PlatformConfig</code> consumes <code>team_roles</code>. Drift has
        not disappeared. For example, the backend workspace response exposes{" "}
        <code>model_pricing</code>, while the frontend's{" "}
        <code>WorkspaceConfig</code> interface does not currently declare it.
        Python, TypeScript, Go, and MCP payloads remain separate contracts.
      </p>

      <h2 id="coding-agent-coverage">Two CLI providers, different confidence levels</h2>
      <p>
        The Runner can execute both <code>claude-cli</code> and{" "}
        <code>codex-cli</code>, including per-stage selection. Their capability
        matrices differ: Codex reports tokens but not a native dollar cost or
        per-session dollar cap, while Claude exposes a native budget flag whose
        usefulness depends on the authentication mode.
      </p>
      <HonestRemark title="Codex execution is implemented, but live certification is limited">
        The Codex driver is covered by fixtures and fake-binary tests, and its
        isolated MCP configuration has been checked against a real CLI. The
        source still records that a complete live Valaris tool-call run has not
        been certified. Do not turn unit coverage into a production guarantee.
      </HonestRemark>

      <h2 id="event-bus-modes">The default event bus is still process-local</h2>
      <p>
        <code>EVENT_BUS_BACKEND</code> defaults to <code>memory</code>. That mode
        is appropriate for one backend process but does not distribute events
        between instances. Setting it to <code>postgres</code> enables the
        PostgreSQL <code>LISTEN/NOTIFY</code> transport and listener health
        reporting. A Redis backend is explicitly rejected because it is not
        implemented.
      </p>

      <h2 id="forge-coverage">Forge support is intentionally uneven</h2>
      <p>
        <code>forge.Provider</code> has GitHub and Gitea/Forgejo drivers. The
        Gitea driver is tested against HTTP fixtures, not a broad live matrix of
        Gitea and Forgejo releases. GitLab credentials and plain-git paths exist
        elsewhere in the platform, but there is no native Runner GitLab forge
        driver for merge requests, reviews, status rollups, or branch
        protection.
      </p>

      <h2 id="code-hygiene">The tree is not permanently spotless</h2>
      <p>
        The repository contains targeted <code>TODO</code> comments and some{" "}
        <code>as any</code> casts. Some are explicit follow-ups or narrow type
        escapes; their presence still means a claim of zero debt would be
        false. Contract tests protect selected boundaries, but they do not
        prove that every component or integration path is covered.
      </p>
    </SectionPage>
  );
}
