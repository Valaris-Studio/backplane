# LLM → Lifecycle Contract Investigation — 2026-05-17

Investigation into the boundary between `llm`-kind steps and subsequent
lifecycle DSL steps in the generic walker, driving the question:
**can the lifecycle DSL enforce structural guarantees (e.g. "create a note of
kind=plan with the LLM's output") instead of leaning on prompt wording and
LLM-initiated MCP tool calls?**

This is a code-truth audit; no behavioural changes are made.

---

## 1. TL;DR

The LLM-output → lifecycle-step composition is **half-built and silently
broken** in three independent layers. (1) `lifecycle.WalkState` carries the
LLM's parsed result, but the only kind that reads it (`create_note`,
`from_llm_output: true`) **hardcodes the note kind to `review_verdict`** at
the HTTP client layer — the `kind` param in `lifecycle_kinds.py` is decorative.
(2) `DEFAULT_PIPELINE_CONFIG`'s reviewer + design-doc rework_mediator branches
already attempt to express the pattern via `mcp_call(create_note, body:
"$llm_output")`, but **neither `create_note` is registered in
`mcpToolDispatch` nor is `$llm_output` recognised as a runtime ref** — these
steps would error on first run. (3) The MCP `create_note` server tool **does
not expose a `kind` parameter** at all — even if the LLM follows its prompt
flawlessly it cannot write a non-default-kind note. Net result: every
non-`review_verdict` note today is either created via prompt + LLM tool-call
with kind silently falling back to `user_note`, or via a hand-rolled Go
client method like `CreateReviewNote`. The lifecycle DSL has no working path
for "write a note of kind X from the LLM output". This is the gap the
redesign session must close.

---

## 2. Q1 — `create_note(from_llm_output: true)`: does it work?

### 2.1 Walker side: state threading is fine

`lifecycle.WalkState` (`intern/internal/lifecycle/state.go:19-61`) carries an
opaque `LLMResult any` field. The `llm` handler writes it at
`intern/internal/workloop/kind_llm.go:66` (`ws.LLMResult = result`) right
after `executeLLM` returns.

The `create_note` handler at
`intern/internal/workloop/kind_create_note.go:22-45` then reads it via the
bridge helper `llmResultFromWalk(ws)` and calls
`reviewNoteSource(...)` (defined at
`intern/internal/workloop/strategy_generic.go:1525-1534`) which pulls
`(Decision, Findings)` off the result's `reviewResult` struct. This part
works — the LLM's parsed output reaches the note-creation handler.

### 2.2 But the body that ends up in the note is fixed-shape

`reviewResult` (`intern/internal/workloop/loop.go:2088`) is a struct with
`Decision`, `Summary`, `Findings`. The `from_llm_output: true` path on
`create_note` pulls **`Decision` + `Findings` only** (kind_create_note.go:32),
then immediately calls `l.client.CreateReviewNote(...)`
(kind_create_note.go:41). The full LLM stdout is not passed through.

To populate `reviewResult` in the first place, the stage's
`llm.post_process_kind` must be one of `produces_decision` or `produces_note`
— see `wrapGenericOutput` at
`intern/internal/workloop/strategy_generic.go:1100-1133`. Those two paths
fill `reviewResult{Decision, Summary, Findings}` from a parsed
`genericLLMOutput` JSON envelope
(`strategy_generic.go:998-1003`). The LLM must therefore emit JSON of shape:

```json
{"status":"...","decision":"...","summary":"...","findings":"..."}
```

Plain markdown / freeform text falls into the
`parseLLMOutputGeneric` fallback path
(`strategy_generic.go:1086-1093`) which **dumps the raw output into
`Summary` and leaves `Findings` empty**. The note handler short-circuits
when `findings == ""` (kind_create_note.go:38) → **the note is silently
skipped**. So the prompt is load-bearing: if the LLM emits markdown
instead of the expected JSON envelope, no note is created and there is no
error surfaced.

### 2.3 The `kind` param is ignored

`lifecycle_kinds.py:144-152` declares `create_note.params_schema` with both
`kind` and `from_llm_output` keys. The Go handler at
`intern/internal/workloop/kind_create_note.go:22-45` **never reads
`step.Params["kind"]`**. It calls
`l.client.CreateReviewNote(...)` which at
`intern/internal/valaris/client.go:573-583` **hardcodes** `kind:
"review_verdict"`:

```go
payload := map[string]any{
    "title":   fmt.Sprintf("Review: %s — %s", cardID, decision),
    "content": findings,
    "pinned":  false,
    "card_id": cardID,
    "kind":    "review_verdict",
}
```

Every note created via the lifecycle `create_note` kind today is a
`review_verdict`, regardless of what the DSL says. Lifecycles that want a
`plan` note or `rework_brief` note cannot get one from this kind.

### 2.4 Backend accepts `kind`, MCP tool does not

The backend Pydantic schema accepts any string for `kind`:
`backend/app/schemas/notes/note.py:53-61` — `NoteCreate.kind: str =
"user_note"`. So the wire side is permissive; the failure point is the Go
client method that hardcodes the value before sending.

The MCP server's `create_note` tool, by contrast, **does not expose a `kind`
argument at all**:
`mcp-server/src/valaris_mcp/tools/notes.py:47-85`. The tool signature is
`(workspace_slug, title, content, pinned, board_id, card_id, ctx)` — no
`kind`. The body constructed at line 81 omits `kind` entirely, so every
LLM-driven `mcp__valaris__create_note` call falls back to the schema default
`"user_note"`. This means even if the planner prompt instructs "call
`create_note` with kind=plan", the LLM has no way to set it.

### 2.5 End-to-end answer

- The walker → LLM → create_note chain plumbs data through correctly.
- But the **kind** of the note that lands in the DB is fixed at
  `"review_verdict"` for every lifecycle-driven call and `"user_note"` for
  every LLM-driven MCP call. Nothing emits `plan`, `rework_brief`, etc. today.
- The note body is the LLM's `findings` field (when the JSON envelope
  parses) — not the full output. Prompts must emit the envelope or the note
  vanishes silently.

---

## 3. Q2 — Is `llm.params.tools` actually enforced?

### 3.1 Wire path

`workspace_config.py:80-86` declares per-stage tool lists. They are surfaced
through `DataDrivenStrategy.AllowedTools()`
(`intern/internal/workloop/strategy_generic.go:33`) and packaged into
`llm.Options.AllowedTools` at
`intern/internal/workloop/loop.go:1041`. The Claude CLI builder iterates the
list and appends `--allowedTools <name>` per entry:
`intern/internal/llm/claude_cli.go:195-197`.

### 3.2 Enforcement gap: `--dangerously-skip-permissions` is on

Every shipped config sets `dangerously_skip_permissions: true`:

- `intern/configs/intern.yaml:41`
- `intern/configs/lifecycle-smoke.yaml:23`
- `intern/configs/alpha-validation.yaml:14`
- `intern/configs/poc-orchestrator.yaml:12`
- `intern/configs/poc-reviewer.yaml:12`
- `intern/configs/poc-documentator.yaml:12`
- `intern/configs/intern.docker.yaml:15`

The flag is set as `--dangerously-skip-permissions` on every Claude CLI
invocation (`intern/internal/llm/claude_cli.go:189-193`, which makes the
flag mutually exclusive with `--permission-mode`). Per claude-cli
semantics this **bypasses all permission gating** including the allowlist
filter — `--allowedTools` becomes advisory in this mode. The session
evidence supports this: the planner LLM created a card via `create_card`
even though that tool is not in the planner's `tools` list.

### 3.3 Discover path has a real allowlist filter

For the read-only discover phase, the runner explicitly strips write tools
before invoking the LLM:
`intern/internal/workloop/loop.go:1050-1069` (`discoverOpts`). This is the
only place the runner enforces a closed write-set, and it does so by
omission from `AllowedTools` — not by relying on the CLI. But since
`--dangerously-skip-permissions` is still set, the discover-time stripping
is **also advisory** to the LLM; nothing prevents the discover LLM from
calling a write tool. It just won't see those tools listed in
`/mcp` introspection.

### 3.4 Net answer

- The DSL `tools` list propagates through the runner to `--allowedTools`.
- With `dangerously_skip_permissions: true` (universally on in every
  shipped config), Claude CLI does not enforce the allowlist. The list
  becomes an advisory "here is the catalogue" rather than a hard gate.
- To make `tools` load-bearing, either (a) drop
  `dangerously_skip_permissions` and accept the human-permission-prompt
  surface area (untenable for an unattended agent) or (b) move the gate
  server-side: the MCP server refuses tool invocations that aren't in the
  per-stage allowlist passed as session metadata. (b) requires plumbing the
  allowlist into the MCP request context, which doesn't exist today.

---

## 4. Q3 — Producer / consumer table of all 18 kinds

Categorisation is by what the handler **writes to** and **reads from**
`WalkState`. Code citations are file:line in
`intern/internal/workloop/` unless noted.

### 4.1 Pure side-effect (no producer/consumer linkage)

| Kind          | Handler file:line               | What it does                                     |
|---------------|----------------------------------|--------------------------------------------------|
| `apply_label` | `kind_apply_label.go:18`         | POST label to backend; terminal.                 |
| `remove_label`| `kind_remove_label.go:12`        | DELETE label; terminal.                          |
| `move_card`   | `kind_move_card.go:14`           | PATCH column_id; terminal.                       |
| `enqueue_for_merge` | `kind_enqueue_for_merge.go:22` | POST to merge queue; terminal.                  |
| `enable_auto_merge` | `kind_enable_auto_merge.go:20` | `gh pr merge --auto`; soft-fail.                |
| `merge_pr`    | `kind_merge_pr.go:22`            | `gh pr merge`.                                   |
| `post_pr_review` | `kind_post_pr_review.go:25`   | `gh pr review`.                                  |
| `wake_role`   | `kind_wake_role.go:15`           | POST scheduler wake.                             |
| `ship`        | `kind_ship.go:17`                | Composite move-and-stop; terminal.               |

None of these read or write `WalkState.Variables` beyond what the bridge
helpers maintain (e.g. `git_cleanup`, `branch_recovered`).

### 4.2 Producers (write to `WalkState`)

| Kind         | Handler file:line       | Writes                                                                                     |
|--------------|--------------------------|--------------------------------------------------------------------------------------------|
| `discover`   | `kind_discover.go:20`    | `ws.Card` = `*discoverResult` (the typed card payload bridge helpers cast to).             |
| `claim`      | `kind_claim.go:23-66`    | `ws.ExecutionID` = string from backend.                                                    |
| `git_setup`  | `kind_git_setup.go:20`   | `ws.RepoDir`, `ws.Branch`, plus `Variables["git_cleanup"]`, `Variables["branch_recovered"]`. |
| `llm`        | `kind_llm.go:24-105`     | `ws.LLMResult = *llmStageResult`; returns `decision` string to walker (which writes `ws.LastDecision`). May write `Variables["no_changes"]` indirectly via the writes_code post-commit gate. |
| `sensor`     | `kind_sensor.go:19-50`   | `ws.SensorResult = *sensorResults`; returns decision.                                       |
| `branch`     | `kind_branch.go:35-59`   | Reads only; returns decision + nextOverride. NO write.                                     |
| `create_pr`  | `kind_create_pr.go:24`   | Sets `Variables["pr_url"]` and updates card row server-side (read by `$pr_url` ref).        |
| `mcp_call`   | `kind_mcp_call.go:25-52` | When handler returns non-nil, `ws.Variables[<tool_name>] = value`.                          |

### 4.3 Consumers (read from `WalkState`)

| Kind          | Handler file:line                | Reads                                                                                     |
|---------------|-----------------------------------|-------------------------------------------------------------------------------------------|
| `create_note` | `kind_create_note.go:31-32`       | When `from_llm_output: true`: pulls `Decision, Findings` from `ws.LLMResult.reviewResult` (or `ws.SensorResult` fallback). |
| `branch`      | `kind_branch.go:64-75`            | Reads `${last_decision}` → `ws.LastDecision`; `${<var>}` → `ws.Variables[var]`.            |
| `mcp_call`    | `kind_mcp_call.go:160-193`        | `$self`, `$agent_id`, `$learning` (computed from card+LLM+sensor), `$last_decision`, `$card_id`, `$pr_url`. |
| Most kinds    | bridge helpers                    | All read `ws.Card` (set by discover) via `cardFromWalk`. Several require `ws.ExecutionID`. |

### 4.4 Implicit contract gaps surfaced

- **No `$llm_output` runtime ref.** `mcpRefNames`
  (`kind_mcp_call.go:158`) declares only `{$agent_id, $card_id,
  $last_decision, $learning, $pr_url, $self}`. The design doc
  (`docs/pipeline-design/02-role-redesign.md:407,433,548`) assumes
  `"$llm_output"` exists. It does not. Any persisted config that uses it
  fails at the `resolveMCPRef` default branch with `unknown runtime ref
  "$llm_output"`.

- **No mechanism to pipe full LLM stdout into a downstream step's params.**
  Today only the parsed `(Decision, Findings)` survives the LLM
  handler (and only when JSON parsing succeeds). The raw output is
  preserved in execution logs but is not addressable from the DSL.

- **`mcp_call` cannot reach `create_note`.** `mcpToolDispatch`
  (`kind_mcp_call.go:60-122`) covers six tools — `add_card_participant`,
  `remove_card_participant`, `update_card`, `append_definition_learning`,
  `delete_card_review_notes`, `get_card_verdict`. **`create_note` is
  absent**. Any config that uses `mcp_call` with `tool: create_note` errors
  with `mcp_call: unknown tool "create_note"`.

- **`branch` writes nothing**, so the only way to thread a custom value
  forward is `mcp_call` with a handler that returns a non-nil value, which
  the walker stores under `Variables[<tool_name>]`. None of the six
  registered tools today produce values that downstream steps reference.

---

## 5. Q4 — Reviewer's `create_note` vs rework_mediator's MCP `create_note`: which is right?

### 5.1 Two competing patterns in `DEFAULT_PIPELINE_CONFIG`

Pattern A — **lifecycle terminal `create_note`** (legacy default before
the 2026-05-16 role redesign): present today in
`workspace_config.py` no longer (was the old reviewer `request_changes_create_note`
referenced in `02-role-redesign.md:457`). Used `from_llm_output: true`
and walked through the typed `lifecycleCreateNote` handler. **This pattern
hits the kind=review_verdict hardcode** (see §2.3) so it cannot express any
other note kind. It is also terminal — chain stops after the note.

Pattern B — **`mcp_call(create_note)` with `$llm_output`** (the design
doc's preferred pattern, persisted in `workspace_config.py` at lines
461-469 for the reviewer's `request_changes_write_verdict` step):

```python
{
    "name": "request_changes_write_verdict",
    "kind": "mcp_call",
    "params": {
        "tool": "create_note",
        "args": {
            "kind": "review_verdict",
            "body": "$llm_output",
        },
    },
    "next": "wake_rework_mediator",
},
```

The design rationale (`02-role-redesign.md:457`):

> the kind `create_note` is terminal in the walker. To express "write a
> note AND continue" we use `mcp_call` with `tool: create_note`
> (non-terminal).

That rationale is **correct in intent** — terminal vs non-terminal is a
real concern — but **both prerequisites are missing in the runner**:

1. `create_note` is not in `mcpToolDispatch` (`kind_mcp_call.go:60-122`).
2. `$llm_output` is not in `mcpRefNames` (`kind_mcp_call.go:158`).

So the persisted reviewer config in `workspace_config.py:443-482` is a
**dead branch**: when a reviewer rejects, `request_changes_unassign_self`
succeeds, then `request_changes_write_verdict` errors with `mcp_call:
unknown tool "create_note"`. The walker propagates the error, the
execution is marked failed, and the rest of the chain
(`wake_rework_mediator`, `request_changes_move_back`) never runs. The
FOLLOWUP-13 "card stuck in review" wedge that the redesign was supposed
to close is in fact re-opened by this branch — except no one has hit it
in smoke yet, because the **smoke evidence in session memory shows the
five-role default has not been exercised end-to-end against
request_changes** (the most recent FOLLOWUP-12 round verified approve +
documentator; the request_changes branch is unverified).

### 5.2 Is the legacy reviewer using lifecycle `create_note` actually working?

Yes — but only because of the `kind=review_verdict` hardcode at
`client.go:580`. The legacy default emitted a `create_note` step whose
intent was specifically "write a review_verdict note", and the client
method bakes that semantics in. So the legacy pattern works for exactly
one note kind. The new pattern (mcp_call with `kind` param) was supposed
to generalise, but the runner-side primitives required to make it generic
were never built.

### 5.3 So which is right?

Neither is fully right. The legacy `create_note` kind is **terminal +
fixed-kind** (only writes `review_verdict`, then stops the walk). The
proposed `mcp_call(create_note)` is **non-terminal + variable-kind** in
spec but **non-functional** in code today. The redesign needs to choose
between (a) making the terminal `create_note` honour `step.Params["kind"]`
+ extend with a non-terminal variant, or (b) wiring `create_note` into
`mcpToolDispatch` + adding the `$llm_output` ref. Either closes the
gap; option (a) is more disciplined (everything stays in the typed
closed-set kinds) and option (b) is more flexible (any future MCP tool
becomes addressable from the DSL with a single registration).

---

## 6. Q5 — Prompt-leakage table (what the prompt enforces that the DSL should)

Sources scanned:

- `intern/internal/workloop/prompts.go` (implement / implement_after_approval /
  mediate_rework / rework_implement)
- `intern/internal/workloop/prompts_reviewer.go` (review)
- `intern/internal/workloop/prompts_documentator.go` (document)
- `intern/internal/workloop/prompts_research_plan.go` (research / plan)
- `backend/app/services/agents/prompt_defaults.py` (UI-surfaced defaults
  — currently shows legacy "orchestrator" stages; in sync drift with
  the new 5-role default)

Each row below is a sentence in a prompt that **encodes a workflow
guarantee** the lifecycle DSL could enforce instead.

| Prompt              | Sentence / instruction                                                                                      | DSL equivalent (kind)                       | Notes |
|---------------------|--------------------------------------------------------------------------------------------------------------|---------------------------------------------|-------|
| planPrompt          | "For each decomposed card, call create_card(...)"                                                            | none (`create_card` not in mcpToolDispatch) | LLM creates cards directly; no DSL primitive. Sibling-card creation is exactly what produced the smoke wedge. |
| planPrompt          | implicit: "write a plan note via create_note MCP tool" (DEFAULT_PIPELINE_CONFIG comment at `workspace_config.py:137-139`) | `create_note` with `kind: plan` (broken)    | Comment in DEFAULT_PIPELINE_CONFIG says "The LLM writes the plan note itself via create_note MCP tool — no separate create_note lifecycle step." This is the leakage in writing. |
| researchPrompt      | "call log_execution_update(...) when done"                                                                   | none (every kind already log-bookends)      | Cosmetic / observability — low value to migrate. |
| implementPrompt     | "If your implementation requires any of the above [approval categories], you MUST call request_approval(...)" | `approval_enabled: true` already gates this | Already DSL-driven; the prompt restates a DSL invariant. Low-risk but redundant. |
| implementPrompt     | "Do NOT commit or push — the orchestrator handles git operations"                                            | covered by walker post-LLM gate at `kind_llm.go:71-102` | DSL-enforced; the prompt restates the constraint defensively. |
| reviewCodePrompt    | "Call the StructuredOutput tool to deliver your verdict. The schema is: decision / summary / findings"        | `post_process_kind: produces_decision` parses JSON post-hoc; no schema-enforced output | The prompt asks for structured output via a "StructuredOutput tool" that does not exist; the runner does post-hoc JSON parsing (`parseLLMOutputGeneric`). If parsing fails, the note is silently dropped (§2.2). This is a load-bearing prompt sentence. |
| reviewCodePrompt    | (no instruction to call create_note)                                                                          | lifecycle `create_note` from_llm_output     | Reviewer relies entirely on the DSL to write its verdict — this is the one role where the boundary is "correctly" enforced (but the DSL hardcodes `review_verdict` kind, see §2.3). |
| generateDocsPrompt  | "Do NOT commit or push — the orchestrator handles git operations"                                            | walker post-LLM gate                        | Same as implementer. |
| mediateReworkPrompt | "Respond with EXACTLY this JSON: {action_plan, escalate}"                                                    | post-hoc JSON parse only                    | Schema not enforced by tool; one bad emit = silent fallback. |
| reworkImplementPrompt | Repeats project directives block + compliance checklist                                                     | DSL `inject_directives: true` already does this | The prompt restates what `inject_directives` provides; defensible duplication. |
| planPrompt (rework_mediator skeleton in design doc) | "Emit the brief body in your closing block; the lifecycle writes it as a `rework_brief` note" | `create_note` with `kind: rework_brief` (broken) | Design doc plans this; runner cannot deliver. |

Concrete migration backlog implied by the table (high → low value):

1. **Plan note** (planner) — biggest leakage. Today the LLM calls
   `create_note` directly with no kind plumbing; the comment at
   `workspace_config.py:137-139` admits this as a workaround for the
   DSL gap. Migrate to a DSL step that produces `kind: plan`.
2. **Sibling card creation in planPrompt** — the LLM calls `create_card`
   to decompose work; this should be a `mcp_call` with a `create_card`
   handler in `mcpToolDispatch`, gated by the `decompose_card` tool
   already in the planner allowlist. Without the gate, the planner can
   create cards in any column with any labels, undermining workspace
   tenancy assumptions.
3. **Verdict note kind / failure_class** — reviewer's
   `request_changes` branch already TRIES to write
   `failure_class: needs_rework` via `mcp_call(create_note)` per the
   design doc, but the current persisted config at
   `workspace_config.py:461-469` omits `failure_class` AND the
   mechanism is non-functional anyway (§5).
4. **JSON envelope contract** — every produces_decision /
   produces_note stage asks the LLM for a 4-field JSON envelope. There
   is no schema enforcement; the runner does best-effort parsing
   (`parseLLMOutputGeneric` at `strategy_generic.go:1086-1093`) and
   silently drops malformed outputs into `Summary`. This is invisible
   to operators when it happens. Either: (a) feed the schema to
   Claude via `--json-schema` (already supported per
   `claude_cli.go:185-187` — `opts.OutputSchema` field) but currently
   never set anywhere in the runner; or (b) treat malformed JSON as a
   loud error, not a silent skip.
5. **`Do NOT commit or push`** repeated in implementer + documentator
   prompts — already covered by walker post-LLM commit gate
   (`kind_llm.go:71-102`). Defensible duplication.

---

## 7. Options for the redesign session

### Option A — Make the terminal `create_note` kind honour its params

**Scope:** Go runner change only; no new kinds.

- Extend `lifecycleCreateNote` (`kind_create_note.go`) to read
  `step.Params["kind"]` and `step.Params["failure_class"]`.
- Replace the `CreateReviewNote` client call with a generic
  `CreateNote(workspace, board, card, kind, title, content,
  failure_class)` method on `valaris.Client` that POSTs to the existing
  `/api/workspaces/{slug}/boards/{board}/notes` endpoint (already
  accepts arbitrary `kind` per `notes/note.py:53-61`).
- Source the note body from the raw LLM stdout (preserved on a new
  `ws.LLMRawOutput` field set by `kind_llm.go`), not the parsed
  `findings` subfield — operators can still ask for the parsed JSON via
  a `body_from: findings|raw|summary` param.

**Risk:** low. The terminal kind stays terminal — chains that need to
continue past the note still need the non-terminal `mcp_call` variant
(see Option B). Parity test (`tests/services/agents/test_lifecycle_kinds_parity.py`)
must be updated.

**New primitives:** none — just plumb existing params.

### Option B — Make `mcp_call(create_note)` functional

**Scope:** Go runner change.

- Register `create_note` in `mcpToolDispatch`
  (`kind_mcp_call.go:60-122`). Handler reads `args.kind`, `args.title`,
  `args.body`, `args.failure_class`, `args.pinned`, calls a new generic
  `valaris.Client.CreateNote` method.
- Add `$llm_output` to `mcpRefNames` and a case in `resolveMCPRef` that
  returns the raw LLM stdout from a new `ws.LLMRawOutput` field.
  Consider also `$llm_findings`, `$llm_summary`, `$llm_decision` as
  parsed-subfield refs for callers who want the structured pieces.

**Risk:** low to medium. Once `create_note` is a `mcp_call` target,
operators may want every MCP tool to be addressable — but the closed
dispatch is the safety rail (per `kind_mcp_call.go:12-24` design note).
Document the policy clearly: "kinds first, mcp_call only when no kind
fits".

**New primitives:** `$llm_output` ref + a generic `CreateNote` client
method. Same client method as Option A — these options share the
client-side work.

### Option C — Both A and B (the comprehensive fix)

Both options share the same `valaris.Client.CreateNote` and the same
need to preserve raw LLM output on the walk state. Doing them together
is roughly the same scope as either alone plus one extra dispatch entry
and one extra ref. Gives operators both shapes: terminal "write and
stop" (Option A) and non-terminal "write and continue" (Option B). The
existing FOLLOWUP-13 fix in `workspace_config.py:461-482` already
assumes Option B is available; doing both keeps the persisted config
working while letting cleaner sequences use Option A.

**Recommendation:** Option C. Single code change cluster, two operator
ergonomic shapes.

### Option D — Make `tools` actually enforced

Orthogonal to A/B/C but in the same trust-surface neighbourhood.

- **Path D1 (runner-side):** drop `dangerously_skip_permissions`,
  switch to `permission_mode: bypassPermissions` with a trusted
  `.claude.json` that whitelists exactly the `mcp__valaris__*`
  toolset. Per claude-cli docs this *does* honour `--allowedTools`.
  Risk: requires `.claude.json` provisioning on every runner host;
  brittle in containers.
- **Path D2 (server-side):** plumb the per-stage allowlist into the
  MCP session metadata at `valaris-mcp` server boot. Server-side
  middleware refuses tool invocations whose name is not in the
  per-execution allowlist. The runner already knows the execution_id
  per LLM run — pass it as an MCP header. Stronger trust boundary
  (works no matter what the CLI flags do), but requires MCP server
  changes and a per-session `tools` propagation mechanism.

**Recommendation:** D2 long-term, but out of scope for the redesign
session — file as a separate Wave. Options A/B/C remove the *need*
for D in the common case by making the DSL produce the structural
outputs instead of trusting the LLM to use the right tools.

---

## 8. Open questions for the next session

1. **Raw LLM stdout vs parsed envelope.** Do operators ever want the raw
   pre-JSON-parse output written into a note, or is "the parsed findings
   field" always the right grain? If always parsed, Option A/B can keep
   reading from `reviewResult.Findings` rather than introducing
   `ws.LLMRawOutput`. Recommended default: support both, default to
   `body_from: findings` with `raw` and `summary` as alternatives.

2. **What note kinds are first-class?** Design doc's resolved
   decision item #4 (`02-role-redesign.md:830`) registers `plan`,
   `review_verdict`, `rework_brief` in `app.models.notes.kinds`. Is
   this still the closed set, or should `user_note` stay open-ended for
   ad-hoc cases?

3. **JSON-envelope schema enforcement.** Should the runner pass
   `--json-schema` to claude-cli (the support is already there at
   `claude_cli.go:185-187` but unused) per stage's
   `post_process_kind`, so malformed JSON is a hard error at the LLM
   layer rather than a silent skip downstream? This would catch the
   "findings field missing → note silently dropped" bug class.

4. **Terminal vs non-terminal: one kind or two?** Option A keeps
   `create_note` terminal and pushes non-terminal usage to
   `mcp_call(create_note)`. An alternative is to split into
   `create_note` (terminal) and `write_note` (non-terminal). Same
   semantic surface, different operator ergonomics. Naming +
   discoverability cost.

5. **`$llm_output` granularity.** Refs like `$llm_findings`,
   `$llm_summary`, `$llm_decision` are easy additions once `$llm_output`
   exists. Are there other parsed fields we expect to thread? (e.g.
   `$llm_status`, `$llm_action_plan`.)

6. **MCP `create_note` tool — should we add `kind`?** The MCP tool
   does not expose `kind` today
   (`mcp-server/src/valaris_mcp/tools/notes.py:47-85`). Adding it is
   one-line, but if Options A/B make every lifecycle path bypass the
   MCP tool and go straight through the runner client, the MCP tool's
   relevance for LLMs shrinks. Decision: do we want LLMs to still be
   able to write `plan` / `rework_brief` notes themselves (e.g. for
   ad-hoc operator-driven flows), or is that path explicitly closed?

7. **Sibling card creation by the planner.** The current planPrompt
   instructs the LLM to call `create_card`. That MCP tool is in the
   server but not in `mcpToolDispatch` (so DSL can't call it). Is
   sibling-card creation a DSL concern at all, or is it OK for it to
   stay a prompt-driven LLM action? If yes-DSL, this implies a new
   `decompose` kind or a `create_card` entry in the dispatch.

8. **Plan failure detection.** Today there is no signal "the planner
   tried to write a note but no note appeared" — `kind_create_note.go`
   silently skips on empty findings. Should this be a hard error so
   the failure subtree (`planner_fail_unassign` etc.) actually runs?

9. **Per-stage `--allowedTools` enforcement** (Option D). Worth filing
   as a separate Wave or roll into the same redesign?

10. **Inline-rationale for the FOLLOWUP-13 dead branch.** The
    reviewer's `request_changes` branch in `workspace_config.py:443-482`
    is non-functional today (`$llm_output` + `create_note` in
    `mcp_call` both unsupported). Smoke has not exercised
    `request_changes` since the redesign deployed. Is there an interim
    band-aid we want to ship before Options A/B/C land, or do we
    accept the broken state until the redesign closes it? (Recommended:
    flag this as smoke-blocking and ship Options A/B before the next
    request_changes-exercising smoke.)
