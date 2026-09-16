# Runner Runtime — Operator Reference

> **Status: Superseded and non-authoritative (2026-08-16).** This smoke-session
> notebook mixes retired runtime behavior with current commands. Use
> `runner/README.md`, `runner/configs/runner.example.yaml`,
> `docs/loop-mode-contract.md`, and `backplane-runner -doctor` for the supported
> operator flow. Historical details below must not be translated or treated as
> current guarantees.

Quirks and gotchas when running the `backplane-runner` Go binary against a live
Backplane platform. Distilled from smoke-test sessions.

## Launching

### Mode dispatch

The binary has three entry paths, resolved before config is loaded:

| Invocation | Mode | Notes |
|---|---|---|
| `./backplane-runner` (TTY on stdin **and** stdout) | Interactive setup wizard | Prompts for API key, workspace, and board; offers to save its own `runner.yaml`. Discovers only `runner.yaml` — never an exported `runner-<name>.yaml`. |
| `./backplane-runner --config <path>` | Headless run | Servers, containers, CI. No prompts. |
| `./backplane-runner -doctor` | Read-only preflight, then exit | See below. Never starts a coding-agent session, never spends. |

Without a TTY on both streams the wizard never runs — Docker, systemd, CI, and
piped invocations fall through to headless behavior, including today's errors,
and not even `-interactive` overrides that.

### Doctor preflight — start here when something is wrong

```bash
./backplane-runner -doctor
```

Checks coding agents on `PATH`, git, the forge CLI and `gh auth`, resolved
credentials (masked, plus which source each came from), backend reachability
with runner identity and budget, MCP config validity, and whether the work dir
is safely outside any git worktree. It never starts a coding-agent session and never spends.

**It exits 1 if any check fails, so it is CI-gate-shaped** — drop it into a
provisioning job to fail a broken machine before a run burns budget on it.
`-doctor -fix` additionally writes a working `mcp-config.json` when none is
configured (needs resolved credentials and `uvx` on `PATH`); `-fix` without
`-doctor` is an error. Doctor also runs as a step inside the setup wizard.

### Config path

The runner reads config via the `--config` flag, **not** `VALARIS_CONFIG` env:

```bash
./bin/backplane-runner --config /path/to/runner-config.yaml
```

Empty flag fails with `valaris.workspace_slug is required`.

### Environment files

The runner's config resolves `${VALARIS_API_KEY}` from process env at launch,
so the env must be populated before `./bin/backplane-runner` runs:

```bash
set -a && source runner/.env && set +a
./bin/backplane-runner --config runner/configs/alpha-validation.yaml
```

**Warning:** a checkout can accumulate two `.env` files with different API
keys:
- the repo-root `.env` — legacy, may hold a key for a deactivated runner.
- `runner/.env` — the one the runner actually needs.

Sourcing the wrong one fails at boot with
`fetching platform config: valaris API error (HTTP 404): No agent linked
to this API key`. Always source the runner-local `.env`.

### API key linkage

Each `backplane-runner` process authenticates as one runner, identified by the
`api_key` it sends. The runner's row in the `agents` table points to an
`api_keys.id` via `api_key_id`. If the on-disk key prefix doesn't match
the runner's linked key, the runner can't be found.

Relink via SQL (MCP `update_agent` blocks on ownership when called from
a different principal than the runner's `created_by_id`):

```sql
-- Find the API key you want to use:
SELECT id, name, key_prefix FROM api_keys WHERE key_prefix = 'vlr_xxxx';

-- Link it to the runner:
UPDATE agents SET api_key_id = '<api_key_uuid>' WHERE id = '<agent_uuid>';
```

Verify with `curl -H "Authorization: Bearer <key>" .../api/agents/me` —
should return the runner record with the right name and budget.

## Budgets

### Server budget vs. per-process cap

Two independent limits:

1. **`agents.budget_usd`** in the backend — total lifetime spend cap the
   server enforces via 402 Payment Required on LLM call recording.
2. **`llm.max_budget_usd`** in the runner YAML — per-process cap enforced
   client-side; the runner halts when exceeded.

Both must be set generously enough for the session. Typical Alpha smoke
test runs cost under $5 end-to-end; the per-process cap of $15 and a
server cap of $45 have been comfortable headroom.

### Bumping budget

```sql
UPDATE agents SET budget_usd = 60 WHERE id = '<agent_uuid>';
```

MCP `update_agent` will return 404 `Agent not found` when the MCP session
principal differs from the runner's `created_by_id`. Fall back to SQL.

## Loop behavior

### Tick cadence

`work_loop.poll_interval: "30s"` in YAML controls how often the runner wakes
up. Each tick cycles through all configured roles in `priority_order`.
A role finding no claimable work takes ~250ms to fast-forward (T2.4).

### What "no work" means per role

- **Implementer**: no cards with `role:implementer` label in a backlog
  column (alpha-validation requires this label; see T1.1 for removal).
- **Reviewer**: no cards in a `review` column that the reviewer hasn't
  already ticked (`skip_if_participant_role: reviewer`).
- **Documentator**: no cards in a `done` column without the `documented`
  label.

### Clone dir reuse

The runner clones each repo once into `<git.base_dir>/<repo_name>/` and
reuses it across ticks. To force a fresh clone (e.g., to re-run
`EnsureBranchProtection`), move or remove the dir:

```bash
mv runner/repos-alpha/smoketest-st12 /tmp/smoketest-st12-backup
```

The working tree isn't precious — the runner syncs from `origin` on every
tick and discards untracked artifacts.

## Rebuild vs. restart

Code changes to the runner require a rebuild:

```bash
cd runner && go build -o bin/backplane-runner ./cmd/backplane-runner
```

Platform config (prompts, pipeline, team composition) is fetched from
the backend over WS every tick; editing a prompt config in the DB or
frontend takes effect on the next `platform config changed` tick — no
rebuild needed.

## Monitoring a run

The runner writes structured logs to stderr. Useful filters:

```bash
# All key lifecycle events
tail -f runner.stderr | grep -E "found card|card claimed|stage completed|llm cost|WARN|ERROR"

# Auto-merge chain specifically
tail -f runner.stderr | grep -E "ensured branch protection|pr merge|auto-merge"

# Cost tracking
grep "llm cost" runner.stderr | awk -F'cost_usd=' '{sum += $2} END {print sum}'
```

Backend events with `VALARIS_EVENT_LOG=1` set in the backend container
surface structured event-bus records on stdout — useful for cross-system
correlation. See WS-6 in plan.md for details.

## Related docs

- `auto-merge-loop.md` — what the runner configures on GitHub and why.
- `pipeline-config-reference.md` — YAML schema for `work_loop`, `llm`, etc.
- `smoke-test.md` — full end-to-end platform validation recipe.
