# Backplane Runner

**The process that actually does the work.**

`backplane-runner` is a single Go daemon. It asks a [Backplane](https://github.com/Valaris-Studio/backplane)
backend for a card, clones the card's repo, drives a coding-agent CLI against it
in a branch, pushes, opens a pull request, and reports the outcome — then asks
for the next card. It runs on your hardware, with your credentials, against your
repos.

It is deliberately thin on opinions. The *pipeline* — which roles exist, what
each stage prompts for, what gates a card must clear — lives on the platform, not
here. The runner's job is to execute one stage at a time and be honest about what
happened.

The integration has two distinct planes, and both are required:

- **REST control plane** — the Go runner calls the backend API for identity,
  heartbeats, platform and loop config, assignment/reservation, execution
  records, card transitions, approvals, and merge-queue handoff.
- **MCP agent plane** — each spawned coding-agent session receives
  `llm.mcp_config_path` and uses the allowed Backplane MCP tools while doing
  the card's work.

MCP is not a replacement for the runner's REST client, and the REST client is
not a replacement for the tools available inside the coding-agent session.

Two seams are pluggable by config, no rebuild:

- **Coding agent** (`llm.provider`) — `claude-cli` or `codex-cli`
- **Git forge** (`git.forge`) — `github` or `gitea`

See **[`docs/providers.md`](docs/providers.md)** for the full matrix, per-stage
agent mixing, and how a merge actually lands on each host. GitLab and Bitbucket
are roadmap, not implemented — `git.forge: gitlab` is a fatal startup error.

The runner is **MIT-licensed** ([`LICENSE`](LICENSE)) while the platform core is
AGPL-3.0. That is intentional: you should be able to embed, fork, or vendor the
thing that runs on your machines without the platform's copyleft following it.

## Prerequisites

| Requirement | Version / detail | Needed for |
|---|---|---|
| Go | 1.26.3+ (`go.mod`) | building from source |
| `claude` and/or `codex` | on `PATH` | the coding agent itself — whichever providers your config names |
| `git` | any | cloning and pushing work |
| `gh` (github forge) | authed via `gh auth login` or `GH_TOKEN` | opening, reviewing, and merging PRs |
| `uv` / `uvx` | any recent | running the MCP server the agent talks to |
| A Backplane backend | reachable over HTTP | work to do, and the API key to do it with |

A startup preflight checks the binaries for every provider you configure and
fails loudly with an actionable message, so a misconfigured host surfaces at boot
rather than on the first card.

**Coding-agent auth.** For `claude-cli`, the runner deliberately *strips* an
inherited `ANTHROPIC_API_KEY` from the agent subprocess so it uses OAuth /
subscription auth (Claude Code Max) by default. If you want to bill API credits
instead, set `llm.anthropic_api_key` in the YAML — that is the only path. For
`codex-cli`, use `codex login`. The driver has an internal API-key hook, but
the current runner config does not populate it and strips an inherited
`CODEX_API_KEY` from the subprocess. **API-key-only Codex auth is therefore not wired**
through the normal runner launch path today.

**Git auth is separate from forge API auth.** `gh auth login`, `GH_TOKEN`, and
per-role `git.tokens` authenticate the `gh` CLI. Plain git does not consume
`GH_TOKEN` by itself, so HTTPS clone/fetch/push also needs a configured git
credential helper; SSH remotes need a reachable local SSH agent and
`~/.ssh/config`. See the provider guide before running headless.

## Quickstart

### 1. Register the runner in the UI

The runner authenticates as an **agent** — a service account on the platform,
holding a `vlr_...` bearer key. Register one with the **Launch runner wizard**:
in your workspace, go to **Runner → Runners → Create runner**. It walks four
steps — **Identity → Roles → Config → Launch** — and covers the whole journey,
so it is the only page you need. (`POST /api/agents` is the API equivalent for
scripting.)

- **Identity** — name and optional description. The workspace is bound
  automatically; there is no scope field to get wrong. Submitting mints the key
  and shows it **exactly once** — the backend stores only a hash. Copy it then.
  If you lose it, rotate to a fresh key (`POST /api/agents/{id}/rotate-key`, or
  *Rotate API Key* under Advanced settings on the runner's detail page) and
  update both the runner credential/env and the private MCP JSON before
  restarting. Re-download the routing bundle if its non-secret settings also
  changed; the runner keeps its roles and history.
- **Roles** — which pipeline roles this runner may claim (`implementer`,
  `reviewer`, `documentator`, or whatever your pipeline defines). Roles come
  from **team membership**, and the wizard does that plumbing itself: it adds
  the runner to the workspace's team, creating a *Default runners* team if none
  exists. The runner never declares its own roles; that's why there is no
  `role:` key in the config. A runner bound to no roles is never handed a card.
- **Config** — generates and downloads the config bundle (step 2).
- **Launch** — the command that starts the binary (step 3).

### 2. Get the runner and MCP configs

The runner's coding-agent sessions reach Backplane through **MCP tools**, so an
MCP config is required even though the Go process also uses the REST control
plane. A missing or unusable MCP config is the most common first-run stumble.

The UI wizard's **Config** step downloads a two-file bundle for the runner you
just created. The same bundle is available directly:

```
GET /api/agents/{agent_id}/export-config
```

(also an inline button in the runner table). It returns a ZIP with
`runner-{name}.yaml` and `mcp-config-{name}.json`, already pointing at each other
and at your backend URL. Keep both in one directory. This is a routing bundle,
not a ready credential bundle: both files deliberately contain a
`${VALARIS_API_KEY}` placeholder. `VALARIS_API_KEY` overrides the value loaded
from runner YAML, but the runner hands the MCP JSON to the coding-agent driver
verbatim and **does not expand placeholders inside that JSON**.

Before launch, use the no-argument setup wizard (recommended) or
`-doctor -fix` to write an owner-only MCP config containing the real agent key,
then point `llm.mcp_config_path` at it. `-fix` writes only when the target is
missing or is the shipped example; it will not overwrite an arbitrary exported
file. If you instead materialize a private copy by hand, set mode `0600` and
never commit it.

With a selected board and an explicit completion policy, `-doctor` checks the
actual MCP server and the board's completion requirements using the same
read-only checks as launch. Without a selected board, workflow compatibility
remains unverified. Executable discovery does not establish model-account or
repository write access; the report distinguishes those limits from verified
prerequisites.

Building the files yourself instead:

```bash
cd runner
cp configs/runner.example.yaml configs/runner.yaml
cp configs/mcp-config.example.json configs/mcp-config.json
# edit the annotated placeholders in both copies; never edit the examples
```

`configs/runner.example.yaml` is the annotated reference — every key on it exists
on the Go config struct, enforced by a drift test. A safer interactive
alternative is the local setup wizard, which can write the MCP config from a
published `uvx backplane-mcp` launch or from a Backplane checkout. With resolved
credentials and `uvx` on `PATH`, `backplane-runner -doctor -fix` can create a
missing conventional `mcp-config.json`; it never overwrites a non-template file.

### 3. Run it

```bash
read -s VALARIS_API_KEY && export VALARIS_API_KEY  # keeps the key out of shell history
make build                                         # -> ./bin/backplane-runner
./bin/backplane-runner
```

Run from a terminal with no flags and you get the **setup wizard**: it resolves
your identity from the credentials it finds, then walks mode → board → work
directory → coding agent, model and budget → MCP configuration → review. Boards come from a live
list showing loop state and ready-card counts, so you never paste a UUID. At the
end you can save a named profile and launch. A profile stores its secret in an
owner-only credentials file; its `runner.yaml` keeps the
`${VALARIS_API_KEY}` placeholder. `-interactive` forces the wizard when you are
passing other flags, but only when stdin and stdout are both TTYs.
Choose a profile inside the wizard. To run an exact `-config` or `-profile`
selection, omit `-interactive`; combining these selection modes is rejected
instead of ignoring the supplied config or profile.

The MCP step always lets you change the selected configuration. It shows its
absolute path and origin; use **Auto-find MCP configs**, enter a path, browse
files, or create one through `uvx` or a local `mcp-server` checkout. Discovery
lists candidates without starting their servers or displaying credentials.
The review screen lets you reopen this selection before launch.

Your explicit selection takes precedence over discovery. A loaded profile
retains its selected path when you start from another directory. If that file
is missing or malformed, choose a replacement; the wizard does not silently
switch to another project's configuration. Creating a config at an occupied
path requires a different destination or explicitly selecting the existing
file. The shipped example and an explicit Skip cannot launch a loop.

Generated `uvx` configs pin `backplane-mcp==0.8.0`. For a board with an explicit
completion policy, the loop checks the actual MCP launch environment, all five
completion tools, and `get_board_loop` before dispatching work. Missing packages,
tools, or incompatible policy responses stop setup before the next model call.
The launch log shows the resolved executable, server version, and config path.
If the pinned package is unavailable, select a config pointing at a qualified
local MCP artifact or regenerate after publication; the runner does not fall
back to an older package.

The runner also reads the backend's resolved completion-role requirements
before paid source work and independent review. It checks the configured
provider registry, required agent executables, structured-output support, git,
and direct validation executables. A missing capability stops launch with the
role and required remedy. Repository-relative validation scripts are checked
after exact checkout rather than searched for on the host's PATH. Deploy a
backend supporting `/completion/requirements` and `/completion/readiness`
before using this runner with an explicit completion policy.

Before each enabled loop cycle, the backend checks repository and pull-request
reads with the credential selected for that workspace and repository. Existing
completion candidates also require access to their exact PR. A rejected or
unverified required read stops the cycle before a completion claim or model
invocation. The report identifies the affected repository and whether the
credential comes from a workspace connection or the platform, without exposing
the token. Fix the indicated connection's repository access and pull-request
read permissions, then rerun doctor. These read-only probes do not establish
permission to push or merge; write access remains explicitly unverified.

For servers, containers, and anything reproducible, name the config explicitly —
this is the path Docker uses:

```bash
./bin/backplane-runner --config configs/runner.yaml
```

The runner appears in the **Runners** tab and flips to connected once it
heartbeats.

### Command-line surface

Go's flag parser accepts one or two leading hyphens; the canonical spellings
below match `backplane-runner -h`:

| Flag | Meaning |
|---|---|
| `-config <path>` | Use a YAML file. Mutually exclusive with `-profile`. |
| `-profile <name>` | Use the named profile under the config home, including its stored credentials. |
| `-discover` | Run one coding-agent discovery report through MCP, then exit. |
| `-doctor` | Run read-only local and selected-board checks, then exit. |
| `-fix` | With `-doctor`, create a conventional MCP config when the safe fix path applies. Alone it exits 2. |
| `-loop` | Bind to one board and run loop mode instead of the pipeline work loop. |
| `-loop-board <id>` | Select the board for `-loop`; overrides config/binding resolution. |
| `-keep-alive[=true|false]` | With `-loop`, override `loop_mode.keep_alive` for this process. |
| `-run-provider <provider>` | With `-loop` or `-doctor`, and `-run-model`, choose the source coding agent for this process only (`claude-cli` or `codex-cli`). |
| `-run-model <id>` | With `-loop` or `-doctor`, and `-run-provider`, use this concrete source model ID instead of the board's model or tier. |
| `-version` | Print version, source commit, and build time, then exit. |
| `-no-supervisor` | Disable panic recovery for debugging; `VALARIS_NO_SUPERVISOR=1` is equivalent. |
| `-verbose` | Emit debug logs with full UUIDs, paths, and internal IDs. |
| `-interactive` | Force the wizard when another flag is present; still requires TTY stdin and stdout. |

### Choose a model for this run

In the loop setup wizard, keep **Follow board settings** to retain normal
routing, or select **Choose a model for this run**. Choose the installed coding
agent and enter the exact model ID accepted by its CLI and your account. The
review shows the board request and your selection. This also works when the
board names a concrete provider/model rather than a tier.

For a non-interactive launch, pass both flags:

```bash
backplane-runner -profile my-runner -loop -loop-board my-board \
  -run-provider codex-cli -run-model your-model-id
```

The choice lasts for this process, including later iterations and keep-alive
resumption. Restart without these flags to follow the board again. It is not
saved in `runner.yaml` or a named profile, and never changes the board's loop
configuration. Board prompts, tools, budget and stop conditions still apply.
This choice applies to source loop sessions; it does not rewrite completion-role
or pipeline-stage models, remove configured providers, or select models for
subagents independently launched by the coding agent. A saved default provider
remains available for independent review even when source work uses an override.

Use a concrete model ID, not `low`, `mid` or `premium`. Both flags are required
and are accepted in non-interactive loop mode or with `-doctor` to check that
selection without starting work; the interactive wizard has its own selector.
Startup checks the selected coding-agent binary, but does not
prove that your account can use a model. If the CLI rejects that model, the
session fails through the normal loop failure handling; the runner does not
substitute another model. Execution records show the effective provider/model
and identify the per-run override alongside the board request.

Check the same selection before launching:

```bash
backplane-runner -profile my-runner -doctor -loop-board my-board \
  -run-provider codex-cli -run-model your-model-id
```

Repository shortcuts:

```bash
make doctor       # builds, then runs the runner's doctor with configs/runner.yaml
make discover     # builds, then runs discovery with configs/runner.yaml
make test         # out-of-tree Go suite; see Running the tests
make lint         # go vet ./...
```

`-doctor` inventories coding-agent binaries, checks git, probes `gh auth` as a
warning, reports Backplane credentials without printing the key, verifies
backend identity/budget, and protects the work-dir boundary. For a selected
board with an explicit completion policy it also starts the configured MCP
server for read-only compatibility checks, checks resolved workflow
requirements, and verifies the backend's repository and PR reads. It never
starts a coding agent, runs validation commands, or
clones/pushes a repository. A local `gh` login does not verify the credential
used by the backend merge queue. Doctor exits 1 if any check fails; a
warning-only verdict exits 0, so read the unverified items in its report.

**The wizard never runs without a TTY on both stdin and stdout.** Docker,
systemd, CI and piped invocations fall through to exactly today's behavior,
including today's errors — and not even `-interactive` overrides that.

From the repo root, `make runner-build`, `make runner-test`, and
`make runner-discover` wrap the same targets.

### Named profiles

The interactive wizard can save several runner identities on one machine. The
default store is `$XDG_CONFIG_HOME/backplane`, or `~/.config/backplane` when
`XDG_CONFIG_HOME` is unset:

```text
profiles/<name>/
├── credentials     # VALARIS_API_KEY/API_URL/WORKSPACE, mode 0600
├── runner.yaml     # non-secret config, key remains a placeholder
└── mcp-config.json # private copy of the selected MCP config, mode 0600
```

Use one non-interactively with `backplane-runner -profile <name>`. `-profile`
and `-config` are mutually exclusive. A profile's non-empty stored
`VALARIS_API_KEY`, `VALARIS_API_URL`, and `VALARIS_WORKSPACE` values win over
different process-env values, and the runner prints a warning for each ignored
env override. A bare interactive launch shows the profile picker and lets the
operator use, edit, or delete a profile. If no profile exists yet, legacy
root-level `credentials`, `runner.yaml`, and `mcp-config.json` files are copied
once into `profiles/default`; the originals remain for older binaries.

The profile's `llm.mcp_config_path` records the selected absolute path. An
external config remains an explicit reference; the profile's private copy is
not used as a silent fallback if that path stops working. Config selection
checks file structure; launch then verifies the actual MCP process and the
selected board's workflow before invoking a model.

### Docker

```bash
docker build -t backplane-runner .                        # claude only (default)
docker build --build-arg CODING_AGENTS="claude codex" -t backplane-runner .
```

`CODING_AGENTS` picks which agent CLIs get baked in: `claude`, `codex`, or both.
The image ships **no config** — mount the runner YAML and the MCP JSON it
references. The default command reads `/etc/backplane/runner.yaml`. There is no
TTY here, so the wizard never engages.

**Current compose limitation.** The `runner` profile in
`docker-compose.prod.yml` is **not runnable as shipped**. It mounts only
`runner.yaml`; the default YAML references an MCP JSON that the service never
mounts. `BACKPLANE_RUNNER_CONFIG` changes the YAML mount only, so it cannot close
that second-file gap. Treat the profile as unfinished until the compose service
gains an explicit MCP-config mount. Do not use a successful image build as
evidence that the runner started.

The image itself is usable by mounting both files explicitly. This example uses
the exported filenames after the MCP JSON has been materialized as a private
runtime file:

```bash
read -s VALARIS_API_KEY && export VALARIS_API_KEY
docker run --rm \
  -e VALARIS_API_KEY -e VALARIS_WORKSPACE \
  -e GH_TOKEN -e CLAUDE_CODE_OAUTH_TOKEN \
  -v "$PWD/runner-my-runner.yaml:/etc/backplane/runner-my-runner.yaml:ro" \
  -v "$PWD/mcp-config-my-runner.json:/etc/backplane/mcp-config-my-runner.json:ro" \
  -v backplane-runner-repos:/home/runner/.valaris/repos \
  backplane-runner \
  -config /etc/backplane/runner-my-runner.yaml
```

Set only the coding-agent and forge credential env vars your selected providers
need. The mounted MCP JSON must already contain a concrete agent key; exporting
`VALARIS_API_KEY` does not rewrite it. A Codex container also needs a prior
`codex login` identity mounted with
`-v "$HOME/.codex/auth.json:/home/runner/.codex/auth.json:ro"`; the current
runner does not wire API-key-only Codex auth. Private-repo git transport
must also be configured inside the container (for example, an HTTPS credential
helper backed by `gh`, or a forwarded SSH agent); `GH_TOKEN` alone is not a
plain-git credential helper. If the backend is
reachable only by a Compose service name, attach the container to that Compose
network and make the bundle's API URL resolvable from inside it.

## Configuration

Full annotated reference: **[`configs/runner.example.yaml`](configs/runner.example.yaml)**.
The sections, and what actually matters in each:

**`valaris`** — identity and scope for the runner's REST control plane.
`api_url` is used throughout the process for authentication, heartbeats,
platform/loop config, assignment and execution lifecycle calls. `api_key` and
`workspace_slug` are required. `board_ids` narrows which boards to watch (empty
= all). Roles are not here — they come from team membership, granted in the
wizard's Roles step.

**`llm`** — the coding agent. `provider` + `model` are the defaults;
`model_overrides` swaps model per pipeline phase. Three keys handle multi-agent
setups:

- `extra_providers` — additional agents to build *and preflight* at startup, so a
  pipeline stage that declares a non-default provider has a driver waiting.
- `tier_providers` — maps the backend's abstract tier (`premium`/`mid`/`low`) to
  *your* ordered local preference. The backend tier is intent; the runner owns
  the policy. A host with only `claude-cli` and one with only `codex-cli` can
  serve the same board with no backend change.
- `mcp_config_path` — required. This is the coding-agent session's integration
  surface: tools the model invokes flow through MCP, while the runner itself
  continues to use REST for orchestration.
  Like `git.base_dir`, a relative value resolves against the config file's own
  directory rather than the process CWD, and a leading `~` expands to your home
  directory — so the runner loads identically however it was launched.
  The runner pins `VALARIS_MCP_TOOLSETS=all` on every launch and in the
  generated template: the stage allowlist is the only narrowing, so a template
  that loads the server's interactive default hand never clips a stage's grant.
  An empty grant (a loop's `tools: []`) is the full platform surface: the
  launch still pins toolsets to `all` and writes no allowlist at all.

`max_budget_usd` sets the requested per-session dollar ceiling. Actual enforcement
depends on the provider and billing mode: subscription sessions and providers
without a dollar-cap capability treat it as advisory. Loop launches report
lifetime recorded cost (provider reports or runner estimates), the current budget
epoch's start, spend and remaining amount, and the session setting and enforcement
capability. Source and completion sessions use the same report. Restarting keeps
the current epoch; disabling and then re-enabling a loop starts a new epoch.
Missing or incompatible spending history blocks budget-dependent execution.

When an implement pass dies past
`budget_suspend_threshold` (default 0.9) of that cap, it's treated as a
checkpoint-and-resume rather than a failure, up to `budget_suspend_max_passes`
(default 5).

**`git`** — `base_dir` for clones, `branch_prefix` for runner branches, and the
forge seam. `forge` selects the one driver built at startup; `gitea` additionally
needs `forge_base_url` and `forge_token`. `review_mode` defaults to `platform`
(comment-only) because a single-identity install cannot approve its own PR;
`github` mode needs a second identity. `git.tokens` are per-role `GH_TOKEN`
overrides for the `gh` CLI and are a different thing from `forge_token`.

**`work_loop`** — polling cadence, per-card timeout, and idle backoff
(`idle_sleep` doubles up to `max_idle_interval`). One Loop always runs one
strategy tick at a time — `max_concurrent` is a deprecated no-op kept only so
old configs still parse.
Under `scheduling`, only `mode` is meaningfully yours to set; the platform's
`pipeline_config.scheduling` is authoritative for `priority_order`.

**`loop_mode`** — runner-local process behavior for `-loop`. `keep_alive:
false` exits when the board loop is disabled. `true` keeps the process alive,
heartbeating `idle_waiting` and waiting for re-enable without running a session
or spending budget. `-keep-alive` / `-keep-alive=false` override it for one
launch; safety-rail completion still exits.

**`daemon`** — `drain_timeout` grace on the first SIGINT/SIGTERM before in-flight
work is killed; `health_port` exposes `/healthz` (0 disables); `health_bind` scopes
which interface it listens on, defaulting to `127.0.0.1` because `/healthz` and
`/pollnow` are unauthenticated — set `0.0.0.0` only to deliberately expose them.

**`websocket`** — backend push events so the runner reacts faster than
`poll_interval`. On by default.

**`telemetry`** — OpenTelemetry tracing, off by default; `otlp` or `stdout`.

### Environment overrides

Four env vars win over the YAML, which is what makes one config file reusable
across hosts and containers:

| Variable | Overrides |
|---|---|
| `VALARIS_API_URL` | `valaris.api_url` |
| `VALARIS_API_KEY` | `valaris.api_key` (required — via env or file) |
| `VALARIS_WORKSPACE` | `valaris.workspace_slug` (required) |
| `VALARIS_WS_ENABLED=false` | force-disables `websocket.enabled` |

`ANTHROPIC_API_KEY` is deliberately *not* read from the environment — see the
auth note above. An inherited `CODEX_API_KEY` is likewise removed from the
Codex subprocess; use `codex login` until the runner exposes a supported
API-key configuration path.

## How it picks up work

The runner does not search the board and claim what looks good. It calls
`POST /api/workspaces/{slug}/agents/{id}/next-assignment` and the backend
scheduler hands back at most one reserved card, already filtered by role, column
type, labels, participants, and role-scoped preconditions, bundled with the
context needed to execute it (board, column, repo, default branch, stage action).
A `204` means no eligible work and the runner backs off. Arbitration lives on the
platform so two runners cannot race for the same card.

## Running the tests

```bash
make test
```

That target shells out to `../scripts/go-test-safe.sh`, which copies the tree to
a temp directory and runs `go test` there. **Never run a bare `go test ./...` in
this checkout**: the suite drives real `git` including `reset --hard`, and a
relative `git.base_dir` resolves against the process CWD — on 2026-07-27 that
rewound `main` and took 25 commits off the branch.

To qualify an already-built runner against the real backend API and disposable
database, run from the repository root:

```bash
cd backend
BACKPLANE_RUNNER_BIN=/absolute/path/to/backplane-runner \
  .venv/bin/python -m pytest -q -s tests/test_runner_readiness_artifact.py
```

This opt-in check reports the binary's version and SHA-256 digest. It exercises
server credential rejection, independent review, and exact-revision validation
with local Git repositories, fixture agents, and controlled forge responses. It invokes no
paid model and does not establish live forge write access.

## Further reading

| Doc | What's in it |
|---|---|
| [`docs/providers.md`](docs/providers.md) | Coding-agent and forge providers, per-stage mixing, merge mechanics |
| [`configs/runner.example.yaml`](configs/runner.example.yaml) | Annotated config reference |
| [`../docs/runner-runtime.md`](../docs/runner-runtime.md) | Historical smoke-session record; superseded for launch/config by this README |
| [`../docs/pipeline-config-reference.md`](../docs/pipeline-config-reference.md) | Historical pipeline reference; use the live platform config for current behavior |
| In-app documentation | Run the stack and open `/documentation` — Getting Started → Registering a Runner |

## License

MIT — see [`LICENSE`](LICENSE). The rest of the Backplane platform is
AGPL-3.0-or-later; the per-component map is in
[`../LICENSES.md`](../LICENSES.md).
