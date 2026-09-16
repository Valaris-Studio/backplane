# MCP Allowlist Enforcement — Design (2026-05-18)

Ship Option D from `03-llm-to-lifecycle-contract-investigation.md` §3+§7:
**server-side per-execution MCP tool allowlist enforcement**.

Mechanism is locked (Option A — dynamic `--mcp-config` per launch). This
doc converts the locked decision into a concrete code-shape map. No code
is written here.

---

## Locked decisions (do not re-litigate)

- **Mechanism:** dynamic `--mcp-config` JSON regenerated per `claude -p`
  launch. Allowlist embedded via env var on the MCP server process spawned
  by that config. Process is short-lived (one claude-cli invocation).
- **Empty `tools: []` = no restriction** (preserves current Go semantics).
- **Missing/absent allowlist = no restriction** (back-compat for this
  Claude Code session, MCP Inspector, kanban UI direct usage).
- **Every tool gated equally** — no read-only bypass.

---

## Section 1 — Current state

### 1.1 The runner-side collision: allowlist is advisory

`intern/internal/llm/claude_cli.go:189-197`:

```go
if opts.DangerouslySkipPermissions {
    args = append(args, "--dangerously-skip-permissions")
} else if opts.PermissionMode != "" {
    args = append(args, "--permission-mode", opts.PermissionMode)
}

for _, tool := range opts.AllowedTools {
    args = append(args, "--allowedTools", tool)
}
```

Every shipped runner config sets `dangerously_skip_permissions: true`
(investigation §3.2 enumerated 7 yaml configs). This flag bypasses the
CLI's allowlist filter — `--allowedTools` becomes advisory. Investigation
§3.4 confirmed by smoke: planner LLM called `create_card` despite it
being absent from the planner's `tools` list.

### 1.2 Where the MCP config path comes from today

`claude_cli.go:169-171`:

```go
if opts.MCPConfigPath != "" {
    args = append(args, "--mcp-config", opts.MCPConfigPath, "--strict-mcp-config")
}
```

`opts.MCPConfigPath` is populated from `l.cfg.LLM.MCPConfigPath`
(`intern/internal/workloop/loop.go:1037`), sourced from the runner yaml.
A static path like `intern/configs/mcp-config-prod.json` is reused across
every `claude -p` launch.

### 1.3 MCP config shape (current static file)

`intern/configs/mcp-config-prod.json`:

```json
{
  "mcpServers": {
    "valaris": {
      "command": "bash",
      "args": ["/path/to/backplane/mcp-server/run.sh"],
      "env": {
        "VALARIS_API_URL": "...",
        "VALARIS_API_KEY": "vlr_...",
        "VALARIS_AGENT_EMAIL": "intern@valaris.dev"
      }
    }
  }
}
```

`mcp-server/run.sh`:

```bash
cd "$(dirname "$0")" && exec uv run valaris-mcp
```

The MCP server process is forked by claude-cli per launch (stdio
transport, lifetime = one claude invocation).

### 1.4 Current FastMCP setup (server.py:20-46)

`install_tracking` already monkey-patches `_tool_manager.call_tool` to
intercept every tool call (used by `ExecutionTracker`). This is the only
pre-existing seam; FastMCP exposes no public middleware/hook API in the
version pinned here. The monkey-patch shape is the precedent.

### 1.5 Where AllowedTools is assembled

`intern/internal/workloop/loop.go:1041` reads
`l.strategy.AllowedTools()` (sourced from `pipeline_config.stages[].llm.tools`
via `DataDrivenStrategy.AllowedTools`) and stuffs it into
`llm.Options.AllowedTools`.

### 1.6 Tool inventory

80 `@mcp.tool()` decorations across 22 modules in
`mcp-server/src/valaris_mcp/tools/`. Categories: workspaces, boards,
columns, cards, notes, resources, channels, definitions, git_repos,
activity, search, health, bulk, agents, assignments, approvals, teams,
prompt_configs, webhooks, merge_queue, context, workspace_config. Every
tool is gated equally; no read-only / write-only partition is needed.

---

## Section 2 — Runner-side: dynamic `--mcp-config` generation

### 2.1 Where to hook

Two options for the hook site:

- **Option α — inside `ClaudeCLI.Execute`** (claude_cli.go:73). Build the
  per-call config file right before `exec.CommandContext`, defer-cleanup
  after `cmd.Run`. Has direct access to `opts.AllowedTools` and
  `opts.MCPConfigPath`. **Recommended** — lifetime trivially matches the
  subprocess lifetime.
- **Option β — `Loop.llmOpts`** (loop.go:1035). Build the file there,
  mutate `MCPConfigPath` to point at it, schedule cleanup separately.
  More plumbing, no upside.

**Pick α.** Cleanup is `defer os.Remove(path)` immediately after the
`os.CreateTemp` call; the deferred remove fires whether the LLM exits
clean, crashes, or the context is cancelled.

### 2.2 Conditional generation (back-compat preserved)

```go
// claude_cli.go — pseudo, around line 167, before the existing
// MCPConfigPath branch:
mcpPath := opts.MCPConfigPath
// Since toolsets (2026-09-03) the dynamic config is written whenever a
// template is configured — an EMPTY grant pins VALARIS_MCP_TOOLSETS=all and
// omits the allowlist key (full surface); see the second addendum below.
if mcpPath != "" {
    tmpPath, cleanup, err := writeDynamicMCPConfig(mcpPath, opts.AllowedTools)
    if err != nil {
        return nil, fmt.Errorf("mcp-config materialize: %w", err)
    }
    defer cleanup()
    mcpPath = tmpPath
}
if mcpPath != "" {
    args = append(args, "--mcp-config", mcpPath, "--strict-mcp-config")
}
```

`writeDynamicMCPConfig`:

1. Read the static base config from `opts.MCPConfigPath` (we keep the
   existing file as the template — preserves env vars, baseURL, key).
2. Parse into a typed struct, inject `VALARIS_MCP_ALLOWLIST=<comma-joined>`
   into each `mcpServers["valaris"].env` map.
3. `os.CreateTemp("", "valaris-mcp-config-*.json")`, write JSON, close,
   return `(path, cleanupFunc, error)` where `cleanupFunc` runs
   `os.Remove(path)` and is idempotent.

Empty/absent `AllowedTools` → skip step entirely, use the static
`mcp-config-prod.json` unchanged. Preserves all back-compat paths:

- Manual `claude` sessions (developer terminal) — no allowlist env var → MCP server boots without restriction.
- MCP Inspector — same path.
- Kanban UI direct usage — direct backend calls, not via MCP, irrelevant.

### 2.3 Temp-file safety

- `os.CreateTemp("", "valaris-mcp-config-*.json")` returns a unique
  filename in `os.TempDir()`. No PID / execution_id collision possible
  (Go's CreateTemp uses random suffix).
- Cleanup is `defer cleanup()` immediately after creation. If the
  process is killed mid-flight, `os.TempDir()` collects orphans via the
  OS's tmp cleanup policy.
- No need to thread `execution_id` into the filename. The allowlist is
  embedded in the file's content, not its name.

### 2.4 Why env var (not CLI arg)

- Env var is the cleanest seam in MCP-config JSON: the `env` map is
  already there for `VALARIS_API_KEY` etc.
- Avoids changing `mcp-server/run.sh` to forward CLI args to
  `valaris-mcp`.
- The MCP server reads the env var once at startup (`os.environ.get`).
  Lifetime matches the per-launch process.

### 2.5 Static file retention

Keep `intern/configs/mcp-config-*.json` files as-is. They are the
templates the dynamic path reads + augments. Deleting them would
require rewriting the temp file from scratch (env vars, baseURL, key) on
every call — pointless duplication.

---

## Section 3 — MCP-side: enforcement middleware

### 3.1 Hook into the existing `install_tracking` pattern

`mcp-server/src/valaris_mcp/server.py:20-34` already monkey-patches
`_tool_manager.call_tool` to add tracking. Add a second wrapper
(`install_allowlist`) using the same shape. Order matters: allowlist
**before** tracking, so denied calls never create execution rows.

```python
# new file: mcp-server/src/valaris_mcp/allowlist.py
import os
from typing import Any

_ALLOWLIST_ENV = "VALARIS_MCP_ALLOWLIST"


def load_allowlist() -> frozenset[str] | None:
    """None = no restriction. frozenset = enforce membership."""
    raw = os.environ.get(_ALLOWLIST_ENV)
    if raw is None:
        return None
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return None  # empty list also means no restriction
    return frozenset(parts)


def install_allowlist(server: Any, allowlist: frozenset[str] | None) -> None:
    if allowlist is None:
        return  # no-op: no restriction
    original = server._tool_manager.call_tool

    async def gated(name, arguments, **kwargs):
        if name not in allowlist:
            # Return an MCP-friendly error payload. Raises propagate as
            # tool errors to the LLM; explicit return keeps the error
            # body shape stable and machine-readable.
            raise PermissionError(_denial_payload(name, allowlist))
        return await original(name, arguments, **kwargs)

    server._tool_manager.call_tool = gated


def _denial_payload(name: str, allowlist: frozenset[str]) -> str:
    import json
    return json.dumps({
        "error": "tool_not_allowed",
        "tool": name,
        "allowlist": sorted(allowlist),
    })
```

### 3.2 Wire into `app_lifespan`

`server.py:37-46`:

```python
@asynccontextmanager
async def app_lifespan(server: FastMCP):
    client = ValarisClient()
    tracker = ExecutionTracker(client)
    install_allowlist(server, load_allowlist())  # NEW — before tracking
    install_tracking(server, tracker)
    try:
        yield AppContext(client=client, tracker=tracker)
    finally:
        await tracker.finalize()
        await client.close()
```

Allowlist is loaded **once at startup** — the env is fixed for the
process's lifetime since each claude-cli launch spawns its own MCP
server. No per-request re-read.

### 3.3 Tracker interaction

Denied tool calls raise before `original(...)` runs. `install_tracking`
wraps the **same** `call_tool` slot; since `install_allowlist` runs
first, the tracker sees the wrapped (gated) function and will fire
`before_tool_call` → `original(gated)` → exception. The tracker's
existing exception path (`tracking.py:before/after`) already handles
this: `after_tool_call(name, None)` is called from the `except` branch.

If we want denied calls to NOT pollute execution rows, swap the install
order so tracking wraps allowlist (tracker outer, gate inner). The
tracker still records the call but with status=failed. **Recommended:**
tracker-outer, gate-inner — denial visibility is useful for forensics.

### 3.4 Denial shape

```json
{
  "error": "tool_not_allowed",
  "tool": "mcp__valaris__create_card",
  "allowlist": ["mcp__valaris__get_card", "mcp__valaris__log_execution_update"]
}
```

Surfaced as a `PermissionError` from `call_tool`. FastMCP's MCP-protocol
serialization turns exceptions into tool-call error responses; the
client (claude-cli) reports the message to the LLM. The LLM sees a
typed error and can adjust its tool selection. Stable shape so future
log-grepping / dashboards can build on it.

### 3.5 Tool name format

The runner emits tool names with the `mcp__valaris__` prefix (see
`loop.go:1054-1062` discover stripping). FastMCP registers them
unprefixed (`create_note`, `get_card`). The prefix is added by claude-cli
when it surfaces tools to the LLM. **The MCP server sees unprefixed
names** in `call_tool(name, ...)`.

This means the allowlist env var must be passed in the form the MCP
server will see. Two choices:

- **α — strip prefix in runner** before joining into env var. Backend
  configs keep `mcp__valaris__*` strings; runner strips at the wire.
- **β — strip prefix in MCP server** when comparing. Tolerates both
  forms.

**Pick α.** Strip once on the runner side. MCP server stays
single-shape. Eliminates the "which form is canonical?" ambiguity. The
strip is a trivial `strings.TrimPrefix(t, "mcp__valaris__")` at the
moment the env var is built.

---

## Section 4 — Test plan (LIST, not implementation)

### 4.1 Go tests — `cd intern && go test ./internal/llm`

- `TestExecute_DynamicMCPConfig_EmbedsAllowlistEnv` — set
  `opts.AllowedTools = ["mcp__valaris__get_card"]`, capture the
  `--mcp-config` argv, read the temp file, assert
  `VALARIS_MCP_ALLOWLIST=get_card` in the valaris server's env.
- `TestExecute_DynamicMCPConfig_StripsPrefixBeforeEmbed` — input has
  `mcp__valaris__create_note`, embedded value is `create_note`.
- `TestExecute_DynamicMCPConfig_EmptyGrant_PinsToolsetsWithoutAllowlist` —
  empty grant still materializes a dynamic config: `VALARIS_MCP_TOOLSETS=all`
  and no allowlist key (replaced the older "empty list uses the static path"
  test when toolsets landed).
- `TestExecute_DynamicMCPConfig_AbsentMCPPath_NoFile` — empty
  `MCPConfigPath`, no temp file created, no `--mcp-config` arg.
- `TestExecute_DynamicMCPConfig_CleanupOnSuccess` — temp file removed
  after Execute returns.
- `TestExecute_DynamicMCPConfig_CleanupOnError` — claude exits nonzero,
  temp file still removed.
- `TestExecute_DynamicMCPConfig_TemplateEnvPreserved` — static config has
  `VALARIS_API_KEY`, dynamic file retains it alongside the new allowlist
  env var.

### 4.2 Python MCP tests — `cd mcp-server && uv run --extra dev pytest tests/`

- `test_allowlist_load_no_env_returns_none` — env unset → `None`.
- `test_allowlist_load_empty_returns_none` — env is `""` → `None`.
- `test_allowlist_load_parses_comma_list` — `"get_card,create_note"` →
  `{"get_card", "create_note"}`.
- `test_allowlist_load_strips_whitespace` — `"get_card , create_note "`.
- `test_install_allowlist_none_is_noop` — server's `call_tool` unchanged.
- `test_install_allowlist_permits_listed_tool` — allowlist
  `{"get_card"}`, call `get_card`, original ran.
- `test_install_allowlist_denies_unlisted_tool` — allowlist
  `{"get_card"}`, call `create_card`, PermissionError raised with
  canonical `{error, tool, allowlist}` JSON payload.
- `test_install_allowlist_denial_payload_shape` — payload parses as
  JSON, has the three required keys, `allowlist` is sorted.

### 4.3 Integration check (manual)

1. Reset the pilot workspace's pipeline_config.
2. Configure planner stage with `tools: ["mcp__valaris__get_card"]`.
3. Trigger a planner run via /tmp/intern-smoke.
4. Observe: LLM attempts `mcp__valaris__create_card` (per current
   prompt) — sees `tool_not_allowed` error, plan stage either retries
   with a permitted tool or completes with the error in
   `$llm_output`.
5. Confirm: `valaris-mcp-config-*.json` temp file appears in
   `os.TempDir()` during the launch and is gone after.

No automated end-to-end; gated on user-driven smoke.

---

## Section 5 — Migration / rollout

### 5.1 No data migration

Config schema unchanged. `pipeline_config.stages[].llm.tools` already
exists; this change makes it load-bearing where it was advisory.

### 5.2 Deploy order

- **Runner binary + MCP server** ship together. The MCP server lives in
  the same monorepo; the runner shells out to `mcp-server/run.sh`. A
  runner-only deploy without the MCP changes still works (env var
  ignored) — but the allowlist won't be enforced. A MCP-only change
  without the runner won't ship the env var. Coordinate.
- **Backend deploy not strictly required.** Existing
  DEFAULT_PIPELINE_CONFIG already carries `tools` arrays; no schema or
  validator changes needed for this feature. Verify no validator regressed
  the `tools` key in `pipeline_config_validation.py`.

### 5.3 Back-compat impact — would any current config break?

`DEFAULT_PIPELINE_CONFIG.stages[].llm.tools` enumerated from
`backend/app/services/workspace_config.py`:

| Stage             | tools[] (line)            | Tools (count) | Would now be enforced? |
|-------------------|---------------------------|---------------|------------------------|
| `plan`            | line 84 / 130             | 4             | Yes — `get_card`, `get_project_context`, `decompose_card`, `log_execution_update`. Planner can no longer accidentally call `create_card` (closes investigation §3.2 leakage). |
| `implement`       | line 226 / 281            | 4             | Yes — get_card, get_project_context, log_execution_update, request_approval. Implementer can no longer call note/card mutations directly. |
| `review`          | line 367 / 418            | 2             | Yes — get_card, get_project_context. Reviewer is read-only. |
| `mediate_rework`  | line 547 / 603            | 3             | Yes — get_card, get_project_context, log_execution_update. Mediator output is owned by lifecycle. |
| `document`        | line 701 / 757            | 5             | Yes — create_note + get_card + get_project_context + list_notes + log_execution_update. Documentator IS allowed to call create_note (only role that still owns its note). |

**Net behaviour change:** every shipped role's allowlist becomes a hard
gate. The DEFAULT was authored with this enforcement in mind (Phase 4
of the role redesign explicitly tightened planner + mediator's tool
lists). **No currently-shipping default config breaks.** Workspaces
with persisted v3 overrides that wrote unrestrictive `tools` arrays
still work (empty = no restriction). Workspaces with restrictive
`tools` arrays may surface previously-silent leakage as denials —
**desired**.

### 5.4 Smoke gate

The round-6 smoke expectations (internal record) should
gain a check: each role's LLM output mentions zero `tool_not_allowed`
errors for the role's expected tools, and (optionally) the planner's
historical `create_card` leakage produces a `tool_not_allowed` denial
that the LLM gracefully ignores.

---

## Section 6 — Open questions / unknowns

1. **Order of `install_allowlist` vs `install_tracking`.** Tracker-outer
   (tracking records denials) or allowlist-outer (denials never log)?
   Recommendation: tracker-outer for forensics, but the user should
   confirm — tracker writes execution rows + tool-invocations against
   the backend, and a flood of denied calls could noise the activity
   feed.

2. **Tool name prefix canonicalization.** Confirmed runner-side strip
   (Section 3.5 α) is the cleaner path, but the canonical wire form is
   under-documented. If the backend ever serializes
   `pipeline_config.stages[].llm.tools` to the frontend, it'd be nice
   to display the unprefixed names too. Frontend display is out of
   scope; flag for the orchestrator.

3. **MCP server start-up failure mode.** If `VALARIS_MCP_ALLOWLIST` is
   malformed (e.g. binary garbage), `load_allowlist` currently coerces
   to `None` (no restriction). Should malformed → server refuses to
   start (fail-closed)? Recommendation: fail-closed for production
   safety; the runner's dynamic path always produces well-formed input,
   so a malformed env is a real bug we want to surface loudly.

4. **Existing `--dangerously-skip-permissions` flag.** This change does
   NOT touch the CLI flag. It moves enforcement server-side, which is
   the correct path. The flag stays on (claude-cli won't prompt for
   permission per tool) but is now enforcement-irrelevant for MCP tools.
   Non-MCP tools (Bash, Edit, Read inside claude-cli) are still
   permission-bypassed — desired for unattended agents. Flag if the
   user wants a follow-up to also gate Bash via a different mechanism.

5. **`--strict-mcp-config`.** Already passed alongside `--mcp-config`
   (claude_cli.go:170). Confirms only the listed MCP servers are used —
   defense in depth against an LLM trying to register additional servers.
   Keep as-is.

6. **MCP Inspector / manual claude session impact.** Both use the static
   `mcp-config-prod.json` without setting `VALARIS_MCP_ALLOWLIST` — they
   continue to work unrestricted. Confirmed back-compat.

7. **Logging of denials.** Should the gate `slog.Warn` (or Python
   `logger.warning`) on every denial? Useful for surfacing prompt-vs-DSL
   contract drift. Recommendation: yes, log at WARN, one line per
   denial, `{tool, allowlist_size}`. Cost is trivial; observability
   payoff is large during the first smoke round.

---

## Addendum (2026-09-03) — the allowlist also filters `tools/list`

`install_allowlist` now filters the listing as well as the call gate: a
stage's process answers `tools/list` with only the tools on its allowlist,
so a stage only sees its hand instead of the full catalog with most of it
refusing at call time. The `tools/call` gate is unchanged and remains the
authoritative backstop.

No `notifications/tools/list_changed` is emitted, on purpose: the allowlist
is read once from `VALARIS_MCP_ALLOWLIST` and is fixed for the lifetime of
the process (one launch per stage), so the listing never changes after the
handshake and there is nothing to notify about.

## Addendum (2026-09-03) — toolsets compose with the allowlist

`VALARIS_MCP_TOOLSETS` (backplane-mcp 0.6.0) selects which taxonomy groups or
categories the server lists at all. The hand a session sees is
`registered ∩ toolsets ∩ allowlist`, and the call gate uses the same set.
Two rules keep runner semantics unchanged:

- When `VALARIS_MCP_ALLOWLIST` is set and `VALARIS_MCP_TOOLSETS` is not, the
  server treats toolsets as `all` — the allowlist *is* the hand, so an older
  runner binary that never heard of toolsets is not clipped.
- Both runner drivers pin `VALARIS_MCP_TOOLSETS=all` in every dynamic config
  and the wizard writes it into the generated template, so the stage grant
  is the only narrowing. An empty grant (loop-mode "full surface") now
  materializes a dynamic config with the pin and **no** allowlist key,
  instead of passing the static template through; the doctor warns when a
  hand-written template lacks the key.

## Addendum (2026-09-04) — `enable_toolsets` widens the toolset layer at runtime

backplane-mcp 0.7.1 adds `enable_toolsets(toolset_ids)` (category
`server-info`, present on every hand). It widens the *toolset* layer of the
running process: the ids are the same values `VALARIS_MCP_TOOLSETS` accepts,
the operation is widen-only and idempotent, and nothing is persisted. The
hand is still `registered ∩ toolsets ∩ allowlist`; only the middle term moves.

The allowlist layer — the stage grant — is unchanged: read once from
`VALARIS_MCP_ALLOWLIST`, fixed for the lifetime of the process, and the
ceiling every widening is re-intersected with. Under a runner launch that
sets only the allowlist the toolset layer is already `all`, so the call is a
no-op and a stage can never see or call a tool outside its grant.

The hand is per *session*, not per process. The lowlevel server enters
`app_lifespan` once per session, and under streamable-http one process serves
many sessions against one shared tool manager, so `install_hand` installs its
list filter and call gate at most once (sentinel on the tool manager) and
resolves the calling session's `HandState` per request through the lowlevel
`request_ctx` (falling back to the install-time hand when no request is
active, the stdio shape). Stacking one closure per session would have let an
earlier session's gate nullify a later session's widening for the life of the
process; `install_tracking` still stacks that way and is tracked as a
follow-up card.

Because the listing can now change after the handshake, the server
advertises `tools.listChanged: true` and sends
`notifications/tools/list_changed` after a widening that adds tools. The
2026-09-03 sentence "no `notifications/tools/list_changed` is emitted" now
applies to the allowlist layer only: an allowlist change still requires a
new process, and no notification is ever sent for it.
