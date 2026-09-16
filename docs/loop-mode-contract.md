# Loop Mode — Platform Contract

Implementation spans the runner, backend, and frontend in this repository. This
document is the current cross-component contract: persisted board config,
runner process behavior, API semantics, status projection, and landing rules.

How to *drive* a loop — prompt tuning, card authoring for parallel work, forge
sharp edges, autonomy postures — lives in `docs/loop-operator-playbook.md`.

The legacy landing rules below apply when no effective `completion_policy` is
selected. [Explicit policy](#explicit-landing-and-completion-policy) takes precedence
for opted-in boards.

## What it is

Loop mode is a third way to run the Backplane runner, alongside the pipeline workloop
and `-discover`. Started with `-loop`, the runner binds to one board and repeats:

```
fetch board loop config ──▶ enabled? ──no──▶ keep_alive? ──no──▶ clean exit
        ▲                     │yes                │yes             (log disabled_reason)
        │                     │                   └──▶ idle: heartbeat, wait, re-fetch
        │                     ▼
        │            run ONE headless coding-agent session
        │            (provider abstraction: claude-cli / codex-cli / …)
        │                     │
        └──── delay ◀── safety rails (budget, iterations, failures)
```

The loop's brain is the *prompt*, not the runner: the operator-authored `loop_prompt`
tells the runner what to do each iteration and instructs it to turn the loop off (via
the `set_board_loop` MCP tool) when the objective is complete or something blocking
surfaces. The runner is a thin, governed executor — all behavior is platform config.

Loop mode does not touch the scheduler: no `next_assignment`, no card reservation, no
pipeline stages. A board can run loop mode with or without a pipeline configured.

## Config schema

Stored on the board, served verbatim (what you PUT is what GET returns). Fields you omit
from a PUT keep their current stored value — see `PUT /loop` below — so only a board's
first-ever PUT actually gets the defaults in this table:

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `false` | The loop on/off flag. Checked by the runner before every iteration. |
| `provider` | string | `""` | Coding-agent suggestion (`claude-cli`, `codex-cli`, …). Free string — never a closed enum. `""` = runner's default. |
| `model` | string | `"mid"` | Tier alias (`premium`/`mid`/`low`) **or** concrete model id. Tier→local-agent policy is owned by the runner's `llm.tier_providers`, same as pipeline stages. |
| `system_prompt` | string | `""` | Passed to the coding-agent session's system prompt. Template vars below. |
| `loop_prompt` | string | — | **Required non-empty to enable.** The per-iteration user prompt. Template vars below. |
| `tools` | []string | `[]` | MCP tool allowlist (`mcp__valaris__*` names). Empty = full platform surface (runner's safety deny-floor still applies). |
| `max_iterations` | int | `25` | ≥1. Hard cap per runner process. |
| `iteration_delay_seconds` | int | `30` | ≥0. Cooldown between iterations. |
| `iteration_timeout_seconds` | int | `3600` | ≥1. Per-session context timeout; a timeout counts as a failed iteration. |
| `budget_usd` | float | `20.0` | >0. Cumulative cost cap across the loop run. |
| `max_consecutive_failures` | int | `3` | ≥1. Errored/empty/timed-out iterations in a row before the runner stops. |
| `max_blocked_on_human` | int | `3` | ≥0. Consecutive sessions reporting `outcome=blocked_on_human` before the runner disables the loop with a reason naming the blocker (outcome→transition table below). **0 opts out** — `blocked_on_human` then only parks. A pre-rollout backend serving no such field decodes to 0, i.e. the pre-card-102dc48e behavior. |
| `starvation_policy` | string | `"park"` | `park` or `always_run`. Under `park` the runner pre-flights `GET /loop/readiness` each cycle and parks for free when nothing is actionable; `always_run` preserves v1 launch-every-cycle behavior for loops whose prompt does non-card work (docs/triage loops). Stored configs written before this field existed are backfilled to `park` on the next save and served as `park` by the read schema meanwhile. |
| `budget_epoch` | string\|null | `null` | **Server-owned** (like `version`/`updated_at` — a PUT carrying it 422s). Stamped on every disabled→enabled transition (PUT or PATCH `/state`); config edits while enabled and disabled saves preserve it. Defines the budget window: the runner seeds `spent` from cost since this instant, so **re-enabling the loop is the operator's budget reset lever**. |
| `loop_landing` | string | `"human"` | `human`, `self_merge` or `merge_queue`. Names WHO lands a green PR, so the config and the prompt can be read against each other. Under `human` (the stored default) PRs land when a person merges — the reconciler still moves the card. Under `self_merge` the loop runner merges its own PR into the integration branch with plain git and moves its own card; no platform actor is involved, so this value grants nothing and opts into nothing — it is the honest name for what a self-merging prompt already does, and it is what Coding Loop v2's default LANDING variant renders. Under `merge_queue` loop runners may call the `enqueue_pr_for_merge` MCP tool and the platform's own merge executor lands the PR (any GitHub plan; CI gate per `merge_gate` below) — per-board OPT-IN for autonomous landing (owner decision 2026-08-07). Server-enforced: a RUNNER enqueue on a loop-configured board whose landing is anything but `merge_queue` is rejected with `loop_landing_not_enabled`. Backfilled like `starvation_policy` for pre-field stored rows. |
| `merge_gate` | string | `"forge_ci"` | `forge_ci` or `none`. What the merge executor requires before landing this board's queued PRs. Under `forge_ci` (default) the forge's CI must be green on the PR head (the `require_ci_green` pre-flight below). Under `none` the CI read is skipped entirely and the queue rebases + merges immediately — for repos without a usable forge CI (e.g. GitHub free-plan orgs where Actions cannot run); the board's review flow is the quality gate. Forge CI is a *desirable*, never a platform dependency. Resolved LIVE per tick from the board's stored config — flipping it unsticks already-queued entries on the next tick, no re-enqueue needed. Fail-closed: an unreadable or unrecognized policy behaves as `forge_ci`. Backfilled like `starvation_policy` for pre-field stored rows. |
| `completion_query` | object\|null | `null` | `{"label": ..., "exclude_column_type": "done"}` or null (off). The run's DECLARATIVE completion condition, evaluated by the runner in code (§ Run-complete pre-flight below). Server-validated: `label` non-empty, `exclude_column_type` must be `"done"`, no other keys — an unknown key would be a silently narrower filter, i.e. a false run-complete. On PUT, `{}` CLEARS it; an omitted field (and an explicit null) means unchanged, like every other field. |
| `template` | object\|null | `null` | Read-only on GET, three-state on PUT (see the matrix below). Present when the board's prompts are RENDERED from a loop template rather than hand-written: `{source: "system"\|"workspace", ref: <slug\|uuid>, version: int, drift: {kind: "none"\|"template_newer", current_version?: int}}`. Deliberately slim — the slot values that produced the prompts are authoring state and live on `GET /loop/binding`, not on the object the runner decodes. The runner ignores this key entirely; the rendered `system_prompt`/`loop_prompt`/`tools` are the whole contract as far as it is concerned. `drift` is computed per read, not stored: a system template bumped by a deploy must show as drifted without anyone re-saving every bound board. |
| `disabled_reason` | string\|null | `null` | Why the loop was last turned off (written on every disable — by humans, by runners, or by the runner's own safety rails). |
| `version` | int | `1` | Increments on every successful mutation. `PUT` accepts optional `expected_version` for optimistic locking. |
| `updated_at` | datetime | — | Server-stamped. |

Prompt templating (runner-side, Go `text/template`): `{{.Workspace}}`, `{{.BoardID}}`,
`{{.AgentID}}`, `{{.ExecutionID}}`, `{{.Iteration}}` (1-based). These five are the whole
vocabulary — loop mode fills exactly them and nothing else. The authoritative list is the
backend constant `LOOP_RUNNER_VARS` (`app/services/loop_config_validation.py`), served on
`GET /api/workspaces/{slug}/loop-templates` as `meta.runner_vars` and drift-tested against
`runner/internal/workloop/testdata/loop_runner_vars.json` from both sides. Any other
`{{.Name}}` is **rejected at save time** with `unknown_runner_var` (see below), because at
render time the two failure modes are not equally visible. The runner builds its
`PromptContext` from a struct shared with pipeline mode, so a pipeline-only field —
`{{.CardID}}`, `{{.Branch}}`, `{{.PRURL}}` — *exists* and loop mode simply leaves it at its
zero value: Go renders it as an empty string and reports nothing, so the prompt silently
loses a sentence and the iteration burns anyway. Only a name absent from the struct
entirely (`{{.Bogus}}`) is a render error the runner counts as a failed iteration. Neither
has a valid loop-mode meaning, so both are refused before they can be stored.

### Template binding on PUT /loop

A board's prompts are either HAND-WRITTEN (raw) or RENDERED from a loop template
(bound). Binding renders at **save** time — the template's prompts, its `tools`, and its
rails are resolved with the supplied slot values and stored as ordinary loop_config
fields, so the runner keeps reading exactly what it always read.

| `template` in the body | Board state | Result |
| --- | --- | --- |
| absent, or `null` | either | Unchanged — the same "omission means inherit" rule every other field follows. A client that serializes all fields with nulls cannot accidentally unbind. |
| `{source, ref, version?, slot_values}` | raw | **Bind**: render, store the prompts/tools, seed the template's rails, write the binding row. |
| same | bound | **Re-render**: same, but the board's CURRENT rails are kept (see precedence below). |
| `{}` | bound | **Detach**: the binding row is dropped and the last-rendered prompts stay behind as ordinary raw text. The rest of the body is then processed as a normal raw PUT, so detaching and hand-editing in one request works. |
| `{}` | raw | No-op, 200 — detaching twice is a retry, not an error. |

Two bodies are refused before any render work:

| Code | Status | When |
| --- | --- | --- |
| `template_and_raw_prompts` | 422 | The body both binds a template AND sets `system_prompt`/`loop_prompt`/`tools`. The render would overwrite the text the caller just sent, so the request contradicts itself. Rails in the same body are fine — those stay the operator's. |
| `board_bound_to_template` | 409 | The board is bound and the body sets `system_prompt`/`loop_prompt`/`tools` with no `template` key. The edit would survive only until the next re-render. The detail names the fix: send `template: {}` first. |
| `new_required_slots_unfilled` | 422 | A re-render moves a bound board to a template version that added slots which are `required` and were NOT required at the bound version, and the request supplies no value for them. Rendering anyway would leave `<<SLOT>>` literals in the prompt — caught downstream by `unrendered_slot`, but with a message about placeholder text rather than about the upgrade that introduced them. `field` is `template.slot_values` and `value` carries the unfilled names. Raised only on the version CHANGE: re-rendering at the same version cannot introduce a new requirement. |

Rails precedence, since it is the one genuinely ambiguous part:

- **First bind** — `rails_defaults` < the selected variant's rails < `derived_rails`; and a
  rail the SAME request sets explicitly beats all three (the operator typed it here on
  purpose).
- **Re-render** — the board's current rails are KEPT, so an operator who tuned `budget_usd`
  after binding does not silently lose it. `derived_rails` is the exception and is
  re-applied, because it is a function of the slot values being re-rendered:
  `completion_query.label` derived from a `<<RUN_LABEL>>` slot must never disagree with the
  prompts that name it.

`GET /loop/binding` (any workspace member) returns the authoring state behind a bound
board: `{template, slot_values, rendered_at, rendered_hash, drift: {kind, bound_version,
current_version}}`. A raw board answers 404 `not_bound`.

Every iteration a bound board runs stamps its execution with
`prompt_slug = "loop-template:<source>/<slug>@<version>"`. This reuses the existing
`prompt_slug` column rather than adding one (operator Direction 2026-08-16), because
the column already means "the prompt the runner rendered" and the activity feed already
displays it; the `loop-template:` prefix keeps the namespace clear of pipeline prompt
slugs. The stamp lives on the durable execution row, never on the binding, so a
template's track record survives detach, rebind, and version upgrades. Writer and
reader both go through `app/services/loop_template_stamp.py` so the key format cannot
drift between them.

The manager UI for all of this is the Runner console's **Loops** tab
(`/:slug/runner/loops`, detail at `/:slug/runner/loops/:templateRef/:tab?`). The
template REST surface (`/loop-templates*`, board-scoped fit/preview, and the
`/loop/binding` reads) is `public` per `docs/api-surfaces.md`; loop CONTROL — `PUT
/loop`, `PATCH /loop/state`, readiness — stays `internal`. Full design of record: spec
note `f52328b3` on the Backplane board.

### Save-time validation errors

`PUT /loop` and `PATCH /loop/state` share one validator, so every code below is raised on
both paths (and therefore on MCP `set_board_loop`, which PUTs). A 422 carries
`detail: [{code, field, message, value}, …]` and stores nothing.

| Code | Field | When |
| --- | --- | --- |
| `unrendered_slot` | `system_prompt`, `loop_prompt` | The prompt still contains a literal template slot matching `<<[A-Z][A-Z0-9_]*>>` — i.e. a template was stored without being rendered, and the runner would ship the placeholder to the agent verbatim. Checked on every save, enabled or not: what is stored today is what the next enable ships. The grammar is uppercase-only and bracketed so `cat <<EOF` and `2>>log` stay legal prompt text. |
| `off_switch_removed` | `tools` | `enabled` is true and a NON-EMPTY `tools` allowlist omits `mcp__valaris__set_board_loop` — the loop would have no way to stop itself. An empty allowlist means the full platform surface and is always fine. There is no override flag, by design. |
| `prompt_too_large` | `system_prompt`, `loop_prompt` | The prompt exceeds 64 KiB measured in **utf-8 bytes** (not characters — the runner ships the string over the wire every iteration). Exactly 64 KiB is accepted. |
| `unknown_runner_var` | `system_prompt`, `loop_prompt` | The prompt uses a `{{.Name}}` outside `LOOP_RUNNER_VARS` — either a pipeline-only `PromptContext` field, which would render EMPTY and never report anything, or a name absent from the struct, which errors at render time. `value` carries every unsupported name in the field, sorted; the message names the first. The trim and whitespace forms (`{{- .X}}`, `{{ .X }}`) are read too, so a typo cannot hide behind spelling. Checked on every save, enabled or not — a disabled save is otherwise how an unsupported name would be staged for a later enable. |

When `tools` is non-empty the runner appends a `## Tools available` block to the rendered
`loop_prompt`, listing the granted names verbatim plus the `ToolSearch("select:<name>")`
escape hatch. It is appended *after* templating, so operator templates need no change and
cannot omit it; an empty `tools` leaves the prompt untouched.

The board schema above is platform-owned. One runner-local YAML setting controls
only the lifetime of the process:

```yaml
loop_mode:
  keep_alive: false  # true waits when this board is disabled; false exits
```

`-keep-alive` overrides it to `true` for one launch, while
`-keep-alive=false` explicitly overrides a profile/YAML value back to `false`.
The flag has no effect unless `-loop` is also selected.

## Runner behavior (implemented — normative for the other halves)

### Invocation-only model selection

The setup TUI defaults to **Follow board settings** and offers **Choose a model
for this run**. The CLI equivalent is `-loop -run-provider <provider>
-run-model <concrete-id>`; both selection flags are required and are invalid
in discovery, doctor, pipeline or forced-interactive invocations.

The explicit pair takes precedence over the board provider/model and tier
routing for every iteration of that process, including keep-alive resumption.
It never changes board configuration or saved profile/YAML defaults. The
request is process-local, not a new board field or persistent YAML option.
Without it, existing board and tier resolution is unchanged. Restart without
the choice to restore normal routing; changing the board model does not erase
an active per-run choice.

Only the explicitly selected coding-agent provider must be built/preflighted
for this path. Missing providers and malformed selections fail rather than
falling back. Model IDs are open strings accepted by the selected CLI; tier
aliases are invalid as explicit model IDs. Binary preflight does not establish
account entitlement or model availability. Provider execution errors retain
the existing failure rails, with no automatic model substitution. Prompts,
tools, budgets, scope, cancellation and the board off-switch remain in force.
Each execution records the effective provider/model; the input summary and
logs retain the requested board pair and the explicit choice's source.

### Iteration lifecycle

1. **Board resolution**: `-loop` requires a board: `-loop-board <id>` flag, else the sole
   entry of `valaris.board_ids`, else the runner's platform `board_id` binding. None or
   ambiguous → fatal with an actionable message. Board selection has no separate
   loop-mode YAML field; `loop_mode.keep_alive` controls process waiting, not which
   board is selected.
2. **Requires a RUNNER key**: `valaris.api_key` must resolve to a runner. Every write the
   loop makes (`LogExecutionStart`, `LogExecutionUpdate`, `FailExecution`) is recorded
   *under the runner*, so a user/personal key — which resolves no runner — has nothing to
   write against. The runner fails fast before the first iteration rather than looping
   with no execution trail: previously the empty ID built `POST /api/agents//executions`,
   which 405s on every write while the loop kept spending. The client now refuses any URL
   containing an empty path segment, so this class of bug cannot recur silently.
3. **Fetch every iteration**: `GET /loop` at the top of each cycle — this doubles as the
   on/off check after the previous session finished, and means config/prompt edits apply
   on the next iteration without a runner restart. There is **no hardcoded fallback
   config** — the platform is authoritative, the runner refuses to run without it.
   HTTP 404 is fatal, and the runner distinguishes two causes by whether the response
   body carries an `error_code` (an application `ValarisError`) or not (FastAPI's
   catch-all for an unrouted path):
   - **Board not configured** — a real board never PUT a loop config, or a wrong/deleted
     board ID, or a workspace/board mismatch. Fix: check `-loop-board` and the workspace
     slug, or PUT a loop config for the board.
   - **Endpoint unsupported** — a pre-rollout backend that doesn't serve `/loop` at all.
     Fix: upgrade the backend.
4. **Safety rails** (each one *disables the loop through the API* with a machine-readable
   reason, so the board shows why it stopped): `max_iterations reached (N)`,
   `budget_usd exhausted ($X of $Y)`, `N consecutive failed iterations`. A success
   resets the failure counter. Operator interrupt (SIGINT/SIGTERM/ctx cancel) exits
   cleanly **without** flipping the flag — stopping the process is not finishing the job.
5. **Provider/model**: the runner builds the same dispatch triple used by pipeline
   assignments (`provider`, `model`, `tier` if `model` is a tier alias) and routes it
   through the existing tier remap; if the remap picks a different local agent than the
   suggestion, the runner substitutes its own configured model (model-follows-provider).
   A tier alias is **never** sent to the coding agent as a literal model id: loop
   configs are served verbatim (pipeline assignments arrive pre-resolved by the
   backend), so when an alias survives resolution the runner substitutes its own
   configured model (empty = the provider's default).
6. **Run-complete pre-flight** (`completion_query`, opt-in): every curated run
   has the same completion condition — zero cards carrying the run label
   outside Done. Configured, the runner evaluates it against
   `GET .../cards/search` at the TOP of each cycle, before readiness, before
   the iteration counter moves, and before any session is spawned: zero
   matches → **disable** with `run complete: completion_query returned 0
   (<label>)` and exit. A finished run therefore costs one HTTP GET rather
   than a full LLM session, and the verdict no longer depends on the model
   remembering to check. Absent (`null`), none of this runs and the loop
   behaves exactly as it did before.

   The same query VERIFIES a session's `objective_complete` claim: with a
   query configured the board is the authority and the session is a witness.
   A claim the query refutes (cards still match) counts the iteration as
   **failed** — a model stuck on "we're done" burns the failure breaker
   instead of looping forever — and the loop continues.

   Probe failures take OPPOSITE safe directions at the two call sites, both
   toward the reversible outcome: the pre-flight fails **open** (a search
   outage must never end a run) while the verify fails **closed** (an
   unverifiable completion is not a completion).
7. **Pre-flight + park** (`starvation_policy: "park"`, the default): after the
   config/enabled check and the rails, the runner probes `GET /loop/readiness`.
   `actionable: false` → **park**: no session, no iteration number consumed, no
   budget spent, no failure-counter interaction, and NO execution row (per-probe
   rows would spam the feed — visibility is one log line per parked cycle, with
   blocked/awaiting-merge/open-PR counts, plus the heartbeat, which reports
   `loop_state: "parked"` with a reason so the board can show parked rather
   than guess at it). Park sleeps `iteration_delay_seconds`,
   doubling per consecutive parked cycle, capped at 10× (`parkDelay`); a zero
   delay stays zero — the probe is one HTTP GET. Probe failure modes: a 404
   (pre-rollout backend without the route) latches a fallback to always_run
   with one WARN; any other probe error fails OPEN — the iteration runs and the
   next cycle probes again. ctx cancellation during a park sleep exits cleanly
   without flipping the flag, same as the iteration delay.

   **Keep-alive** (`loop_mode.keep_alive`, default `false`; `-keep-alive` or
   `-keep-alive=false` to override per run) changes what a *disabled* board
   means to a running process. Off — the historical behaviour — the runner logs the
   `disabled_reason` and exits 0. On, a loop-off is a **pause**: the runner
   stays up, heartbeats `loop_state: "idle_waiting"` with the board's
   `disabled_reason`, and re-fetches until the loop comes back. It runs no
   session, consumes no iteration, spends nothing, and writes no execution row
   — the same zero-cost shape as a park.

   Two constraints make it safe:

   - **The idle branch sits ABOVE the rails, and that is deliberate.** Rails
     (`budget_usd`, `max_iterations`, `completion_query`, `blocked_on_human`)
     disable the board *through the same flag* an operator uses, so ordering is
     the only thing separating "paused" from "finished". They fire on the cycle
     that spots them and return from there, so a rail-tripped run never reaches
     the idle branch. A keep-alive runner must never resurrect a
     budget-exhausted or completed run.
   - **Waking re-seeds continuity.** Re-enabling a loop opens a fresh
     `budget_epoch` server-side, so the `spent` this process accumulated belongs
     to a closed epoch. The runner drops its seed on wake and re-reads
     `GET /loop/history`; without that it would charge the new run for the old
     one's money and trip the budget rail on the first post-wake cycle.

   Pacing is `30s` then `60s`, and the ceiling is **not** operator-tunable: it
   is pinned below the backend's `ALIVE_THRESHOLD_SECONDS = 90`, because every
   idle tick heartbeats and a longer gap would make a healthy waiting runner
   read `offline`. The real wake is the WebSocket — under keep-alive, loop mode
   starts an events client subscribed to `board.*` and wakes on
   `board.loop_updated` for its own board with `enabled: true`. That payload
   carries no `actor_id`, so the client's self-filter is inert for it and the
   `enabled == true` gate is the only thing keeping the runner's own
   rail-tripped disable (which publishes `enabled: false`) from waking it
   straight back up. The poll is the fallback; SIGINT during an idle wait exits
   cleanly without flipping the flag.

   Deploy note: `idle_waiting` is a new heartbeat literal. A backend that
   predates it rejects the value with a 422, so the runner latches to `parked`
   for the process lifetime on the first rejection **and re-sends immediately in
   the same tick** — deferring the retry to the next backoff would gap ~120s,
   past the 90s liveness threshold, and flicker the runner offline once.
   `/loop/status` still resolves to `off` while a keep-alive runner idles
   (the board loop *is* disabled); that is correct and intentional.

   **Structured outcome backstop**: when the provider supports structured
   output, every loop session carries an output schema
   `{outcome: worked | nothing_ready | blocked_on_human | objective_complete,
   summary}` (OpenAI structured-output rules — `required` lists every property
   — so the same schema serves claude `--json-schema` inline and codex
   `--output-schema` by file). The parsed outcome is recorded on the execution
   row's summary (`outcome=… cost=… duration=… — …`). No outcome ever counts
   toward the failure rail — an honest verdict is a successful iteration.
   Providers without structured output run without the schema; the probe alone
   drives parking there.

   **Outcome → transition table (the authoritative exit contract).** The
   session REPORTS state; the harness OWNS the transition. This is a rail in
   code, not a directive the model executes through a tool grant — the model
   asking to stop and the loop stopping are two different things, and three
   runs (Loop #1, Loop #2, a field run on 2026-08-09) burned iterations on the gap between
   them.

   | reported `outcome` | iteration failed? | transition |
   |---|---|---|
   | `worked` | no | continue; resets the blocked streak |
   | `nothing_ready` | no | **park** per `starvation_policy` (`parkDelay` backoff); never disables |
   | `blocked_on_human` | no | **park**, and increment the blocked streak; on the `max_blocked_on_human`-th consecutive one, **disable** with `N consecutive iterations reported blocked_on_human: <summary>` |
   | `objective_complete` | no | with no `completion_query`: **disable immediately** with `run complete (reported by iteration N): <summary>`, then exit cleanly. With one: the claim is verified against the query first — confirmed → disable as above; refuted or unverifiable → the iteration counts **failed** and the loop continues |
   | *any* | **yes** | the verdict is DISCARDED — a provider error or timeout can carry any structured payload, so a failed session can neither stop the run nor advance the blocked streak. The failure rail (`max_consecutive_failures`) governs. |

   Disable-on-outcome goes through the same credentialed `PATCH /loop/state`
   as every other stop, so board activity, `disabled_reason`, and telemetry are
   identical to a tool-driven or rail-driven disable — only the reason text
   differs, and only because it is finally the TRUTH rather than the name of
   whichever rail happened to trip first. Session summaries are trimmed to 300
   chars in the reason (it is a board chip, not a transcript).

   `max_blocked_on_human` (config, default 3) is the streak threshold; **0
   opts out** — `blocked_on_human` then only parks, forever, which is also
   what a pre-rollout backend serving no such field decodes to.
8. **Two budgets, one effective cap.** The board's `budget_usd` is the
   *cumulative* rail across the loop run, enforced by the runner. The runner
   YAML's `llm.max_budget_usd` is a *per-session* ceiling. Each session is
   handed `min(budget_usd − spent, llm.max_budget_usd)` — the **remaining**
   budget, never the full one, so the cap tightens with every dollar spent and
   a late session can overshoot the board budget by at most one session AT the
   cap. Every iteration logs a `loop budget` line before the session (board
   budget, spent, remaining, effective session cap and which term is binding),
   and crossing 80% of either the board budget (cumulative) or the session cap
   stamps a `budget warning: $X of $Y (Z%)` into the execution row's summary —
   the loop feed is where the operator looks between iterations. Every exit
   path logs a `loop spend recap` (spent, budget, iterations).

   **Enforceability, per provider** (the honest part): the session cap is only
   as real as the CLI behind it. `claude` accepts `--max-budget-usd`, but it
   meters **API-billed dollars only** — under subscription/OAuth auth the
   CLI's own cost counter stays 0 and the cap cannot cut a session off
   (field-verified: a $31 rate-sheet-estimated session sailed under a $10
   cap). `codex` (0.144.1) has **no budget flag at all** — the cap is advisory
   there. The runner surfaces this as the `BudgetCap` provider capability and
   logs ONE loud WARN per run when the cap cannot be enforced (non-capable
   provider, or capable-but-subscription-auth) — the cumulative rail, which
   the runner enforces itself from provider-reported or rate-sheet-estimated
   costs, is the backstop that always works.
9. **Cross-run continuity.** At startup (once per process, after the first
   config fetch) the runner seeds from `GET /loop/readiness`'s sibling
   aggregate `GET /loop/history` →
   `{iteration_count, spent_usd, budget_epoch}`:
   - `{{.Iteration}}`, execution rows, and logs use the GLOBAL number
     (all-time `iteration_count` + this process's count) — monotonic across
     restarts, so note titles derived from it never collide.
   - `spent` starts at `spent_usd` — the sum of structured `cost_usd` over
     the board's `loop_iteration` executions SINCE `budget_epoch` (all-time
     when null), aggregated server-side (the executions list endpoint is
     limit-capped; a lower-bound sum on money would under-enforce the rail).
     A crash-restart loop can no longer launder money already spent this
     epoch — a seeded spend past `budget_usd` trips the rail before any
     session runs.
   - **`max_iterations` stays per-process** — it is a runaway guard, not
     money; a restart may always run again. `budget_usd` is genuinely
     cumulative since the epoch.
   - Seeded values are logged at startup (`loop mode: continuity seeded`).
     History fetch failure (pre-rollout 404 or transient error) → WARN +
     zero-seed, exactly the pre-continuity behavior, never fatal.
10. **Sessions are fresh each iteration.** Durable memory is the board itself, via MCP.
   (A `resume` mode is a possible v2 field; deliberately out of v1.)
11. **Working dir**: `<git.base_dir>/loop/<board_id>` — created if missing, stable across
   iterations, never a live repo checkout.
12. **Execution logging**: each iteration logs an AgentExecution (`action:
   "loop_iteration"`, **no card**) at start, stamping the RESOLVED provider/model
   (post tier-remap — never a tier alias) rather than empty strings. The completion
   PATCH carries the human-readable summary plus structured `tokens_used`
   (input+output), `cost_usd` (provider-reported, or rate-sheet estimate when the
   provider is cost-blind), and `duration_seconds` — for both a successful and a
   failed iteration that reached the provider, since a failed session still spent
   real tokens. An early failure that never reaches the provider (template render,
   working-dir error) completes with status+summary only — there is no real Result
   to report numbers from, so the runner omits the metrics keys rather than send
   fabricated zeros. Logging failures are warnings — observability must never stop
   the loop; rails/budget enforcement live entirely in the runner, these backend
   fields are observability only.
13. **Heartbeat** per iteration keeps runner presence fresh AND claims the
    board: every loop-mode tick sends `loop_board_id` plus
    `loop_state: "ticking" | "parked" | "idle_waiting"`. Parked and idle ticks
    add `loop_park_reason`
    and `loop_parked_since` — the start of the CURRENT park streak, stamped
    once, not re-stamped per tick, so "how long has it been asleep" has an
    answer. A `ticking` tick clears both, since waking is the only signal the
    runner sends on wake. The backend fans these onto nullable `health_loop_*`
    columns (migration 086) and `/loop/status` reads them; a runner built
    before this sends none of the fields and behaves exactly as before.

14. **Off-switch pre-flight (three layers, once per run, never a gate).** The
    loop's designed exit is the session calling `set_board_loop`; without it the
    only stops are safety rails, which record the rail rather than the truth. So
    before the first session the runner asks three independent questions, stopping
    at the first failure — one fault, one line, each pointing somewhere different:

    | # | question | how | fails when | warning sends the operator to |
    |---|---|---|---|---|
    | 1 | Is it **granted**? | `mcp__valaris__set_board_loop` present in the board's `tools` allowlist | the board config omits it | the board's tool list |
    | 2 | Is it **callable**? | `PATCH /loop/state` re-asserting `enabled=true` — idempotent, so the probe of the off-switch can never flip it | the endpoint refuses this runner identity (card ba778abd: a client-side gate past the allowlist) | the runner's identity/authz |
    | 3 | Is it **served**? | spawn the configured `mcpServers.valaris` entry, `initialize` + `tools/list`, look for the tool | the MCP server build is stale or misconfigured — **the failure that actually happened in Loops #1–#3**: a stale PyPI 0.1.0 wheel resolved behind a correct-looking template, so the session simply had no such tool | the MCP server build |

    Layers 1 and 2 cannot see layer 3's failure, which is why the historical one
    went undiagnosed for three runs: the allowlist listed the tool and the runner
    key could call the endpoint, both true and both irrelevant to what the session
    was actually handed. Layer 3 reads the catalog off the same template the
    session gets, and accepts either spelling (the `mcp__valaris__` prefix is the
    coding agent's namespacing; the server's own catalog is unprefixed).

    All three are **diagnostics, never gates** — an unreachable off-switch is
    exactly when the operator most needs the run's work to still happen. Layer 3
    additionally fails **silent**, not open: it warns only on a conclusive
    negative (the server answered with a catalog lacking the tool). No template
    configured, a server that will not spawn, a handshake that never completes —
    all inconclusive, all logged at debug only. An unprobeable server says nothing
    about the off-switch, and a warning that fires on unrelated misconfiguration is
    one operators learn to scroll past, which would cost exactly the signal it
    exists to send. The spawn is bounded (10s) and the child is killed and reaped.

**Tool-level guardrails (what a loop session can never do), per provider.**
Every session — loop or pipeline, with or without
`dangerously_skip_permissions` — carries `SafeToolDenyFloor`: no `gh pr merge`
/ `gh pr review` / `gh pr close`, no force-push, no push to main/master, no
`git reset --hard`. A backend-supplied deny-list extends the floor, never
replaces it (`deny_source` logs `floor-backstop` when the floor stands alone,
`merged` otherwise). On `claude-cli` the floor travels as `--disallowedTools`
and deny rules win regardless of permission mode. On `codex-cli` (verified
0.144.1) the floor travels as execpolicy prefix rules in
`rules/backplane-deny.rules` inside the per-launch isolated `CODEX_HOME`,
riding on every launch — plain `codex exec` and `codex exec resume`. A
project-scope `.codex/rules` allow cannot override a forbidden floor entry,
the rules are still evaluated under `--dangerously-bypass-approvals-and-sandbox`
(the unchanged `dangerously_skip_permissions` mapping; verified live
2026-09-02: `gh pr merge 1` Rejected with the flag present), and
`--ignore-rules` is never emitted. The sandbox posture itself is unchanged —
no Codex OS sandbox was turned on, because `workspace-write` refuses writes to
the Go build cache and `~/.cache` (verified live), which would break
go/pnpm/pip. Deny entries that are neither `Bash(...)` nor `mcp__valaris__*`
are unenforceable on Codex and are logged as `unenforced_deny` at WARN. The
honest limitation is shared: BOTH providers match by command prefix only and
unwrap one shell layer, so a nested shell (`bash -lc "gh pr merge 1"`,
`sh -c`, `eval`, a script file) is caught by neither. The review gate is
therefore protected by the floor AND backstopped by the platform's
server-side gates (done-merge gate, merge queue). Once loop landing goes
through `enqueue_for_merge` (merge-queue landing, per-board opt-in), no loop
session ever needs `gh pr merge` — the floor closes the direct bypass on both
providers, and the platform gates backstop both.

## Backend deliverables

Router → Service → Repository layering; services own authorization; TDD throughout.

1. **Storage**: `boards.loop_config` JSON column, nullable — additive migration
   (migration-safety compliant; no defaults backfill needed).
2. **Endpoints** (workspace-tenanted under `/api/workspaces/{slug}/boards/{board_id}`):
   - `GET /loop` — any workspace member or runner key. 404 until first configured.
   - `PUT /loop` — admin/owner. Merges onto the board's stored config: an omitted field
     (or an explicit JSON `null` — `LoopConfigPut` fields are all Optional, so the two
     are indistinguishable and MUST behave identically) keeps its current stored value;
     only the first-ever PUT for a board has nothing stored to inherit from and gets the
     documented defaults. Validates the merged result; applies defaults on that first PUT
     so GET always returns a complete object; optional `expected_version` optimistic
     lock. A rejected (422/409) PUT never lands any part of the config — version and
     rails are left exactly as they were.
   - `GET /loop/readiness` — any workspace member or runner key (same authz as
     `GET /loop`). The board-level starvation probe: lets the runner ask "is there
     anything to do?" for the price of one HTTP GET instead of a paid runner session.
     Unlike `GET /loop`, it is a **pure board read** — it answers even before the
     board's first `PUT /loop` (404 strictly means the board doesn't exist, or, on a
     pre-rollout backend, that the endpoint isn't served — the runner may fall back
     to always-run behavior on 404, so "loop unconfigured" must never map to it).
     Response:

     ```json
     {
       "ready_count": 2,          // cards in backlog/active-typed columns, dependency_status != "blocked"
       "blocked_count": 5,        // the rest of those cards
       "awaiting_merge_count": 4, // blocked cards whose unsatisfied blockers ALL sit in review-typed columns with a PR url
       "review_open_pr_count": 3, // cards in review-typed columns carrying a PR url
       "actionable": true         // ready_count > 0
     }
     ```

     Semantics are exactly `attach_dependency_counts` (the board-view dep-chip
     annotator) — one predicate, never forked. Untyped columns are excluded
     everywhere (human scratchpads). "Carrying a PR url" follows the done-merge-gate
     doctrine: the structured `pr_url` column wins, a description scan
     (`extract_pr_url`) is the fallback. When the `card_dependencies` table is
     absent (pre-DEP-1), every backlog/active card counts as ready, matching the
     annotator's soft-pass. `awaiting_merge_count` is visibility/parking metadata
     ONLY — dependency satisfaction stays merged-only (done-column) by owner
     decision 2026-08-07; "blocked on a human merge" (park) and "blocked on a
     dependency" (stop) call for opposite loop responses, which is why the probe
     distinguishes them. Loop mode stays scheduler-free: the probe reserves
     nothing and never touches `next_assignment`.
   - `GET /loop/status` — any workspace member or runner key (same authz as the
     rest of the family). The loop **truth layer**: one answer to "what is the
     loop actually doing right now?", stitched server-side from config,
     in-flight iterations, and bound-runner liveness so the frontend never has
     to. Like `/loop/readiness` it is a **pure board read** — an unconfigured
     loop serves `state: "off"`, never 404 (404 stays strictly
     board-not-found; the dashboard must render every board's loop state
     without special-casing). Response:

     ```json
     {
       "state": "waiting",             // off | running | parked | waiting | unattended
       "enabled": true,
       "disabled_reason": null,        // last stop reason while off, else null
       "park_reason": null,            // the runner's own account of the park; non-null ONLY in state=parked
       "actionable": true,             // the readiness probe's ready_count > 0 — same computation, never forked
       "has_inflight_iteration": false,
       "last_iteration_at": "…",       // most recent loop_iteration (completed_at, or started_at while in-flight)
       "last_iteration_status": "completed",
       "bound_agent_count": 2,         // ALL team-bound runners, regardless of liveness
       "alive_agent_count": 1,         // the heartbeat-alive (≤90s) subset
       "spent_usd": 0.50,              // /loop/history's epoch-windowed sum, same computation
       "budget_usd": 7.5               // from the stored config; null when unconfigured
     }
     ```

     State derivation, first match wins:

     | state | condition |
     |---|---|
     | `off` | config absent OR `enabled: false`. Wins even over an in-flight iteration — but `has_inflight_iteration` still reports the fact truthfully, so the UI can say "off (an iteration is still draining)". |
     | `running` | an in-flight iteration on THIS board: `action: "loop_iteration"`, status started/running, `completed_at` null. Board-scoped — another board's iteration never lights this one up; non-iteration executions (card pipeline stages) never count. |
     | `parked` | no in-flight iteration, and ≥1 bound runner that is heartbeat-alive AND whose last heartbeat reported `loop_state: "parked"` with `loop_board_id` equal to THIS board. `park_reason` carries the runner's reason. Runner truth, not a board-readiness guess — and it expires with the reporting runner's liveness, which is what keeps "asleep on purpose" distinguishable from "the process died". A parked claim scoped to a different board is ignored. |
     | `waiting` | no in-flight iteration, and ≥1 bound runner heartbeat-alive. **Bound = member of an `AgentTeam` with this `board_id`** — never derived from `health_current_board_id` (that is a runner passing through, not a binding). |
     | `unattended` | enabled but nobody alive to run it — no teams bound, or every bound runner stale/offline/unknown. A runner killed while parked lands here once its liveness lapses. |

     Frontend: `resolveLoopChipState` serves the backend's `parked` verbatim.
     The older `waiting && !actionable` inference is kept ONLY as a fallback
     for pre-086 backends — it answers a board question ("is there work?") in
     place of a runner one ("is the runner asleep?"), so it may upgrade
     `waiting` but never contradict a state the server resolved.

     Related fix, same card: the agent-metrics surface's in-flight liveness
     promotion is now **capped**. An in-flight execution row may bridge a
     short heartbeat gap (`stale` → `alive` — long LLM stages heartbeat only
     at stage boundaries), but never resurrects `offline` (heartbeated, then
     silent past the threshold) or `unknown` (never heartbeated at all): a
     runner that died mid-execution leaves a stuck in-flight row behind, and
     that row is evidence *against* liveness, not for it — uncapped, a wedged
     runner read "alive" forever.
   - `PATCH /loop/state` — body `{"enabled": bool, "reason": str|""}`. Any member or
     runner key (runners must be able to turn the loop off autonomously). **Idempotent**:
     setting the current state returns 200 with the current object, never 409. Enabling
     requires a configured non-empty `loop_prompt` (422 otherwise). Records the actor.
3. **Validation** (mirrors the pipeline-config validator's posture): `enabled=true`
   requires non-empty `loop_prompt`; numeric bounds per the table; `provider` is a free
   string (white-label — local agent availability is the runner's preflight concern).
5. **MCP tools**: `get_board_loop(workspace_slug, board_id)` and
   `set_board_loop(...)`. `set_board_loop` is the full editing surface (card 32e8927b —
   prompt tuning is one tool call): every operator field is an optional parameter routed
   through PUT `/loop` (omitted = unchanged, the server merge rule), while
   `enabled`/`reason` always route through PATCH `/state` so a pure state flip stays
   rail-safe and idempotent; config + enabled together applies config first, then flips
   state. Writes are last-write-wins — the optimistic lock is deliberately not exposed
   to runners. `set_board_loop`'s docstring must instruct loop runners:
   *"When running in loop mode: call this with enabled=false and a concise reason when
   the objective is complete or you are blocked."* and state that edits apply on the
   NEXT iteration (config re-fetched per cycle).
6. **AgentExecutions**: verify `card_id` is nullable and accept `action:
   "loop_iteration"` on the execution create/update endpoints the runner already uses
   (`POST /api/agents/{id}/executions`, `PATCH …/executions/{id}`). If `card_id` is
   NOT NULL today, relax it (additive migration).
7. **Activity + WS**: activity entries for config edits and state flips (with actor and
   `reason`), and a `board.loop_updated` WS broadcast so open clients flip live.
8. **Interplay with board freeze** (separate in-flight card): when freeze ships, frozen
   boards should reject loop mutations like every other board-scoped mutation; the GET
   stays readable. Runner-side no change — a frozen board's loop simply can't be re-enabled.

## Frontend deliverables

Board settings → **Loop Mode** panel:

- **Toggle** (the `enabled` flag) with the current `disabled_reason` surfaced when off —
  this is how operators see *why* a runner or safety rail stopped the loop.
- **Config editor**: system/loop prompt textareas (placeholder text showing the
  off-switch instruction pattern), provider input, model/tier select, tools multiselect
  (reuse the MCP-tool picker used by pipeline stage config), numeric caps. PUT on save
  with `expected_version`.
- **Live status** via `board.loop_updated` WS event (WS-first; no polling).
- **Execution visibility**: card-less `loop_iteration` executions render in the board's
  execution timeline/feed with iteration cost and duration.
- **Board-scoped iteration query params**: `GET /api/workspaces/{slug}/executions` takes
  optional `board_id` and `action` filters (alongside the existing `status`/`agent_id`/
  `role`/`card_id`), applied identically across all three service branches (card-scoped,
  `status=inflight`, and the default paged list). Omitting both is unchanged legacy
  behavior. The Loop Mode dialog and board-header badge use `board_id=<board uuid>&
  action=loop_iteration` instead of fetching every workspace execution and filtering
  client-side.
- **Liveness signal (frontend)**: the board-header loop badge is two-state, not just
  on/off — amber `data-state="enabled"` (the loop flag is on) vs. green
  `data-state="looping"` (an iteration is actually active or between iterations right
  now). Green means the newest board-scoped `loop_iteration` execution is either
  still in-flight (`started`/`running`) and younger than
  `iteration_timeout_seconds + 60s`, or terminal (`completed` **or** `failed` — a
  failing-but-still-iterating loop still reads as looping) and younger than
  `iteration_delay_seconds + 120s` (measuring from `completed_at`, falling back to
  `started_at`). Past those grace windows the badge decays to amber on its own, via a
  client-side timer (~30s tick) re-evaluating the same pure function
  (`computeLoopLiveness` in `loop-liveness.ts`) against the same last-fetched data — no
  new network call is needed to decay. The dialog's telemetry section shows the same
  fetched window's spend-vs-budget, current iteration count (parsed from the newest
  row's `input_summary`, falling back to the row count), and a consecutive-failure
  warning near `max_consecutive_failures`.

## Merged-PR → Done reconciler

A human merging a PR must not need a second, unrelated action (moving the card):
dependency satisfaction keys strictly on done-typed columns, so a forgotten move
silently starves a parked loop. The backend runs a reconciler
(`app/services/kanban/reconciler.py`, wired in `main.py` beside the liveness and
merge-queue loops) that lands cards automatically via two paths:

- **Event path**: subscriber on `merge_queue.merged` — the platform's own merge
  executor merged the entry's PR; the card follows immediately. Origin-only (the
  postgres bus fans events to every replica; only the publisher acts). No GitHub
  re-check: the event is the proof.
- **Poll path** (default every 60s, `RECONCILER_TICK_SECONDS`): cards in
  review-typed columns carrying a GitHub PR URL (structured `pr_url` column or
  description scan — gate doctrine) are checked via the same GitHub client the
  done-merge gate uses; `merged: true` → moved to the board's done-typed column
  (lowest-position one when several exist). Bounded per pass (50 cards);
  non-GitHub forge URLs are skipped for now, same posture as the gate. Fail-soft
  per card: unreachable GitHub or a vanished PR skips quietly and retries next
  pass — a card only ever moves on a positive `merged: true`.

**Gate policy** (owner-aligned 2026-08-07): a merged PR is the strongest form of
landing — the human who merged IS the review. The reconciler runs with no runner
contextvar, so the done-merge gate treats its moves as human-driven and the
reviewer-verdict backstop does not apply. That backstop exists to stop *runners*
landing unreviewed work via `move_card`; the reconciler only ever acts on an
already-merged PR. Runner-driven `move_card` behavior is unchanged.

The move is idempotent (already-done → no-op; board without a done column →
skip), recorded in activity with a `reconciler: PR merged — auto-landed …`
summary (actor: the card's creator — `Activity.actor_id` is non-nullable and
there is no system user; the summary is what marks reconciler moves), and
WS-broadcast like any move, so open boards update live. Idempotence holds
under concurrency: every backend worker/replica runs the poll loop, so the
landing re-reads the card row (on Postgres under `FOR UPDATE SKIP LOCKED`,
the merge-queue `pop_next` idiom) before the already-done check — concurrent
passes over the same merged PR produce exactly one move and one activity
entry.

**The chain this completes** (the point of the three starvation cards): a loop
is parked because every remaining card is blocked on PRs awaiting human merge —
`GET /loop/readiness` reports `actionable: false, awaiting_merge_count: N` and
each parked probe costs $0. The operator merges a PR on GitHub. Within one
reconciler tick the card lands in Done, its dependents flip
`blocked → unblocked`, the next readiness probe reports `actionable: true`, and
the parked runner wakes and works — zero board touches, zero wasted sessions.

## Loop landing via the platform merge queue (per-board opt-in)

The loop's structural gap on free-plan private repos: Done-means-merged, the
deny floor (correctly) blocks `gh pr merge`, and GitHub auto-merge requires
branch protection — a paid feature there. The old failure mode is retained only
as history in the superseded, non-authoritative
[`auto-merge-loop.md`](auto-merge-loop.md): enabling `allow_auto_merge` on such
repos returns HTTP 200 while silently storing `false`. Without a landing path,
every card terminates at Review awaiting a human and loop throughput is bounded by
operator merge latency, not available work.

The platform owns the answer: the server-side merge queue
(`app/services/merge_executor.py`) does a real clone → rebase →
force-with-lease push → squash merge on any GitHub plan, serialized per
(repo, integration branch), with conflict consolidation. Loop wiring:

- **Opt-in**: `loop_landing: "merge_queue"` on the board's loop config
  (admin PUT). Default stays `human`, and `self_merge` — the runner landing its
  own PR with plain git — is NOT this opt-in: only `merge_queue` reaches the
  platform's executor. Server-enforced at enqueue: a runner
  caller on a loop-configured board without the opt-in gets 403
  `loop_landing_not_enabled`. Boards with no loop config (pure pipeline
  boards) are untouched — their enqueue paths were already operator-gated
  (workspace `merge_via_queue`, or an explicitly wired lifecycle step); a
  hybrid board (pipeline + loop config) gates its pipeline runners too — the
  operator who configured a loop there owns both knobs. Humans are never
  gated.
- **Runner path**: the `enqueue_pr_for_merge` MCP tool (distinct from
  `enqueue_for_merge`, which only RE-queues after conflict consolidation) —
  add it to the loop's tool allowlist on opted-in boards. Prompt pattern:
  *"when your PR is green and your self-review passes, call
  enqueue_pr_for_merge; the platform lands it and the reconciler moves the
  card — never call `gh pr merge` yourself."*
- **Base-branch guard (GitHub path)**: `gh pr merge` lands a PR into its OWN
  base branch — the entry's `integration_branch` only drives the rebase
  target and queue keying. Before merging, the executor reads the PR's
  `baseRefName` and refuses on mismatch with an explicit `error_message`
  naming both branches and the fix (`gh pr edit --base <branch>` +
  re-enqueue). This makes "merges land only on the integration branch" a
  structural invariant instead of prompt discipline — a PR mistakenly opened
  against the default branch can no longer be merged there by the queue
  (field audit, 2026-08-09).
- **require_ci_green**: the executor pre-flights the PR's CI (check runs +
  legacy commit statuses — plain reads, no branch protection needed) before
  touching git. The pre-flight is governed per board by `merge_gate` (field
  table above): the executor resolves the entry's repo → board loop config on
  every attempt, and `merge_gate: "none"` skips the CI read entirely — the
  entry proceeds straight to rebase + merge. Boards without a loop config, a
  stored config missing the field, or a policy read that fails all behave as
  `forge_ci` (fail-closed to checking). Red / pending / unreadable → the entry returns to `queued`
  as `ci_not_green` (event `merge_queue.ci_not_green`) and retries next tick,
  bounded (`CI_GIVE_UP_ATTEMPTS`, ~20 min at the 10s tick) before failing
  terminally. While churning, the queued entry carries its latest reason in
  `error_message` (`ci_not_green (will retry): …`) and re-enters at the BACK
  of the FIFO — a churning entry never starves fresh ones behind it (both
  field findings, 2026-08-08). A repo with NO CI at all fails open
  by default (`require_ci_present=False`). The CI verdict is read on the
  pre-rebase head — deliberately before the clone, so a pending CI costs one
  API read per tick, not a clone. Unreadable-checks block-and-retry is a
  deliberate inversion of the house soft-pass: a merge gate never merges on
  a guess. **Token requirement**: the backend's forge token must be able to
  READ CI state. Fine-grained PATs cannot read the Checks API at all
  (Apps-only permission), so on a 403 the reader falls back to the Actions
  workflow-runs API — grant the PAT **Actions: read** and **Commit
  statuses: read** on top of PR read. A token that can see PRs but neither
  CI surface makes every entry churn "ci state unreadable" (visible on the
  entry's `error_message`) until give-up — or set the board's
  `merge_gate: "none"` when the CI surface is dead for good (billing,
  no runners), which unsticks queued entries on the next tick.
  Deployment-wide kill switch: `MERGE_REQUIRE_CI_GREEN=false`.
- **Which credential the merge runs as**: see *Forge credential resolution*
  below. Failure messages name the source (`using workspace connection <login>`
  vs `using platform token`), and a 401/403 marks a bound connection unhealthy
  in Workspace Settings → Git Connections.
- **The full autonomous cycle** this closes: implement → PR → CI green →
  enqueue → platform merges → `merge_queue.merged` → reconciler lands the
  card in Done → deps unblock → readiness flips actionable → the parked loop
  wakes. No human in the loop on opted-in boards; the reviewer verdict and
  CI remain the quality gates.

## Forge credential resolution

Every backend git operation — merge queue, done-merge gate, merged-PR
reconciler, scheduler open-PR precondition — resolves its forge credential
through one seam (`app/services/git/credential_resolver.py`). Nothing reads
`settings.GITHUB_TOKEN` directly any more. Operator-facing setup (how to make a
token per forge, exact scopes, Verify's checks, troubleshooting) lives in
`docs/git-credentials.md`; this section is the contract.

**Chain, first match wins**, per repo:

1. The connection the repo is bound to (`git_repos.connection_id`, admin-only
   to set; same workspace + same provider enforced).
2. The workspace's **sole** connection for that repo's provider. Two or more
   with no binding is `ambiguous_connections` — no credential, and the detail
   names the candidates. Refusing to guess is deliberate: picking one would
   merge as an identity the operator never chose.
3. The platform env token for that provider (`GITHUB_TOKEN` / `GITLAB_TOKEN`),
   iff `ALLOW_GLOBAL_TOKEN_FALLBACK` (default `true`).
4. None.

**Host matching is enforced on every branch.** A credential is used only when
the repo URL's host equals the credential's host — a connection's `base_url`,
or the provider default (`github.com`, `gitlab.com`, `bitbucket.org`) when it
names none. Comparison folds case, trailing dot and a leading `www.`, and keeps
the port (`git.acme.dev:8080` and `:9090` are different origins). scp-style
remotes (`git@host:owner/repo`) are parsed; userinfo never wins over the real
host, so `https://github.com@evil.example.com/x` matches evil.example.com.

The rule is what makes the chain safe to run on registered-by-anyone repo URLs:
the token is embedded into the clone URL, so an unmatched credential is handed
to whatever host the URL points at. Two structural consequences:

- **`GITEA_TOKEN` no longer resolves to anything.** Gitea has no canonical
  host, so the env token names no host and can never host-match. Self-hosted
  gitea must create a workspace connection with `base_url` (the schema rejects
  a gitea connection without one). This closed a token-exfiltration hole where
  any registered repo URL got the platform token embedded.
- **No cross-provider fallback.** The old merge executor handed `GITHUB_TOKEN`
  to gitlab/gitea repos; that is gone.

**Resolution reasons** (stable strings, UI keys off them): `no_connection`,
`ambiguous_connections`, `host_mismatch`, `fallback_disabled`,
`provider_has_no_fallback`, `unparseable_repo_url`. Each carries an
operator-written `detail` naming the fix.

**Failure postures — no credential is never a hard failure:**

| Consumer | Without a credential |
|---|---|
| Merge queue | Attempts **unauthenticated** — public repos keep merging. A failure message appends `— no credential was used: <detail>`; with one, it appends `(using <source>)`, where source is `workspace connection <login>` or `platform token`. |
| Done-merge gate | Soft-pass: stamps `verification-deferred` on the card and logs the reason with board + PR, same posture as an unreachable GitHub. Never wedges a card. |
| Merged-PR reconciler | Skips the card, logs the reason. Its own rule holds — a card moves only on a positive `merged: true`, never on an unreadable answer. |
| Scheduler open-PR precondition | Soft-pass with the reason logged; a workspace with no token must not deadlock assignment. |

**Connection health.** A 401/403 while *using* a bound connection writes
`last_error` on it (URL credentials redacted, truncated to 500 chars); a
subsequent success clears it. Only auth-shaped failures count — a rebase
conflict or a protected branch says nothing about the token, and flagging it
would send an operator to rotate a good credential. `last_verified_at` moves
only on a successful probe: a later 401 does not un-happen it. This
production-observed health is a stronger signal than Verify's probe and is the
first place to look at a wedged merge queue.

## Interplay with the done-merge gate

Workspace config exposes `enforce_done_merge_gate` (bool, default `true`, served by
`GET /api/workspaces/{slug}/config`), and each board carries a nullable override of the
same name that wins over it (see *Opting out (per board)* below). Neither is part of
loop mode's own config, but a loop board is subject to the gate like any other
runner-driven move, so it matters here.

- **What it requires**: `CardService._enforce_done_merge_gate` runs whenever an
  authenticated *runner* (not a human) moves a card into a `done`-typed column from a
  non-`done` column, on a board with at least one linked git repo. The card's
  description must contain a PR URL
  (`pr_url_missing` otherwise); if the URL is a GitHub PR, the gate also confirms via
  the GitHub API that the PR is **merged** (`pr_not_merged` otherwise), and — for any
  forge — that the card has an approving reviewer verdict on record
  (`merge_requires_review` otherwise). A non-GitHub PR URL skips only the merge-status
  check (no forge-native client yet) but still requires the reviewer verdict. All of
  this is skipped entirely for human-driven moves, and for a move that starts already
  inside a `done`-typed column.
- **Board-aware exemption**: a board with NO git repo linked is exempt from the gate
  entirely — such a board cannot produce a mergeable PR by construction, so docs, ops,
  and planning loop boards land cards in Done without a PR URL or verdict. A board
  WITH a linked repo keeps the full gate; if its cards don't actually produce PRs, a
  `move_card` called from inside a loop iteration will keep failing the gate — the
  card never lands, the loop prompt's own "call `set_board_loop` when done"
  instruction never fires, and the loop burns iterations/budget against a stop
  condition it cannot reach. The frontend's Loop Mode dialog states this requirement
  informationally — only when the gate is enforced AND the board has a linked repo,
  i.e. exactly when the gate can actually block a Done move. Repo-less boards are
  exempt server-side, so the dialog stays silent there.
- **Auto-relax on a self_merge save**: a `self_merge` landing can never satisfy the
  gate — the loop runner merges with plain git, so no reviewed GitHub PR ever exists
  for the gate to verify. A **human**-credentialed `PUT /loop` that **expresses the
  landing in that request** — `loop_landing: "self_merge"` in the body, or a template
  bound in the same PUT whose render lands there — writes the board override to `off`
  in the same transaction as the config (choosing the landing IS the consent),
  recorded as its own board activity (`done_gate_auto_relaxed`). A stored
  `self_merge` landing merely **inherited** by a later save never stamps: consent
  cannot be staged by one party and executed by another's unrelated save. The
  implicit stamp is further scoped to saves where the gate would actually bite —
  board override unset (an explicit `enforced` is an admin hardening act and is
  never implicitly softened), workspace gate resolving on, and a repo linked —
  which is exactly where the dialog shows its notice; consent the UI never
  surfaced is not consent. An explicit `relax_done_merge_gate: true` keeps its
  pre-existing unconditional shape (human + canonical self_merge landing, stamps
  regardless of those scoping conditions). `relax_done_merge_gate: false` on the
  same PUT declines — the save succeeds and the gate stays armed (the loop will
  then dead-end on its first Done move; an explicit operator choice). The decline
  applies to **that save only**; it is never stored. The relax follows the
  landing: a later save — human **or runner** — that moves a stored `self_merge`
  landing elsewhere restores an `off` override back to `inherit`
  (`done_gate_rearmed` activity); re-arming is the safe direction, so it is
  caller-agnostic, and it deliberately includes an `off` that was set manually,
  since there is no provenance marker and a re-armed gate is the recoverable
  mistake. **Runner-credentialed saves never auto-relax** (and
  `relax_done_merge_gate: true` from a runner key is 403 `admin_required`, as
  before): un-arming the gate stays a human act, and for runners the armed gate
  remains the security boundary.
- **Opting out (workspace-wide)**: set `enforce_done_merge_gate: false` via
  `PUT /api/workspaces/{slug}/config` (admin/owner only). This exempts every board's
  runner-driven Done transitions, not just loop boards. The field itself is refused
  from a runner key — either direction — with 403 `admin_required` (as with
  `relax_done_merge_gate`), and the refusal is atomic: a gate write smuggled in a
  mixed payload lands nothing. Other config fields stay runner-writable, since the
  runner legitimately writes them.
- **Opting out (per board)**: boards carry their own tri-state
  `enforce_done_merge_gate` override, set via `PATCH /api/workspaces/{slug}/boards/{id}`
  or the MCP `update_board` tool's `done_merge_gate` argument
  (`inherit` / `enforced` / `off`). Admin/owner only, like freeze; a plain member
  PATCHing this field gets 403 `admin_required`, while a member's PATCH of any other
  board field still works. Runner keys are refused outright on the board PATCH (403,
  as with `relax_done_merge_gate`): the override — like every board field — stays a
  human act. `null`/`inherit` is the default every existing board
  carries and follows the workspace flag; `true`/`enforced` keeps the gate on for this
  board even when the workspace opted out; `false`/`off` turns it off for this board
  even when the workspace enforces. The MCP `inherit` value sends an explicit JSON
  null (omitting the field leaves the override untouched).
- **Precedence**, highest first:
  1. **Structural** — a board with no linked git repo is exempt, full stop. An
     `enforced` override cannot conjure a mergeable PR onto such a board.
  2. **Board override** — when set (`true`/`false`), it decides, and the workspace
     config is not even read.
  3. **Workspace flag** — consulted only when the board override is `null`.

### Explicit landing and completion policy

An operator can opt a board into a versioned `completion_policy`. The board's
whole policy wins over the workspace's whole policy; a null board policy inherits,
and null at both levels preserves legacy behavior. Only human workspace admins
or owners change policy or choose a card's `evidence_only` mode. Selecting a
preset fills primitives; arbitrary configured roles, providers and concrete
per-role models remain supported.

| Primitive | Meaning |
| --- | --- |
| `landing_actor`, `landing_methods` | Agent/platform landing through the authorized merge queue, or human external landing |
| `source_review`, `review_role` | Optional independent review in a fresh configured execution |
| `require_forge_checks` | Require authoritative forge checks before landing |
| `postmerge_validation` | Configured role and direct argv checks against the exact frozen merge SHA |
| `evidence_only` | Operator opt-in plus optional independent evidence approval |
| `dependency_release` | Release prerequisites at acceptance or only after accepted work reaches Done |
| `auto_complete` | Automatically move accepted work to Done, or leave the final step to a human |

Source work records the real open PR on the card, then calls
`submit_completion_candidate` with the runner-supplied source execution ID.
The backend resolves repository, PR head and base identity from the supported
forge. `request_landing` uses the current authorized candidate; shell merge
commands do not bypass the contract. Independent source review does not count
as postmerge validation. A merge alone cannot satisfy configured validation:
the runner checks a clean detached checkout of the frozen merge SHA, verifies
HEAD before and after direct argv checks, and reports bounded exact results.
Later main advancement does not invalidate acceptance of that immutable SHA.
Policy, mode and relevant card/source changes invalidate prior acceptance.

An evidence-only card needs an operator-selected mode, source execution and full
source SHA, artifact records `{name, uri, sha256}` and named check results
`{id, source_sha, exit_code, output}`. No fake or unrelated PR is evidence.
`get_completion_status` exposes the current candidate and public attempt history.
`retry_completion` schedules a fresh failed phase; leases and result acknowledgment
belong to the runner control plane and never to model-visible MCP tools.

The runner processes outstanding completion before readiness parking, the
`completion_query`, or an `objective_complete` decision. Code injects mandatory
policy, board definition and pinned context. The initial strict forge capability
is GitHub; an unsupported forge/provider or missing configured role fails closed
with a configuration finding, without substituting a provider or weaker policy.

Before enabling an explicit policy, install a backend, runner and MCP build that
support completion protocol version 1. Keep the loop disabled while configuring
concrete source and per-role provider/model values. Rehearse template fit and
preview using the proposed slots and rails, `draft=false` and the exact published
version, then bind and review the effective policy. Rebind existing coding
prompts to pick up their policy-aware kernel. Declared `branch_constraints` use
`{kind: "distinct", slots: ["DEFAULT_BRANCH", "INTEGRATION_BRANCH"]}` and evaluate
defaults and variant fills; there is no global prohibition on targeting a default
branch. Run a supervised disposable source/evidence cycle and inspect exact
acceptance before authorizing operational use. Source tests, exported artifacts,
clean installs, public availability and human rollout approval are separate evidence.

### Evidence-only completion and legacy postmerge acceptance

With no effective policy, the existing Done merge gate remains. Evidence-only
work on a gated repo-linked board requires a human completion step: record the
source SHA, artifacts and checks, leave the card outside Done and report
`blocked_on_human`. Preserve that evidence note for the human review; never
fabricate a PR or borrow another card's PR. Legacy merged-PR polling and queue
events may move a card to Done before local postmerge checks. Use an explicit policy when those checks
must hold acceptance or dependency release.

## Worked example

```json
PUT /api/workspaces/acme/boards/1234…/loop
{
  "enabled": true,
  "provider": "",
  "model": "mid",
  "system_prompt": "You are the maintenance agent for {{.Workspace}}. Work in small, reviewable increments.",
  "loop_prompt": "Iteration {{.Iteration}}. Pick the highest-priority unblocked card on board {{.BoardID}}, make real progress on it, and leave the board state accurate. If every card is done, or you are blocked on something only a human can resolve, call set_board_loop with enabled=false and a one-line reason.",
  "tools": ["mcp__valaris__get_project_context", "mcp__valaris__get_card", "mcp__valaris__update_card", "mcp__valaris__move_card", "mcp__valaris__create_note", "mcp__valaris__set_board_loop"],
  "max_iterations": 25,
  "iteration_delay_seconds": 30,
  "iteration_timeout_seconds": 3600,
  "budget_usd": 20.0,
  "max_consecutive_failures": 3
}
```

Runner: `backplane-runner -config runner.yaml -loop -loop-board 1234…`

## Test guidance

- **Backend**: authz matrix per endpoint (member/admin/runner × GET/PUT/PATCH), PATCH
  idempotency, enable-without-prompt 422, defaults application, version increments,
  card-less execution accept, WS broadcast, MCP tool round-trip.
- **Template rendering**: `tests/services/test_loop_template_render.py` pins the slot
  renderer against checked-in **golden fixtures** — a full-slot render and an
  all-optionals-empty render, plus the dangling-punctuation and orphaned-parenthesis
  cases that an emptied optional slot creates. A renderer change must update those
  fixtures in the same PR; that is what makes them golden.
- **Frontend**: toggle optimistic update + WS reconcile, editor round-trip preserves
  tier aliases verbatim, disabled_reason rendering.
- **Runner** (done): fake backend via `httptest`, `MockProvider` for sessions; covers
  disabled-exit, re-fetch-per-iteration, 404-fatal, every safety rail, tier remap,
  template rendering, cancel-without-disable, logging-failure tolerance.
