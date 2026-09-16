# Choosing a coding agent and a forge

The runner has two pluggable provider seams, both selected by config (no binary
swap needed once the drivers exist):

- **Coding agent** (`llm.provider`) — which LLM CLI executes card work.
- **Forge** (`git.forge`) — which code host the runner opens/reviews/merges
  changes ("PRs"/"MRs") against.

A startup preflight (`cmd/backplane-runner/preflight.go`) verifies the binaries the
selected providers need are on `PATH` and fails loudly with an actionable
message — so a misconfigured host surfaces at boot, not on the first card.

## Coding agent — `llm.provider`

```yaml
llm:
  provider: claude-cli   # or codex-cli
  model: sonnet
```

| Value | Driver | Requirements |
|-------|--------|--------------|
| `claude-cli` (default) | Claude Code (`claude -p`, stream-json) | A `claude` binary on `PATH`. |
| `codex-cli` | OpenAI Codex (`codex exec --json`, NDJSON) | A stock `codex` binary on `PATH`, authenticated with `codex login`. API-key-only auth is not wired through runner config today (see below). |

Notes:

- The coding-agent seam is a `Provider` interface (`internal/llm/provider.go`)
  with an optional `CapabilityProvider` (`Capabilities`: structured output, cost
  in USD, tokens, session resume, native MCP, auto-commits). The cost map in
  `internal/workloop/loop.go` is provider-keyed; an unknown provider/model
  defaults to the Sonnet rate sheet (unknown ≠ free) and is cost-blind-safe.
- Codex blocks reading stdin when the prompt is a positional arg, so the driver
  feeds it an empty/EOF stdin. Verified live against stock codex `0.144.1`.
- The driver contains an `Options.Extra["codex_api_key"]` hook and strips an
  inherited `CODEX_API_KEY` before launch, but neither pipeline nor loop mode
  currently populates that hook. In normal runner operation, use `codex login`;
  setting only `CODEX_API_KEY` on the runner process is not sufficient. This is
  a current product limitation, not a credential operators should guess around.

### Codex MCP wiring and the allowlist

Codex has no `--mcp-config` flag — Claude reads the static template at
`llm.mcp_config_path` directly, but Codex only accepts MCP server config via
`$CODEX_HOME/config.toml` (or the interactive `codex mcp add`, which writes
the same file). The driver (`internal/llm/codex_cli_mcp.go`,
`codexMCPHome`) reads the same static template Claude uses and, for each
launch, materializes an **isolated `CODEX_HOME`**: a temp directory holding a
generated `config.toml` (the `[mcp_servers.valaris]` table, translated from
`mcpServers.valaris.{command,args,env}`) plus a symlink to the real
`CODEX_HOME`'s `auth.json` so login/API-key auth still resolves. `Execute`
points the subprocess at it via the `CODEX_HOME` env var and removes the temp
dir when the launch ends. This only happens when the stage both sets
`llm.mcp_config_path` and grants at least one tool in its allowlist; a
pure-shell stage with no granted tools pays nothing for an MCP server it
never calls, and leaves the inherited `CODEX_HOME` (or codex's own `~/.codex`
default) untouched.

The translation copies MCP environment strings literally. Neither the Codex
nor Claude runner driver expands `${VALARIS_API_KEY}` inside the JSON template,
so the file used at runtime must already contain a concrete key. The setup
wizard and the safe `-doctor -fix` path write such a 0600 file; the backend's
downloaded export remains a placeholder-bearing routing template until an
operator materializes a private runtime copy.

**Why a file and not `-c` overrides:** an earlier version of this driver
passed `-c mcp_servers.valaris.env.VALARIS_API_KEY=<key>` directly as a
`codex exec` argument. Process argv is world-readable via `ps`/procfs on
shared hosts, so that put the valaris API key on display for any other user
on the box — the same leak class as embedding a secret in a URL query string.
The `config.toml` this driver writes is `chmod 0600`, matching the posture of
Claude's `--mcp-config` temp file and of codex's own `auth.json`.

The `VALARIS_MCP_ALLOWLIST` env var is embedded exactly like the Claude driver
does it: the granted `mcp__valaris__*` tools, stripped of their prefix and
comma-joined, or the deny-all sentinel (`__none__`) when a non-empty grant
carries no valaris tool (built-ins only). An **empty** grant is the full
platform surface (the loop contract's `tools: []`): both drivers still write
the per-launch config, with `VALARIS_MCP_TOOLSETS=all` and no allowlist key at
all — never the sentinel. That env var is the **server-side, authoritative** enforcement for BOTH the
listing and the call gate: the MCP server filters `tools/list` down to the
granted hand, so the coding agent never sees a tool outside its stage's grant,
and it refuses `tools/call` for anything not on the list. The config file is
just how the value reaches the spawned process for Codex, same as
`--mcp-config` is just how it reaches the spawned process for Claude.
Both drivers also pin `VALARIS_MCP_TOOLSETS=all` on every launch, the empty
grant included (and the wizard writes it into the generated template), so the
stage allowlist stays the only narrowing and a default-hand template never
clips a stage's grant — the default hand omits the autonomous-operations tools
(`enqueue_pr_for_merge`, `list_skills`/`get_skill`, the approvals tools). With
the full surface there is no allowlist to subtract an `mcp__valaris__*` deny
entry from, so the Codex driver reports such an entry on `Result.UnenforcedDeny`
rather than dropping it (Claude still enforces it through `--disallowedTools`).

**Out-of-band wiring bypasses the allowlist.** If a host machine's
`~/.codex/config.toml` already has a hand-added `[mcp_servers.valaris]` entry
(e.g. because an operator ran `codex mcp add valaris -- <command>` once,
outside the runner), that static config is a **different file** from the
per-launch isolated `CODEX_HOME` this driver builds, so it plays no part in a
runner-launched `codex exec` — but if anything on the host ever launches codex
WITHOUT going through this driver (an interactive `codex` session, a cron job,
a different tool), it would see that static entry with whatever tools were
granted at `codex mcp add` time, independent of any card's current allowlist.
**The safe posture is to never hand-configure `mcp_servers.valaris` in
`~/.codex/config.toml` on a runner host** — every codex launch on that host
should go through this driver (or an equivalent per-launch mechanism) so the
allowlist always reflects the current stage's grant, not whatever was true at
setup time.

Live end-to-end (a real Codex call exercising an actual `mcp__valaris__*` tool
through this wiring) is unverified — see the NOTE at the top of `codex_cli.go`.
The isolated-`CODEX_HOME` mechanism itself is confirmed against codex-cli
0.144.1 (`codex mcp list`/`codex mcp get` under a redirected `CODEX_HOME`
correctly read the isolated config; `codex login status` under the same
redirected home still reports the real login when `auth.json` is present
there via the symlink), and the arg-assembly/file-emission is unit-tested
(`codex_cli_mcp_test.go`,
`codex_cli_test.go::TestCodexCLI_Execute_WiresMCPConfigViaCodexHome_NotArgv`
— which pins that the API key lands in the config file and never in argv).

### Shell deny-list

The backend's per-stage `llm.tool_policy.deny` (and the runner's own
`SafeToolDenyFloor`: no `gh pr merge` / `gh pr review` / `gh pr close`, no
force-push, no push to main/master, no `git reset --hard`) is enforced on
**both** providers, by different mechanisms:

| | `claude-cli` | `codex-cli` (verified 0.144.1) |
|---|---|---|
| Mechanism | `--disallowedTools` argv | execpolicy **prefix rules** written to `rules/backplane-deny.rules` inside the per-launch isolated `CODEX_HOME` |
| Applies to | every session | every launch — plain `codex exec` **and** `codex exec resume` |
| Can the project override it? | no | no — a project-scope `.codex/rules` allow cannot override a forbidden floor entry |
| Under `dangerously_skip_permissions` | deny rules win regardless of permission mode | still evaluated under `--dangerously-bypass-approvals-and-sandbox` (verified live 2026-09-02: `gh pr merge 1` Rejected with the flag present); `--ignore-rules` is never emitted |

**Sandbox posture is unchanged.** The rules file rides on every Codex launch,
but it does not change how the process is sandboxed: `dangerously_skip_permissions`
maps to `--dangerously-bypass-approvals-and-sandbox` exactly as it always has.
A Codex OS sandbox was deliberately NOT turned on — `workspace-write` refuses
writes to the Go build cache and `~/.cache` (verified live), which would break
`go`, `pnpm` and `pip` for every Codex user.

**What the floor cannot express.** Backend deny entries that are neither
`Bash(...)` nor `mcp__valaris__*` cannot be expressed as execpolicy rules. On
Codex they are **unenforceable** and the runner logs each one as
`unenforced_deny` at WARN rather than pretending. Keep deny entries in those
two shapes.

**Limitation, both providers — prefix match only.** Claude (2.1.258) and
Codex (0.144.1) each match a denied command by its prefix and unwrap exactly
one shell layer. A nested shell is NOT caught by either: `bash -lc "gh pr
merge 1"`, `sh -c ...`, `eval ...`, or the same command inside a script file
all pass the floor. The floor is a guardrail against the coding agent doing
the dangerous thing *directly*; the review gate is backstopped by the
platform's server-side gates (done-merge gate, merge queue), which do not
depend on what the session's argv or rules file say.

### Per-stage provider (mixing coding agents in one pipeline)

`llm.provider` is the **default**. A pipeline can also run *different* coding
agents on different stages — e.g. `codex-cli` for the implementer while the
`ui_validator` stage stays on `claude-cli` (it needs the Claude visual-testing
skill, which Codex doesn't consume). The per-stage provider is declared by the
**backend** in `pipeline_config` (each stage's `llm.provider`), carried to the
runner on the assignment, and dispatched at execute time. A stage that declares
no provider — or names one the runner didn't build — falls back to the default.

For the runner to honor a non-default provider, that provider's driver must be
**built at startup**. List the extras in the runner YAML so they're constructed
*and* preflighted:

```yaml
llm:
  provider: codex-cli          # default for stages that declare none
  extra_providers:             # also build (+ preflight) these
    - claude-cli               # e.g. so the ui_validator stage can use it
  model: sonnet
```

The startup preflight gates **every** provider in `{provider} ∪ extra_providers`
(both `codex` and `claude` must be on `PATH` above), so a misconfigured host
fails at boot, not on the first card that routes to the missing agent.

## Forge driver — `git.forge`

```yaml
git:
  forge: github          # or gitea
  # gitea only:
  forge_base_url: https://gitea.example.com
  forge_token: <gitea access token>
```

| Value | Driver | Requirements |
|-------|--------|--------------|
| `github` (default) | wraps the `gh` CLI | `gh` on `PATH`, authed via `gh auth login` or `GH_TOKEN`. Infers owner/repo from the local clone's remote. |
| `gitea` | Gitea/Forgejo REST API (HTTP) | `git.forge_base_url` (instance root, no `/api/v1`) + `git.forge_token`. No CLI needed. |

**Those two are the whole list.** GitLab and Bitbucket are **roadmap, not
implemented** — there is no runner forge driver for either, and setting
`git.forge: gitlab` is a fatal startup error. The seam is designed for them
(and the backend `GitProvider` enum already carries the values), but writing
the driver is still open work: implement `forge.Provider` (`internal/forge`)
and register it in `internal/forge/registry`.

GitLab and Bitbucket repos can still be *landed* by the backend merge queue,
which finalizes non-GitHub hosts with plain git. That path is independent of the
runner's forge driver. What is missing is a runner-side driver that can open and
review the initial GitLab/Bitbucket change request.

Notes:

- The forge seam is a `Provider` interface (`internal/forge`); the driver is
  built once at startup by `internal/forge/registry`. An unknown `git.forge` is
  a fatal startup error, never a silent github fallback.
- `git.forge_token` is **separate** from `git.tokens` — the latter are per-role
  `GH_TOKEN` overrides for the `gh` CLI; `forge_token` is the HTTP-API token the
  gitea driver authenticates with.
- The runner builds ONE forge driver at startup; `git.forge` is authoritative.
  The platform-supplied `GitRepo.provider` remains a per-repo guard (e.g. it
  gates branch-protection for non-github repos), not a per-card driver swap.
- CI policy and workspace Git Connections belong to the backend merge queue,
  not to this construction-time runner driver.

## Credential model

There are independent credential planes. Configuring one does not configure the
others.

### Runner process credentials

These credentials exist on the machine or container running
`backplane-runner`:

| Purpose | Source | Scope |
|---|---|---|
| Backplane identity | `VALARIS_API_KEY` / profile credentials, plus a separately materialized MCP JSON containing the same key | REST control plane in the Go process; MCP agent plane in the coding-agent subprocess |
| Claude Code | OAuth/subscription login, or `llm.anthropic_api_key` | LLM execution only; an inherited `ANTHROPIC_API_KEY` is stripped |
| Codex | `codex login` (`auth.json` under the effective Codex home) | LLM execution only; inherited `CODEX_API_KEY` is stripped and is not populated from runner config today |
| GitHub forge API (`gh`) | `gh auth login` or ambient `GH_TOKEN`; optional `git.tokens.<role>` overrides | Runner PR/review/merge operations for that role |
| Gitea forge API | `git.forge_token` + `git.forge_base_url` | Runner PR API calls only; configure git transport auth separately |
| Git transport | a git credential helper for HTTPS, or a local SSH agent plus `~/.ssh/config` for SSH | Runner clone/fetch/push; configure independently of the forge API token |

`git.tokens.<role>` becomes `GH_TOKEN` in that role's git/`gh` subprocess
environment. It is how a reviewer can use a different GitHub identity from an
implementer for `gh` operations. Plain git does not interpret `GH_TOKEN` by
itself, so HTTPS clone/fetch/push still needs a credential helper (or a remote
whose helper is already configured). `git.forge_token` is not interchangeable
with either one: the Gitea driver uses that token for HTTP API calls and does
not install a git credential helper.

SSH remotes pass through unchanged. `SSH_AUTH_SOCK` reaches git, while
`GIT_SSH_COMMAND` and `GIT_SSH` are scrubbed because they name commands to
execute. Put non-default identities in `~/.ssh/config` instead.

The platform **never sends workspace Git Connections to the runner**. Those
encrypted credentials remain backend-side. A runner that must clone, push, open,
or directly merge a PR still needs its own host credential.

### Platform merge-queue credentials

When a pipeline's `pipeline_config.merge_via_queue` is `true`, a lifecycle
`merge_pr` step hands the PR to the backend queue. Loop mode can also enqueue
when the board opts into `loop_landing: merge_queue`. The backend then resolves
a credential for each repo in this order:

1. The workspace connection explicitly bound to the repo.
2. The workspace's only connection for that provider.
3. The platform's provider-matched `GITHUB_TOKEN` or `GITLAB_TOKEN`, only when
   `ALLOW_GLOBAL_TOKEN_FALLBACK` permits it.
4. No credential, with an operator-readable reason.

Every candidate is host-matched before use. There is no cross-provider token
fallback, and `GITEA_TOKEN` has no safe global host association, so self-hosted
Gitea requires a workspace connection with `base_url`. The full setup and
permission matrix is in [`../../docs/git-credentials.md`](../../docs/git-credentials.md).

The queue performs `clone → fetch PR branch → checkout → rebase onto the
integration branch → push --force-with-lease`, with credential-bearing URLs redacted from
errors. It then lands by provider:

- **GitHub** — confirms the PR base matches the integration branch, then runs
  `gh pr merge --squash --delete-branch` with the entry's resolved credential.
- **Non-GitHub** — checks out the integration branch, fast-forwards it to the
  rebased PR branch with `--ff-only`, and pushes. It does not call a host API,
  so a forge that does not auto-detect the new commits may leave a stale-open
  PR/MR in its UI.

The board's `merge_gate` is read on every attempt. `forge_ci` checks GitHub CI
before cloning and fails closed on unreadable/pending/red state; `none` skips
that check. Workspace connection health is updated after authenticated merge
successes and 401/403-style failures.

## Review and merge lifecycle

The pipeline lifecycle, not `git.auto_pr` or `review_mode`, decides when work
lands:

1. A shipping stage may create and push a branch and, when `git.auto_pr` is
   enabled, open the PR through the configured runner forge driver.
2. A decision-producing review stage can mirror its verdict with
   `post_pr_review`. `review_mode: platform` posts a comment, which works with
   one identity. `review_mode: github` posts a formal review and therefore
   needs a second identity to avoid GitHub's self-review restriction.
3. A lifecycle `merge_pr` step merges directly through the runner forge driver
   when `merge_via_queue` is false, or enqueues the PR when it is true. An
   explicit `enqueue_for_merge` step always queues it.
4. The merged-PR reconciler moves the card only after the forge or queue reports
   a real merge. The removed `enable_auto_merge` lifecycle kind is a no-op;
   GitHub auto-merge is not a hidden landing path.

`review_mode` controls how a verdict is represented on the PR. It does not
select direct versus queued merge, and it does not grant credentials.

## Switching, in one line each

- Coding agent → Codex: set `llm.provider: codex-cli` (ensure `codex` is on
  `PATH` and authenticated with `codex login`).
- Forge → Gitea: set `git.forge: gitea` plus `git.forge_base_url` and
  `git.forge_token`.
