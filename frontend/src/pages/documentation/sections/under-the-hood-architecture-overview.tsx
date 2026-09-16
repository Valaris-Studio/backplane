// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §3 and
// docs/research/backend-architecture.md §1.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ProTip } from "../callouts";

export function UnderTheHoodArchitectureOverview() {
  return (
    <SectionPage title="Architecture Overview" eyebrow="Under the Hood">
      <p>
        Four cooperating surfaces, one monorepo. The backend is the system of
        record. The frontend is the operator's cockpit. The MCP server is the
        cross-LLM integration point. The runner is the credentialed process
        that actually executes LLM work against a card. Every piece of the
        platform falls into one of those four surfaces, and they all live in
        the same git tree so cross-surface refactors happen in one PR with one
        CI run.
      </p>

      <h2 id="the-four-surfaces">The four surfaces</h2>
      <p>
        Read this diagram left-to-right. A human operator clicks the frontend;
        the frontend talks to the backend over REST and WebSockets; a runner
        running on an operator's laptop talks to the same backend with the
        same protocols; the LLM the runner spawns reaches back to the backend
        through the MCP server. Nothing is circular.
      </p>

      <CodeExample language="text" title="Data flow across the four surfaces">
        {`┌──────────────────────────────────────────────────────────────────────┐
│                       Backplane Backend (FastAPI)                    │
│    Router → Service → Repository → Model   |   Postgres 16           │
│ EventBus (memory | postgres LISTEN/NOTIFY) → WS + local subscribers  │
└───────▲────────────────────▲────────────────────▲────────────────────┘
        │ REST + WS          │ REST + WS          │ REST (MCP proxy)
        │                    │                    │
┌───────┴────────┐  ┌────────┴────────┐  ┌────────┴───────────┐
│  Frontend      │  │  Runner (Go)    │  │  MCP Server (py)   │
│  React 19      │  │  runner binary  │  │ FastMCP stdio/HTTP │
│  React Query   │  │ coding-agent CLI│◄─┤  MCP tools ·       │
│  dnd-kit · WS  │  │  git.Manager    │  │  prompts           │
└────────────────┘  └─────────────────┘  └────────────────────┘
                            │                     ▲
                            │ spawns per stage    │
                            └─────────────────────┘`}
      </CodeExample>
      <p>
        <code>EVENT_BUS_BACKEND</code> selects <code>memory</code> for local
        in-process delivery or <code>postgres</code> for cross-instance fan-out
        over Postgres LISTEN/NOTIFY. Both adapters feed the same local
        subscribers; neither is a durable queue or replay log.
      </p>

      <h2 id="backend-pattern">Backend pattern: Router → Service → Repository → Model</h2>
      <p>
        Most feature endpoints flow through the same four layers. The router
        parses the request and
        wires dependencies (workspace resolution, auth). The service owns
        business logic, authorization beyond membership, idempotency, activity
        recording, and event publishing. The repository is pure data access
        over a generic <code>BaseRepository</code>. The model is SQLAlchemy
        2.x with UUID primary keys and timestamp mixins.
      </p>
      <p>
        A routine card create is a five-step trace: route handler hits{" "}
        <code>get_workspace</code> for membership, calls{" "}
        <code>CardService.create_card</code>, which computes a fractional
        position and calls <code>CardRepository.create</code>, which inserts,
        flushes, and re-fetches with <code>selectinload</code> so the response
        includes participants. The session auto-commits on the way out. The
        same pattern holds across the domain routers. Cross-cutting adapters do
        have explicit exceptions: the WebSocket router resolves users and
        workspaces during its handshake, and the workspace-config router checks
        repository linkage while exporting a runner config.
      </p>

      <h2 id="error-envelope">One error envelope</h2>
      <p>
        Every error the API returns — domain errors, plain HTTP errors, and
        request validation — carries the same four-key body, so a client
        parses one shape and branches on <code>error_code</code> rather than
        on prose. <code>detail</code> is the human-readable message,{" "}
        <code>error_code</code> is a stable machine string (
        <code>not_found</code>, <code>forbidden</code>,{" "}
        <code>board_frozen</code>, <code>stale_version</code>, ...),{" "}
        <code>error_params</code> holds structured parameters for rendering
        the message, and <code>context</code> carries machine-readable extras
        when the code alone is not enough — or <code>null</code>.
      </p>
      <CodeExample language="json" title="The envelope, on a stale config write">
        {`{
  "detail": "Config version mismatch: expected 3, current 5",
  "error_code": "stale_version",
  "error_params": {},
  "context": { "current_version": 5, "expected_version": 3 }
}`}
      </CodeExample>
      <p>
        Validation failures return 422 with{" "}
        <code>error_code: "request_validation_error"</code> and an{" "}
        <code>error_params.issues</code> array of{" "}
        <code>&#123;field, code, params&#125;</code> objects, one per invalid
        field. Errors raised outside the domain hierarchy are mapped onto the
        same envelope from the HTTP status, so the shape holds even for
        framework-level failures. Message prose can change between releases;
        the codes are the contract.
      </p>

      <h2 id="frontend-layout">Frontend: feature modules, no orphans</h2>
      <p>
        The React app lives in <code>frontend/src/</code>, with domain code
        colocated under <code>features/&#123;name&#125;/</code>. A feature adds{" "}
        <code>api/</code>, <code>components/</code>, <code>hooks/</code>, and{" "}
        <code>utils/</code> only as needed rather than carrying an empty fixed
        scaffold. Twenty-three modules exist today —{" "}
        <code>agents</code> is the largest because it owns the pipeline
        builder and runner overview; <code>kanban</code> is next because it
        owns the board + drag-and-drop + card detail sheet.
      </p>
      <p>
        There is no Redux. There is no Zustand for server state. React Query
        v5 is the uniform substrate. Shared domain query-key factories live in{" "}
        <code>src/lib/query-keys.ts</code>; a few composed inbox and local file
        preview keys stay beside their callers. The AppShell renders the
        sidebar, topbar, outlet,
        and the floating ObserverPanel; workspace routing lives in a single{" "}
        <code>App.tsx</code>.
      </p>

      <h2 id="mcp-as-integration-point">MCP: the cross-LLM integration point</h2>
      <p>
        The Model Context Protocol is an Anthropic-led protocol that lets an
        LLM host — Claude Code, Claude Desktop, Cursor, Codex CLI, a custom
        Go runner — discover and call external tools over a negotiated
        capability surface. The Backplane MCP server wraps the backend REST API
        and exposes platform operations as MCP tools. Whatever an agent wants
        to do programmatically against Backplane — list cards, claim one, move
        it, create a note, request approval — it does via one of the MCP
        tools (the full tool census, drift-guarded in CI).
      </p>
      <p>
        Interactive hosts such as Claude Code and Codex, plus coding-agent
        sessions spawned by the Go runner, call the MCP server. Registered
        workflow prompts use their exact underscore handles, including{" "}
        <code>init_project</code>, <code>standup</code>, and <code>pickup</code>.
        Tools proxy authenticated backend operations; prompts and resources add
        server-authored context without moving platform authority out of the
        backend.
      </p>

      <h2 id="runner-as-credentialed-process">Runner: the credentialed process</h2>
      <p>
        The Go runner at <code>runner/cmd/backplane-runner/main.go</code> is a single
        static binary that an operator launches on their own hardware. Each
        process normally starts from one registered agent's config and bearer
        key. On startup it
        authenticates against the backend with{" "}
        <code>Authorization: Bearer vlr_...</code>, fetches its platform
        pipeline config, optionally opens a workspace WebSocket, and enters a
        work loop that ticks every two minutes by default or wakes on matching
        WS events. Each stage may spawn the selected coding-agent driver —{" "}
        <code>claude-cli</code> or <code>codex-cli</code>, including per-stage or
        tier routing — with a rendered prompt, the MCP tool allowlist, and the
        workspace context.
      </p>
      <p>
        The runner owns git directly: <code>git.Manager</code> handles clone,
        checkout, commit, and push, while the configured GitHub or Gitea forge
        adapter handles pull requests and merge behavior. The coding agent edits
        files; the runner is the component responsible for the branch lifecycle.
      </p>

      <h2 id="monorepo-layout">One monorepo, ecosystem-specific locks</h2>
      <p>
        All four surfaces live in the same tree. The root and frontend keep
        separate pnpm lockfiles; Go modules own their own dependencies; Python
        for the backend and the MCP server is managed via <code>uv</code>. One place to{" "}
        <code>git clone</code>. One place to diff across a schema change.
      </p>

      <CodeExample language="text" title="Monorepo layout (top two levels)">
        {`valaris/internal/
├── backend/          FastAPI app, Alembic migrations, tests
│   ├── app/
│   │   ├── routers/       # thin HTTP adapters
│   │   ├── services/      # business logic, event publishing
│   │   ├── repositories/  # data access, selectinload eager-loading
│   │   ├── models/        # SQLAlchemy 2.x declarative
│   │   └── core/          # auth, workspace dep, event bus
│   └── alembic/versions/  # 001..093 sequential migrations
├── frontend/         React 19 + Vite + Tailwind v4
│   └── src/
│       ├── features/      # 23 domain modules, colocated as needed
│       ├── pages/         # route-level composition
│       ├── components/ui/ # hand-written shadcn/ui
│       ├── providers/     # WebSocketProvider, QueryClientProvider
│       └── lib/           # api client, query keys, websocket service
├── runner/           Go runner (single binary)
│   ├── cmd/backplane-runner/        # main.go
│   └── internal/
│       ├── workloop/      # Loop, scheduler, strategies
│       ├── valaris/       # REST + WS client
│       ├── git/           # gh-aware git.Manager
│       └── llm/           # claude CLI subprocess + stream-json
├── mcp-server/       Python MCP server (FastMCP)
│   └── src/valaris_mcp/
│       ├── tools/         # @mcp.tool() modules, drift-guarded in CI
│       ├── prompts.py     # 10 workflow prompts
│       └── resources.py   # 3 URI resources
└── infra/            setup.sh, cloudbuild.yaml, Terraform (future)`}
      </CodeExample>

      <ProTip title="Cross-surface refactors ship in one PR">
        A rename that touches a Pydantic schema, a TypeScript interface, a Go
        struct, and an MCP tool signature is one commit with one CI run
        because the four surfaces share a tree. The drift guard in{" "}
        <code>backend/tests/test_mcp_catalog_drift.py</code> AST-parses tool and
        prompt decorators plus resource URIs, then fails CI when the frontend
        catalog disagrees. The frontend signature-parity test additionally
        checks every tool and prompt parameter in declaration order with exact
        requiredness. The first time you add a parameter and CI flags the
        reference before you remembered to update it, the monorepo pays for
        itself.
      </ProTip>

      <p>
        The rest of this group walks through the patterns that tie these four
        surfaces together: the event bus and WebSocket model, fractional
        indexing, idempotency, platform authority, and the model-agnostic
        future. None of them are incidental — they're the reason a retry-happy
        LLM operator doesn't set the platform on fire.
      </p>
    </SectionPage>
  );
}
