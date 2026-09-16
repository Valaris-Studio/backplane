# Backplane MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the
[Backplane](https://github.com/Valaris-Studio/backplane) platform to AI agents.
The live catalog spans workspaces, boards, cards, executions, approvals, notes,
resources, and pipeline configuration, plus role-specific prompts and resources.
Use `get_server_info` or the in-app MCP reference for the catalog served by the
version you are running instead of relying on a frozen tool count.

Point any MCP-capable client (Claude Code, Claude Desktop, or your own agent) at
a Backplane instance and it can read board state, claim and move cards, log
executions, and request approvals.

## Install

```bash
uvx backplane-mcp
```

The command above runs the released package. An unpublished candidate must be
validated from its reviewed source checkout or wheel, not inferred from a
released package install. When the candidate commit is accessible, pin it exactly:

```bash
uvx --from "git+https://github.com/Valaris-Studio/backplane.git@<commit>#subdirectory=mcp-server" backplane-mcp
```

## Configure

Choose the startup toolsets for your connection:

- Everyday project work → `default`, the compact interactive catalog.
- Loops and runners → `default,autonomous-operations` for an interactive human connection to prepare and manage loops.
- Everything → `all`, an explicit opt-in to a larger catalog that may exceed client tool limits.

Preserve custom toolset compositions and existing credentials. Actual autonomous
runner launches remain `all` intersected with their authorized allowlist; the
interactive loops preset does not replace runner execution configuration.

A local stdio MCP process can use a remote Backplane API through
`VALARIS_API_URL`. Client environment cannot configure a remote MCP HTTP service:
its operator must set the actual service startup environment and restart it.

Add the local stdio configuration to your client's MCP config (for example,
Claude Code's project `.mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "valaris": {
      "command": "uvx",
      "args": ["backplane-mcp"],
      "env": {
        "VALARIS_API_URL": "https://your-backplane-host",
        "VALARIS_API_KEY": "vlr_...",
        "VALARIS_MCP_TOOLSETS": "default"
      }
    }
  }
}
```

| Variable | Required | Purpose |
|---|---|---|
| `VALARIS_API_URL` | yes | Base URL of your Backplane backend |
| `VALARIS_API_KEY` | yes | Platform API key (`vlr_…`). Create one in the UI from your account menu (API Keys), or `POST /api/me/api-keys`. |
| `VALARIS_AGENT_EMAIL` | no | development fallback identity when neither a bearer API key nor an authenticated proxy supplies identity. It is ignored when `VALARIS_API_KEY` is used. |
| `VALARIS_MCP_TOOLSETS` | no | Which slice of the tool surface this session lists at startup. Unset loads the default interactive hand (or every tool when `VALARIS_MCP_ALLOWLIST` is set, the runner shape); `all` loads every tool; a comma list of group/category ids (with `default` as an alias, e.g. `default,autonomous-operations`) composes a custom hand. An unknown id fails startup. A running session widens its hand with the `enable_toolsets` tool (same ids). |

### Upgrading from 0.5.0

0.6.0 lists the interactive default hand instead of every tool. To keep the
full surface an existing config had, add one line to the server env:

```json
"VALARIS_MCP_TOOLSETS": "all"
```

Runner launches need nothing: a present `VALARIS_MCP_ALLOWLIST` with no
toolsets env loads every toolset, and new runner binaries pin `all`.

For an autonomous runner, or whenever you want the full surface, add
`VALARIS_MCP_TOOLSETS`:

```json
{
  "mcpServers": {
    "valaris": {
      "command": "uvx",
      "args": ["backplane-mcp"],
      "env": {
        "VALARIS_API_URL": "https://your-backplane-host",
        "VALARIS_API_KEY": "vlr_...",
        "VALARIS_MCP_TOOLSETS": "all"
      }
    }
  }
}
```

The default hand covers project context, search, boards, cards, notes and
the other knowledge tools, plus a few read-only helpers (linked git repos,
the board's skills, velocity and cost), leaving workspace-admin and
destructive verbs, the collaboration setup tools and the rest of the
autonomous-operations tools opt-in. The env var picks the initial hand only.
Every hand, including the default one, also carries the `server-info` category:
`get_server_info`, `whoami` and `enable_toolsets`. Call `get_server_info` and
read its `toolsets` key to see what is loaded and which toolset ids exist; call
`enable_toolsets(toolset_ids)` with any of those ids (`all`, `default`, or a
group/category id) to widen the server session. Clients that refresh their catalog can use the added tools without restarting. Widening is
widen-only, idempotent and per-MCP-session, and after one that adds tools the
server sends `notifications/tools/list_changed` (the handshake advertises
`tools.listChanged: true`). This is a refresh request, not proof that the client
exposed the new tools to its agent. `list_changed_sent=true` and
`get_server_info.enabled_tools` describe server state only;
`client_catalog_status` remains `unverified`.

### When enabled tools are still missing

Some clients retain their initial tool catalog. Repeating `enable_toolsets`
cannot force them to refresh, and agents may have no way to call `tools/list`.
Use the exact returned `restart_env` to preserve every enabled group, including
custom toolsets. Keep the existing credentials and allowlist unchanged
(`VALARIS_MCP_ALLOWLIST`). A narrower preset must not overwrite that selection.

For a fresh interactive loops connection, this remote MCP service environment
is an example; recovery uses the returned selection instead:

```env
MCP_TRANSPORT=streamable-http
MCP_HOST=0.0.0.0
VALARIS_MCP_TOOLSETS=default,autonomous-operations
```

The operator applies these values at the actual MCP service startup, retaining
the existing API/authentication configuration. Protect the endpoint behind
authenticated access or a trusted private network. `MCP_HOST=0.0.0.0` is a bind
address, not access control. Use your deployment's service restart mechanism.

1. For **local stdio**, apply the exact returned `restart_env` to the MCP
   server launch configuration and retain stdio transport. For **remote HTTP**,
   the operator applies that recovery selection to the remote service startup
   environment; client-side environment does not configure a remote server.
2. Restart the MCP server/connection so it reads that configuration, then
   start a new agent session to load its initial catalog. Restarting with the
   old environment loses the widening; a new chat alone may reuse the old
   server or cached catalog.
3. Verify successful native tool calls using the current client schema.
   Authentication or API-key activity does not verify the selected tools;
   `get_server_info` alone does not verify client discovery.

For every preset, call `whoami()` and resolve an authorized workspace from
established context. If unresolved, call `list_workspaces()` and use a returned
slug. If the choice is ambiguous, ask the user to confirm. If no authorized
workspace exists, report that limitation and stop workspace checks. Never invent
a slug.

**Everyday project work (`default`):** call `list_boards`, then
`get_project_context` with an existing returned board ID. Replace the example
placeholders with those authorized values. If no boards exist, report the
successful empty list and skip the project-context call.

```python
list_boards(workspace_slug="your-workspace")
get_project_context(workspace_slug="your-workspace", board_id="existing-returned-board-id")
```

**Loops and runners:** use the following checks for the interactive loops
preset. **Everything** combines the everyday and loops checks as representative
read checks; they do not verify every tool. Do not expect the default preset to
expose all loop tools. `list_agents` takes no `workspace_slug` and lists agents
visible to your credentials; use the authorized workspace for the other calls.

```python
list_loop_templates(workspace_slug="your-workspace")
list_agents()
list_executions(workspace_slug="your-workspace", limit=1)
```

Empty successful lists count as callable. Inspect `propose_skill` presence
without invoking it. Do not register runners, bind/start loops, propose skills,
or mutate boards to test setup.

- Missing native tool: compare the client catalog with `get_server_info`, startup
  toolsets, the running server version and `VALARIS_MCP_ALLOWLIST`. Keep that
  authorization ceiling; only an authorized operator can change a grant.
- HTTP 401: check or replace the API key. HTTP 403: confirm workspace membership
  and permissions with the operator; wider toolsets do not grant access.
- Network failure: check the API origin, connectivity and protected remote
  endpoint. Process-start failure: check `uvx` and host config syntax.
- Version/schema mismatch: use a compatible reviewed server artifact, restart,
  and repeat these read-only native checks.

The recovery environment is returned even on an idempotent repeat. Keep the
existing API credentials and allowlist unchanged. To avoid refresh dependence
from the outset, select **Everything** in the connection wizard or configure
`VALARIS_MCP_TOOLSETS=all`. That larger catalog may exceed some clients' tool
limits; selecting only the required groups keeps the initial catalog smaller.
 `VALARIS_MCP_ALLOWLIST`
stays a ceiling the tool never lifts: `resolved_tool_count` in
`get_server_info` is the size of the loaded toolsets before the allowlist
intersection; `enabled_tools` is the hand after it.

> The server name `valaris` is a stable, permanent namespace — agent tool names
> are `mcp__valaris__*`. It is intentionally not renamed alongside product
> branding, because renaming it would break every existing agent config. The
> `valaris-mcp` console script remains as an alias of `backplane-mcp`.

## Upgrading

### Upgrading from 0.7.3

**Breaking:** 0.8.0 changes `list_notes` from a bare array to a paged object:
`{notes, total, limit, offset, has_more, next_offset, _hint}`. Read its `notes`
field and repeat the call using `offset=next_offset` and the same filters until
`has_more` is false. The default page contains up to 25 summaries; set
`summary_only=false` explicitly for raw bodies, or use `get_note(format="markdown")`
for editable content. Restart pagination if notes change during traversal.

The deprecated aliases from 0.7.0 remain callable; their planned removal is
postponed to 0.9.0. Migrate to the canonical tools before that release.

Upgrade the backend alongside the MCP package: paging and bulk repository
validation require the matching backend support. The raw HTTP notes API keeps
its array response. Bulk card creation now preserves supplied repository and
other supported metadata; an unknown or non-board repository slug rejects the
whole batch before any insertion. Mutation receipts label raw ProseMirror;
read Markdown before editing, or retain your original Markdown input.

Clients must treat protocol `isError=true` as a failed call even when the
preserved receipt contains structured content. Read that receipt for the error
details before deciding whether to retry. Loop stop/resume responses report the
stored `disabled_reason`; a repeated same-state request may retain the prior
reason rather than persisting the newly supplied one.

For clients with fixed tool catalogs, apply the startup toolset selection to
the actual MCP server, restart the connection, and start a fresh agent session.
Use `get_server_info` and then the native-tool checks above to confirm both
server readiness and client availability. A successful server check or toolset
notification alone does not prove that the client can call the tools. Remote
HTTP startup settings belong to the service operator; preserve credentials and
runner allowlists during the upgrade.

### Upgrading from 0.7.2

0.7.3 changes nothing in configs or tool signatures. It makes
`MCP_TRANSPORT=streamable-http` actually start: `MCP_HOST` / `MCP_PORT` are
now applied through the SDK's settings, where earlier releases crashed at
startup with a `TypeError` before listening. stdio is unchanged.

### Upgrading from 0.7.1

0.7.2 changes nothing in configs or tool signatures. It fixes execution
tracking: rows now carry the real status, `cards_affected` and result
summary (error payloads and raised calls are recorded `failed`), and
streamable-http sessions no longer stack tracker wrappers.

### Upgrading from 0.7.0

0.7.1 changes nothing in existing configs. It adds `enable_toolsets`, so an
interactive session can widen its server hand at runtime. Clients that do not
refresh still require the startup configuration and restart procedure above;
runner grants are unaffected.

Retired or renamed tools stay callable for one minor version as deprecated
aliases: `get_server_info` lists them under `deprecated_aliases` with their
replacement and `deprecated_removed_in`, and `allowlist_deprecated` names the
ones a `VALARIS_MCP_ALLOWLIST` still grants. The CHANGELOG carries the
rename → replacement table for each release.

## Getting started as an agent

Start with `get_project_context` — one call returns the board definition, a board
summary, notes, git repos, and recent activity. Then use the prompt matching your
role (`init_project`, `standup`, `plan_work`, `pickup`, …).

Autonomous runners must claim work through `next_assignment`, never by searching
and claiming manually: the backend scheduler applies every role-aware filter and
atomically reserves one card with its bundled context. Interactive agents and
humans claim by moving the card into the column resolved by `column_type` and
adding themselves as a participant.

## Development

```bash
pip install -e ".[dev]"
pytest
ruff check src/
```

A drift guard in the platform's backend test suite asserts this server's tool
catalog stays in sync with the frontend's documentation catalog, so adding a tool
requires updating both.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE). The MCP **tool and prompt schemas**
(names, descriptions, input/output JSON Schemas) are additionally available under
Apache-2.0 so integrations can implement against them freely; see
[LICENSES.md](../LICENSES.md) in the repository root.

## Note browsing and editing after upgrading

`list_notes` now returns a bounded object instead of a bare array:
`{notes, total, limit, offset, has_more, next_offset, _hint}`. Update clients to
read `notes` and follow `next_offset` with identical filters until `has_more`
is false. The default is `summary_only=true`, `limit=25`, `offset=0`; `limit`
is 1–100 and offsets must be nonnegative. Set `summary_only=false` explicitly
if a bounded page needs raw bodies. Upgrade the backend too: missing pagination
metadata fails explicitly. The raw HTTP API retains its legacy array response.

`q` searches title and plain-text body by case-insensitive substring;
`pinned_only` restricts to pinned notes, and `kinds` matches any supplied kind.
These filters combine with `card_id` before paging; `card_id` requires
`board_id`. Without `board_id`, only workspace-level notes are listed. Pages
are a live view: restart at offset zero when notes change during traversal.

Mutation receipts may contain raw ProseMirror JSON. `_content_format` or
`_description_format` and `_hint` identify that representation; they do not
make the receipt editable markdown. Before replacing content, call
`get_note(format="markdown")` or `get_card`, or retain the original markdown
used to create it. This does not add a format selector to mutation tools.

`bulk_create_cards` preserves each card's `git_repo_slug` and other supported
create fields. An unknown slug or a repository not attached to the target
board rejects the whole batch with 422, without creating cards. The historical
single-card `create_card` fallback is unchanged. Bulk creation is still not
idempotent: retrying a successful batch creates duplicates.
