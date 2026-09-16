// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProTip } from "../callouts";
import { SectionPage } from "../shell/SectionPage";

export function HonestRemarksWhatWorksWell() {
  return (
    <SectionPage title="What Works Well" eyebrow="Honest Remarks">
      <p>
        Backplane's strongest parts are the boundaries that the repository can
        verify. The backend, frontend, MCP server, and Go Runner live together,
        and focused contract tests pin the payloads and names they share. That
        does not make every boundary automatic, but it turns important drift
        into a test failure instead of an operator surprise.
      </p>

      <h2 id="backend-authority">The platform owns execution shape</h2>
      <p>
        The Runner fetches <code>pipeline_config</code> from the backend and
        executes the stages that the platform resolved. A registration can
        carry multiple <code>team_roles</code>, and assignment responses can
        select a provider and model for the current stage. Pipeline behavior
        therefore changes through platform configuration rather than a
        hardcoded role list in the Runner binary.
      </p>

      <h2 id="dependency-graph">Dependencies are an end-to-end feature</h2>
      <p>
        The <code>card_dependencies</code> relation is backed by database
        constraints, cycle validation, scheduler filtering, board and card
        APIs, frontend management surfaces, and MCP tools. A planner can build
        a dependency graph and a Runner can avoid work whose prerequisites are
        not complete without encoding the graph in prose.
      </p>

      <h2 id="provider-seams">Provider seams execute real implementations</h2>
      <p>
        The coding-agent seam has working <code>claude-cli</code> and{" "}
        <code>codex-cli</code> implementations. The forge seam exposes{" "}
        <code>forge.Provider</code> and ships GitHub and Gitea/Forgejo drivers.
        The registries reject unknown provider names instead of silently
        falling back to a different implementation.
      </p>

      <h2 id="event-delivery">Event delivery has a scale-aware backend</h2>
      <p>
        The event API keeps one subscriber contract while{" "}
        <code>EVENT_BUS_BACKEND</code> selects an in-process memory bus or a{" "}
        <code>postgres</code> implementation based on PostgreSQL{" "}
        <code>LISTEN/NOTIFY</code>. The health endpoint reports the selected
        backend and listener state, so cross-instance delivery is observable
        when it is enabled.
      </p>

      <ProTip title="The useful discipline is enforced, not aspirational">
        Contract tests cover high-risk seams such as MCP signatures, lifecycle
        kinds, dependency events, localized technical tokens, and Runner wire
        shapes. The repository still contains ordinary maintenance debt; the
        strength is that critical invariants have executable checks.
      </ProTip>
    </SectionPage>
  );
}
