# Pipeline Builder UI — Redesign Audit (2026-05-18)

Goal: unify the two pipeline-builder pages onto the lifecycle DSL so every
`kind: llm` step in a role lifecycle exposes its resolved prompt inline,
matching the durable rule [feedback_extensibility_no_limits.md] — any role with
any rules and any prompts must be user-expressible end-to-end. No code in this
doc.

## 1. Component inventory

Path prefix: `frontend/src/features/agents/components/pipeline-builder/`.

| File | Role | Used by |
|------|------|---------|
| `PipelineBuilderPage.tsx` | Legacy page: one stage card per role, flattens to a single `llm.stage` per role. Route `/agents/pipeline`. | legacy (`App.tsx:60`) |
| `LifecyclePipelineBuilderPage.tsx` | Lifecycle page: per-role card, ordered list of typed steps. Route `/agents/pipeline/lifecycle`. | lifecycle (`App.tsx:61`) — orphan, no nav link |
| `SortableStageCard.tsx` | Render one stage with discover/claim/git/llm/sensors/on_success/on_failure forms. Holds `ResolvedPromptRow` (lines 637–688). | legacy (`PipelineBuilderPage.tsx:392`) |
| `LifecycleRoleCard.tsx` | Wraps one role's lifecycle: drag-handle, role label, step-count, `Add step` button, dnd-sortable child steps. | lifecycle (`LifecyclePipelineBuilderPage.tsx:404`) |
| `SortableLifecycleStep.tsx` | Renders one step row: name input, kind select, `KindEditor` dispatch (line 151), `BranchingEditor` (line 153). No prompt resolution. | lifecycle (`LifecycleRoleCard.tsx:200`) |
| `kinds/registry.tsx` | Closed `KIND_EDITORS` map keyed on `LifecycleKindName` (`registry.tsx:28`). Dispatches to per-kind editor. | lifecycle (via `SortableLifecycleStep.tsx:23`) |
| `kinds/LlmEditor.tsx` | LLM step params editor: stage / provider / model / post_process_kind / tools / inject_directives / approval_enabled / use_minimal_prompt_when_unauthored. **No resolved-prompt row.** | lifecycle |
| `kinds/{Apply,Branch,Claim,CreateNote,Discover,EnqueueForMerge,GitSetup,McpCall,MoveCard,RemoveLabel,Sensor}Editor.tsx`, `UnknownKindFallback.tsx`, `JsonField.tsx` | Per-kind params editors. | lifecycle |
| `AddRoleDialog.tsx` | New-role modal (name + starter lifecycle template). | lifecycle (`LifecyclePipelineBuilderPage.tsx:421`) |
| `AddStageDialog.tsx` | Legacy template picker. | legacy (`PipelineBuilderPage.tsx:444`) |
| `BranchingEditor.tsx` | `next` + `branches{}` editor for a step. Decision-only steps show branches. | lifecycle (`SortableLifecycleStep.tsx:153`) |
| `ContextSourcePicker.tsx` | Pick `LLMDef.context_sources` entries (board/notes/sibling-cards). | legacy `SortableStageCard.tsx:560` only; lifecycle `LlmEditor.tsx` does NOT surface context sources (gap) |
| `context-filters/{BoardSnapshot,CardNotes,SiblingCards}Filter.tsx` | Filter sub-forms for each context source kind. | shared via `ContextSourcePicker` |
| `FieldCheckbox.tsx` / `FieldError.tsx` | Generic form atoms. | shared |
| `ToolPicker.tsx` | MCP/Claude tool allowlist picker. | shared (`SortableStageCard.tsx:547`, `LlmEditor.tsx:139`) |
| `SchedulingEditor.tsx` | `scheduling.priority_order` + mode. | legacy only (`PipelineBuilderPage.tsx:427`) — lifecycle page hides it (gap) |
| `SensorListEditor.tsx` | Stage-level sensors. | legacy only |
| `ActionDefEditor.tsx` | `on_success` / `on_failure` blocks. | legacy only |
| `ValidationSummary.tsx` | Renders `PipelineValidationError[]`. | shared (both pages) |
| `lifecycleDraft.ts` | `DraftStep`/`DraftStage` types + `newDndId` factory (lines 7–13). | lifecycle |
| `__tests__/*` | See §5. | — |

Wiring detail: `LifecyclePipelineBuilderPage.tsx:403–413` composes `LifecycleRoleCard`
per draft stage; `LifecycleRoleCard.tsx:194–211` wraps its `steps` in a nested
`DndContext` + `SortableContext` and renders `SortableLifecycleStep` per step.
Two independent dnd contexts (roles outer, steps inner). Lifecycle page never
renders `SortableStageCard`; legacy never renders `LifecycleRoleCard`.

## 2. Data flow

### 2.1 Legacy prompt resolution

`PipelineBuilderPage.tsx:97–129` reads two queries:

- `usePromptDefaults(slug)` → `GET /workspaces/{slug}/prompt-configs/defaults` → `PromptStageDefault[]` (`prompts.ts:3–10, 43–50`).
- `usePromptConfigs(slug)` → `GET /workspaces/{slug}/prompt-configs` → `PromptConfig[]` (`prompts.ts:12–27, 52–59`).

Lines 104–129 build a `Map<"${role}::${stage}", ResolvedStagePrompt>`. Defaults
seed the map first, then workspace overrides overwrite entries — so the
**override-beats-default** semantics are computed client-side; the backend
returns both layers independently and the UI decides which wins.

Per legacy stage, `PipelineBuilderPage.tsx:388–404` keys the map on
`stage.role` + `stage.llm.stage` (the single LLM stage string) and passes the
hit through to `SortableStageCard` as `resolvedPrompt`. `SortableStageCard.tsx:62–69`
defines the shape:

```ts
interface ResolvedStagePrompt {
  slug: string;          // e.g. "implementer-implement" — backend-emitted
  role: string;          // explicit, NOT parsed from slug (62–69 explains why)
  stage: string;
  contentPreview: string;
  workspaceSlug: string;
  isCustom: boolean;     // computed client-side: override beats default
}
```

`SortableStageCard.tsx:474, 637–688` render `ResolvedPromptRow`: a slug code,
custom/default badge, "Edit prompt" deep link to
`/${workspaceSlug}/agents/prompts?role=…&stage=…`, and a truncated preview
(80-char limit, line 84).

### 2.2 Lifecycle prompt resolution (proposed)

`LifecyclePipelineBuilderPage.tsx` does **not** invoke `usePromptConfigs` /
`usePromptDefaults` at all (grep the file). Each `kind: llm` step's
`params.stage` (`pipelineConfig.ts:137–151`) is the missing key. A role can
have N LLM steps; today the user has no way to see which prompt fires for
which step.

Proposed resolver shape (no code, just types):

```ts
interface ResolvedLifecycleStepPrompt {
  stepName: string;           // step.name — stable id within the role
  stageToken: string;         // step.params.stage
  role: string;               // owning DraftStage.role
  slug: string;               // backend-emitted prompt slug
  contentPreview: string;
  workspaceSlug: string;
  isCustom: boolean;          // override beats default, same rule as §2.1
  isMissing: boolean;         // true when stageToken has no default AND no override
}

interface LifecycleLLMStepPromptProps {
  resolved?: ResolvedLifecycleStepPrompt;  // optional — same omit semantics as legacy
  workspaceSlug: string;
  stageToken: string;                      // for the missing-prompt deep link
  role: string;
}
```

Composition: extend `SortableLifecycleStep.tsx` so that when `step.kind === "llm"`,
after `KindEditor` (line 151), a new `LifecycleLLMStepPrompt` row renders the
resolved info — reusing the visual idiom of `SortableStageCard`'s
`ResolvedPromptRow` (badge + slug + preview + deep link). Lookup map keyed on
`${role}::${stageToken}` is built once in `LifecyclePipelineBuilderPage` (same
shape as `PipelineBuilderPage.tsx:104–129`) and threaded down through
`LifecycleRoleCard` → `SortableLifecycleStep` via a new prop
`resolvedPromptByStep?: Map<string, ResolvedLifecycleStepPrompt>` keyed on
`step.name`. Per-step lookup happens inside `SortableLifecycleStep` so the
prop crosses one boundary, not two.

Header summary on each role card: `LifecycleRoleCard.tsx:162–168` currently
shows only `stepCount`. Recommendation: add a derived per-role count of LLM
steps (`steps.filter(s => s.kind === "llm").length`) and, when ≥1, render a
horizontal list of `stageToken` chips (with a `(missing)` red badge for any
chip with `isMissing`). Keeps the role card scannable at a glance — addresses
the "thought there could be multiple" feedback by surfacing the count + the
tokens before the user expands.

### 2.3 Custom-vs-default badging

`PipelineBuilderPage.tsx:117–127` defines the rule: every entry from
`promptDefaults` is seeded with `isCustom: false`; every entry from
`promptConfigs` (where `c.team_role && c.stage`) overwrites with
`isCustom: true`. There is **no backend `is_custom` flag** — the
`PromptConfig.workspace_id` (`prompts.ts:21`) is non-null for overrides but
the UI never reads it. The boolean is a pure client-side computation derived
from "which query returned it last". Recommend keeping that semantics for the
lifecycle page (identical resolver shape) so the two pages stay byte-equal in
their badging logic.

## 3. i18n keys

Two namespaces are in play and do not match:

- `pipelineBuilder.*` — owned by the legacy page (en.json:971–1143).
- `pipelineBuilder.lifecycle.kinds.*` — owned by per-kind editors (en.json:1144 onward, but **nested under `pipelineBuilder`**, not under `pipeline.lifecycle`).
- `pipeline.lifecycle.*` — owned by the lifecycle page chrome (en.json:4429–4495).

Keys currently used in `SortableStageCard.tsx` (legacy) and their disposition:

| Key | Disposition | Notes |
|-----|-------------|-------|
| `pipelineBuilder.dragHandle` (152) | reuse | identical UX in lifecycle role/step rows; lifecycle uses `pipeline.lifecycle.role.dragHandle` + `pipeline.lifecycle.step.dragHandle` instead — split is a wart, leave as-is |
| `pipelineBuilder.stage.noLLM` (170) | reuse | applies per role-card summary |
| `pipelineBuilder.errors` (174) | reuse | |
| `pipelineBuilder.deleteStage` (194) | reuse | |
| `pipelineBuilder.stage.role`, `.stageRolePlaceholder` (208, 214) | reuse | role rename input identical |
| `pipelineBuilder.discover.*`, `.claim.*`, `.git.*`, `.llm.*`, `.sensors.*`, `.onSuccess`, `.onFailure`, `.action.*` (221–606) | reuse for legacy only | not needed in lifecycle (per-kind editors own their copy under `pipelineBuilder.lifecycle.kinds.<kind>.*`) |
| `pipelineBuilder.llm.resolvedPrompt`, `.editPrompt` (648, 674) | reuse | the new per-step row should reuse the exact same two strings to keep visual continuity |
| `prompts.custom`, `prompts.default` (661) | reuse | already shared with the prompt page |

Lifecycle equivalents (en.json:4429–4495): `pipeline.lifecycle.role.{add,delete,deleteConfirm,dragHandle,namePlaceholder,nameLabel,stepsCount,stepsCount_plural}`, `pipeline.lifecycle.step.{add,delete,deleteConfirm,namePlaceholder,nameLabel,kindLabel,dragHandle}`, `pipeline.lifecycle.{next,branches,template,errors,addRoleDialog,save,savedToast,saveFailed,openLegacy}`.

New keys needed (proposed; en + es both):

| New key | Use |
|---------|-----|
| `pipeline.lifecycle.role.llmStepCount` (and `_plural`) | Role header summary: "2 LLM steps". Sibling of existing `stepsCount`. |
| `pipeline.lifecycle.role.llmStageList` | Header label "Prompts:" preceding the chip list. |
| `pipeline.lifecycle.role.llmStageMissing` | Red-badge tooltip "No prompt authored for stage `{{stage}}`". |
| `pipeline.lifecycle.step.llm.missingPrompt` | In-step warning when `resolved.isMissing` is true. |
| `pipeline.lifecycle.step.llm.authorPrompt` | CTA "Author prompt" deep-link label when missing. |

Rename: `pipeline.lifecycle.openLegacy` (en.json:4492) should rename to
`pipeline.lifecycle.openCurrent` / `…openClassic` after the route swap so the
copy still makes sense when the legacy page lives at `/agents/pipeline/legacy`.
Treat the rename as a same-PR change with the swap; both keys can coexist for
one deploy if a feature flag is used.

## 4. Migration risk

`pipeline_config_validation.py` has **no v1→v8 migration chain**. Searched:

- `grep -nE "migrate|to_v|upgrade_to|_v[0-9]_to_v"` → no matches in `pipeline_config_validation.py`.
- `grep -rn "lifecycle" backend/alembic/versions/` → no matches.
- The only `version` field on `PipelineConfig` is the **OCC counter** that bumps on save (`workspace_config.py:864–895, 871–877`). It is not a schema version.

What this means for the lifecycle page:

- `pipeline_config_validation.py:317–318` makes `lifecycle` **optional** per stage:
  `if "lifecycle" in stage: _validate_lifecycle(...)`. Stages without a
  `lifecycle` array still validate.
- `pipelineConfig.ts:236` types it as optional: `lifecycle?: LifecycleStep[]`.
- `LifecyclePipelineBuilderPage.tsx:75` reads `(cloned.lifecycle ?? []).map(...)` —
  so a stage with no lifecycle simply renders as a role with zero steps.
- The UI gap: an operator landing on the lifecycle page for a workspace whose
  persisted config predates the redesign (no `lifecycle[]`) sees an apparently
  empty role with all the legacy `discover/claim/git/llm/on_success/on_failure`
  data **hidden**. The data still saves (lifecycle save flow preserves the
  legacy blocks: see `LifecycleBuilder` test `LifecycleSaveFlow.test.tsx:85`
  "PATCHes pipeline_config with lifecycle + preserved legacy blocks") but the
  user can't see or edit them on the lifecycle page.

`DEFAULT_PIPELINE_CONFIG` (`workspace_config.py:43–`) emits **both** the
legacy blocks AND a populated `lifecycle[]` per stage. New workspaces and
the pilot workspace are safe.

Workspaces at risk: any workspace whose `pipeline_config` was written before
the 2026-05-16 redesign **and never re-saved through the new code path**.
There is no auto-upgrader; canonicalization (`workspace_config.py:125–174`)
only fills `unique` + `scheduling.priority_order` + `scheduling.mode`. It does
NOT synthesize a `lifecycle[]` from the legacy blocks.

Recommendation: orchestrator should run a one-off script before/with the
route swap that, for every workspace where `any(stage.get('lifecycle') is None
for stage in pipeline_config.stages)`, either:

(a) backfills a default lifecycle by mapping the legacy blocks
(`discover` → `discover` kind, `claim` → `claim`, `git` → `git_setup`,
`llm` → `llm`, `sensors` → `sensor`, `on_success`/`on_failure` → `next`/`branches`)
— mirrors what `lifecycleTemplates.ts` and the `copy_*` starter templates
already do for fresh roles; or

(b) ships an "Upgrade to lifecycle" banner on the new page when at least one
stage has no `lifecycle[]`, with a one-click backfill that writes through
the existing PATCH endpoint.

Couldn't find a v1→v8 migration; recommend orchestrator verify before Phase 2
that no migration chain exists in another module (I grepped only
`pipeline_config_validation.py` and `workspace_config.py`).

## 5. Test inventory

`pipeline-builder/__tests__/`:

| File | Coverage | Route swap | Per-step prompt rows |
|------|----------|------------|----------------------|
| `PipelineBuilderPage.test.tsx` | Legacy page render + admin gate + drift dialog + template add + dnd id stability + re-seed after save (8 cases, lines 141–501) | update needed: testing-library navigation paths may hard-code `/agents/pipeline`; reroute to `/agents/pipeline/legacy` if asserted | no change |
| `LifecycleBuilder.test.tsx` | Lifecycle page render + role/step CRUD + duplicate-role guard + empty state (7 cases, lines 105–207) | update needed if any test imports `LifecyclePipelineBuilderPage` route — currently renders the component directly, low risk | additive new test only: assert prompt row appears when `step.kind === "llm"` and `usePromptDefaults`/`usePromptConfigs` are stubbed |
| `LifecycleSaveFlow.test.tsx` | PATCH payload shape preserves legacy blocks; Save-disabled when clean | no change | no change (save-flow doesn't read prompts) |
| `LifecycleBranching.test.tsx` | `BranchingEditor` next/branches discriminator across kinds (7 cases) | no change | no change |
| `RoleComposer.test.tsx` | `AddRoleDialog` form submission | no change | no change |
| `SortableStageCard.prompt.test.tsx` | Legacy `ResolvedPromptRow` slug/preview/deep-link/missing-placeholder | no change | additive new test only: mirror the same three cases for the new lifecycle row component |
| `SortableStageCard.a11y.test.tsx` | Legacy card form labels | no change | no change |
| `SortableStageCard.tooltips.test.tsx` | RichTooltip wiring on legacy fields | no change | no change |
| `ActionDefEditor.a11y.test.tsx` | Legacy `on_success`/`on_failure` form labels | no change | no change |
| `SchedulingEditor.a11y.test.tsx` | Legacy scheduling form labels | no change (legacy lives on) | no change. Note: lifecycle page doesn't mount this editor yet — separate gap. |
| `SensorListEditor.a11y.test.tsx` | Legacy sensors editor | no change | no change |
| `ContextSourcePicker.test.tsx` | Picker behaviour | no change | no change |
| `ToolPicker.tooltips.test.tsx` | Selected-tool badge tooltips | no change | no change |
| `kinds/__tests__/{14 files}` | Per-kind editor unit tests including `LlmEditor.test.tsx` and `registry.test.tsx` | no change | update needed for `LlmEditor.test.tsx`: assert the new prompt row only when `resolvedPrompt` prop is provided; or, if the resolver lives on `SortableLifecycleStep`, no change to `LlmEditor.test.tsx` and a new test on `SortableLifecycleStep` covers the row |

## 6. Done-When-#1 recommendation

**Straight swap in one commit.** `/agents/pipeline` → lifecycle page;
`/agents/pipeline/legacy` → legacy page (`App.tsx:60–61`). No feature flag.

Reasoning: the lifecycle page is already gated by `useWorkspaceAdmin`
(`LifecyclePipelineBuilderPage.tsx:175`) so the blast radius is admins only.
Both pages PATCH the same `/workspaces/{slug}/config` endpoint with the same
`PipelineConfig` shape — there is no data divergence between them; an admin
who saves on the new page produces a config the legacy page can still read
(legacy ignores `lifecycle[]`, lines 67–80 of `PipelineBuilderPage.tsx` don't
even reference it). Rollback is a one-line route-swap revert; there is no
migration to unwind. A feature flag would add a query-key surface, two
deploy paths, and a "which page did I land on" question — all cost without
buying additional safety since the failure mode (admin sees an unfamiliar
page) is identical with or without a flag. Bookmark drift is solved by the
`/legacy` redirect target itself: anyone who had `/agents/pipeline`
bookmarked for the old page lands on the new page, sees the same role names
and PATCH endpoint, and the legacy view is one click away via a header link
(replace `pipeline.lifecycle.openLegacy` with a forward link from the new
default page to `/legacy`). Two-deploy safety not required: the route map is
client-side React Router, hot-reloaded with the bundle.

Caveat: §4 migration gap. If pre-redesign workspaces still hold configs
without `lifecycle[]`, the straight swap exposes them to the empty-role
problem. Gate the swap on resolving §4 first (either backfill script run
against prod, or the "Upgrade to lifecycle" banner shipped in the same PR).

## 7. Top 2 open questions for the orchestrator

1. **Pre-redesign workspace backfill: script or in-app banner?** Script is
   one-shot, removes the legacy code path entirely, runs against prod with
   user approval (no destructive ops without approval rule). Banner keeps
   the legacy structure dormant in the DB and shifts the upgrade decision
   onto each workspace admin, but it costs an extra render path on the new
   page indefinitely. Recommend: script, because the lifecycle DSL is the
   single source of truth (project principle 5) and forking the UI to handle
   "legacy-only configs gracefully" violates principle 5. Decision needed
   before Phase 2 because it determines whether `LifecyclePipelineBuilderPage`
   needs an "empty-but-not-really" rendering mode.

2. **Resolver location: page-level fetch or step-level lookup?** Page-level
   (mirrors legacy `PipelineBuilderPage.tsx:104–129`): one `Map` built once,
   threaded through two component boundaries — clean data flow but extra
   props. Step-level (lookup hook inside `SortableLifecycleStep`): each step
   calls `usePromptConfigs(slug)` + `usePromptDefaults(slug)` directly,
   relying on React Query's cache to dedupe — fewer props but N queries
   declared (deduped to 2 by React Query). Recommend page-level for symmetry
   with the legacy page and to keep render predictable when ten LLM steps
   exist in one role. Decision needed because it shapes the component API
   for `LifecycleRoleCard` and `SortableLifecycleStep`.
