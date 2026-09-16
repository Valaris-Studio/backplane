# MCP Server — Source of Truth

**Scope:** `mcp-server/`
**Date:** 2026-04-19
**Audience:** Contributors writing agents, adding tools, or debugging MCP-driven workflows.

---

## 1. Purpose

The **Model Context Protocol (MCP)** is an Anthropic-led protocol that lets an LLM host
(Claude Code, Claude Desktop, Cursor, Codex CLI, custom runners) discover and call
external "tools," read "resources," and expand server-authored "prompts." Each MCP
server declares a capability surface; the host negotiates it at startup and exposes
tool handles to the model.

`mcp-server/` is Valaris's MCP surface. It wraps the backend FastAPI REST API and
exposes Valaris platform operations — workspaces, kanban boards, cards, columns,
notes, resources, activity, channels, git repos, agent/team/prompt configuration,
approvals, webhooks — as MCP tools and prompts. Callers include:

- **Claude Code / Codex running on a developer laptop** — configured via
  `claude_desktop_config.example.json` to `uvx --from git+... valaris-mcp`.
- **The Go intern coding runner** (`intern/`) — talks to Claude Code in
  subprocess mode, inheriting this MCP surface through `--allowedTools`.
- **The workflow prompts** (init_project, standup, pickup, ship, …) — bundled
  as `@mcp.prompt()` templates so runners can `/init-project` etc. and get the
  full phased workflow injected.

The server is the **single cross-LLM integration point**: whatever a platform
user or runner wants to do programmatically against Valaris, they do via an MCP
tool call routed to the FastAPI backend.

---

## 2. Tool Inventory

**Total registered tools:** every `@mcp.tool()` decorator across the `tools/` package — the full census is drift-guarded in CI by `backend/tests/test_mcp_catalog_drift.py` (read the current count from there or from `get_server_info`).

All tools share this shape: `async def tool(...kwargs, ctx: Context = None) -> str`,
decorated with `@mcp.tool()` over `@handle_api_errors`, returning
`json.dumps(result, indent=2, default=str)`. Most include an `_hint` field to
guide the LLM's next action.

### Workspaces (6) — `tools/workspaces.py`
- `list_workspaces` — all accessible workspaces.
- `get_workspace` — single workspace by slug.
- `get_workspace_summary` — aggregate counts + recent activity.
- `create_workspace` — pre-GETs to detect duplicates (see Known Bugs §7).
- `add_workspace_member`, `remove_workspace_member` — membership CRUD.

### Boards (4) — `tools/boards.py`
- `list_boards`, `get_board` (with `summary_only` flag that strips cards
  client-side — see Known Bugs §7), `create_board`, `update_board`.

### Columns (4) — `tools/columns.py`
- `create_column`, `update_column`, `delete_column`, `reorder_columns`.

### Cards (9) — `tools/cards.py`
- CRUD: `list_cards`, `get_card`, `create_card`, `update_card`, `delete_card`.
- Kanban ops: `move_card` (float position, fractional indexing),
  `add_card_participant`, `remove_card_participant`, `claim_card`.

### Bulk / Composite (4) — `tools/bulk.py`, `tools/search.py`, `tools/context.py`, `tools/health.py`
- `bulk_create_cards` — up to 50 cards in one POST to `/cards/bulk`. Essential
  for `plan_work`.
- `search_cards` — server-side filter: `q`, priority, card_type, status, label,
  `has_assignee`, `assignee_id`, `column_id`, `column_type`,
  `exclude_column_type`, `overdue`, `limit`. Hits `/cards/search`.
- `get_project_context` — one call returns definition + board summary + notes
  + git repos + recent activity. Recommended first call for any workflow.
- `get_board_health` — computed metrics: health score (0-100), stale cards,
  overdue, unassigned, distributions, velocity. Hits `/health`.

### Notes (4) — `tools/notes.py`
- `list_notes` (accepts `card_id` to scope to a card), `create_note`,
  `update_note`, `delete_note`. Dual scope: pass `board_id` for board-level,
  omit for workspace-level.

### Resources (7) — `tools/resources.py`
- `list_resources`, `get_resource`, `create_resource`, `update_resource`,
  `delete_resource`.
- GCS-backed: `get_upload_url`, `get_download_url` issue signed URLs.

### Channels (4) — `tools/channels.py`
- `list_channels`, `create_channel`, `update_channel`, `delete_channel`.
  Channel types: email, slack, whatsapp, phone, website, other.

### Git Repos (4) — `tools/git_repos.py`
- `list_git_repos`, `create_git_repo`, `update_git_repo`, `delete_git_repo`.

### Definitions (2) — `tools/definitions.py`
- `get_definition`, `update_definition` (shallow-merge update of JSON
  `content`).

### Activity (1) — `tools/activity.py`
- `list_activity` — audit feed filtered by `workspace_slug`, `board_id`,
  `entity_type`, `action`, `limit`.

### Agents / Runners (6) — `tools/agents.py`
- Lifecycle: `create_agent`, `update_agent`, `get_agent`.
- Execution logging: `log_execution_start`, `log_execution_update` (includes
  `duration_seconds` — audit item fixed, see `tools/agents.py:80`).
- Config fetch: `get_agent_config` — the Go intern equivalent of
  `/agents/me/config`, returns identity, budget, team roles, prompt configs,
  workspace config.

### Teams (7) — `tools/teams.py`
- `list_teams`, `get_team`, `create_team`, `update_team`, `deactivate_team`,
  `add_team_member`, `remove_team_member`.

### Prompt Configs (5) — `tools/prompt_configs.py`
- `list_prompt_configs`, `get_prompt_config`, `create_prompt_config`,
  `update_prompt_config`, `delete_prompt_config`.

### Approvals (3) — `tools/approvals.py`
- `request_approval` (creates approval + returns id to poll),
  `get_approval_status` (pending / approved / rejected / expired /
  auto_approved, each with targeted `_hint`),
  `decide_approval`.

### Webhooks (2) — `tools/webhooks.py`
- `create_webhook`, `list_webhooks`. No update/delete/get exposed (see Known
  Bugs §7).

### Tool category counts at a glance

| Category        | Count | File                       |
|-----------------|-------|----------------------------|
| Workspaces      | 6     | `tools/workspaces.py`      |
| Boards          | 4     | `tools/boards.py`          |
| Columns         | 4     | `tools/columns.py`         |
| Cards           | 9     | `tools/cards.py`           |
| Composite       | 4     | `tools/{bulk,search,context,health}.py` |
| Notes           | 4     | `tools/notes.py`           |
| Resources       | 7     | `tools/resources.py`       |
| Channels        | 4     | `tools/channels.py`        |
| Git Repos       | 4     | `tools/git_repos.py`       |
| Definitions     | 2     | `tools/definitions.py`     |
| Activity        | 1     | `tools/activity.py`        |
| Agents          | 6     | `tools/agents.py`          |
| Teams           | 7     | `tools/teams.py`           |
| Prompt Configs  | 5     | `tools/prompt_configs.py`  |
| Approvals       | 3     | `tools/approvals.py`       |
| Webhooks        | 2     | `tools/webhooks.py`        |
| **Total**       | **72**| 19 modules (research-time snapshot) |

_The per-category rows above are a research-time snapshot. The live census across the `tools/` package is drift-guarded in CI by `backend/tests/test_mcp_catalog_drift.py` — read the current count from there rather than from this doc._

---

## 3. Prompts

10 `@mcp.prompt()` definitions in `src/valaris_mcp/prompts.py`. Each returns a
multi-phase, fenced instruction block. Parameters are f-string-interpolated into
the prompt text. Phases follow GATHER → ANALYZE → ACT → VERIFY idioms.

| Prompt            | Agent role              | File:line                      | Parameters                                     | Purpose |
|-------------------|-------------------------|--------------------------------|------------------------------------------------|---------|
| `init_project`    | Project Initializer     | `prompts.py:12`                | `workspace_slug`, `project_brief`              | Bootstrap: UNDERSTAND → DESIGN → BUILD → VERIFY |
| `standup`         | Project Secretary       | `prompts.py:131`               | `workspace_slug`, `board_id`                   | Daily standup HTML note |
| `triage`          | Project Secretary       | `prompts.py:215`               | `workspace_slug`, `board_id`                   | Health check + proposed fixes (wait for confirm) |
| `status`          | Project Secretary       | `prompts.py:308`               | `workspace_slug`                               | Cross-board executive summary |
| `plan_work`       | Project Architect       | `prompts.py:371`               | `workspace_slug`, `board_id`, `objective`      | Decompose objective → sequenced Backlog cards |
| `decompose_card`  | Project Architect       | `prompts.py:469`               | `workspace_slug`, `board_id`, `card_id`        | Split oversized card into children |
| `sprint`          | Project Architect       | `prompts.py:546`               | `workspace_slug`, `board_id`                   | Backlog review → select → assign → pinned note |
| `pickup`          | Coding Agent            | `prompts.py:620`               | `workspace_slug`, `board_id`, `card_id=""`     | Claim card (auto-select if id empty) + brief |
| `implement`       | Coding Agent            | `prompts.py:701`               | `workspace_slug`, `board_id`, `card_id`        | PICKUP → PLAN → TDD → VERIFY → SUBMIT |
| `ship`            | Coding Agent            | `prompts.py:790`               | `workspace_slug`, `board_id`, `card_id`        | Move to Done → record → unblock → suggest next |

Key design choices:

- The **init_project** prompt's definition-content schema now matches the
  frontend `DefinitionContent` (`frontend/src/types/definition.ts`) — keys are
  `objectives, exclusions, milestones, tech_stack, stakeholders, constraints,
  decisions, references, custom_fields`. Audit finding §2 (stale keys `no_gos,
  timeline, team, acceptance_criteria`) is resolved; `test_server.py:99` pins
  the new shape.
- The **implement** prompt embeds the project's TDD rule ("Write failing tests
  first", `prompts.py:737`) inline — consistent with project CLAUDE.md.
- Prompts explicitly gate destructive actions: `standup` and `triage` both say
  *Do NOT execute Phase 4 unless the user explicitly confirms.*
- `pickup` uses a ternary in the f-string to pivot between "given card_id" and
  "auto-select highest priority unassigned To Do card" branches (`prompts.py:632`).

---

## 4. Architecture

### Runtime

- **Language:** Python ≥ 3.12 (`pyproject.toml:5`). Dev env uses Python 3.13
  managed by `uv` at `mcp-server/.venv`.
- **Framework:** `mcp[cli] >= 1.12.0` (FastMCP) from `pyproject.toml:7`.
- **Transports:** stdio by default; switchable via `MCP_TRANSPORT=streamable-http`
  (listens on `MCP_HOST:MCP_PORT`, default `0.0.0.0:8001`). See
  `server.py:139-145`.

### Module layout

```
mcp-server/
├── src/valaris_mcp/
│   ├── server.py       # FastMCP instance + lifespan + tool imports (reg by side-effect)
│   ├── client.py       # httpx.AsyncClient wrapper; auth dispatch
│   ├── config.py       # 4 env vars: API URL, email, API key, IAP audience
│   ├── errors.py       # @handle_api_errors decorator
│   ├── prompts.py      # 10 @mcp.prompt() phased templates
│   ├── resources.py    # 3 @mcp.resource() endpoints (valaris:// URIs)
│   ├── tracking.py     # ExecutionTracker: wraps tool_manager.call_tool
│   └── tools/          # every @mcp.tool() decorator, one module per domain (census drift-guarded in CI)
├── tests/              # 186 tests across 4 files
├── pyproject.toml
├── run.sh              # convenience launcher
└── claude_desktop_config.example.json
```

### Backend transport

- All tools route through `ValarisClient` (`client.py:8`). The client holds one
  `httpx.AsyncClient` with `base_url=API_BASE_URL` and auth headers. Paths are
  all under `/api`.
- Helpers: `get`, `post`, `patch`, `put`, `delete`, plus URL builders
  `ws(slug)` and `board(slug, board_id)`. Note: `get(path, **params)` takes
  params as kwargs — not a dict — which trips `list_teams` (see Known Bugs §7).

### Authentication (three-way)

`client.py:11-32` picks one of three modes at init:

1. **API key (`VALARIS_API_KEY=vlr_...`)** — sends `Authorization: Bearer vlr_...`.
   Simplest; preferred for end users; used by default in the frontend
   Platform Settings config snippet. Skips IAP and email headers.
2. **Dev mode (no API key, no IAP)** — sends both `X-User-Email` and
   `X-Goog-Authenticated-User-Email` set to `VALARIS_AGENT_EMAIL`
   (default `agent@valaris.dev`). Backend's dev-mode auth
   (`backend/app/core/auth.py`) auto-provisions this user.
3. **IAP mode (`VALARIS_IAP_AUDIENCE` set)** — uses Google ADC
   (`google.auth.default()`) and dispatches by credential type:
     - `ImpersonatedCredentials` → `IDTokenCredentials` with target_audience
     - `ServiceAccountCredentials` → `with_target_audience`
     - Otherwise → `fetch_id_token` fallback each request
   Injects `Authorization: Bearer <OIDC token>` per request. Token refresh
   happens in `_get_iap_headers` before each call.

### Error handling

`errors.py:9 handle_api_errors` catches:
- `httpx.HTTPStatusError` → `{error, status, message, error_code?}` from JSON body.
- `httpx.ConnectError` → "Cannot reach the Valaris API."
- `httpx.TimeoutException` → "Request to Valaris API timed out."
- `httpx.HTTPError` → generic transport error.
- `Exception` (catch-all, `errors.py:44`) → `"Unexpected error: {e}"`. Audit
  flagged this can mask bugs (e.g., the `list_teams` kwarg mis-pass returns a
  benign "error" to the LLM instead of crashing).

### Execution tracking

`tracking.py` wraps `server._tool_manager.call_tool` in `install_tracking` at
app lifespan start. Behaviour:

- Disabled if no API key is set (`tracking.py:38`).
- On the first tool call with a `workspace_slug`, looks up the agent by
  `api_key_prefix` (first 8 chars) via `/agents` and creates an execution
  record.
- Captures `tools_used`, `cards_affected` (extracted from card-mutating tool
  results), `tool_calls_count`, per-invocation `arguments_summary` (200 chars),
  `result_summary` (500 chars), and `duration_seconds`.
- On `finalize` (lifespan exit), PATCHes the execution with status and POSTs
  all pending tool invocations to `/executions/{id}/tool-invocations`.
- Tracking-exempt tools (`TRACKING_TOOLS` set at `tracking.py:14`):
  `log_execution_start`, `log_execution_update`, `get_agent_config`.
- Audit flagged that `_discover_agent_id` iterates `/agents` linearly;
  `/agents/me` exists and would be faster.

### Resources (MCP `resources://`)

`resources.py` registers three `@mcp.resource()` URIs:

- `valaris://workspaces`
- `valaris://workspace/{workspace_slug}/summary`
- `valaris://workspace/{workspace_slug}/board/{board_id}/definition`

Resources are thin GET wrappers; most discovery goes through tools instead.

---

## 5. Test Suite

`tests/` has **186 collected tests** across 4 files:

| File                  | Tests | Coverage |
|-----------------------|-------|----------|
| `test_server.py`      | 22    | Tool registration (spot-check of 35 tools), prompt registration (all 10), prompt-parameter embedding (one per prompt), definition schema alignment with frontend, client default config, all 5 IAP auth modes (none, impersonated SA, service account, metadata fallback, header fetch paths). |
| `test_tools.py`       | 124   | Happy-path invocation of every tool. Each test constructs a mock `ValarisClient`, calls the tool, asserts the HTTP verb + path + body, and parses the returned JSON string. Follows project naming `test_{tool}_{scenario}`. |
| `test_tracking.py`    | 33    | `ExecutionTracker` lifecycle: disabled without API key, agent discovery via prefix match, execution start/finalize, tool-invocation capture, card-id extraction for card-mutating tools, truncation of args/results, tracking-exempt tools skipped. |
| `test_errors.py`      | 7     | `handle_api_errors`: HTTPStatusError with/without JSON detail + error_code, ConnectError, TimeoutException, HTTPError, generic Exception. |

Gaps flagged by the audit:

- `test_server_loads_all_tools` only asserts a fixed subset of the registered
  tools (`test_server.py:16-55`). Approval, team, prompt_config, agent-lifecycle,
  claim_card, workspace-member, webhook, and upload/download tools aren't
  listed. Broken registration of any of those would not fail CI.
- `test_tools.py` is happy-path: mocked `ValarisClient` swallows argument
  shape, so the `list_teams` kwarg-spread bug (see §7) passes its test.

Tests run with `uv run --extra dev pytest tests/ -v`. No real HTTP or backend
is exercised.

---

## 6. Frontend MCP Config Page

### Location

- **Route:** Platform Settings (the page rendered by
  `frontend/src/pages/PlatformSettingsPage.tsx`).
- **i18n namespace:** `settings.*` (strings live in `src/i18n/locales/{en,es}.json`).

### What the page shows

Four cards in order (`PlatformSettingsPage.tsx:138-250`):

1. **MCP Server install instructions** — copy-pasteable
   `uvx backplane-mcp` (published on PyPI; git-URL form available for
   pinning to a revision) and the pip equivalent.
2. **Agent Workflows** — static grid of the 10 prompts grouped by role. Uses
   the `WORKFLOW_ROLES` array (`PlatformSettingsPage.tsx:55-88`):
     - Initializer: `/init-project`
     - Secretary: `/standup`, `/triage`, `/status`
     - Architect: `/plan-work`, `/decompose`, `/sprint`
     - Coder: `/pickup`, `/implement`, `/ship`
3. **API Keys** — list/generate/revoke (`features/settings/components/ApiKeyList`).
4. **MCP Configuration snippet** — JSON block the user drops into Claude
   Desktop / Claude Code config. Fixed shape (`PlatformSettingsPage.tsx:37-53`):
   ```json
   {
     "mcpServers": {
       "valaris": {
         "command": "uvx",
         "args": ["--from", "git+...#subdirectory=mcp-server", "valaris-mcp"],
         "env": { "VALARIS_API_URL": "...", "VALARIS_API_KEY": "vlr_..." }
       }
     }
   }
   ```

### Tool catalog (separate surface)

`frontend/src/features/agents/lib/toolCatalog.ts:39-112` hand-maintains
`VALARIS_MCP_NAMES` — a sorted alphabetical list of all tool names used by the
Pipeline Builder's `ToolPicker` (`features/agents/components/pipeline-builder/
ToolPicker.tsx`). Tool IDs get `mcp__valaris__` prefix because Claude Code
passes them via `--allowedTools`.

**A backend pytest guards drift.** `backend/tests/test_mcp_catalog_drift.py`
AST-parses every `mcp-server/src/valaris_mcp/tools/*.py` for `@mcp.tool()`
decorators and compares the set against `VALARIS_MCP_NAMES`. Any rename / add /
remove fails CI until the operator updates `toolCatalog.ts`. This is the
canonical "is the frontend in sync" check.

### Drift status (2026-04-19)

- **Install snippet:** Current. Uses `uvx`, matches `pyproject.toml` script
  entry `valaris-mcp = "valaris_mcp.server:main"`.
- **Config env vars:** Matches `config.py` (`VALARIS_API_URL`, `VALARIS_API_KEY`).
- **Workflow prompt list (settings page):** All 10 prompts present and
  accurately assigned to roles. The page uses dashed command names
  (`plan-work`, `init-project`); the MCP registers underscore names
  (`plan_work`, `init_project`). Minor: a user clicking the dashed name will
  not find a matching MCP prompt handle. If Claude Code slash-commands are
  meant to match, either update the page or add dashed aliases. Cosmetic.
- **Tool catalog (pipeline builder):** Sync-enforced by
  `test_mcp_catalog_drift.py`. Last verified with the frontend tool names
  matching the `@mcp.tool()` decorators one-to-one.
- **Summary heuristic** in `toolCatalog.ts:140-181` derives tooltips from tool
  name prefixes (list/get/create/…). No actual docstring flow. A new verb
  falls through to the `default` branch — readable but not great.
- **No UI list of prompts from the live server.** The "Workflows" card is
  hard-coded. If a prompt is added to `prompts.py` it won't appear on the page
  until someone edits `WORKFLOW_ROLES`. Consider surfacing via `mcp list-prompts`.
- **No UI list of tools** beyond the pipeline builder's internal catalog. End
  users cannot browse the full tool catalog from the Platform Settings page. Likely
  fine — discovery happens via the host's MCP inspector.

---

## 7. Known Bugs & Limitations

Softened from `~/.claude/projects/.../memory/audits/audit_mcp_and_crosscut.md`.
References use MCP source paths.

### Critical

1. **`list_teams` query-params shape** (`tools/teams.py:28-31`). The call
   `client.get(path, params={"include_inactive": "true"})` passes the dict as
   a single kwarg named `params`, so the actual HTTP query becomes
   `?params=%7B...%7D` and `include_inactive` is dropped. Other tools
   (`list_prompt_configs`, `list_resources`) spread correctly. Fix: spread the
   kwargs — same pattern the rest of the file uses. The unit test only checks
   return shape, so it passes today. Low-effort fix.

2. **`create_agent` / `create_prompt_config` agent_type docstring drift**
   (`tools/agents.py:166`, `tools/prompt_configs.py:86`). Docstrings list
   `coding | reviewer | documentator`; the backend `AgentType` enum is
   `coding | manager | reviewer | secretary | improver`. `documentator` is a
   `team_role`, not an `agent_type` — passing it will 422. Fix: update
   docstrings to the live enum.

### Major

3. **`create_workspace` violates the idempotent-mutations rule**
   (`tools/workspaces.py:82-97`). The tool does a pre-GET to detect duplicates
   and returns a custom error payload; the backend raises `ConflictError`.
   Project convention says create ops should return the existing entity on
   duplicate, not 409. Fix both layers.

4. **Webhook event docstring is stale** (`tools/webhooks.py:26`). Lists 8
   events; backend enum has 14. Missing: `approval.updated`,
   `execution.started`, `execution.completed`, `agent.status_changed`,
   `config.changed`, `cost.threshold_crossed`. Still mentions the legacy alias
   `agent.execution_completed` — backend emits `execution.completed` now.

5. **Test registration assertion is partial** (`tests/test_server.py:16-53`).
   Covers a fixed subset of the registered tools. Approval, team, prompt_config, agent
   lifecycle, claim_card, workspace-member, webhook, upload/download tools
   aren't in the assertion. Expand the expected list or dump registry
   programmatically.

6. **`log_execution_update.duration_seconds`** — audit flagged missing; now
   present at `tools/agents.py:80`. **Resolved.**

### Minor

7. **Boards `summary_only` post-processes** (`tools/boards.py:39-50`). The
   tool fetches the full board then strips cards client-side. The backend has
   no `?summary=true` query parameter. Low priority; backend-side change.
8. **`get_project_context` has no `_hint`** (`tools/context.py`). Every other
   tool does. Consistency gap.
9. **`list_notes` URL-concatenation** (`tools/notes.py:38-41`) — appends
   `?card_id=` to the path string rather than using `**params`. Works, but
   stylistically inconsistent.
10. **Missing thin CRUD symmetry**: `get_note`, `get_channel`, `get_webhook`,
    `update_webhook`, `delete_webhook` exist on the backend but have no MCP
    tool. Not blocking.
11. **`handle_api_errors` generic Exception catch** (`errors.py:44`) hides
    programmer bugs like the `list_teams` params issue from the LLM. Consider
    logging or re-raising non-HTTP exceptions in dev mode.
12. **`ExecutionTracker._discover_agent_id`** (`tracking.py:47-54`) iterates
    `/agents` to match the prefix. `/agents/me` exists on the backend and is
    O(1).
13. **Docstrings all say "UUID of …"** for `*_id` parameters. The backend
    accepts slug-or-UUID for Board, Team, GitRepo. Agents would benefit from
    knowing they can pass slugs when they have them. Non-bug; doc polish.
14. **No `TODO/FIXME/XXX/HACK` strings** in `mcp-server/src/` — clean.

---

## 8. Cross-System Schema Drift

The audit (full inventory at `audit_mcp_and_crosscut.md:127-229`) compared
Backend (FastAPI / Pydantic) ↔ Frontend (TypeScript) ↔ Intern (Go) ↔ MCP
(dict passthrough) for the main entities. MCP doesn't maintain typed models,
so it's not the source of drift but it is also the place where ambiguity
surfaces for LLMs reading fields by name.

**Key mismatches (scope: ≠ MCP, but impact MCP consumers):**

- **Board.** Backend `BoardRead` has `created_by`; frontend `Board` omits it;
  intern only carries `id, workspace_id, name` — slug/tags/timestamps absent.
  An LLM fetching a board through MCP sees the backend shape (all 9 fields);
  reconciling with frontend display is the LLM's problem.
- **Card.** Frontend `Card` omits `board_id` and `created_by`; intern omits
  `created_by`. MCP returns full backend shape — agent can rely on `board_id`
  and `created_by`.
- **Team.** Backend has `slug` optional on create/update; frontend types omit
  it; members list matches. Low-impact.
- **GitRepo.** Intern keeps only `id, name, url, default_branch` — can't move
  to slug addressing without a struct change.
- **AgentConfig.** Intern `PlatformConfig` is missing `description,
  allowed_workspaces, allowed_actions, team_name, team_roles[]`. Intern reads
  single `TeamRole` but backend now returns `team_roles` list. Multi-role
  agents will see only the first role through the intern path; MCP
  `get_agent_config` returns the full dict so MCP callers are fine.
- **PipelineConfig / WorkspaceConfig.** Backend `pipeline_config` is opaque
  `dict | None`; intern and frontend both define typed shapes. Frontend
  `WorkspaceConfig` omits `model_pricing` (backend has it) — if
  workspace-scoped pricing becomes authoritative, both clients miss it.
  Frontend `SchedulingDef` doesn't have `min_failure_backoff_seconds` that
  intern does — users can't set it from the UI.
- **Approval.** Intern carries a thin status struct (id/status/category/risk);
  backend returns full Approval with agent/board/payload/decision/timestamps.
  MCP `get_approval_status` returns the full shape.

**Event namespace drift (affects MCP webhook tool):**

- Backend emits 14 events. Frontend subscribes to `team.*` — backend emits
  nothing under that namespace (team changes come through `config.changed`).
  Dead subscription.
- `agent.heartbeat_received` is emitted but has no consumer.
- `board.health_changed` is declared in the WebhookEvent enum but never
  emitted.
- Legacy alias `agent.execution_completed` still in `WebhookEvent` (backend
  now uses `execution.completed`). MCP `create_webhook` docstring still
  mentions the old alias.

---

## 9. How to Extend

### Add a new tool

Rules from `.claude/rules/mcp-server.md` and `mcp-server/CLAUDE.md`:

1. Pick (or create) a module in `src/valaris_mcp/tools/`. Related ops group
   by entity — e.g., a new card op belongs in `cards.py`.
2. Write the function:
   ```python
   @mcp.tool()
   @handle_api_errors
   async def my_new_tool(
       workspace_slug: str,
       # … required args
       optional_arg: str | None = None,
       ctx: Context = None,
   ) -> str:
       """One-line purpose.

       A paragraph explaining when to call this. Reference related tools.

       Args:
           workspace_slug: The URL slug identifying the workspace.
           optional_arg: What it does.
       """
       app: AppContext = ctx.request_context.lifespan_context
       client = app.client
       result = await client.post(
           f"{client.ws(workspace_slug)}/my-endpoint", {"field": optional_arg}
       )
       result["_hint"] = "Suggested next action for the LLM."
       return json.dumps(result, indent=2, default=str)
   ```
3. **Parameter order matters:** `ctx: Context = None` is always last.
4. **Return:** `json.dumps(result, indent=2, default=str)` — always a string.
5. **Include `_hint`** in the response body to steer the LLM's next step. Make
   it action-oriented ("Call X next to …"), not descriptive.
6. **Register by import** in `src/valaris_mcp/server.py` (`import
   valaris_mcp.tools.my_module  # noqa: F401, E402`). The `@mcp.tool()`
   decorator registers by side effect at import time.
7. **Add test** in `tests/test_tools.py`:
   - Mock `ValarisClient` to record `(method, path, body)`.
   - Call the tool through a fake `Context`.
   - Assert HTTP verb + path + body + that the parsed JSON contains your key
     fields. Naming: `test_my_new_tool_success`.
8. **Update the frontend catalog.** Add the tool name (sorted alphabetically)
   to `frontend/src/features/agents/lib/toolCatalog.ts:39 VALARIS_MCP_NAMES`.
   `backend/tests/test_mcp_catalog_drift.py` will fail CI otherwise.

If the tool mutates cards, add it to `CARD_MUTATING_TOOLS` in `tracking.py:15`
so `cards_affected` gets populated in execution records.

### Add a new prompt

1. Append to `src/valaris_mcp/prompts.py`:
   ```python
   @mcp.prompt()
   def my_role(workspace_slug: str, board_id: str) -> str:
       """One-line description (shown in the prompt picker)."""
       return f"""\
   You are a **Role Name** agent. <purpose>.

   WORKSPACE: {workspace_slug}
   BOARD: {board_id}

   ━━━ PHASE 1 — GATHER ━━━
   <tool calls>

   ━━━ PHASE 2 — ANALYZE ━━━
   <logic>

   ━━━ PHASE 3 — ACT (only if the user confirms) ━━━
   <mutations>
   """
   ```
2. **Gate mutations behind explicit confirmation.** Every existing prompt that
   mutates data says *Do NOT execute Phase N unless the user confirms.* Follow
   suit.
3. **Use phased structure** (GATHER → ANALYZE → ACT → VERIFY or a role-specific
   variant) with the `━━━` heavy-horizontal-line separators for visual
   anchoring.
4. **Reference real tool names** from `tools/*.py`. The LLM needs exact names
   or the MCP host won't route the call.
5. **Tests** in `tests/test_server.py`:
   - Add the prompt name to the `expected_prompts` list at `test_server.py:66`
     and bump the `len(prompts) == N` assertion.
   - Add a `test_prompt_my_role_embeds_parameters` test that asserts the
     returned string includes the workspace_slug / board_id arguments and a
     few critical tool names / phase headers.
6. **Surface it in the UI** (optional). Add an entry to the
   `WORKFLOW_ROLES` array in
   `frontend/src/pages/PlatformSettingsPage.tsx:55-88` so it shows on the
   Platform Settings card. Add `i18n` strings in
   `frontend/src/i18n/locales/{en,es}.json` under `settings.workflows.<key>`.

No registry file to edit — `@mcp.prompt()` auto-registers on module import, and
`prompts.py` is already imported by `server.py:135`.

---

## 10. Quick Reference

| Thing                        | Where                                                     |
|------------------------------|-----------------------------------------------------------|
| FastMCP entry                | `src/valaris_mcp/server.py:49`                            |
| Tool registration            | `src/valaris_mcp/server.py:115-135` (import side-effects) |
| Transport switch             | `src/valaris_mcp/server.py:138-145` (`MCP_TRANSPORT` env) |
| HTTP client                  | `src/valaris_mcp/client.py:8 ValarisClient`               |
| Auth dispatch                | `src/valaris_mcp/client.py:11-32`                         |
| IAP token refresh            | `src/valaris_mcp/client.py:56-65`                         |
| Env vars                     | `src/valaris_mcp/config.py`                               |
| Error envelope               | `src/valaris_mcp/errors.py:9 handle_api_errors`           |
| Execution tracking           | `src/valaris_mcp/tracking.py`                             |
| Prompts                      | `src/valaris_mcp/prompts.py` (10 prompts)                 |
| Resources                    | `src/valaris_mcp/resources.py` (3 URIs)                   |
| Tools                        | `src/valaris_mcp/tools/*.py` (one module per domain)      |
| Tests                        | `tests/*.py` (186 tests)                                  |
| Frontend catalog             | `frontend/src/features/agents/lib/toolCatalog.ts`         |
| Frontend config page         | `frontend/src/pages/PlatformSettingsPage.tsx`             |
| Drift guard (frontend ↔ MCP) | `backend/tests/test_mcp_catalog_drift.py`                 |
| Run locally                  | `uv run valaris-mcp` (or `./run.sh`)                      |
| Run tests                    | `uv run --extra dev pytest tests/ -v`                     |

