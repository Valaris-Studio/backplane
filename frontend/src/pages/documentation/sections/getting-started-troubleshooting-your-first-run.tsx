// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ImportantNote } from "../callouts";

export function GettingStartedTroubleshootingYourFirstRun() {
  return (
    <SectionPage
      title="Troubleshooting Your First Run"
      eyebrow="Getting Started"
    >
      <p>
        Diagnose from evidence in the runner terminal, backend logs, execution
        history, and activity feed. Avoid moving a card manually until you know
        whether it was never eligible, never claimed, or failed after claim.
      </p>

      <ImportantNote title="Run doctor against the exported config first">
        The generated runner filename is not auto-discovered. Use the same
        environment and explicit file that the work loop will use.
      </ImportantNote>
      <CodeExample language="bash" title="Read-only first-run preflight">
        {`read -s VALARIS_API_KEY && export VALARIS_API_KEY
./backplane-runner -doctor -config runner-laptop-seba.yaml`}
      </CodeExample>

      <h2 id="startup-authority">The runner refuses platform authority</h2>
      <p>
        A startup error about a missing pipeline config, stages, or roles means
        the backend did not return executable authority. Confirm the runner is
        bound to a workspace team, the pipeline is saved and non-empty, and at
        least one effective role remains. With no team binding the runner does
        not receive a pipeline; an empty role list on an existing membership
        means all pipeline roles.
      </p>

      <h2 id="scope">The configured workspace or board is rejected</h2>
      <p>
        A runner cannot quietly claim outside its allowed workspace. If the
        exported workspace or board no longer matches its server-side scope,
        authentication or configuration validation reports the mismatch.
        Re-export for the intended board or correct the runner scope in the UI;
        do not reuse a bundle from another workspace.
      </p>

      <h2 id="unclaimed">Cards remain unclaimed</h2>
      <ul>
        <li>
          Compare the card's column type, not its visible column name, with the
          stage discover column type.
        </li>
        <li>
          Confirm the runner's effective team roles include the stage role. A
          non-empty membership list is a restriction; an empty list grants all
          pipeline roles.
        </li>
        <li>
          Check budget, dependencies, gates, existing claims, and any board or
          repository requirements reported by next-assignment.
        </li>
        <li>
          Inspect health_config_errors. When an effective role has no required
          prompt, platform-authority validation drops that role before claims;
          the card remains unclaimed rather than entering an awaiting-prompt
          state.
        </li>
      </ul>
      <p>
        The backend appends missing lifecycle roles to scheduling priority
        during validation, so manually editing priority order is not the normal
        fix for a newly added role. Repair the reported pipeline or role error
        instead.
      </p>

      <h2 id="coding-agent">The coding-agent process exits</h2>
      <p>
        Verify the provider selected by the runner config. claude-cli requires
        the Claude CLI and its login or configured token; codex-cli requires
        the Codex CLI and its own authentication. The runner intentionally
        removes an inherited ANTHROPIC_API_KEY before launching Claude when its
        provider contract selects subscription or explicit configured auth, so
        a random parent-shell key is not a reliable fallback.
      </p>
      <p>
        Loop launch verifies the selected MCP configuration and required completion tools before model invocation. Local provider diagnostics report the executable, installation and version, and check recognized runtime dependencies. These diagnostics do not verify account or model access. Use the complete provider installation when a bundled inspection companion is missing. The TUI confirms providers required by the board independently from the source-model override and saves them with the selected profile.
      </p>

      <h2 id="claimed-failure">A claimed card stops progressing</h2>
      <p>
        Open its execution record before changing the column. Look for model
        exit status, timeout, approval state, git clone or forge errors, budget
        rejection, and the lifecycle action that was expected to move the
        card. Missing prompt configuration is normally caught before claim, so
        do not diagnose every stalled card as a prompt gap.
      </p>

      <h2 id="events">Events are delayed</h2>
      <p>
        If the WebSocket cannot connect through a firewall or proxy, the runner
        can continue with HTTP polling at its configured interval. Startup also
        polls once immediately. Persistent delay after a healthy connection
        needs timestamps from stdout and the activity feed, not an assumption
        that the first interval has not elapsed.
      </p>

      <h2 id="evidence">Collect a useful failure report</h2>
      <p>
        Record the runner version, config filename, workspace and board IDs,
        failing stage and role, doctor result, relevant sanitized runner and
        backend log lines, execution ID, and timestamps. Never include the
        vlr_ key, provider tokens, cookies, or full secret-bearing config.
      </p>
      <p>
        The Observer Panel and /&#123;slug&#125;/history provide the event trail.
        Continue with Debugging a Stuck Card under Operating the Platform when
        the first-run checks pass but the execution still diverges from the
        saved lifecycle.
      </p>
    </SectionPage>
  );
}
