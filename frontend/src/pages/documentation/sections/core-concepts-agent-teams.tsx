// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §2.4 and
// docs/research/runner-pipeline-internals.md §2.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, HonestRemark } from "../callouts";

export function CoreConceptsAgentTeams() {
  return (
    <SectionPage title="Agent Teams" eyebrow="Core Concepts">
      <p>
        An <strong>agent team</strong> is the membership graph that pairs
        runners with roles inside a workspace. A runner on its own is just a
        credential. A role on its own is just a string in a pipeline config.
        The team is the thing that says "this runner plays these roles on this
        board." Without it, the runner has no mandate to pick up work.
      </p>

      <h2 id="shape">Shape</h2>
      <p>
        A team lives in a workspace and is optionally scoped to a single
        board. It has a slug (unique within the workspace), an{" "}
        <code>is_active</code> flag, and zero or more <strong>members</strong>.
        Each member is a <code>(team, runner)</code> pair carrying a list of
        role strings — the pipeline personas this runner is authorized to
        execute for this team.
      </p>
      <p>
        Team slugs are unique per workspace and creation is idempotent: a
        repeat create returns the existing team instead of a 409. Adding a
        member is idempotent too — if the runner is already on the team, its
        role list is overwritten, not conflicted.
      </p>

      <h2 id="unique-roles">Unique roles</h2>
      <p>
        A role declared <code>unique: true</code> in <code>pipeline_config</code>{" "}
        may only be staffed by one member on a team. The three legacy roles —{" "}
        <code>orchestrator</code>, <code>reviewer</code>,{" "}
        <code>documentator</code> — are grandfathered into uniqueness by the
        backend canonicalization pass. Custom roles default to non-unique unless
        the operator sets the flag. This prevents two runners racing to claim
        the same card under the same role; it does not prevent two runners
        playing different roles on the same card.
      </p>

      <h2 id="creating-a-team">Creating a team over MCP</h2>
      <p>
        Most operators create teams through the Teams section of the Runners tab,
        but MCP is the cleaner path when scripting a bootstrap. The call is
        idempotent on <code>(workspace_slug, slug)</code>, so a repeat returns
        the existing team.
      </p>

      <CodeExample language="typescript" title="Create a team, then add a runner to it">
        {`// Via MCP from an LLM host (Claude Code, Cursor, custom runner).
const team = await mcp.call("create_agent_team", {
  workspace_slug: "backplane",
  slug: "platform-team",
  name: "Platform Team",
  board_id: null,                   // workspace-scoped, not board-scoped
});

await mcp.call("add_agent_team_member", {
  team_id: team.id,
  agent_id: "agt_01H...",
  roles: ["orchestrator", "reviewer"],
});`}
      </CodeExample>

      <h2 id="runner-vs-team">Runner vs team</h2>
      <p>
        A runner is a credential and a process identity; it exists
        workspace-independently at the platform level (with an{" "}
        <code>allowed_workspaces</code> list gating where it may work). A team
        is per-workspace and scopes which roles that runner is allowed to
        play there. The runner's effective roles on a given workspace come
        from the intersection of team membership and the pipeline's stage
        roles — so adding a role to <code>pipeline_config.stages[]</code> does
        nothing until a team member carries that role string.
      </p>

      <HonestRemark title="Multi-team runners exist in the schema, not in the UI">
        The data model supports one runner belonging to multiple teams. The
        backend helper <code>get_agent_team_info</code> returns the{" "}
        <em>first</em> active team an agent is in, and the UI treats the
        relationship as 1:1. A runner that's a member of two teams will only
        ever pick up work from the first one today. The simplification will
        lift when multi-team runners become a real use case. Don't plan
        around it until it does.
      </HonestRemark>

      <h2 id="team-vs-participant">Team membership vs card participant</h2>
      <p>
        These sound similar and are not the same. <strong>Team membership</strong>{" "}
        is a long-lived authorization — "this runner may play role X here."{" "}
        <strong>Participant</strong> is per-card — "this runner is the hero on
        card 42." Runners claim cards by adding themselves as a hero
        participant at execution time; team membership is what let them even
        consider claiming.
      </p>
    </SectionPage>
  );
}
