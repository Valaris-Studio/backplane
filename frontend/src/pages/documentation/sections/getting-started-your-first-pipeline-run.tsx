// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ImportantNote, ProTip } from "../callouts";

export function GettingStartedYourFirstPipelineRun() {
  return (
    <SectionPage
      title="Your First Pipeline Run (Guided Walkthrough)"
      eyebrow="Getting Started"
    >
      <p>
        This walkthrough proves a configured runner can authenticate, accept
        platform authority, claim eligible work, and report the result. The
        exact card movements, git actions, approvals, and pull-request behavior
        come from your saved lifecycle; they are not unconditional defaults.
      </p>

      <h2 id="distribution">1. Obtain the published runner</h2>
      <p>
        Version 0.8.4 is published as checksummed macOS, Linux, and Windows binaries
        for arm64 and amd64. Select the filename for your host; this example is
        macOS arm64.
      </p>
      <CodeExample language="bash" title="Download and verify the macOS arm64 binary">
        {`curl -fsSO https://storage.googleapis.com/backplane-artifacts/runner/v0.8.4/SHA256SUMS
curl -fsSO https://storage.googleapis.com/backplane-artifacts/runner/v0.8.4/backplane-runner-darwin-arm64
grep darwin-arm64 SHA256SUMS | shasum -a 256 -c -
chmod +x backplane-runner-darwin-arm64
./backplane-runner-darwin-arm64 --version`}
      </CodeExample>
      <CodeExample language="powershell" title="Download and verify the Windows amd64 binary">
        {`curl.exe -fsSO https://storage.googleapis.com/backplane-artifacts/runner/v0.8.4/SHA256SUMS
curl.exe -fsSO https://storage.googleapis.com/backplane-artifacts/runner/v0.8.4/backplane-runner-windows-amd64.exe
(Get-FileHash backplane-runner-windows-amd64.exe -Algorithm SHA256).Hash -eq (Select-String windows-amd64 SHA256SUMS).Line.Split(" ")[0].ToUpper()
.\\backplane-runner-windows-amd64.exe --version`}
      </CodeExample>
      <p>
        A public container is also available at
        ghcr.io/valaris-studio/backplane-runner:0.8.4. A container deployment
        must mount both runner YAML and MCP JSON at the paths referenced by the
        YAML; the single-mount Compose profile does not do that completely.
      </p>
      <CodeExample language="bash" title="Pull the published container image">
        {`docker pull ghcr.io/valaris-studio/backplane-runner:0.8.4`}
      </CodeExample>

      <h2 id="config">2. Prepare the exported bundle</h2>
      <p>
        Download the runner-scoped bundle from the Launch runner wizard or the
        runner detail. Keep runner-laptop-seba.yaml beside
        mcp-config-laptop-seba.json. The YAML points at its sibling and both
        use ${`{VALARIS_API_KEY}`} rather than embedding the one-time key.
      </p>
      <p>
        Confirm the chosen board, backend URL, workspace slug, work directory,
        LLM provider, and MCP path. The host also needs git, the selected
        coding-agent CLI, its authentication, and forge credentials when the
        lifecycle performs repository work.
      </p>

      <h2 id="preflight">3. Run doctor with the same config</h2>
      <CodeExample language="bash" title="Resolve the key and run the read-only preflight">
        {`read -s VALARIS_API_KEY && export VALARIS_API_KEY
./backplane-runner -doctor -config runner-laptop-seba.yaml`}
      </CodeExample>
      <p>
        Replace ./backplane-runner with the downloaded versioned filename when
        you have not renamed it. Doctor checks local tools, credential sources,
        backend reachability, runner identity and budget, MCP configuration,
        and work-directory safety without claiming a card or spending model
        budget. Fix failures before starting the loop.
      </p>

      <h2 id="authority">4. Verify platform-side prerequisites</h2>
      <ul>
        <li>
          The runner must belong to a team. An empty team role list means all
          pipeline roles; a non-empty list limits it to that subset. With no
          team binding, the platform cannot return a runnable pipeline config.
        </li>
        <li>
          The pipeline needs at least one stage, effective roles, and authored
          prompts. The runner refuses startup when the returned authority is
          incomplete.
        </li>
        <li>
          The board needs a card in the column type discovered by a stage. If
          that lifecycle performs git work, the board also needs a usable
          repository and matching forge credentials.
        </li>
      </ul>

      <h2 id="launch">5. Start the work loop</h2>
      <CodeExample language="bash" title="Launch with the exported filename">
        {`VALARIS_API_KEY=$VALARIS_API_KEY ./backplane-runner \
  -config runner-laptop-seba.yaml`}
      </CodeExample>
      <p>
        Healthy startup includes authenticated, agent identity resolved, llm
        providers ready, either single-role mode or multi-role mode, websocket
        connected, and work loop starting. The runner polls once immediately
        on startup; it does not wait for the first scheduled interval. Later
        work can wake through WebSocket events, with HTTP polling as fallback.
      </p>

      <h2 id="observe">6. Observe an eligible card</h2>
      <p>
        Create or move one well-scoped card into the first stage's discover
        column type. Watch stdout, the card detail, runner activity, execution
        history, and the Observer Panel. The Observer currently covers card,
        column, agent, execution, approval, and activity event namespaces.
      </p>
      <ImportantNote title="Eligibility and movement are lifecycle decisions">
        The backend next-assignment endpoint applies column, role, scope, and
        gate rules before a claim is returned. After execution, configured
        lifecycle actions determine commits, pushes, pull requests, and card
        movement. A successful model invocation alone does not promise any one
        of those outcomes.
      </ImportantNote>

      <h2 id="approval">7. Decide an approval only when requested</h2>
      <p>
        An approval appears only when the active lifecycle stage enables it
        and the execution requests an approval category. Review the payload in
        /&#123;slug&#125;/approvals and approve or reject it. Do not assume every
        git push or schema change automatically pauses; that policy belongs to
        the saved pipeline configuration.
      </p>

      <h2 id="finish">8. Confirm the configured end state</h2>
      <p>
        Verify the execution record, card column and status, activity events,
        and any expected branch or pull request against the lifecycle you
        saved. If those expectations differ, preserve the logs and use the
        troubleshooting page instead of manually forcing the card forward.
      </p>
      <p>
        Stop with SIGINT. The runner enters a graceful drain for up to 60
        seconds before exit. Restart it with the same explicit config and
        confirm it authenticates and returns to the work loop without
        regenerating identity or configuration.
      </p>

      <ProTip title="Keep the first run deliberately small">
        Use one reversible card and acceptance criteria you can inspect. The
        goal is to validate distribution, configuration, authority, execution,
        and evidence before entrusting a larger backlog.
      </ProTip>
    </SectionPage>
  );
}
