# Pipeline Config Audit — 2026-05-16

## Summary

- **13 workspaces audited** via `mcp__valaris__get_workspace_config`.
- **0 workspaces use custom roles or v3-DSL extensions.** Every workspace runs the canonical 3-role pipeline (orchestrator / reviewer / documentator) defined in `backend/app/services/workspace_config.py::DEFAULT_PIPELINE_CONFIG`.
- **12 of 13 workspaces** have `version: 0` — they have **no persisted `WorkspaceConfig` row**, so `WorkspaceConfigService.get_config` returns `PLATFORM_DEFAULTS` (which embeds `DEFAULT_PIPELINE_CONFIG`) verbatim. These will inherit any backend default change for free.
- **1 workspace (the pilot workspace, version 3)** has a persisted row. Its `pipeline_config` is byte-for-byte equal to `DEFAULT_PIPELINE_CONFIG` with one drift: `on_success.branches.approve.cleanup_review_notes = true` (default is `false`; legacy block only, walker ignores).
- **All workspaces have the lifecycle DSL** because they all serve DEFAULT_PIPELINE_CONFIG. Both FOLLOWUP-13 (reviewer `request_changes` terminal-without-move) and FOLLOWUP-14 (`skip_if_participant_role: reviewer` vs claimed `helper`) are **defects of the default config** and therefore present in every workspace.

Workspaces audited: `internal-projects`, `static-playground`, `valaris-general`, plus ten client workspaces including the pilot workspace (client slugs anonymized for the public export).

## Per-workspace inventory

### `internal-projects` (config version: 0 — using PLATFORM_DEFAULTS)

No persisted `WorkspaceConfig` row. Reads DEFAULT_PIPELINE_CONFIG. See the **DEFAULT_PIPELINE_CONFIG** table below — every cell applies.

### The pilot workspace (config version: 3 — persisted, one legacy drift)

Persisted pipeline. **Identical to DEFAULT_PIPELINE_CONFIG** in `stages[*].lifecycle` (the path the new walker actually executes), plus identical in every `discover`/`claim`/`git`/`llm` block, with two cosmetic deltas in legacy-only fields:

- `stages[reviewer].on_success.branches.approve.cleanup_review_notes` = **`true`** (DEFAULT_PIPELINE_CONFIG sets `false`). Legacy `on_success` is not read by the new walker. **No runtime effect under the lifecycle walker.** Under the legacy Tick path, this means approved cards have their review notes wiped — which the 2026-05-14 smoke filed as a defect; fix is to flip to `false`.
- `stages[*].llm` blocks omit `provider`/`model` keys (lifecycle `llm.params` still carries both). Reflects pre-CRIT-1/2 migration state. Lifecycle path unaffected.

### All other 11 workspaces (nine client workspaces + `static-playground`, `valaris-general`) (config version: 0)

No persisted `WorkspaceConfig` row. Reads `PLATFORM_DEFAULTS` → `DEFAULT_PIPELINE_CONFIG` verbatim. **Identical to the table below.**

### DEFAULT_PIPELINE_CONFIG (the actual table — applies to all 13 workspaces)

| Role | participant_role | execution_action | discover.column_type | discover.filters | llm.stage | lifecycle has full state-transition tail? | terminal kinds per branch |
|---|---|---|---|---|---|---|---|
| orchestrator | `hero` | `implement_card` | `""` (any), `exclude=done` | `require_git_repo: true`; preconditions `repo_has_no_open_pr` | `implement` | YES (linear) | `ship` (single branch) |
| reviewer | `helper` | `review_card` | `review` | `require_pr_url`, `skip_if_participant_role: reviewer`, `require_git_repo` | `review` | PARTIAL — approve branch OK; request_changes branch ends in `create_note` (terminal) **without moving the card** | approve: `move_card`→done; request_changes: `create_note` (BROKEN, no `move_card`) |
| documentator | `helper` | `document_card` | `done` | `exclude_label: documented`, `require_git_repo` | `document` | YES (linear, with on_failure subtree) | success: `apply_label` (documented); failure: `apply_label` (documentation-failed) |

**Legacy-block drift that the walker ignores (recorded for completeness):**

- Orchestrator `on_success.move_to_column_type: "review"` and `wake_roles: [reviewer]` — superseded by lifecycle `ship` + `wake_role` (orchestrator lifecycle has no `wake_role` step at all — see Role-gap analysis below).
- Reviewer `on_success.branches.approve.cleanup_review_notes` — lifecycle has no equivalent. Cards approved via the new walker never wipe their review notes (which matches the 2026-05-14 fix intent, but the policy is now silent rather than expressed).
- Reviewer `on_success.branches.request_changes.create_review_note: true` — lifecycle handles this via `create_note` step.
- Reviewer `on_success.branches.request_changes.append_learning: false` — lifecycle simply omits the step; no override mechanism if a workspace wanted it on.
- Documentator `on_success.add_label: documented` — lifecycle expresses as `apply_label` step; equivalent.
- Documentator `on_failure.stay_in_column: true` — lifecycle does not emit any `move_card` on the failure branch, so card stays. Equivalent by omission.

## Lifecycle DSL completeness check

Walker terminal-kind rules: `move_card`, `apply_label`, `remove_label`, `create_note`, `enqueue_for_merge`, `ship` are terminal. Other kinds without `next`/`branches` are config errors. A branch is "OK" if its tail moves the card to the intended column type **or** ends in `ship` (which moves the card as a side-effect of its handler).

Since 12/13 workspaces serve DEFAULT_PIPELINE_CONFIG verbatim and the pilot workspace only drifts on the legacy `cleanup_review_notes` flag, the same row applies to every workspace. Listing per-role once:

| Workspace | Role | Decision branch (if any) | Last step kind | Card moved? | Participant released? | Verdict |
|---|---|---|---|---|---|---|
| ALL 13 | orchestrator | — | `ship` (`to_column_type: review`) | YES (ship handler moves to `review`) | n/a (hero stays until reviewer approves) | OK |
| ALL 13 | reviewer | `approve` | `move_card` (`to_column_type: done`) | YES | NO — reviewer is not unassigned on approve (relies on next reviewer pass not re-claiming; FOLLOWUP-14 means filter is broken so the card *can* be re-claimed) | OK functionally for the happy path; **degraded** because the skip-filter doesn't actually skip — see FOLLOWUP-14 |
| ALL 13 | reviewer | `request_changes` | `create_note` (terminal, no preceding `move_card`) | **NO** | YES (`request_changes_unassign_self` runs before the note) | **BROKEN** — FOLLOWUP-13. Card sits in `review` column with no reviewer participant; the next reviewer tick re-discovers it (skip filter doesn't catch it — see FOLLOWUP-14), so the reviewer loops forever on the same rejection until cooldown/cost-breaker fires. |
| ALL 13 | documentator | success | `apply_label` (`documented`) | NO (intentional — docs stays in `done`) | NO (not explicit; relies on `exclude_label: documented` to prevent re-pickup) | OK (the `documented` label is the de-facto release signal via the discover filter) |
| ALL 13 | documentator | `on_failure` subtree | `apply_label` (`documentation-failed`) | NO (intentional) | YES (`fail_unassign_self` runs first) | OK (`documentation-failed` label is not currently filtered out, so the card *will* be re-discovered next tick — minor secondary bug, not on the FOLLOWUP list yet) |

## Role gap analysis

### Roles that conflate concerns

- **orchestrator = planner + implementer + shipper.** The current `orchestrator` lifecycle does `discover → claim → git_setup → llm(stage=implement) → create_pr → enable_auto_merge → ship`. The LLM prompt stage is named `implement` and the participant role is `hero`. There is no separate planner step, no architect step, and no decomposition step. For non-trivial cards this means a single Sonnet call has to read the card, design, implement, test, commit, and push — which the 2026-05-14 and 2026-05-16 smoke notes flagged as the dominant cause of mid-card rework. The role name `orchestrator` is also a misnomer: it does no orchestration of subroles; it is just `implementer`.
- **reviewer = code-review judge + GitHub-PR-actuator + lifecycle-state-machine.** Reviewer is the only role that does `post_pr_review` + `merge_pr` + `wake_role(documentator)` + `move_card`. Approving means the reviewer becomes the merge actor; if merge fails there is no operator handoff (no `on_failure` route on `merge_the_pr`). Splitting the GH actuation from the judgement would let an operator retry merges without re-running the LLM.
- **documentator = doc-writer + label-keeper.** Mild conflation: the documentator does the doc commit *and* manages the `documented` label that gates re-discovery. Acceptable as-is, but worth noting that the label is being used as a state machine, not as user-facing metadata.

### Roles missing from defaults that real workflows need

- **`planner` / `architect`** — decompose large cards, produce an explicit implementation plan note before any code is written. Currently `mcp__valaris__decompose_card` exists as a prompt but no pipeline role invokes it.
- **`implementer`** distinct from `orchestrator` — see conflation above. Once split, the orchestrator becomes a thin discover→delegate role and the implementer owns the LLM call.
- **`rework_mediator` / `re-implementer`** — today, when reviewer says `request_changes`, the card moves (would-move, if FOLLOWUP-13 were fixed) back to `active` and the orchestrator re-claims it. The orchestrator has no awareness it is doing rework vs. greenfield. A dedicated rework role could read the verdict note and target the changes instead of re-running the full implement prompt.
- **`security_auditor`, `ux_writer`, `qa_smoke`, `migration_safety_checker`** — north-star calls for arbitrary user-authored roles. None exist as defaults; nothing in DEFAULT_PIPELINE_CONFIG demonstrates a sensor-driven or non-LLM gate role beyond documentator's label step.
- **`integration_branch_owner`** — referenced in `git.base_ref: integration_branch` but no role owns creating or rotating the integration branch.

### Per-role: is the LLM stage prompt actually doing what the role name suggests?

- `orchestrator.llm.stage = "implement"` → role is named "orchestrator" but the prompt key is `implement`. **Names disagree with behavior.** This is the silos issue (`project_prompts_pipeline_runner_ui_clarity.md`).
- `reviewer.llm.stage = "review"` → consistent. Note `inject_directives` ships as `true` in DEFAULT but the pilot workspace's persisted v3 has it as `true` for reviewer too (parity confirmed; earlier `project_reviewer_inject_directives_asymmetry.md` resolved).
- `documentator.llm.stage = "document"` → consistent. `inject_directives = false` — intentional, but worth flagging that ProjectDirectives are silently absent from the docs prompt; if a directive said "all docs must include a security section" the documentator wouldn't see it.

## Filter semantics audit

Search for role-keyed discover filters across all 13 configs:

| Workspace | Role | Filter | Filter value | Claim writes participant_role = | Mismatch? |
|---|---|---|---|---|---|
| ALL 13 | reviewer | `skip_if_participant_role` | `"reviewer"` | `"helper"` | **YES — FOLLOWUP-14.** Filter never matches because claim writes `helper`, not `reviewer`. Combined with FOLLOWUP-13 (no `move_card` on request_changes), this is the rejection-loop mechanism. |
| ALL 13 | orchestrator | (none — no role-keyed filter; uses `preconditions: [repo_has_no_open_pr]` instead) | — | `"hero"` | n/a |
| ALL 13 | documentator | (uses `exclude_label: documented` — not role-keyed) | — | `"helper"` | n/a |

**No other role-keyed filters exist** in any workspace. `skip_if_participant_role` and `require_participant_role` are only used in the one reviewer instance, and it's wrong everywhere.

Secondary observation: the documentator and reviewer both write `participant_role: "helper"`. A `skip_if_participant_role: "helper"` filter (if ever added) would conflate the two roles. The participant-role taxonomy is effectively binary (`hero` vs `helper`) which means it cannot distinguish "a reviewer already looked at this" from "a documentator already looked at this". This is a structural limitation that any rework-mediator or auditor role will hit immediately.

## Recommendations (input to design doc)

- **Fix FOLLOWUP-13 in DEFAULT_PIPELINE_CONFIG**: insert a `move_card(to_column_type: active)` step between `request_changes_unassign_self` and `request_changes_create_note` (or after the note, since `create_note` is terminal — likely simpler to invert the order: note first, then move, then implicit terminal via `move_card`). All 13 workspaces inherit the fix on next deploy.
- **Fix FOLLOWUP-14**: either change the claim to write `participant_role: "reviewer"` (semantically truer), or change the filter to `skip_if_participant_role: "helper"` (matches current claim but conflates with documentator), or add a new `skip_if_execution_action: "review_card"` filter keyed on the unambiguous claim field. Recommend renaming the claim to `participant_role: "reviewer"` — `helper` is content-free.
- **Introduce a `participant_role` taxonomy**: one value per pipeline role (`implementer`, `reviewer`, `documentator`, plus user-defined). Drop the `hero`/`helper` binary. This is a prerequisite for any user-authored role to express "skip if my role already touched this card".
- **Split orchestrator into `planner` + `implementer`** (two stages) — even if the default keeps them collapsed for back-compat, the lifecycle DSL must be able to express the split for user-authored pipelines.
- **Promote `cleanup_review_notes` to a first-class lifecycle step kind** (or fold into `create_note` params) — currently policy lives only in the legacy block, with no DSL expression, so user-authored reviewer roles cannot opt in.
- **Decommission the legacy `on_success` / `on_failure` blocks** from `DEFAULT_PIPELINE_CONFIG` once the walker is the only execution path. Keep the JSON-schema field for back-compat reads but stop emitting it in new configs; the drift between legacy `cleanup_review_notes: true` (the pilot workspace) and the lifecycle (silent) is exactly the kind of two-source-of-truth bug the audit was meant to surface.
- **Add per-role `wake_role` steps to the orchestrator lifecycle**. Today the orchestrator's `on_success.wake_roles: [reviewer]` is legacy-only; the lifecycle just runs `ship` and assumes the scheduler wakes the reviewer. Make it explicit.
- **Add `on_failure` routes to `merge_the_pr`, `post_pr_review_approve`, `create_pr_for_card`, `enable_auto_merge`** — today these are non-terminal kinds with no `on_failure`, so a failure aborts the walk and the card is left in an indeterminate state (PR may or may not exist, participant still held).
- **Document a re-discovery exclusion for `documentation-failed`** label, mirroring `documented`.
- **Migrate the 12 default-inheriting workspaces to persisted configs** before changing DEFAULT_PIPELINE_CONFIG, OR commit to the inheritance model (don't persist on first edit). Today the line is ambiguous: any UI edit will materialize a snapshot and freeze that workspace at the v3-ish drift point of the pilot workspace.
- **Add `lifecycle` schema validation that asserts every decision-producing kind has a branch for every decision it can emit** (walker's docstring already notes backend validation should do this — verify `pipeline_config_validation.py` enforces it and add the FOLLOWUP-13 case: a `request_changes` branch must terminate with `move_card` or `ship`).

## Project principles (re-stated for the design phase)

- Backend owns pipeline/role/prompt config. The Go runner must never hardcode role names or stage transitions.
- The lifecycle DSL is the single source of truth for the new walker. Legacy `on_success`/`on_failure` blocks are dead code under the new walker and should not encode policy the lifecycle cannot.
- Any user must be able to define any role with any rules end-to-end. Today's defaults bake in `hero`/`helper` and a 3-role assumption — both must be expressible as user choices, not platform constants.
- The code IS the documentation; this audit's purpose is to make the spec input for the next phase legible without reading 500 lines of JSON per workspace.
