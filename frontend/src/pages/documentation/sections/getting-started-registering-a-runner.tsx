// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, DangerZone, ImportantNote, ProTip } from "../callouts";

export function GettingStartedRegisteringARunner() {
  return (
    <SectionPage title="Registering a Runner" eyebrow="Getting Started">
      <p>
        A runner is the credentialed process that claims and executes eligible
        cards. The Launch runner wizard creates its identity and key, binds
        pipeline roles, exports configuration, and explains how to start the
        binary on your own machine.
      </p>

      <h2 id="open">Open the four-step wizard</h2>
      <p>
        In /&#123;slug&#125;/runner, open the Runners tab and choose Create
        runner. The progress strip is Identity, Roles, Config, and Launch. The
        Config step requires at least one board in the workspace because the
        exported MCP scope and runner settings are board-aware.
      </p>

      <h2 id="identity">Identity and one-time key</h2>
      <p>
        Enter a name and optional description. The runner is created in the
        current workspace. Creation returns a vlr_ API key once; Backplane
        stores its hash rather than recoverable plaintext.
      </p>
      <DangerZone title="Copy the API key before leaving the step">
        If the plaintext is lost, rotate the runner key. Rotation preserves the
        runner identity, role bindings, budget, and execution history, but the
        previous key stops working immediately.
      </DangerZone>

      <h2 id="roles">Bind only the roles this process may execute</h2>
      <p>
        Choose from roles declared by the workspace pipeline. The wizard adds
        the runner through team membership and can create the Default runners
        team when needed. Skipping roles is allowed for configuration work, but
        a runner without an effective pipeline role cannot claim a stage.
      </p>
      <ImportantNote title="Role bindings remain editable">
        Change roles later from the runner detail and team controls. A binding
        authorizes a role; it does not repair a missing pipeline, prompt, board
        repository, or coding-agent prerequisite.
      </ImportantNote>

      <h2 id="config">Download the board-aware configuration</h2>
      <p>
        Select a board when the workspace has several. The agent-scoped Config
        bundle contains runner-&#123;name&#125;.yaml and
        mcp-config-&#123;name&#125;.json, with paths already pointing at each
        other. The separate mcp-config.json download is board-scoped for agent
        clients that do not need the runner YAML.
      </p>
      <p>
        The bundle does not embed the raw API key. Both generated files use the
        ${`{VALARIS_API_KEY}`} placeholder, so the process must receive that
        environment variable at launch. The bundle is safer to store than a
        plaintext key, but it still reveals internal URLs and scope and should
        not be published casually.
      </p>

      <h2 id="launch">Use the exported filename explicitly</h2>
      <p>
        Bare interactive startup discovers runner.yaml and mcp-config.json in
        its supported locations. It does not auto-discover the exported
        runner-&#123;name&#125;.yaml filename. Use -config for the downloaded
        bundle, from the directory that contains both exported files.
      </p>
      <CodeExample language="bash" title="Launch the downloaded bundle">
        {`read -s VALARIS_API_KEY && export VALARIS_API_KEY
VALARIS_API_KEY=$VALARIS_API_KEY ./backplane-runner \
  -config runner-laptop-seba.yaml`}
      </CodeExample>
      <p>
        On success, the runner authenticates, resolves its identity, downloads
        the platform pipeline, connects its event channel, and starts the work
        loop. The Runners tab should then report it connected.
      </p>

      <h2 id="rotate">Rotate and re-download together</h2>
      <p>
        Rotate API Key from the runner detail when a key is lost or exposed.
        Copy the new value once, re-download the updated bundle, update every
        host that used the old key, and restart those processes with the new
        key. Test the new key before removing your secure recovery notes.
      </p>

      <ProTip title="Run doctor before the first work loop">
        The next page uses -doctor with the explicit config filename. That
        read-only preflight catches missing CLIs, credentials, MCP config,
        repository access, scope, and backend connectivity before a card is
        claimed.
      </ProTip>
    </SectionPage>
  );
}
