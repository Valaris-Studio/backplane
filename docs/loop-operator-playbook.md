# Loop Mode — Operator Playbook

Field learnings from running Backplane loop mode on a real delivery (a client
loop run on 2026-08-06→07: 3 runs, 12 iterations, 11 cards merged), folded
together with the harness improvements that run produced. The contract of
record is `docs/loop-mode-contract.md`; this document is how to *drive* it. The
operator-facing summary also ships in-app under **Documentation → Core Concepts
→ Loop Mode**.

## Select completion before enabling

Choose the whole board or inherited workspace completion policy before starting
work. [The policy contract](loop-mode-contract.md#explicit-landing-and-completion-policy)
separates source review, authorized landing, exact merged-commit validation,
evidence-only approval and the final human/automatic Done step. Keep the loop
disabled while rehearsing proposed slots and rails against the exact published
template version. Rebind older coding templates to pick up policy-aware prompts.

Use `get_completion_policy` and `get_completion_status` to inspect effective
capabilities and acceptance. Presets do not limit operator-defined roles or
per-role models. Unsupported capabilities require configuration changes; do not
relax a policy or substitute a provider to make a run appear ready. A failed
phase stays visible until a deliberate `retry_completion` or a new candidate.

A supervised handoff should identify the exact source commit, installed backend,
runner and MCP artifacts, selected policy, candidate/merge SHA, check results and
human approval still required. Source test success does not prove an exported
artifact, clean installation or public availability. The remaining legacy
landing examples apply only when no effective completion policy is selected.

## 0. Choose the process lifetime before launch

By default, switching the board loop off ends the runner process. Opt into a
resident process only when an operator is expected to pause and resume that
same board without restarting the service:

```yaml
loop_mode:
  keep_alive: true
```

```bash
backplane-runner -config runner.yaml -loop -loop-board <board-id>
# one-launch overrides:
backplane-runner -config runner.yaml -loop -loop-board <board-id> -keep-alive
backplane-runner -config runner.yaml -loop -loop-board <board-id> -keep-alive=false
```

These are different idle states. `parked` means the board is **enabled** but
readiness found no actionable work, so the process keeps probing. `idle_waiting`
means the board is **disabled** and `keep_alive` deliberately keeps the process
present for a later re-enable. Both run no coding-agent session and spend
nothing, but `/loop/status` remains `off` during `idle_waiting`. Safety rails
still terminate the process instead of entering the disabled-board wait.
With WebSockets enabled, `board.loop_updated` wakes the runner immediately when
that board is re-enabled; 30s/60s REST re-fetches remain the fallback.

## 1. The tuning loop — the mechanism that makes loop mode work

The runner re-fetches the board's loop config at the top of **every**
iteration. That single property turns the loop into a live instrument:

```
iteration writes a run-log note on the board
        ↓
operator reads it, folds the lesson into loop_prompt
        ↓            (one set_board_loop call — every operator field is editable)
next iteration picks the new prompt up — no restart, no redeploy
```

Worked examples from the field:

- **Branch survey before checkout.** An early iteration checked out `main`,
  did work, and collided with a prior iteration's unmerged branch. The run-log
  note said so; the operator added "survey existing remote branches before
  choosing where to start" to the prompt; every later iteration did it right.
- **Allowlist gap.** A session reported it lacked a tool it needed. The
  operator added the tool to `tools`, wrote the reason into the board
  definition, and the next iteration proceeded. The gap surfaced, was fixed,
  and *stayed* fixed — because the fix landed in config, not in a human's
  memory.

Treat the prompt as versioned method, the board's notes as the loop's memory,
and the config as the only knob you ever need mid-run.

## 2. Templates & slots — start from Coding Loop v2

**Do not hand-write a `loop_prompt` from scratch.** The prompt fragments this
section used to list are now the body of a maintained system template, and the
guidance that used to sit around them is now the `help` text on the slot you
fill in. Start from **Coding Loop v2** in the Runner console's **Loops** tab
(`/:slug/runner/loops`) and fill its slots; the manager renders the prompts and
writes them to the board for you.

### Bind a board in five steps

1. **Choose** — Runner console → **Loops** → *Coding Loop v2*. The profile page
   is the template's own documentation: what it assumes, which slots are
   required, what it renders.
2. **Fit** — open the template against your board. Fit reports what the
   template needs that the board does not yet have (a missing column type, an
   absent label, no bound git repo). Where the gap is mechanical, **apply
   fixes** does it; where it is a judgement call, fit tells you and stops.
3. **Fill slots** — every slot carries `help` explaining what a good value looks
   like and why. Required slots gate the save. `<<SLOT>>` is the only slot
   grammar; `{{.Var}}` names are RUNNER variables and a different thing
   entirely (see the contract's runner-vars list).
4. **Preview** — read the fully rendered `system_prompt` and `loop_prompt`
   before anything runs. This is the last cheap moment to catch a slot value
   that reads wrong in context.
5. **Save** — the render is stored as ordinary loop config, so the runner reads
   what it always read. *Then* enable the loop, as a separate deliberate act.

After binding, `GET /loop/binding` shows the authoring state (slot values,
render hash, drift). When the template gains a new version the board shows as
drifted; re-rendering keeps the rails you tuned since binding.

### Sharp edges that outlive any template

- **Repo setup that survives parallel work.** If your run has several runners or
  restarts, say so in the slot text: *"Before starting, list remote branches
  (`git ls-remote --heads`) and check for open PRs touching your card's area.
  Never assume the default branch is where you start — a prior iteration's
  branch may already carry the base you need."* Nothing in the template can know
  your branch topology.
- **Write the general rule down.** *"When you hit a non-obvious constraint,
  write the general rule into your card's description (an INHERITED FROM / AS
  BUILT block) — the next iteration or the next card's runner will hit it too."*
  Cheap to add to a slot, and it is what stops the same discovery being paid for
  twice.
- **Hand-editing a bound board's prompts is refused**, not silently overwritten:
  `PUT /loop` answers `409 board_bound_to_template`. Detach first (`template:
  {}`) if you genuinely want raw text; the last render stays behind as the
  starting point.

## 3. Card-authoring for parallel loops

Shared-file conflicts between parallel cards are **structural, not
incidental**: any two cards that append to the same status section, register
into the same map/registry file, or edit the same barrel export WILL produce a
rebase conflict when their PRs land. Author cards so the collision never
exists:

- **Per-card registration files** + a generated (or union) registry: each card
  adds `registrations/<feature>.ts`; a codegen step or an explicit integration
  card produces the union.
- **Append-only logs** over in-place status tables — two appends merge; two
  edits of row 3 don't.
- **Explicit integration cards** for union merges, with dependency edges on
  the cards they integrate. Don't make the last parallel card "also merge
  everything" implicitly.
- When a conflict happens anyway, the platform merge queue's
  **consolidator-card flow** files a rework card on the board automatically
  (entry state `blocked_pending_consolidation`) — resolve it there, then
  `enqueue_for_merge` re-queues the original.
- One field-proven dodge for the no-stacking rule: when card B needs card A's
  unmerged interfaces, **copy the interface files verbatim** into B's branch
  (they'll be identical at merge and rebase away cleanly) instead of stacking
  B's branch on A's.

## 4. Forge sharp edges (each cost real diagnosis time)

**Before diagnosing runner-host failures by hand, run
`backplane-runner -doctor` on that host.** It is a read-only preflight — coding
agents on `PATH`, git, the runner forge CLI and its local auth, masked
runner-side credentials, backend identity and budget, MCP JSON syntax/path,
and work-dir safety — and it never spends. It exits 1 on a failed check (but
can exit 0 with warnings), so it is useful as a provisioning gate.

Doctor does not inspect workspace Git Connections or the credential the
backend merge queue will resolve. Diagnose §4b from the merge-queue entry's
credential source/error and the connection-health UI; a locally green doctor
cannot prove that backend-side merge auth is valid. Doctor also does not start
the MCP server, verify a coding-agent login, clone/push a repo, or make a real
MCP tool call.

- **PR stacking + `--delete-branch` is a trap.** Merging a base PR with
  branch deletion auto-closes any PR stacked on that branch
  (`base_ref_deleted`) — and GitHub will NOT let you reopen it while the base
  ref is gone. Recovery recipe, in order: **recreate the deleted ref → reopen
  the PR → retarget its base to the integration branch → delete the temp
  ref.** This footgun is *why* dependency satisfaction on the platform stays
  merged-only — no PR-satisfies-deps, no stacking (owner decision
  2026-08-07).
- **`gh pr view --json headRefOid` can serve a stale SHA** while
  `git ls-remote` already shows the new one. Any tooling (or prompt) that
  checks "did the push land?" must use `git ls-remote`, never gh's cached
  view.
- **`allow_auto_merge` writes silently no-op on free-plan private repos**:
  `PATCH /repos/{owner}/{repo}` returns HTTP 200 while the stored value stays
  `false` (plan-gated). The incident detail is retained in the superseded,
  non-authoritative [`auto-merge-loop.md`](auto-merge-loop.md). The current
  path is the platform merge queue; do not try to arm GitHub auto-merge.

## 4b. "The platform's token can't see my org"

The field case (a field run, 2026-08-09): a loop board on a repo the
deployment's own PAT had no access to. The platform token was fine-grained and
scoped to a different organization, so every merge-queue attempt failed on a
repo the operator could see perfectly well in their browser. The fix at the
time was **manual-landing mode** — `loop_landing: "human"`, a human lands PRs,
the reconciler moves the cards. (This doc used to call that
"self-merge mode", which collided with the posture where the RUNNER merges. Card
B9 gave the latter its own value — `loop_landing: "self_merge"` — so the two
are named apart now.)

That is no longer the only option. The workspace can now bring its own
credential: **Workspace Settings → Git Connections → add an access token**
scoped to *your* org, then bind the repo to it if the workspace has more than
one connection for that provider. Full setup and per-provider scopes:
`docs/git-credentials.md`.

Diagnosing which case you're in: the merge-queue entry's `error_message` names
the credential it used — `(using platform token)` on a repo your org owns is
exactly this failure. `no credential was used: …` names the reason and the fix
instead.

Still reach for manual-landing mode when:

- The repo's forge has **no usable CI** *and* you'd rather review by hand than
  set `merge_gate: "none"`.
- Policy says a human must land every PR — a credential doesn't change that.
- You're mid-run and don't want to stop to mint a token; adding the connection
  later works, and queued entries pick it up on the next tick without
  re-enqueueing.

A workspace connection also fixes the quieter version of this failure: a token
that can read PRs but not CI makes every entry churn `ci state unreadable`
until give-up. Grant **Actions: read** and **Commit statuses: read** (the
Checks API is GitHub-Apps-only and a PAT can never call it).

## 5. Autonomy posture matrix

Two loop-config fields define the posture (see the contract's config table):

| | `loop_landing: "human"` (default) | `loop_landing: "merge_queue"` (opt-in) | `loop_landing: "self_merge"` |
|---|---|---|---|
| Who merges PRs | A human, on the forge | The platform merge executor (`enqueue_pr_for_merge`), gated per the board's `merge_gate` | The loop runner itself, with plain git into the integration branch |
| What moves the card to Done | The merged-PR reconciler (event + ~60s poll) | Same reconciler, fed by `merge_queue.merged` | The runner, with its own `move_card` call |
| While work is blocked on merges | `starvation_policy: "park"` idles at $0, probing readiness; wakes when a merge unblocks deps | Rarely parked — the loop lands its own green PRs | Never blocked on merges — it never waits on another actor |
| What it requires | Nothing extra — works on any plan | Board admin sets the flag; add `enqueue_pr_for_merge` to the loop `tools`; usable CI on the repo — or `merge_gate: "none"` when there isn't one (no-CI repos fail open) | The board's done gate **off** — a human save choosing this landing relaxes it automatically (§5a); the platform grants nothing here, so nothing else has to be enabled |
| Guard rails | Deny floor blocks `gh pr merge` from sessions; done-merge gate on runner moves | Same, plus the `merge_gate` CI pre-flight in the executor (default `forge_ci`; `none` skips it — e.g. free-plan orgs where Actions cannot run) and the server-side `loop_landing_not_enabled` gate | Deny floor still blocks `gh pr merge`; the done gate is deliberately traded away, so the loop **prompt** is the only thing holding the quality bar |

`self_merge` is the honest name for what a prompt saying "merge it yourself"
already does — it is not a permission the platform hands out, and it grants
nothing. That is also why it is the one posture that collides with the done
gate; see §5a.

Both postures share the money rails: cumulative `budget_usd` since the last
enable (`budget_epoch` — re-enabling the loop resets the window), per-session
cap = min(remaining, runner yaml), an 80% warning in the loop feed, and the
honest once-per-run WARN when the provider cannot enforce a session cap
(codex has no cap flag; claude's binds API-billed sessions only).

## 5a. The first-loop trap: the done gate vs. a self-merging loop

The single most common way a first loop used to die on its first card, and it
looked like a platform bug rather than a setting. A human `self_merge` save now
defuses it automatically (below) — this section remains because you should
know what was traded and how to decline it.

**The done-merge gate** stops a *runner* moving a card into a done-typed column
unless that card has a merged, reviewed PR. It defaults **on** for the whole
workspace, and it exists for a good reason: without it an autonomous runner can
declare work finished having shipped nothing.

It only fires for runners, and only on boards **with a linked git repo** — a
board with no repo cannot produce a mergeable PR, so the gate is unsatisfiable
there and is skipped by construction.

Now set `loop_landing: "self_merge"` on a repo-bound board. That posture's whole
definition is *the runner merges its own PR and moves its own card* — so the
first Done move hits the gate and fails with `pr_url_missing`, forever. The two
settings are individually reasonable and jointly unusable.

**The fix is per-board, not per-workspace.** `boards.enforce_done_merge_gate` is
a three-valued override: `null` inherits the workspace flag (every pre-existing
board), `true` enforces even where the workspace opted out, `false` turns the
gate off for that board alone. Leave the workspace default `true` — you almost
certainly still want the gate on your other boards.

Since the auto-relax change you normally set nothing at all:

- **The save is the consent.** A *human* loop save that names
  `loop_landing: "self_merge"` in that request — typed in the dialog or via a
  template bound in the same save — stamps `enforce_done_merge_gate: false` on
  the board in the same transaction. The dialog shows the gate notice and
  saves with the relax accepted by default; unticking it (API:
  `relax_done_merge_gate: false` on the PUT, also exposed on the MCP
  `set_board_loop` tool) declines for that save only — the decline is never
  stored. The stamp only fires where the notice actually renders: override
  unset, workspace gate on, a repo linked. A board an admin explicitly set to
  `true` is never softened implicitly — the dialog warns instead.
- **It re-arms itself.** Moving the landing off `self_merge` on a save
  restores the override to `null` (inherit), so the gate is back on for a
  landing that can satisfy it. Both transitions are recorded as board
  activity (`done_gate_auto_relaxed` / `done_gate_rearmed`).
- **Runner keys get none of this.** A runner save never auto-relaxes — a
  landing a runner stored never counts as consent, even for a later human
  save that doesn't name it — and an explicit `relax_done_merge_gate: true`
  from a runner key is a 403.
- **The manual override still exists** —
  `PATCH /api/workspaces/{slug}/boards/{id}` with
  `{"enforce_done_merge_gate": false}`. A workspace owner or admin may set it,
  and so may the **board's own creator**. You only need it off the beaten
  path now (e.g. relaxing a board without touching its loop config).

Know what you are trading. With the gate off, any runner may move any card on
that board to Done with no PR at all, and it takes effect immediately —
including for cards already in flight. Under `self_merge` the loop prompt is
then the only thing enforcing "landed before Done", which is exactly why that
posture's prompt should spell out the landing steps.

**Not to be confused with `merge_gate`** (the neighbouring select, labelled
*CI gate* in the UI). That one is the merge *queue*'s CI pre-flight —
`forge_ci` or `none` — and has nothing to do with the done gate. It only
matters under `loop_landing: "merge_queue"`.

## 6. Which component owns which feature (and how to check versions)

Field lesson (field report 2026-08-07): an operator ran `strings` on the runner
binary looking for `loop_landing` and `enqueue_pr_for_merge`, found neither,
and concluded the build was stale. It wasn't — neither feature lives in the
runner. Know who owns what before diagnosing "missing feature":

| Feature | Owner | Runner's role |
| --- | --- | --- |
| `loop_landing` opt-in + enqueue gate | backend (+ UI select) | none — never reads it |
| `merge_gate` CI policy (`forge_ci`/`none`) | backend (+ UI select) | none — never reads it |
| `enqueue_pr_for_merge` / all MCP tools | MCP server | passes tool *names* through verbatim to the coding agent's allowlist |
| merge queue worker, reconciler, readiness/history endpoints | backend | calls the endpoints |
| workspace Git Connections + credential resolution | backend (+ UI panel) | none — the runner carries its own `GH_TOKEN` for pushing PRs; these creds are the *backend's* |
| parking, budget caps, continuity seeding, outcome schema | runner | — |
| `starvation_policy`, `budget_epoch` values | backend stores; runner reads | fingerprint strings for a current runner build |

Version checks, one per component:

- **Runner**: `backplane-runner --version` → prints commit + build time. If the
  loop never logs `continuity seeded` / `parked`, the *running process* is an
  old build regardless of what's on disk — restart it.
- **MCP server**: `get_server_info` reports the package version; a checkout
  launch (`uvx --from <repo>/mcp-server backplane-mcp`) tracks the repo.
- **Backend**: features arrive with deploys — if a new endpoint 404s, the
  runner treats it as unsupported and degrades gracefully (that's the
  `*Unsupported` latch, not an error).

## Operator quick-reference

- Edit anything mid-run: `set_board_loop` (omitted fields keep their values;
  applies next iteration).
- Why did it stop? `get_board_loop` → `disabled_reason`. Rails write
  machine-readable reasons; runners are instructed to disable-with-reason.
- Is it parked, waiting, or dead? `parked` means an enabled board has no
  actionable work; `GET /loop/readiness` shows why and heartbeats continue.
  `idle_waiting` means a disabled board is being held by `keep_alive`; the
  board status remains `off`. No fresh heartbeat means the process is dead or
  disconnected, not deliberately parked.
- Spend so far this run: `GET /loop/history` (`spent_usd` since
  `budget_epoch`), plus the per-iteration `loop budget` log line.
- Budget reset: disable, then re-enable the loop (stamps a fresh
  `budget_epoch`).
- Merge failing to authenticate? The entry's `error_message` names the
  credential used (`using workspace connection <login>` / `using platform
  token`) or why there was none. Health chips and the fix:
  Workspace Settings → Git Connections, `docs/git-credentials.md`.
