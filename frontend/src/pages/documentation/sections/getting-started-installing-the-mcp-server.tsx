// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ImportantNote } from "../callouts";

export function GettingStartedInstallingTheMcpServer() {
  return (
    <SectionPage
      title="Installing the MCP Server in Your Agent Client"
      eyebrow="Getting Started"
    >
      <p>
        backplane-mcp exposes Backplane operations and guided prompts to any
        MCP-aware agent host. Install it on each machine that needs platform
        access and give each client its own revocable API key.
      </p>

      <h2 id="install">Install or run the package</h2>
      <CodeExample language="bash" title="Run the published package with uvx">
        {`uvx backplane-mcp`}
      </CodeExample>
      <CodeExample language="bash" title="Install into the active virtual environment">
        {`pip install backplane-mcp`}
      </CodeExample>
      <p>
        The package exports backplane-mcp and the compatible valaris-mcp alias.
        To test a reviewed source revision, include the commit in the Git URL;
        an unqualified branch is not a pin.
      </p>
      <CodeExample language="bash" title="Run an exact source revision">
        {`uvx --from "git+https://github.com/Valaris-Studio/backplane.git@<commit>#subdirectory=mcp-server" valaris-mcp`}
      </CodeExample>

      <p>
        The package commands install the released package. An unpublished
        candidate requires its reviewed source checkout or wheel; use the exact
        candidate commit when it is accessible. A released package install does
        not validate an unpublished candidate.
      </p>
      <h2 id="configure">Configure the MCP host</h2>
      <p>
        Claude Desktop uses claude_desktop_config.json. Claude Code supports a
        project-scoped .mcp.json file and the claude mcp add command. Legacy
        user-level configuration paths are not the current repository guidance.
        Other hosts use the same command, arguments, and environment values in
        their own MCP configuration format.
      </p>
      <ul>
        <li>
          Everyday project work: default keeps the interactive catalog compact.
        </li>
        <li>
          Loops and runners: default,autonomous-operations is for an interactive
          human connection to prepare and manage loops.
        </li>
        <li>
          Everything: all is an explicit opt-in to a larger catalog that may
          exceed client tool limits.
        </li>
      </ul>
      <p>
        Presets are starting selections. Preserve custom toolset compositions
        and existing credentials. Actual autonomous runner launches use all
        intersected with their authorized allowlist; do not replace that
        execution configuration with the interactive loops preset.
      </p>
      <p>
        A local stdio MCP process can use a remote Backplane API through
        VALARIS_API_URL. The example configures that local process. For remote
        MCP HTTP, the operator sets the environment at the actual MCP service
        startup and restarts it. Client environment cannot configure a remote
        MCP service.
      </p>
      <CodeExample language="json" title="Project .mcp.json or desktop MCP block">
        {`{
  "mcpServers": {
    "valaris": {
      "command": "uvx",
      "args": ["backplane-mcp"],
      "env": {
        "VALARIS_API_URL": "https://your-backplane-host",
        "VALARIS_API_KEY": "vlr_your_key_here",
        "VALARIS_MCP_TOOLSETS": "default"
      }
    }
  }
}`}
      </CodeExample>

      <ul>
        <li>
          VALARIS_API_URL is the Backplane origin without a trailing /api. The
          client appends API paths itself. Production Compose on the same
          machine is http://localhost:8080; direct backend development is
          commonly http://localhost:8000.
        </li>
        <li>
          VALARIS_API_KEY is a personal vlr_ key sent as Authorization: Bearer
          on every request. Create it from the account menu under API Keys; the
          plaintext is shown once.
        </li>
      </ul>
      <ImportantNote title="Treat the client configuration as a secret">
        A literal API key in JSON grants the same workspace access as its
        owner. Keep the file out of git, restrict filesystem access, and rotate
        the key if it is copied into logs or shared material.
      </ImportantNote>

      <h2 id="verify">Verify the connection</h2>
      <p>
        Restart the MCP server/connection after changing startup configuration,
        then start a fresh agent session. Inspect the current native tool schema
        before calling. Run whoami to confirm identity; authentication or
        API-key activity does not verify the selected tools. get_server_info
        reports server-enabled tools, while list_changed_sent only reports
        notification delivery. Neither proves native client availability.
      </p>
      <p>
        For every preset, resolve an authorized workspace from established
        context after whoami. If unresolved, call list_workspaces and use a
        returned slug. If the choice is ambiguous, ask the user to confirm. If
        no authorized workspace exists, report that limitation and stop
        workspace checks. Never invent a slug.
      </p>
      <CodeExample language="python" title="Identity and workspace resolution">
        {`whoami()
list_workspaces()`}
      </CodeExample>
      <p>
        Everyday project work (default): call list_boards in that workspace,
        then get_project_context with an existing returned board ID. Replace the
        placeholders below with those authorized values. If no boards exist,
        report the successful empty list and skip the project-context call.
      </p>
      <CodeExample language="python" title="Everyday project read checks">
        {`list_boards(workspace_slug="your-workspace")
get_project_context(workspace_slug="your-workspace", board_id="existing-returned-board-id")`}
      </CodeExample>
      <p>
        Loops and runners: use the loop checks below with the interactive loops
        preset. Everything combines the everyday and loops checks as
        representative read checks; they do not verify every tool. Do not expect
        the default preset to expose all loop tools.
      </p>
      <CodeExample language="python" title="Loop read checks">
        {`list_loop_templates(workspace_slug="your-workspace")
list_agents()
list_executions(workspace_slug="your-workspace", limit=1)`}
      </CodeExample>
      <p>
        For loops, replace your-workspace with the selected authorized
        workspace. list_agents takes no workspace_slug and lists agents visible
        to your credentials. Empty successful lists count as callable. Inspect
        propose_skill presence without invoking it. Do not register runners,
        bind or start loops, propose skills, or mutate boards to verify setup.
      </p>
      <ul>
        <li>
          Missing tool: compare the selected toolsets with get_server_info and the
          client catalog. Check the running server version and its schema.
          Preserve VALARIS_MCP_ALLOWLIST; only an authorized operator can change a
          grant. If the server enables the tool but the client lacks it, follow
          catalog recovery.
        </li>
        <li>
          401: check or replace the API key. 403: confirm authorized workspace
          membership and permissions with the operator; widening toolsets does not
          grant access.
        </li>
        <li>
          Network error: check the API origin, connectivity and protected remote
          endpoint. Process-start failure: check uvx availability and host config
          syntax. Version or schema mismatch: use a compatible reviewed server
          artifact and repeat the read-only checks after restart.
        </li>
      </ul>
      <p><a href="../documentation/mcp-toolsets#discovery">Catalog recovery and remote operator setup</a></p>

      <h2 id="prompts">Use the exact prompt identifiers</h2>
      <p>
        The MCP server currently registers ten prompts:
      </p>
      <ul>
        <li>init_project initializes a project from a brief.</li>
        <li>standup, triage, and status summarize and organize work.</li>
        <li>
          plan_work, decompose_card, and sprint turn objectives into sequenced
          board work.
        </li>
        <li>pickup, implement, and ship guide the coding delivery loop.</li>
      </ul>
      <p>
        These underscore names are the registered MCP IDs. Use the identifier
        shown by your host rather than translating it or replacing underscores
        with dashes.
      </p>
    </SectionPage>
  );
}
