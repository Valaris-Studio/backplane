// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content verified against runner/cmd/backplane-runner/main.go,
// runner/internal/config/config.go, and runner/configs/runner.example.yaml.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, HonestRemark, ImportantNote } from "../callouts";

export function CoreConceptsRunners() {
  return (
    <SectionPage
      title="Runners (the credentialed process)"
      eyebrow="Core Concepts"
    >
      <p>
        A <strong>Runner</strong> is the credentialed Go process an operator
        starts on a laptop, VM, container, or Kubernetes pod. It authenticates
        with one runner API key, resolves its workspace identity, sends
        heartbeats, and asks the platform for authoritative configuration. Git,
        provider CLI, and MCP execution stay on the runner host; the Backplane
        backend coordinates state and records the audit trail.
      </p>

      <h2 id="entry-points">Executable modes</h2>
      <p>
        A bare interactive launch opens the setup wizard. Automation should
        pass <code>-config runner.yaml</code> and choose one of these explicit
        modes:
      </p>
      <ul>
        <li>
          <strong>Pipeline mode.</strong> The default when neither{" "}
          <code>-discover</code> nor <code>-loop</code> is present. It polls for
          claimable cards and executes the platform-authored pipeline.
        </li>
        <li>
          <strong>Doctor.</strong> <code>-doctor</code> performs read-only
          diagnostics and never starts an agent session or spends model budget.
          Add <code>-fix</code> only when you explicitly want supported local
          repairs.
        </li>
        <li>
          <strong>Discovery.</strong> <code>-discover</code> runs one MCP
          capability discovery pass and exits.
        </li>
        <li>
          <strong>Loop mode.</strong> <code>-loop</code> works one board
          continuously. <code>-loop-board</code> selects that board explicitly;
          otherwise the runner requires one unambiguous configured or
          platform-bound board.
        </li>
      </ul>
      <p>
        <code>-keep-alive</code> is a loop-only runtime override. When present,
        it takes precedence over <code>loop_mode.keep_alive</code> in YAML. The
        remaining operational flags include <code>-profile</code>,{" "}
        <code>-version</code>, <code>-verbose</code>, and{" "}
        <code>-no-supervisor</code>.
      </p>

      <h2 id="startup">What every working mode validates</h2>
      <ol>
        <li>Load and validate the local YAML file and environment overrides.</li>
        <li>
          Authenticate, resolve the workspace and runner identity, and start
          heartbeat reporting.
        </li>
        <li>
          Validate the selected provider CLI and the MCP configuration before
          accepting work.
        </li>
        <li>
          Fetch platform-authored pipeline or board-loop configuration for the
          selected mode. Missing or ambiguous authority is a startup error, not
          a signal to invent a local fallback.
        </li>
      </ol>

      <h2 id="config">Validated host configuration</h2>
      <p>
        The host file contains connectivity, provider, MCP, and filesystem
        concerns. Pipeline stages, prompts, and board-loop policy remain
        platform-owned. At minimum, set an API key, a workspace slug, the MCP
        config path, and a safe git base directory.
      </p>

      <CodeExample language="yaml" title="runner.yaml — required foundations">
        {`valaris:
  api_url: https://backplane.example.com
  api_key: vlr_...                 # or VALARIS_API_KEY
  workspace_slug: my-workspace     # or VALARIS_WORKSPACE

llm:
  provider: claude-cli             # claude-cli or codex-cli
  mcp_config_path: /absolute/path/to/mcp.json

git:
  base_dir: /absolute/path/to/runner-worktrees

loop_mode:
  keep_alive: false                # -keep-alive overrides this when passed`}
      </CodeExample>

      <ImportantNote title="git.base_dir must be outside every Git worktree">
        The runner resolves relative paths and <code>~</code>, converts the
        result to an absolute path, and refuses a directory nested inside an
        existing worktree. Give each runner a dedicated parent directory for
        the repositories and worktrees it creates.
      </ImportantNote>

      <p>
        <code>claude-cli</code> and <code>codex-cli</code> are built-in provider
        names. Additional providers can be declared under{" "}
        <code>extra_providers</code>, and model tiers can route work without
        hard-coding a model into every stage. Use the bundled{" "}
        <code>runner/configs/runner.example.yaml</code> as the complete field
        reference rather than copying an abbreviated example forward.
      </p>

      <HonestRemark title="The API still calls runners agents">
        The product term is <em>Runner</em>, while database models, API routes,
        and MCP tools retain the older <code>agent</code> vocabulary. For
        example, <code>/api/agents/me</code> resolves the runner identity. This
        is deliberate compatibility, not a second kind of executor.
      </HonestRemark>
    </SectionPage>
  );
}
