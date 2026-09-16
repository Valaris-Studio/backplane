# Agentic Delivery Playbook — raw knowledge for the board-setup skill

**Status:** raw-but-organized brain dump, 2026-06-10.
**Provenance:** distilled from an early client pilot run (incidents #3–#7), a second client run — "run B" throughout this doc — (30/30 cards landed, then its "Done vs Actually-Working" audit, kept internal), the default-pipeline program (6-role default + portable bundles + setup contract + WS4 handoff context), and the live `internal-projects` workspace config (v24).
**Audience:** the engineer/agent who will write the "configure a Backplane board + cards + pipeline for an autonomous dev run" skill. Everything here is battle-tested; nothing is speculative unless marked.

---

## 0. The two governing truths

1. **The North-Star failure class.** Almost every production incident was one shape: *a stage reaches a clean exit WITHOUT consuming a card or producing a real artifact, and the system treats that as work (re-loop) or as failure (re-reserve) or as nothing (dead-end).* Money-loops, phantom cards, poll storms, label wedges, discover dead-zones — all instances. Every config decision below exists to make a no-op be **IDLE** (release cleanly), never failure-that-re-reserves or success-that-loops. When designing a board, ask of every signal you produce: *who consumes this, and what happens if nobody does?*

2. **The integration lesson (run B).** A board can land 30/30 cards, every PR merged, every card unit-green, agent_efficiency 0.992 — and the product **cannot perform its north-star function at all**. Run B shipped solid bricks and no mortar: `NewFakeCapturer()` in the prod path, a `silentRecognizer` returning empty transcripts, detection probes whose signals were never pumped into the orchestrator, an onboarding screen that traps the user (a cross-card bug both cards' tests missed), and a binary that was never built. **Unit-level Definition-of-Done ≠ working product.** Card authoring must make integration a first-class, card-owned, dependency-gated deliverable. Section 4 is the cure.

---

## 1. Platform model (what you're configuring)

- **Entities:** Workspace → Boards → Columns → Cards; plus Notes (kinds: `plan`, `review_verdict`, `rework_brief`, `ui_validation`), Definitions, Resources, Git Repos, Teams, Agents, workspace `pipeline_config`.
- **The runner** (`backplane-runner` Go binary) is a multi-role worker loop. Each pipeline **stage** = a role with: a `discover` filter (which cards it may pick up), a `claim` (participant role + execution action), a `git` block (checkout strategy), an `llm` block (stage prompt, model tier, tool allowlist, context_sources), and a `lifecycle` (the step graph including fail paths). The backend scheduler (`next_assignment`) owns all filtering; the runner just asks "next card for role X."
- **House backend invariants** (they shape what configs are safe): Router→Service→Repository→Model layering; **idempotent mutations** — create/add that already exists returns the entity (200/201), never 409, because LLMs retry and multiple roles hit the same endpoint; **2xx ≠ persisted** — always re-read after a write before declaring a config patched (every prod config patch in these runs was verified by independent re-read).
- **Prompt resolution (critical wiring fact):** the runner caches **stored prompt rows** from `GET /prompt-configs` (no synthesis); cache miss → the runner's **built-in Go prompt**. The backend registry defaults (with synthesis) at `/prompt-configs/defaults` **never reach the runner**. ⇒ A corrected prompt must exist as a stored DB row. Deleting a stale override falls back to the *built-in*, which may lack your fix (this burned us: deleting the stale `implement` override would have dropped the PlanNote block entirely).
- **Config-lever hierarchy:** prompt patch < config patch < backend deploy < runner binary rebuild. Prefer the smallest lever. But know the gates: a new **enum value** (e.g. `checkout_integration_head`) must be known by the **deployed backend validator** before any config using it can be saved (422 until deployed — incident #7), and the **running runner binary** must know how to execute it.

---

## 2. Board setup

### 2.1 Columns — column_types ARE the scheduler

Discover filters key on `column_type`, not column names. The canonical set (what the 6-role default's setup_contract derives): **backlog, active, review, done** (optionally blocked). Mapping:

| column_type | who scans it |
|---|---|
| `backlog` | planner only |
| `active` | implementer (`unassigned_or_rework`), rework_mediator |
| `review` | reviewer |
| `done` | documentator, ui_validator |

Consequences:
- **A card in a column no configured role scans is invisible forever** — the "discover dead-zone." Both run-B pauses stranded cards in *backlog + `planned` label* (planner excludes `planned`; implementer never scans backlog) → hand-move to active was the only cure.
- An **untyped column** is excluded from role scanning entirely.
- Don't invent extra typed columns without checking every role's `column_type` + `column_type_exclude`; the setup contract (WS3) exists precisely so the columns a config expects are machine-readable: use the bundle export's `data.description` (setup_contract) as ground truth when creating the board.

### 2.2 Git repo binding

- Bind exactly one repo per board (`create_git_repo`): URL, `default_branch`, `integration_branch` (null ⇒ default branch). Every build role has `require_git_repo: true` — no repo, no pickup.
- The implementer's `repo_has_no_open_pr` precondition is **repo-wide**: ONE orphaned open PR blocks every implementer pickup on the board (incident #3 wedged a whole board on one conflicting leftover PR). One board per repo; never leave PRs open out-of-band; the merge-conflict self-heal edge (now in the default) routes failed merges into rework instead of orphaning.
- Keep `require_branch_protection: false` and `review_mode: "platform"` — standing rule: **don't add new GitHub couplings** (existing `gh pr create`/`gh pr merge` is acknowledged debt; `review_mode:"github"` would need a second identity + `gh pr review`).
- Autonomy is the default: reviewer APPROVE → lifecycle `merge_pr` → squash-merge immediately. There is **no merge_trigger knob** (removed); don't cargo-cult it into configs.

### 2.3 Team + runner binding (the #1 startup footgun)

- **A runner binds to its workspace + pipeline_config via its TEAM, not `allowed_workspaces`.** `allowed_workspaces` is auth-scope only. No team ⇒ `GET /api/agents/me/config` returns empty `workspace_config` ⇒ "platform returned no pipeline_config — agent refuses to start." (Hit live on run B.)
- Fix shape: `create_team` in the workspace, `add_team_member` for the runner, and set **team_roles = every active pipeline role** (e.g. `[planner, implementer, reviewer, rework_mediator, ui_validator]`; disabled documentator may be omitted). **team_roles is the runner's claimed-role set: a pipeline role absent from team_roles silently never runs** — no error, the stage just never fires.
- Teams are created via API/MCP only (no reachable frontend UI for this).
- Identity quirk: `/api/me` with a runner key returns the **owning user**; the runner identity is `/api/agents/me`. Card participation is attributed to the owning user id. Don't "fix" this.

### 2.4 Workspace config

- New workspaces seed the 6-role default pipeline (PLATFORM_DEFAULTS v1). For an existing workspace, verify **parity** before a run: the un-hardened older config reproduces pilot-run-class failures. Checklist of must-haves (all in `internal-projects` v24, the reference): WS4 `context_sources` on implementer/reviewer/rework_mediator; `clear_implementer_hero` before `wake_implementer` in the mediator; reviewer `request_changes` verdict carries `failure_class: needs_rework`; ui_validator `checkout_integration_head` (NOT `checkout_pr_branch`); `all_dependencies_done` on planner + implementer + ui_validator; merge-conflict `on_failure` edge on `merge_the_pr`; no dead `rework-brief-ready` label step.
- The portable bundle (`export_pipeline_bundle` / `import_pipeline_bundle`) is the sanctioned way to bring a workspace to parity: export the good config → import with `dry_run=true` → review preview → commit. Atomic, `expected_version` 409 guard, idempotent re-import. Its `data.description` IS the setup contract (columns + label gates + role orchestration) — feed it to the board-setup step.
- Every config write: pass `expected_version`, and **re-read to verify persistence** (version bump + the specific fields). 2xx ≠ persisted.

---

## 3. Card authoring

### 3.1 The house card anatomy (and why each section earns its place)

Run B's cards were judged "plan-grade, better-formed than the earlier pilot's — no restructure needed." The anatomy:

- **Context** — where this fits; references into the repo's own locked docs (its `PLAN.md §0`, `RESEARCH.md:187`). Why: the implementer reads the repo; pointing at committed docs gives durable, version-controlled grounding the prompt can't drift from. Verify the referenced files actually exist in the repo before launch (we did — dangling refs poison every downstream stage).
- **Goal** — one sentence of intent; the planner's plan note and reviewer's judgment anchor on it.
- **Scope** — concrete deliverables. Keeps the implementer from gold-plating and gives the reviewer a checklist.
- **Acceptance Criteria** — observable outcomes. This is what the reviewer reviews against.
- **Test-First DoD** — "write the meaningful long-term test, then implement until green." The pipeline is TDD-mandatory; a card without a testable DoD produces untestable diffs.
- **Likely Files** — paths to touch. Cuts exploration cost dramatically (~$10/card on run B vs the pilot's worse) and anchors the plan note.
- **Out of Scope** — explicit non-goals. Prevents cross-card collisions when many cards run back-to-back, and *(run-B lesson)* this is exactly where "main-layer wiring" silently leaked out of every card — see 4.3 for the rule that fixes it.
- **Depends On** — human-readable mirror of the dependency edges (the edges are the machine truth; the text helps the planner reason).

Plus: **priority** (scheduler is priority-mode; urgent fix cards preempt), **card_type** (`feature`/`bug`/`task`), and **epic/milestone labels** (`M1`…, organizational, not routing).

### 3.2 Dependency edges — the DAG is load-bearing

- Use `add_card_dependency` / `bulk_set_card_dependencies`; validate with `validate_board_dependencies` and `get_card_dependency_status`.
- `all_dependencies_done` on planner/implementer/ui_validator discover means **a card is untouchable until every dependency card is Done**. Run B's 49-edge DAG (A1→{A2,A3,A4}→capture→detection→transcribe→storage→UI→polish) was topologically verified pre-launch and the cycle-1 watch item ("planner reserves only dep-unblocked A2/A3/A4/C1/D1/E1") proved live.
- **The auditor invariant (incident #5):** any role that spawns follow-up work MUST make that work block the audited item — `create_fix_cards` now auto-adds `source depends_on fix_card`. Without the edge, the auditor re-audits the unfixed source every poll (~$6/cycle money-loop) while starving the fixes. If you ever hand-file fix cards, add the edges yourself.
- Compute and record the expected **cycle-1 eligible set** from the edges before launch — it's your first live correctness check.

### 3.3 Labels are ROUTING, not decoration

Default label flow (from the setup contract): `planned`, `planning-failed`, `direct-implement`, `needs-ui-validation`, `ui-validated`, `rework-mediation-failed`, `documented`, `duplicate`.

- `planned` — applied by the planner on success; excludes the card from planner re-pickup; the implementer takes it once it's in active.
- `direct-implement` — pre-apply (with `planned`) ONLY to cards that should skip planning (e.g. engine-filed fix cards land in active with `[frontend, ui-fix, direct-implement, planned]`).
- `needs-ui-validation` — gates the post-merge ui_validator (done column + include_label). **Applied AT REVIEW, never pre-seeded** — see the wedge below.
- `planning-failed` / `rework-mediation-failed` — fail-path telemetry; proven harmless (NOT discover-excludes; planner re-picks a `planning-failed` card and the label self-clears in effect).
- `duplicate` — terminal marker for approval-gated close-as-duplicate (incident #6): "closed because already shipped" ≠ "built here."

**The wedge classes (memorize these):**
1. **Pre-seeded routing label strands the card (incident #4).** The pilot run pre-seeded `needs-ui-validation` on 12 backlog cards. Every build role `exclude_label`s it; ui_validator only scans `done` ⇒ chicken-and-egg: can't build, can't validate. **Rule: a routing label that gates a LATE stage must never be applied at an EARLY stage.** The sanctioned mechanism: put the machine-readable **body marker** `Validation: requires-ui-validation` in the card description; the reviewer's prompt applies the label on the APPROVE path when the marker is present. (Run B's UI cards lacked the marker → ui_validator stayed dormant the whole run — which is also why nobody caught the onboarding trap; see 4.4.)
2. **Fail-path partial abort + label = discover dead-zone (run-B FIX #2).** A card carrying an all-build-roles-excluded label in a column only excluded-roles scan is invisible. Cleanup recipe in §6.3.
3. **Excluded-label + no_other_card_in_flight = board-wide planner freeze.** A single unactionable card in `active` used to stop ALL planning (run B's one 18-min deadlock). Fixed: `no_other_card_in_flight` now counts only **actively-worked** siblings (CardParticipant row OR unexpired AgentReservation) — a card no role can act on is NOT "in flight." Verify the deployed backend has this fix before relying on it.
4. **Engine-owned invariants bypassed by raw tools (incident #5).** If the engine kind owns labels+edges (`create_fix_cards`), do NOT also give that role's LLM raw `create_card` — it will self-file with wrong labels and no edges. Tool allowlists are part of the routing design.

---

## 4. THE integration lesson — authoring boards that produce working products

Run B proved the pipeline can be flawless per-card and still ship a non-app. The board-setup skill must bake these rules in:

### 4.1 The failure mechanics (so the rules make sense)
Every run-B card had a unit-level DoD. Production seams were stubbed with self-documented interim fakes ("main-layer construction lands with B5/C wiring" — verbatim comments in `autoflow_wire.go`). Each card deferred wiring to "the next card," **and no card was the next card.** Result: `NewFakeCapturer()` in prod (`autoflow_wire.go:171`), `silentRecognizer` (always-empty transcripts), a corroborator constructed and discarded (auto-detect never fires), `endDetector.Observe()` never called (auto-stop never fires), `diarize.MergeWithDiarization` with 0 prod call sites, an 18-line Swift CLI stub behind a fully-built IPC client, `wails build` never run, and a Root↔Wizard handoff bug that traps the user on "All set" — a **cross-card** bug invisible to both cards' unit tests.

### 4.2 Rule: every card touching a production seam must WIRE-OR-FILE
If a card introduces or leaves an interim/fake/stub at a seam the running app uses (`main.go`, the `*_wire.go` layer, DI/constructor sites), its DoD must include ONE of:
- (a) wire the real implementation into the running app's construction path, OR
- (b) create the follow-up integration card **on the board, with a dependency edge**, before closing.
A code comment is not a tracker. "Real impl exists, tests-only call sites" must be treated as **not done** at the board level.

### 4.3 Rule: explicit integration cards with E2E DoD
For each subsystem seam, author a dedicated integration card whose DoD is end-to-end and environmental, not unit:
- "A real Google Meet produces two-track WAV segments on disk; finalize yields two verified Opus masters" (not "supervisor tests pass").
- "Opening a Meet arms+records hands-free; ending it auto-stops within the grace window."
- "The committed WER fixture passes against real fetched models; a group call shows ≥2 system speakers."
These cards depend on the unit cards and are depended on by the milestone (next rule), so `all_dependencies_done` enforces the ordering automatically.

### 4.4 Rule: a final integration/acceptance milestone card
One card, last in the DAG, depending on everything, whose DoD = build the artifact (`wails build` actually runs), execute the human-or-runner smoke checklist (`build/SMOKE.md`-style: real hardware, real permissions, real meeting → searchable transcript), and **launch the app and click through it**. Run B's `build/bin/<App>.app/Contents/MacOS/` was empty after 29 merged PRs — nothing ever forced a build. Cross-card UI bugs (Root↔Wizard) need an E2E smoke (Playwright against the real build, or the manual checklist), **not unit tests** — both components were individually green.

### 4.5 Rule: grep-able "no fake in prod path" assertions
Make the fakes mechanically findable and gate on them:
- Name fakes consistently (`Fake*`, `silent*`, `interim*`, `stub`) and have the integration/acceptance card (or a reviewer directive, or a repo CI check) run `grep -rn 'NewFake\|silentRecognizer\|interim' --include='*_wire.go' main.go app*.go` and require zero hits in prod construction paths — or an explicit linked card per hit.
- Symmetric check: every "real impl" package must have ≥1 production call site (`NewSupervisor()` was called only in tests — grep call sites outside `_test.go`).
- These are cheap, white-label, and would have flagged all four run-B gaps at review time.

### 4.6 Rule: activate the validator for UI surfaces
ui_validator is the pipeline's only "actually look at it" stage and it is **dormant by default** — it fires only on done cards carrying `needs-ui-validation`. Card authoring must put the `Validation: requires-ui-validation` **body marker** on every card with a real UI surface (run B omitted it ⇒ zero validation ⇒ the onboarding trap shipped). The reviewer prompt converts marker→label on approve. Pair with the surface-type resolution in the `validate_ui` prompt v4: (A) web → browser at baseURL; (B) desktop/webview (Wails/Tauri/Electron) → frontend dev server standalone with the native bridge (`window.go.*`) faithfully mocked, packaged-app out of scope; (C) VM-renderable → pve-vm. A Wails .app cannot be browser-tested (WKWebView ≠ Chromium).

---

## 5. Pipeline config knowledge (the 6-role default, internal-projects v24 as reference)

### 5.1 Roles and contracts

Scheduling: `mode: priority`, order **reviewer → rework_mediator → implementer → planner → documentator → ui_validator** (drain downstream before starting new work). All roles `unique: true`. All LLM stages carry the deny-floor `tool_policy.deny`: `gh pr merge/review/close`, `git push --force[--with-lease]`, push to main/master, `git reset --hard` (enforced by the runner on both providers; prefix match).

| role | discover | claim | git | output / on success |
|---|---|---|---|---|
| **planner** | backlog scan; exclude_label `[planned, needs-ui-validation, direct-implement]`; `no_other_card_in_flight`; `all_dependencies_done`; `require_git_repo` | helper / `plan_card` | none | LLM `produces_note` → `create_note(kind=plan)` → unassign self → apply `planned` → move to **active**. Fail: unassign → label `planning-failed` → end. |
| **implementer** | `unassigned_or_rework` in active; exclude `needs-ui-validation`; `all_dependencies_done`; precondition `repo_has_no_open_pr` (repo-wide!) | hero / `implement_card` | `create_branch` off integration_branch, `create_pr`, `force_push_on_rework` | LLM `writes_code` (model `mid`; approval_enabled; context_sources: PlanNote) → `create_pr` → wake reviewer → ship to **review**. Fail: unassign → move back to **active** (⚠️ partial-abort wedge, FIX #2 — see §6.3). |
| **reviewer** | review scan; `require_pr_url`; precondition `pr_is_open`; exclude `needs-ui-validation` | helper / `review_card` | `checkout_pr_branch` (frozen PR branch — CORRECT pre-merge) | LLM `produces_decision` (context: PlanNote). **approve** → `post_pr_review` → `merge_pr` → write `review_verdict` note → move **done**. merge failure → on_failure subtree: unassign → conflict verdict note w/ `failure_class:needs_rework` → wake mediator → move **active** (the incident-#3 self-heal). **request_changes** → unassign → verdict note w/ `failure_class:needs_rework` → wake mediator → move **active**. |
| **rework_mediator** | active scan; `require_pr_url` + `pr_is_open`; `require_note_kind: review_verdict`; **freshness gate** `require_note_kind_newer_than {review_verdict > rework_brief}` (only mediates verdicts it hasn't already briefed); exclude `needs-ui-validation` | helper / `mediate_rework` | `checkout_pr_branch` (pre-merge — correct) | LLM `produces_note` (context: review_history → `{{.ReviewHistory}}`) → write `rework_brief` note → **`clear_implementer_hero`** (`remove_card_participant (pipeline_role)(implementer)` — without it a different-runner hero blocks re-discovery) → wake implementer → unassign → end. |
| **documentator** | done scan; exclude `[documented, needs-ui-validation]` | — | — | **DISABLED** (llm.enabled=false; lifecycle = single `end`). Historical bug: a disabled role's clean no-card walk once reported `lastTickHadWork=true` and starved the role after it in the walk — fixed (clean walk with no card = IDLE), but keep disabled roles' lifecycles minimal. |
| **ui_validator** | done scan; `include_label: needs-ui-validation`; `require_pr_url`; `all_dependencies_done` (the #5 loop-breaker) | helper / `validate_ui` | **`checkout_integration_head`** (fetch + checkout + `reset --hard origin/<default>`; hard-fail on error) | LLM `produces_decision`, broad tools (Bash/Read/Write/Edit/Grep/Glob/Skill — it drives a real app). **approve** → `ui_validation` note → unassign → label `ui-validated` → remove `needs-ui-validation` (NO move — card is already done; the 2 validator warnings about no terminal move are expected/correct). **request_changes / on_failure** → verdict note → **`create_fix_cards`** (engine kind: to active, priority urgent, type bug, labels `[frontend, ui-fix, direct-implement, planned]`, + auto dep-edge source-depends-on-fix) → unassign → end. NO raw `create_card` in its tools (incident #5). |

### 5.2 Discover filter semantics (precise)

- `column_type` / `column_type_exclude` — column-type scoping (board column names irrelevant).
- `include_label` / `exclude_label` (string or list) — routing-label gates.
- `skip_if_pipeline_role: X` — skip if a participant with that pipeline_role already exists (self-dedup).
- `all_dependencies_done` — every dependency card Done.
- `require_git_repo`, `require_pr_url`, `require_note_kind`, `require_note_kind_newer_than {kind, than_kind}` (the freshness gate).
- `no_other_card_in_flight` — planner serialization. **Post-FIX-#2 semantics: counts only actively-worked siblings (CardParticipant OR unexpired AgentReservation).** Pre-fix it counted any non-backlog card and a stranded card froze all planning.
- `preconditions`: `repo_has_no_open_pr` (REPO-wide — one orphaned PR blocks all implementer pickup), `pr_is_open`.
- **Split-brain trap:** discover predicates must live in BOTH `_candidate_cards` AND `_reservation_still_eligible` (a mid-reservation label change once caused per-poll re-handing of an already-approved card). When the platform adds a predicate, check both. Also: the filters appear twice in the config (flat `discover` + the lifecycle `discover` step params) — keep them identical; patches must hit both spots (every incident patch did "2 spots").

### 5.3 Fail paths and their wedge classes

- Every `llm`/`merge_pr`/`create_pr` step needs `on_failure`; a `produces_decision` step returning an EMPTY decision soft-fails to `on_failure` (engine fix `52460eb`) — without it, empty verdicts dead-end cards.
- **Fail-path steps must be ordered restore-first / best-effort:** the implementer fail path is `unassign → move_back(active)`; a transient 429/timeout between them strands the card in backlog+`planned` (the FIX #2 wedge, hit twice in one run). Preferred shape: column-restore BEFORE unassign, and cleanup mcp_calls best-effort/non-fatal. Until that lands in your config, know the cleanup recipe (§6.3).
- Fail paths must terminate in a state SOME role can discover: reviewer/mediator failures end with the card still in their scanned column unassigned (self-heals); planner failure leaves the card in backlog without `planned` (re-planned next poll). Audit any custom fail path against the role/column matrix in §2.1.
- A produced signal needs a consumer (class rule): a failed merge now produces a `needs_rework` verdict the mediator consumes; a failed validation produces dep-linked fix cards; an approved close-as-duplicate produces a terminal close. If your custom branch produces a note/label/decision nothing consumes, it WILL loop or strand.

### 5.4 Circuit breakers

- **cost_circuit_breaker** `{enabled, threshold_usd_per_15min, action: alert|pause|kill_runner}` — set threshold above your per-card budget but low enough to catch loops (run B: per-card $30, breaker $35/15min, action pause; two heavy cards in one window can pause → human resumes; acceptable backstop).
- **Empty-LLM breaker (FIX #1, runner-side):** the cost breaker is blind to **$0 failures** — Claude quota exhaustion returns instantly `exit_code=1, tokens_in=0, tokens_out=0, cost_usd=0`, and pre-fix the runner re-reserved forever (participant add/remove board loop + backend 429s) until human kill. Post-fix: 3 consecutive empty results → pause reservations+refreshes 15min (heartbeat kept), expiry = probe. **Requires the rebuilt binary** — verify your launch binary carries it.
- **No-diff backstop (incident #6):** `maxConsecutiveNoChangeImplements=2` force-blocks any undeclared repeated no-op implement so no role can $-loop regardless of prompt quality. The clean path is the LLM declaring `resolution: "duplicate"` → **approval-gated** terminal close (Done + `duplicate` label). Defense-in-depth principle: *a declared signal for the good outcome, a mechanical breaker for the floor.*

### 5.5 Approval gates

`approval_enabled: true` on the implementer; the prompt teaches when to `request_approval`: close-as-duplicate claims (category `close_as_duplicate` — the gate caught a confidently-wrong duplicate verdict live), bulk/destructive changes, and **conflicts with locked spec** (run-B D1: the pipeline escalated a false locked-constraint to a human instead of silently rewriting — exactly the wanted discipline). **Every approval outcome must map to a terminal action** (close/proceed/block); an approval that merely "lets the next pass run" is decorative (incident #6's root cause).

### 5.6 Handoff context (WS4) — why roles don't fabricate anymore

The pilot run's systemic weakness: prompts told roles to `list_notes` for their critical input, but `list_notes` wasn't in their tool allowlists (hard server-side gate) ⇒ implementer never read the plan, mediator never quoted the verdict ⇒ fabrication. Fix = **server-side `context_sources` pre-injection**:
- implementer + reviewer: `{kind: card_notes, as: PlanNote, filter: {kind: plan}}` → prompt references `{{ index .ContextSources "PlanNote" }}` (NOT `{{.PlanNote}}` — renders empty + trips lint).
- rework_mediator: `{kind: review_history}` with **no `as:`** (the legacy bridge fills `{{.ReviewHistory}}`; an alias breaks it).
- Declare on BOTH the stage `llm` block and the lifecycle llm-step params (the lifecycle copy is load-bearing). The runner WARNs `context source declared but not referenced` if the stored prompt row doesn't reference it — that WARN's absence is a launch watch-list item. Proven conclusively on run B: an implementer diff used paths that existed only in the injected plan note.

---

## 6. Run operations

### 6.1 Launch checklist (run-B-proven order)

1. **Backend parity:** workspace config has every §2.4 item; verify by re-reading the config (and/or `export_pipeline_bundle` and diff against the reference). Prompt **rows** (not registry defaults) carry PlanNote/ReviewHistory blocks and no dead `list_notes`.
2. **Board:** typed columns; cards with full anatomy incl. integration cards + milestone; DAG validated (`validate_board_dependencies`); compute cycle-1 eligible set; **zero pre-seeded routing labels**; UI cards carry the body marker; repo bound, the plan/research docs the cards cite exist in the repo.
3. **Runner + team:** dedicated runner (never a human key) with its own `vlr_` key; **team in the workspace with the runner and ALL active roles in team_roles**; verify `GET /api/agents/me/config` returns the pipeline_config + team_roles + prompt_configs.
4. **Runner config** (`runner/configs/<run>.yaml`, **git-ignored** — keys live here): prod `api_url`, `workspace_slug`, `board_ids`, `api_key: ${VALARIS_API_KEY}`, `max_budget_usd` per card (high enough to never interrupt mid-card), `mcp_config_path` to a run-specific MCP config carrying the runner key in `env.VALARIS_API_KEY` (that's what authenticates every MCP call), `llm.context_dirs: ["~/.claude"]` (→ `--add-dir`, the explicit headless skill-discovery trigger — without it `claude -p` may not find user skills), defaults `auto_pr: true / merge_strategy: squash / review_mode: platform`; no dead keys (`merge_trigger` is gone). Note `--strict-mcp-config` silently ignores MCP servers not in the runner's mcp-config — any MCP-delivered capability must be added there; skills (bun/CLI) are fine.
5. **Binary:** confirm the binary's commit carries every runner-side fix you depend on (dep-edges #5, no-diff backstop #6, `checkout_integration_head` #7, empty-LLM breaker FIX #1, self-trigger rate-floor). Config-only fixes flow live via RefreshPlatformConfig; **runner-executed behavior needs the binary swap**.
6. **Dry validation:** `./bin/backplane-runner --config <cfg> --discover` (exits before the work loop; proves config load, identity = the runner, deny-floor active, MCP config generated) — validates without reserving cards.
7. **Cost rails:** cost_circuit_breaker threshold vs per-card budget (§5.4).
8. **Launch with a log:** `VALARIS_API_KEY=… ./bin/backplane-runner --config … 2>&1 | tee /tmp/<run>/run-$(date +%F-%H%M).log`. Write the watch-list (cycle-1 eligible set; PlanNote rendered + no declared-but-unreferenced WARN; no same-card re-reservation after approve; no repeated no-diff; integration-head checkout) before launching.

### 6.2 Monitoring signals

| signal | meaning | action |
|---|---|---|
| `exit_code=1 … cost_usd=0 tokens_in=0 tokens_out=0` (often `output_len=66`) | **provider quota/credits exhausted** — NOT a card defect | old binary: KILL NOW (it will spin + 429 + participant add/remove loop). New binary: breaker pauses 15min and probes; wait. |
| backend HTTP 429 storms | call-rate burst — usually downstream of the empty-LLM spin or an unthrottled refresh loop | find the upstream spin; kill if old binary |
| card bouncing column↔column ~every poll w/ participant add/remove pairs | a money-loop (re-reserve class) | kill; identify which produced signal lacks a consumer |
| same Done card re-reserved minutes after a clean approve | reservation-eligibility split-brain or missing dep gate | kill + patch config/backend |
| planner idle, board has eligible backlog | `no_other_card_in_flight` tripped by a stranded non-backlog card, OR repo-wide open-PR gate, OR a label wedge | board lever first: find the stranding card (§6.3) — moving it resumes planning on the next ~2-min poll, no restart |
| card in backlog with `planned` label and 0 participants | fail-path partial abort (FIX #2 wedge) | move to active (reversible board lever); self-heals from there |
| card in active with 0 participants | benign — implementer `unassigned_or_rework` self-heals it | wait |
| WS disconnect/reconnect every ~5 min during long stages | Cloud Run idle recycle, ~1s reconnect — benign | ignore unless cadence collapses to rapid succession |
| `agent_presence: touched` on a card | computed read-time annotation, does not gate scheduling | nothing to clear |
| 18-min idle-but-alive with in-flight executions | often just a long LLM stage or a poll gap | check executions before assuming wedge |

**Kill vs wait:** kill on structural loops (money-loops, quota spin on old binary, storms) and leave killed until the structural fix — re-launching reproduces the wedge. Prefer **reversible board levers** (move a card, strip a label, add a dep edge, reap a zombie execution to `aborted`) over restarts for stranded-state wedges — the runner self-resumes on its next poll without ever stopping (incident #4 proved the runner picked up the unwedged card 21 seconds after the board edit). No work was lost across any pause in either run — board state IS the durable state.

### 6.3 Cleanup recipes (post-pause reconciliation)

- Backlog card with `planned` + 0 participants → move to active.
- Active card with 0 participants → leave (self-heals).
- Zombie `running` executions (esp. `cards_affected=null`) → reap to `aborted`.
- Orphaned open PR (merge failed, card bounced) → rebase/resolve and re-queue the card to review, or close the PR — it's blocking ALL implementer pickup.
- Auditor loop in progress → manually add the missing dep edges (source depends_on each fix card) + ensure fixes are in active with `direct-implement`.

---

## 7. Failure-class taxonomy (every known instance of the North-Star class)

*The class: a clean no-op exit treated as work/failure instead of IDLE → re-loop or dead-end.*

1. **Incident #3 — orphaned-PR wedge:** failed merge produced a conflict outcome with no consumer (`merge_pr` had no `on_failure`); the open PR then board-blocked every implementer via the repo-wide gate. Fix: merge-conflict self-heal edge into the rework machinery + zombie-execution reaper that doesn't gate on a nullable field.
2. **Incident #4 — pre-seeded routing-label wedge:** `needs-ui-validation` on backlog cards = every build role excludes, the gated stage never reaches them. Fix: label applied at review via body marker; never pre-seed late-stage labels.
3. **Incident #5 — re-validation money-loop:** validator FAIL spawned fix cards with no dep edge back to the source → source re-audited every poll (~$6/cycle) while the single runner starved the fixes. Fix: auto dep-edge in `create_fix_cards` + `all_dependencies_done` on the validator + remove raw `create_card` from its tools.
4. **Incident #6 — no-diff "duplicate" money-loop:** clean-tree implement = the runner's only meaning was failure→re-reserve (~$2/cycle); approvals were decorative (no consumer). Fix: declared `resolution: duplicate` → approval-gated terminal close + the consecutive-no-op breaker. Lessons: name the reason not the mechanism; gate self-declared verdicts (the gate caught a wrong one live); overloaded "done" forced side-effect inference.
5. **Incident #7 — stale-PR-branch phantom cards:** post-merge validator checked out the frozen PR branch → re-found already-fixed bugs → phantom fix cards feeding the #6 loop. Fix: distinct `checkout_integration_head` action; invariant: pre-merge audits the candidate (PR branch), post-merge audits the integrated result (main HEAD) — split the action, never overload.
6. **Empty-decision dead-end:** a `produces_decision` step returning nothing hard-errored the card; now soft-fails to `on_failure`.
7. **Self-trigger poll storm:** a lifecycle walk to a clean exit without consuming a card set `lastTickHadWork=true` → self-trigger re-armed every tick (~13/s). Fix: clean no-card walk = IDLE + a 3s self-trigger rate-floor.
8. **Disabled-role phantom work:** documentator's `[{kind:end}]` walk reported work → scheduler walk ended one slot before ui_validator every time (the role after a disabled role silently starved).
9. **Reservation-eligibility split-brain:** `_reservation_still_eligible` lacked the label predicates `_candidate_cards` had → a mid-reservation label change re-handed the card every poll.
10. **Run-B FIX #1 — empty-LLM spin:** $0 quota failures invisible to the cost breaker → reserve→fail→re-reserve forever + 429 storm. Fix: consecutive-empty breaker (environment failure ≠ card defect).
11. **Run-B FIX #2 — fail-path partial abort:** transient 429 mid-fail-path stranded the card in a discover dead-zone (backlog+`planned`), and the stranded card then froze all planning via `no_other_card_in_flight` — fixed by counting only actively-worked cards.
12. **The run-B product-level instance (the biggest):** every card reached a clean per-card exit (unit-green, merged) **without the product consuming the work** — fakes at every seam, signals pumped nowhere, no build. The board-level analogue of the class: "card Done" must not be a clean no-op against the running product. Cure = §4 (wire-or-file, integration cards, acceptance milestone, grep-able no-fake assertions, validator activation).

**Design heuristics distilled:** every produced signal needs a named consumer; every approval needs a terminal action; every auditor's spawned work blocks the audited item; every fail path ends somewhere discoverable; every no-op is IDLE; every breaker has a $0-blind-spot check; every label gate is checked against "can the card still reach the stage that needs it"; every seam fake has a card with an edge.

---

## 8. Misc hard-won facts the skill should encode

- Adversarially verify wedge theories with instrumentation before fixing (the "frozen strategy set" theory was confidently wrong; `scheduler.Len()` proved it).
- A live board usually runs a **stored config override** — a source-code default fix needs a parallel live `update_workspace_config` (or bundle import) to protect the running board.
- An all-SQLite test suite cannot see PG-only INSERT-shape bugs (the `activities.seq` NULL outage took down every card write board-wide); platform changes near hot tables need a dialect-compile assertion. Runner-relevant because every lifecycle step writes activities.
- `make deploy-backend` builds the submitted local source — it does not merge; fix-forward off origin/main when prod is ahead. Confirm `gcloud config get-value project` first.
- Good upfront grounding looks like Run B's `RESEARCH.md` (option matrices, risks, reusable references) → `PLAN.md` (a **Locked Decisions table** with rationale, target architecture diagram, state-machine spine, repo layout, phased epics→cards each with test-first DoD, sequencing/milestones, top-risks carried on every board). Cards then cite these by section/line. This is the single highest-leverage input to run quality — run B's $/card and reversion_rate (0.032) beat the pilot's largely on spec quality. What PLAN.md still lacked — and what the skill must add — is the integration/acceptance layer of §4.