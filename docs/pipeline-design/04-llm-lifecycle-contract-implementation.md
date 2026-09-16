# LLM → Lifecycle Contract — Implementation Outline (2026-05-17)

This is the **Phase 2 implementation plan** for the gap surfaced in
`03-llm-to-lifecycle-contract-investigation.md`. The locked decisions live
in the parent brief (Option C, `body_from` default = `findings`, MCP
`create_note` gains `kind`, planner `create_card` stays closed off, hard
errors on missing kind / empty body, four new `$llm_*` refs, terminal
`create_note` kept + `mcp_call(create_note)` made functional, `CreateReviewNote`
preserved as a router into the generic `CreateNote`).

No code is written here. TDD ordering, per-file scope, test scopes, and
back-compat impact only.

---

## Section 1 — Architecture summary

### Today

- `lifecycle.WalkState.LLMResult: any` is populated by `kind_llm.go:66` from
  `executeLLM` (returns `*llmStageResult`).
- The only consumer that reads it is `kind_create_note.go`, which extracts
  `(Decision, Findings)` via `reviewNoteSource` and calls
  `valaris.Client.CreateReviewNote` — which **hardcodes `kind:"review_verdict"`**
  at `valaris/client.go:580`.
- `kind_create_note.go:37-39` silently skips when findings are empty.
- `mcp_call` does not list `create_note` in `mcpToolDispatch`
  (`kind_mcp_call.go:60-122`) and does not recognise any `$llm_*` ref in
  `mcpRefNames` (`kind_mcp_call.go:158`).
- MCP `create_note` tool (`mcp-server/.../tools/notes.py:47-85`) does not
  accept `kind`; every LLM-driven write falls back to `"user_note"`.
- `prompt_defaults.py` planner stage (`plan` slug) instructs the LLM to
  call `create_card` and `create_note` directly. `mediate_rework` stage
  asks for a JSON envelope (`action_plan`/`escalate`) — the lifecycle
  cannot today read that as a note body.

### After this change

- `WalkState` gains a typed scalar `LLMRawOutput string` (full LLM stdout,
  preserved verbatim by `kind_llm.go`).
- `valaris.Client.CreateNote(ctx, workspace, board, card, kind, title,
  body, failureClass, pinned)` is the single client method. `CreateReviewNote`
  becomes a thin wrapper that calls `CreateNote` with `kind="review_verdict"`
  and the legacy title format — every existing caller keeps working.
- Terminal `kind_create_note` reads `step.Params["kind"]`,
  `step.Params["title"]`, `step.Params["body_from"]` (enum
  `findings|raw|summary|decision`, default `findings`),
  `step.Params["failure_class"]`. Hard-errors on missing `kind` and on
  empty resolved body.
- `kind_mcp_call` gains a `create_note` dispatch entry. Args =
  `{kind, title, body, failure_class, pinned}`. String args starting with
  `$` resolve through the extended `resolveMCPRef`.
- `mcpRefNames` grows by 4 entries: `$llm_output`, `$llm_findings`,
  `$llm_summary`, `$llm_decision`. The first reads `ws.LLMRawOutput`;
  the rest pull from the already-parsed `*llmStageResult.reviewResult`.
- MCP `create_note` tool accepts an optional `kind: str | None = "user_note"`
  argument and propagates it into the POST body.
- `DEFAULT_PIPELINE_CONFIG` is updated so the planner and rework_mediator
  stages each end with a terminal `create_note` of the right kind, and the
  reviewer's request_changes branch's existing `mcp_call(create_note)` step
  becomes functional rather than dead code.

### Data flow

```
                ┌────────────────────────────────────────┐
                │            kind_llm                     │
                │  executeLLM -> *llmStageResult          │
                │   .decision, .reviewResult{             │
                │      Decision, Summary, Findings        │
                │   }, .rawStdout                         │
                └────────────────┬────────────────────────┘
                                 │ write
                                 v
                  ws.LLMResult      = *llmStageResult
                  ws.LLMRawOutput   = result.rawStdout   <-- NEW
                                 │
                ┌────────────────┴────────────────┐
                │                                  │
                v                                  v
   ┌─────────────────────────┐     ┌─────────────────────────────────┐
   │  kind_create_note       │     │  kind_mcp_call(create_note)     │
   │  (terminal)             │     │  (non-terminal)                 │
   │                         │     │                                 │
   │  kind        = param    │     │  args.kind, args.title,         │
   │  title       = param    │     │  args.body, args.failure_class, │
   │  body_from   = param    │     │  args.pinned                    │
   │   findings|raw|summary| │     │                                 │
   │   decision              │     │  $llm_output  -> raw stdout     │
   │  failure_class = param  │     │  $llm_findings/summary/decision │
   │                         │     │   -> parsed subfields           │
   │       \                 │     │              /                  │
   └────────┐\               │     │             /                   │
            \ \              │     │            /                    │
             v v             v     v           v                     │
              valaris.Client.CreateNote(...)                          │
                          │                                           │
                          v                                           │
          POST /api/workspaces/{slug}/boards/{board}/notes            │
              {title, content, pinned, card_id, kind, failure_class}  │
                                                                      │
  CreateReviewNote(...) -> CreateNote(kind="review_verdict", ...)  ◄──┘
  (legacy callers unchanged)
```

Terminal `create_note` stops the walk. `mcp_call(create_note)` continues
the chain. Same client method, two ergonomic shapes — Option C.

---

## Section 2 — Go runner changes (per-file, TDD-ordered)

### 2.1 `intern/internal/lifecycle/state.go`

**What changes:** add `LLMRawOutput string` field on `WalkState`
(zero-value safe).

**Test scope:** `go test ./internal/lifecycle/... -run TestWalkState`

**Test cases to write FIRST (red phase):**
- `TestWalkState_LLMRawOutput_ZeroValue` — empty string by default.
- `TestWalkState_LLMRawOutput_AssignReadable` — set then read returns the
  same string.

**Implementation sketch:**
```go
type WalkState struct {
    // ... existing fields ...
    LLMRawOutput string // verbatim LLM stdout for downstream consumers
}
```

**Back-compat impact:** None. New zero-value field. No existing test
references the field name.

---

### 2.2 `intern/internal/workloop/kind_llm.go`

**What changes:** after `ws.LLMResult = result`, also set
`ws.LLMRawOutput = result.rawStdout` (or whatever the existing field is
named on `*llmStageResult` — **FLAG** if `rawStdout` is not present and
must be added to `llmStageResult` first; investigation §2.2 implies the
full stdout exists in execution logs but is not stored on the struct
today).

**Test scope:** `go test ./internal/workloop -run TestLifecycleLLM`

**Test cases to write FIRST:**
- `TestLifecycleLLM_PopulatesRawOutput` — fake `executeLLM` returns a
  result with a known stdout; assert `ws.LLMRawOutput` equals that
  string after `lifecycleLLM` returns.
- `TestLifecycleLLM_RawOutput_EmptyOnNilResult` — when `executeLLM`
  returns nil, `LLMRawOutput` stays empty (no panic).
- `TestLifecycleLLM_RawOutput_PreservedAcrossPostCommitGate` — even when
  the writes_code commit-and-push side path fires (returns `no_changes`),
  `ws.LLMRawOutput` is still set from the LLM stage.

**Implementation sketch:** one extra line after the existing
`ws.LLMResult = result` assignment, behind `if result != nil`.

**Back-compat impact:** None — purely additive. Existing
`TestLifecycleLLM_*` tests should keep passing.

**FLAG:** If `*llmStageResult` does not currently carry the raw stdout
(only the parsed `Decision/Summary/Findings`), we must thread the raw
string out of `executeLLM` first. The investigation says it lives in
execution logs, not on the struct. Phase 2 must (a) confirm by reading
`strategy_generic.go:1000-1100`, and (b) if missing, extend
`llmStageResult` with a `rawStdout string` field set inside
`wrapGenericOutput` before this kind_llm.go change can compile.

---

### 2.3 `intern/internal/valaris/client.go`

**What changes:**
- New exported method `CreateNote(ctx context.Context, workspaceSlug,
  boardID, cardID, kind, title, body string, failureClass string,
  pinned bool) error`.
  - POSTs to the same URL as `CreateReviewNote` does today.
  - Payload: `{title, content: body, pinned, card_id: cardID, kind,
    failure_class: failureClass}` — omit `failure_class` from the map
    when empty (so non-rejection notes don't carry a NULL we don't need
    to serialize).
- Refactor existing `CreateReviewNote` to internally call `CreateNote`
  with `kind="review_verdict"`, `title=fmt.Sprintf("Review: %s — %s",
  cardID, decision)`, `body=findings`, `failureClass=""` (legacy callers
  never passed one), `pinned=false`. Preserves existing immutability
  semantics (review_verdict kind is `IMMUTABLE_KINDS` on the backend).

**Test scope:** `go test ./internal/valaris -run "TestClient_CreateNote|TestClient_CreateReviewNote"`

**Test cases to write FIRST:**
- `TestClient_CreateNote_PostsCanonicalPayload` — httptest server
  captures request; assert URL path, method=POST, body fields.
- `TestClient_CreateNote_OmitsEmptyFailureClass` — when `failureClass=""`
  the request body does NOT include the `failure_class` key (avoids
  serializing a meaningless empty string).
- `TestClient_CreateNote_PassesFailureClass` — when `failureClass="needs_rework"`,
  request body includes `"failure_class":"needs_rework"`.
- `TestClient_CreateNote_PropagatesAPIError` — server returns 400, the
  method returns the wrapped `*APIError` unchanged.
- `TestClient_CreateReviewNote_DelegatesToCreateNote` — calling the
  legacy method produces the same wire bytes as a direct CreateNote
  call with `kind="review_verdict"` and the canonical title format.

**Implementation sketch:**
```go
func (c *Client) CreateNote(ctx context.Context, workspaceSlug, boardID,
    cardID, kind, title, body, failureClass string, pinned bool) error {
    url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/notes",
        c.baseURL, workspaceSlug, boardID)
    payload := map[string]any{
        "title":   title,
        "content": body,
        "pinned":  pinned,
        "card_id": cardID,
        "kind":    kind,
    }
    if failureClass != "" {
        payload["failure_class"] = failureClass
    }
    return c.jsonRequest(ctx, http.MethodPost, url, payload)
}

func (c *Client) CreateReviewNote(ctx context.Context, workspaceSlug,
    boardID, cardID, decision, findings string) error {
    title := fmt.Sprintf("Review: %s — %s", cardID, decision)
    return c.CreateNote(ctx, workspaceSlug, boardID, cardID,
        "review_verdict", title, findings, "", false)
}
```

**Back-compat impact:** Zero — `CreateReviewNote` keeps its exact wire
output and signature. Existing callers (orchestrator Done-gate, smoke
tests asserting `review_verdict` immutability) are unaffected.

---

### 2.4 `intern/internal/workloop/kind_create_note.go`

**What changes:** complete rewrite of the handler body. Read params:

| Param           | Type   | Required                    | Default      | Notes                                                       |
|-----------------|--------|-----------------------------|--------------|-------------------------------------------------------------|
| `kind`          | string | **yes**                     | —            | Hard-error on missing/empty.                                |
| `title`         | string | no (operator-friendly)      | derived      | When empty, fallback to `Note: <card_id>` (cheap default).  |
| `body_from`     | string | no                          | `findings`   | Enum: `findings`, `raw`, `summary`, `decision`.             |
| `failure_class` | string | no                          | `""`         | Plumbed through as-is.                                      |
| `from_llm_output` | bool | DEPRECATED                  | true         | Kept as a soft-alias: when true (the only persisted value), `body_from` defaults to `findings`. **FLAG**: do we want to drop this alias entirely now or wait one deploy? |

Body resolution:
- `findings` — read `reviewResult.Findings` via existing
  `reviewNoteSource(llmResultFromWalk(ws), sensorResultFromWalk(ws))`.
- `raw` — read `ws.LLMRawOutput`.
- `summary` — read `reviewResult.Summary`.
- `decision` — read `reviewResult.Decision`.

Hard-error contract:
- Missing/empty `kind` → return a typed `configError`; walker propagates as
  step failure (so the operator's `on_failure` subtree fires). No silent
  skip.
- Resolved body is empty → return a typed `noteBodyEmptyError`; same
  treatment. The legacy "silently skip when findings empty" line at
  `kind_create_note.go:37-39` is **removed**.

Call site: `l.client.CreateNote(ctx, workspace, card.BoardID, card.CardID,
kind, title, body, failureClass, pinnedFalse)`.

**Test scope:** `go test ./internal/workloop -run TestLifecycleCreateNote`

**Test cases to write FIRST:**
- `TestLifecycleCreateNote_RejectsMissingKind` — params omit `kind`;
  expect step failure with a clear "missing kind" message; client mock
  asserts zero calls.
- `TestLifecycleCreateNote_RejectsEmptyKind` — `kind=""` same outcome.
- `TestLifecycleCreateNote_RejectsEmptyBody_FromFindings` — LLM returned
  nil findings, `body_from` defaulted to `findings`; expect step failure.
  Verifies the FOLLOWUP-13 "note silently dropped" bug class is closed.
- `TestLifecycleCreateNote_BodyFromFindings_Default` — sets `kind=plan`,
  no `body_from`; client receives the parsed findings string.
- `TestLifecycleCreateNote_BodyFromRaw` — `body_from=raw`; client
  receives `ws.LLMRawOutput` verbatim, NOT the parsed envelope.
- `TestLifecycleCreateNote_BodyFromSummary` — client receives `Summary`.
- `TestLifecycleCreateNote_BodyFromDecision` — client receives `Decision`.
- `TestLifecycleCreateNote_BodyFromUnknown_HardErrors` — `body_from=banana`;
  reject with explicit list of allowed values.
- `TestLifecycleCreateNote_PassesFailureClass` — `failure_class=needs_rework`
  reaches the client.
- `TestLifecycleCreateNote_DefaultTitleWhenMissing` — title param absent;
  client gets the fallback title shape.
- `TestLifecycleCreateNote_HonoursLegacyFromLLMOutput` — only
  `from_llm_output=true` set, no `body_from`; behaves identically to
  `body_from=findings`. **FLAG** if locked decision drops the alias.

**Implementation sketch:**
```go
func lifecycleCreateNote(ctx context.Context, ws *lifecycle.WalkState,
    step *valaris.LifecycleStep) (string, string, error) {
    l := loopFromWalk(ws)
    card, err := requireCard(ws, step.Name, step.Kind)
    if err != nil { return "", "", err }

    kind := strings.TrimSpace(paramString(step, "kind", ""))
    if kind == "" {
        return "", "", &configError{
            msg: fmt.Sprintf("create_note(%s) requires 'kind' param", step.Name),
        }
    }
    bodyFrom := paramString(step, "body_from", "findings")
    body, err := resolveCreateNoteBody(ws, bodyFrom)
    if err != nil { return "", "", err }
    if body == "" {
        return "", "", fmt.Errorf(
            "create_note(%s): resolved body is empty (body_from=%s)",
            step.Name, bodyFrom)
    }

    title := paramString(step, "title", fmt.Sprintf("Note: %s", card.CardID))
    failureClass := paramString(step, "failure_class", "")

    return "", "", l.client.CreateNote(ctx,
        l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID,
        kind, title, body, failureClass, false)
}
```

**Back-compat impact:** Loud. Any persisted config that has a `create_note`
step without `kind` (the legacy default emitted exactly such a step)
fails after this change. Mitigated because the **only** caller of the
legacy terminal `create_note` in the persisted DEFAULT_PIPELINE_CONFIG
today is the design-doc plan note — which Phase 3 of this change rewrites
to include `kind: plan`. The pilot workspace's persisted config uses the
non-terminal `mcp_call(create_note)` shape on the rejection branch, not
the terminal kind — unaffected. **Smoke-blocking:** any workspace whose
persisted config still references a terminal `create_note` without a
`kind` param must be re-applied with the new default before redeploy.

---

### 2.5 `intern/internal/workloop/kind_mcp_call.go`

**What changes:**

(a) Add `create_note` to `mcpToolDispatch`. Handler:
- Pulls `args.kind` (required), `args.title` (default
  `Note: <card.CardID>`), `args.body` (required after `$` resolution),
  `args.failure_class` (default ""), `args.pinned` (default false).
- Returns the handler's typed error if `kind` or `body` is empty after
  ref resolution. Mirrors the terminal-kind contract — same hard-error
  semantics, just non-terminal.
- Calls `l.client.CreateNote(...)`.

(b) Extend `mcpRefNames` from
`{$agent_id, $card_id, $last_decision, $learning, $pr_url, $self}` to
also include `$llm_output`, `$llm_findings`, `$llm_summary`, `$llm_decision`.

(c) Extend `resolveMCPRef` switch:
- `$llm_output` → `ws.LLMRawOutput` (empty string when no LLM has run).
- `$llm_findings` → `reviewResult.Findings` via existing bridge helper.
- `$llm_summary` → `reviewResult.Summary`.
- `$llm_decision` → `reviewResult.Decision`.

For `$llm_findings/summary/decision`: when the LLM result is absent
(planner stage before LLM, or non-LLM stage), return `""` rather than
error — the downstream handler's empty-body check is the load-bearing
guard. Document this in a comment so operators understand the timing
contract.

**Test scope:** `go test ./internal/workloop -run "TestLifecycleMCPCall|TestResolveMCPRef"`

**Test cases to write FIRST:**
- `TestResolveMCPRef_LLMOutput_FromRawStdout` — `ws.LLMRawOutput="..."`,
  ref `$llm_output` resolves to that string.
- `TestResolveMCPRef_LLMOutput_EmptyWhenUnset` — no LLM ran; resolves
  to "" (no error).
- `TestResolveMCPRef_LLMFindings_FromReviewResult` — LLM result has
  Findings; ref resolves accordingly.
- `TestResolveMCPRef_LLMSummary` and `TestResolveMCPRef_LLMDecision`
  — symmetric coverage.
- `TestResolveMCPRef_UnknownRef_StillErrors` — `$banana` keeps erroring
  with the updated `available:` list (regression guard).
- `TestMCPCall_CreateNote_DispatchesToClient` — `tool: create_note`
  with literal kind+title+body; assert client received them.
- `TestMCPCall_CreateNote_ResolvesLLMOutputRef` — args contain
  `body: "$llm_output"`; ws has a raw stdout; client receives the
  resolved string.
- `TestMCPCall_CreateNote_RejectsMissingKind` — args omit `kind`; step
  fails with a "missing kind" error; client mock asserts zero calls.
- `TestMCPCall_CreateNote_RejectsEmptyBodyAfterResolve` — body is
  `"$llm_output"` but `ws.LLMRawOutput=""`; step fails; client mock
  asserts zero calls.
- `TestMCPCall_CreateNote_PropagatesFailureClass` — args carry
  `failure_class: "needs_rework"`; reaches the client.
- `TestMCPCall_CreateNote_NonTerminal_WalkerContinues` — integration-ish:
  build a tiny lifecycle that runs `mcp_call(create_note)` then
  `apply_label`; assert both ran (proves non-terminal).

**Implementation sketch:**
```go
"create_note": func(ctx context.Context, l *Loop, ws *lifecycle.WalkState,
    args map[string]any) (any, error) {
    card, err := requireCard(ws, "mcp_call", "create_note")
    if err != nil { return nil, err }
    kind, _ := args["kind"].(string)
    if kind == "" {
        return nil, fmt.Errorf("missing required arg kind")
    }
    body, _ := args["body"].(string)
    if body == "" {
        return nil, fmt.Errorf("missing required arg body (after $-ref resolution)")
    }
    title, _ := args["title"].(string)
    if title == "" {
        title = fmt.Sprintf("Note: %s", card.CardID)
    }
    failureClass, _ := args["failure_class"].(string)
    pinned, _ := args["pinned"].(bool)
    return nil, l.client.CreateNote(ctx, l.cfg.Valaris.WorkspaceSlug,
        card.BoardID, card.CardID, kind, title, body, failureClass, pinned)
},
```

```go
var mcpRefNames = []string{
    "$agent_id", "$card_id", "$last_decision", "$learning",
    "$llm_decision", "$llm_findings", "$llm_output", "$llm_summary",
    "$pr_url", "$self",
}
```

**Back-compat impact:**
- No persisted config calls `mcp_call(tool: create_note)` against the
  current dead-branch code path other than the reviewer's
  `request_changes_write_verdict` step — which today errors with
  `mcp_call: unknown tool "create_note"` (investigation §5.1). After
  this change, that step starts succeeding. **Smoke-blocking**: the
  request_changes path becomes live for the first time; expect a
  `review_verdict` note + `failure_class: needs_rework` to appear on
  rejected cards in round 6 (this is the desired behaviour).
- `$llm_*` refs do not appear in any persisted config today (investigation
  §4.4 confirmed). Adding them is purely additive.

---

## Section 3 — Backend changes (per-file)

### 3.1 `backend/app/services/agents/lifecycle_kinds.py`

**What changes:** extend `create_note.params_schema` from
`{kind, from_llm_output}` to

```python
"create_note": {
    "name": "create_note",
    "params_schema": {
        "kind": _PARAM_TYPE_STRING,            # required (validator-enforced)
        "title": _PARAM_TYPE_STRING,
        "body_from": {
            "type": "string",
            "enum": ["findings", "raw", "summary", "decision"],
        },
        "failure_class": _PARAM_TYPE_STRING,
        # Kept for back-compat with persisted v3 configs; on the runner
        # side it's treated as a synonym for body_from="findings".
        "from_llm_output": _PARAM_TYPE_BOOL,
    },
    "produces_decision": False,
    "terminal": True,
},
```

The `mcp_call` schema stays open-ended (`args: _PARAM_TYPE_OBJECT`). The
validator already knows nothing about the inner shape per tool. The new
`create_note` tool argument set is enforced runner-side; the Python
validator only checks `tool` is a recognised name (see §3.5).

**Test cases (red phase):**
- `test_create_note_schema_includes_body_from_enum`
- `test_create_note_schema_includes_title_and_failure_class`
- `test_create_note_terminal_flag_unchanged`
- `test_create_note_from_llm_output_still_accepted_for_back_compat`

---

### 3.2 `mcp-server/src/valaris_mcp/tools/notes.py`

**What changes:** add `kind: str | None = "user_note"` argument to
`create_note`, plumb into the POST body when non-None. Add to the
docstring + `_hint` line. No other changes.

Validation: leave open. Backend already accepts any `kind` string;
hard-coding a closed-set check on the MCP side duplicates state.

**Test scope:** `cd mcp-server && uv run --extra dev pytest tests/test_tools.py -v -k create_note`

**Test cases (red phase) — extend `tests/test_tools.py`:**
- `test_create_note_passes_kind_when_provided` — call with
  `kind="plan"`; the mocked HTTP client sees `body["kind"]=="plan"`.
- `test_create_note_omits_kind_when_default_user_note` — call without
  `kind`; the body still includes `"kind":"user_note"` (or omits it,
  pick one — **FLAG** locked decision: spec says
  `kind: str | None = "user_note"`; that suggests always sending so the
  LLM-driven planner can produce a `plan` note when prompted. Recommend
  always-send so the wire is unambiguous.).
- `test_create_note_passes_kind_review_verdict_rejected_by_backend` —
  optional: assert that asking for an immutable kind from the MCP tool
  is allowed at the wire layer (backend may have its own gating; defer).

**Implementation sketch:**
```python
@mcp.tool()
@handle_api_errors
async def create_note(
    workspace_slug: str,
    title: str,
    content: str = "",
    pinned: bool = False,
    kind: str = "user_note",
    board_id: str | None = None,
    card_id: str | None = None,
    ctx: Context = None,
) -> str:
    ...
    body = {"title": title, "content": content, "pinned": pinned, "kind": kind}
    if card_id:
        body["card_id"] = card_id
    ...
```

**Back-compat impact:** None. Existing LLM-driven `create_note` calls
that don't pass `kind` keep landing as `"user_note"`. Existing tests
that don't assert the `kind` key keep passing.

---

### 3.3 `backend/app/services/workspace_config.py` (DEFAULT_PIPELINE_CONFIG)

#### 3.3.1 Planner stage (lines 91-169)

**What changes:**
- Remove the comment at lines 137-139 (`The LLM writes the plan note
  itself via create_note MCP tool — no separate create_note lifecycle
  step.`) — the lifecycle now handles it.
- Insert a new step between `produce_plan` and `planner_unassign_self`:

```python
{
    "name": "write_plan_note",
    "kind": "create_note",
    "params": {
        "kind": "plan",
        "title": "Plan",
        "body_from": "raw",   # planner JSON envelope or markdown — raw is friendlier
    },
    # terminal — chain stops here.
},
```

But the existing chain (`planner_unassign_self -> planner_apply_planned_label`)
must still run. Since terminal `create_note` stops the walk, we restructure
the planner to use `mcp_call(create_note)` (non-terminal) so the unassign +
label steps still execute. **FLAG**: choose one ergonomic shape:

- Shape A (clean): `produce_plan` -> `planner_unassign_self` ->
  `planner_apply_planned_label` -> `write_plan_note` (terminal). Drops
  the auto-`planned` label on planner output, which is desired today
  (planned is a manual-promotion gate; flipping to auto-`planned` after
  write_plan_note is a behavioural change to the existing flow).
- Shape B (drop-in): use `mcp_call(create_note)` for the plan note,
  keep the existing terminal-label step.

Locked-decision check says terminal `create_note` honours its params AND
`mcp_call(create_note)` works. The recommendation is **Shape B** for the
planner — preserves the existing label-as-terminal pattern, lets the
plan note happen non-terminally. The reviewer's request_changes branch
already uses Shape B for its verdict note.

Concretely, planner lifecycle gets a new step before `planner_unassign_self`:

```python
{
    "name": "write_plan_note",
    "kind": "mcp_call",
    "params": {
        "tool": "create_note",
        "args": {
            "kind": "plan",
            "title": "Plan",
            "body": "$llm_output",
        },
    },
    "next": "planner_unassign_self",
},
```

And `produce_plan.next` changes from `planner_unassign_self` to
`write_plan_note`. `on_failure` stays `planner_fail_unassign`.

#### 3.3.2 Reviewer's request_changes branch (lines 461-469)

**What changes:** none structurally — the persisted step already exists
as Shape B `mcp_call(create_note, body: $llm_output)`. Update it to also
carry `failure_class`:

```python
{
    "name": "request_changes_write_verdict",
    "kind": "mcp_call",
    "params": {
        "tool": "create_note",
        "args": {
            "kind": "review_verdict",
            "title": "Review verdict",
            "body": "$llm_output",
            "failure_class": "needs_rework",
        },
    },
    "next": "wake_rework_mediator",
},
```

The reviewer's `approve` branch currently writes no verdict note (the
prior session's commit a817c2b dropped it after merge). Confirm against
the round-6 smoke expectations (internal record) whether to add a symmetric approve-
verdict note via `mcp_call(create_note, kind: review_verdict, body:
$llm_output, failure_class: "")` between `merge_the_pr` and
`wake_documentator`. **FLAG** — locked-decision list does not specify.

#### 3.3.3 Rework_mediator stage (lines 567-586)

**What changes:** insert a `write_rework_brief` step between
`produce_rework_brief` and `wake_implementer`:

```python
{
    "name": "write_rework_brief",
    "kind": "mcp_call",
    "params": {
        "tool": "create_note",
        "args": {
            "kind": "rework_brief",
            "title": "Rework brief",
            "body": "$llm_output",
        },
    },
    "next": "wake_implementer",
},
```

`produce_rework_brief.next` changes from `wake_implementer` to
`write_rework_brief`. Comment lines 587-589 (`The LLM writes the
rework_brief note itself via create_note MCP tool.`) are removed —
the lifecycle now handles it.

#### 3.3.4 Documentator stage

No DEFAULT_PIPELINE_CONFIG change needed. The documentator already
emits its work as a `writes_code` post-process via the docs branch;
it doesn't produce a structured note.

**Test scope:** `cd backend && source .venv/bin/activate && python
-m pytest tests/services/test_workspace_config.py -v`

**Test cases (red phase):**
- `test_default_pipeline_planner_emits_create_note_step` — planner
  lifecycle includes a step with `kind: mcp_call, params.tool:
  create_note, params.args.kind: "plan"`.
- `test_default_pipeline_rework_mediator_emits_create_note_step` —
  symmetric for `rework_brief`.
- `test_default_pipeline_reviewer_request_changes_carries_failure_class` —
  verdict step args include `failure_class: needs_rework`.
- `test_default_pipeline_validator_accepts_new_default` — the freshly
  emitted default round-trips through `validate_pipeline_config`
  without errors or warnings.

---

### 3.4 `backend/app/services/agents/prompt_defaults.py`

**What changes:**

(a) **Planner (`plan` stage, lines 638-679):**
- Drop step 5 (`For each decomposed card, call create_card(...)`) —
  locked decision keeps planner's `create_card` capability closed off.
  Phase 4 of locked decisions: drop `mcp__valaris__decompose_card` and
  `mcp__valaris__create_note` from the planner stage `tools` allowlist
  in DEFAULT_PIPELINE_CONFIG (§3.3.1, also remove from the `tools:
  [...]` array on both the top-level `llm` block and the lifecycle
  `produce_plan` step).
- Drop the "call create_note via MCP" instruction. Keep the JSON
  envelope instruction (`status/decision/findings/summary`) — the
  lifecycle will route findings into the `plan` note body.
- Adjust the response-format section to say "Emit findings as markdown
  in the JSON envelope; the lifecycle writes the plan note for you."

(b) **Rework_mediator (`mediate_rework` stage, lines 198-245):**
- Drop the "call create_note via MCP" instruction (not currently present
  but check). Keep the JSON `action_plan/escalate` envelope — the
  lifecycle reads `$llm_output` (raw) so the full envelope is preserved.
- Add a one-line "The lifecycle writes your output as a `rework_brief`
  note — your job is to emit the body text."

(c) **Reviewer (`review` stage, lines 398-453):**
- No copy change needed (reviewer already emits the JSON envelope and
  the lifecycle now records it as a `review_verdict` note via the
  request_changes branch's `mcp_call`).

(d) **Implementer / Documentator:** no changes.

**Test scope:** `cd backend && python -m pytest
tests/services/agents/test_prompt_defaults.py -v`

**Test cases (red phase):**
- `test_plan_prompt_drops_create_card_instruction`
- `test_plan_prompt_drops_create_note_instruction`
- `test_plan_prompt_retains_json_envelope_instruction`
- `test_mediate_rework_prompt_no_mcp_create_note_instruction`

**Back-compat impact:** Prompts are read at every LLM invocation; no
persisted prompt-override is changed. Workspaces with custom planner
overrides keep their copy. The shipped default just stops telling the
LLM to do what the lifecycle now owns.

---

### 3.5 `backend/app/services/pipeline_config_validation.py`

**What changes:** confirm and extend.

- `_PARAM_TYPE_*` validators for `create_note.params` accept the new
  `body_from` enum + the `title` and `failure_class` keys. The current
  validator already passes through unknown keys for tolerance; tighten
  to a closed set per the Open Questions in 02-role-redesign.md
  (§rule 7). **FLAG** — locked-decision list says tools allowlist
  enforcement (Option D) is out of scope. Tightening create_note's
  params schema to a closed set is in scope here.
- `mcp_call.params.args` for `tool: create_note` should be validated
  with a sub-schema: `{kind: str, title?: str, body: str,
  failure_class?: str, pinned?: bool}`. The current validator doesn't
  introspect tool-specific arg schemas. **FLAG** — investigate
  `_validate_mcp_call` (if it exists) and either add a tool→schema
  registry or accept the looser arg pass-through and rely on
  runner-side hard errors. Recommendation: add a minimal registry keyed
  on tool name; reuse the same enum-of-args names used in the runner
  dispatcher.

**Test scope:** `cd backend && python -m pytest
tests/services/test_pipeline_config_validation.py -v`

**Test cases (red phase):**
- `test_validate_create_note_step_body_from_enum_rejects_unknown`
- `test_validate_create_note_step_requires_kind`
- `test_validate_create_note_step_accepts_failure_class`
- `test_validate_mcp_call_create_note_requires_kind_and_body`
- `test_validate_default_pipeline_config_passes` — full DEFAULT round-trips.

---

## Section 4 — TDD test plan summary

### Backend pytest scope

```
cd backend && source .venv/bin/activate && python -m pytest -v \
  tests/services/agents/test_lifecycle_kinds.py \
  tests/services/agents/test_lifecycle_kinds_parity.py \
  tests/services/agents/test_prompt_defaults.py \
  tests/services/test_workspace_config.py \
  tests/services/test_pipeline_config_validation.py
```

Expected new test cases: 10–12 (4 in lifecycle_kinds, 4 in prompt_defaults,
4 in workspace_config, 4 in pipeline_config_validation; parity test
absorbs schema updates without new cases).

### Go test scope

```
cd intern && go test ./internal/lifecycle/... \
    ./internal/valaris/... \
    ./internal/workloop/...
```

Expected new test cases: 12–15
(2 in `lifecycle`,
5 in `valaris` for the CreateNote/CreateReviewNote delegation,
10 in `workloop` split across `kind_llm_test`, `kind_create_note_test`,
`kind_mcp_call_test`).

Subagent briefing rule: scope `go test` to these three packages, NOT the
full module. Full-module run reserved for the orchestrator's pre-commit
sweep.

### MCP server test scope

```
cd mcp-server && uv run --extra dev pytest tests/test_tools.py -v -k create_note
```

Expected new test cases: 2.

### Parity test (`test_lifecycle_kinds_parity.py`)

The parity test asserts every kind name and its terminal+produces_decision
flags match between Python `LIFECYCLE_KINDS` and Go `kinds.go`. After
this change:
- Kind name set is unchanged (no new kind).
- `create_note` flags unchanged (terminal=true, produces_decision=false).
- The new param keys on `create_note.params_schema` do not appear in
  `kinds.go` (which only carries name/terminal/produces_decision).
- **Net effect:** parity test should keep passing without modification.
  If the parity test asserts on `params_schema` keys (it does not today
  per the comment at `lifecycle_kinds.py:8-10`), update it to ignore the
  new keys.

---

## Section 5 — Migration impact

1. **DEFAULT_PIPELINE_CONFIG rewrite** — backend redeploy + per-workspace
   re-apply. Established pattern from the 2026-05-17 session: backend
   ships the new config in the next deploy, then
   `python scripts/reset_demo_pipeline_config.py --slug <workspace-slug> --yes`
   wipes the pilot workspace's persisted v3 row so it inherits the new default.
   Same script is the smoke-round-6 pre-flight, gated on user consent.
   For any other workspaces with persisted configs (12/13 have none per
   the audit), they keep their persisted row and the warnings surface
   via the workspace-config-GET `warnings: []` envelope.

2. **Note kinds verification (`backend/app/models/notes/kinds.py`)** —
   confirmed by read: `PLAN = "plan"` and `REWORK_BRIEF = "rework_brief"`
   and `REVIEW_VERDICT = "review_verdict"` are all already registered.
   No data-model migration needed. `IMMUTABLE_KINDS = frozenset({REVIEW_VERDICT})`
   means rework_brief and plan are mutable — consistent with their use
   (an operator may edit/retitle a plan note).

3. **Persisted pilot-workspace reviewer config** — the dead `mcp_call(create_note,
   body: $llm_output)` step at `workspace_config.py:443-482` becomes
   functional. **Smoke must exercise the request_changes branch** to
   validate the verdict note + failure_class + downstream wake_role +
   move_card all run cleanly. Round-6 expectation: a rejected card
   produces exactly one `review_verdict` note with
   `failure_class: needs_rework`, and a follow-on `rework_brief` note
   from the mediator.

4. **No DB migration.** Note kinds already in the closed-set registry;
   no new column; no Alembic revision required for this change.

5. **No runner config change.** The walker reads `LIFECYCLE_KINDS`
   shape from `kinds.go` — kind names unchanged. New params on
   `create_note` and new tool entry on `mcp_call` are pure handler
   logic; no runner config flag toggles.

---

## Section 6 — Risks + back-compat

### Risks

1. **Persisted configs with terminal `create_note` and no `kind`** —
   would hard-fail after the rewrite. Mitigation: the DEFAULT
   never emitted a kind-less terminal `create_note` in the v3 era
   (the design comment at the planner stage explicitly delegated to
   the MCP tool). The smoke pre-flight script wipes any non-default
   persisted rows on the pilot workspace. **Risk level: low.** Action: scan
   any persisted `pipeline_config` rows in prod via a quick SQL probe
   before redeploy:
   ```sql
   SELECT workspace_id, pipeline_config
   FROM workspace_config
   WHERE pipeline_config::text LIKE '%"kind": "create_note"%';
   ```

2. **FOLLOWUP-13 dead-branch revival** — the reviewer's request_changes
   path was never reachable in prod (it errored on
   `mcp_call: unknown tool "create_note"` per investigation §5.1). After
   this change, the branch goes live for the first time. **Risk:** any
   bug in downstream `wake_role(rework_mediator)` + `move_card(active)`
   surfaces only after deploy. **Mitigation:** smoke-round-6
   explicitly drives a reviewer rejection (per the round-6 smoke
   expectations, an internal record). Expect a `review_verdict`
   note + a `rework_brief` follow-up; if either is missing, roll back.

3. **`CreateReviewNote` legacy callers** — unaffected. The function
   keeps its signature + wire output (verified by
   `TestClient_CreateReviewNote_DelegatesToCreateNote`).

4. **MCP `create_note` adding `kind`** — existing LLM-driven calls
   that didn't pass `kind` still produce `user_note` (default unchanged).
   Frontend "Create note" form on the UI does not call the MCP tool
   directly, so no frontend churn. **Risk level: very low.**

5. **Body-from defaults vs the FOLLOWUP-13 silent-skip class** — today
   `kind_create_note` silently skips on empty findings; after this
   change it hard-errors. **Risk:** any persisted config that depended
   on the silent skip (none should — the silent skip was always a bug)
   surfaces a step failure where it previously got a no-op. **Mitigation:**
   the planner & rework_mediator stages are migrated atomically; the
   reviewer's approve-path no longer writes a terminal note at all.

6. **Runner-side `$llm_output` empty for non-LLM consumers** —
   `mcp_call(create_note, body: "$llm_output")` placed BEFORE the LLM
   step (e.g. in a discover-only branch) resolves `$llm_output` to ""
   and triggers the hard-error. **Mitigation:** operator-facing — the
   error message must explicitly say "LLM has not run in this walk;
   $llm_output is empty". The validator does NOT today catch
   ordering issues (and shouldn't — walker state ordering is a runtime
   concern).

### Back-compat checklist

- [ ] `CreateReviewNote` Go callers: unchanged signature, byte-for-byte
      wire payload preserved.
- [ ] MCP `create_note` LLM callers without `kind`: still produce
      `user_note`.
- [ ] Persisted v3 configs with `create_note.params.from_llm_output: true`:
      validator accepts; runner treats as `body_from: findings`.
- [ ] Parity test: no kind-name churn, flags unchanged.
- [ ] `IMMUTABLE_KINDS = {review_verdict}`: still enforced; the new
      generic `CreateNote` path goes through the same backend POST
      endpoint that already gates immutable kinds.

---

## Section 7 — Open follow-ups (enumerated, not filed)

1. **`--json-schema` claude-cli wiring per stage** — leverage the
   already-supported `opts.OutputSchema` field at
   `intern/internal/llm/claude_cli.go:185-187` to feed the produces_*
   stage's JSON envelope schema into the CLI invocation. Closes the
   "malformed JSON dropped into Summary" silent-skip class
   (investigation §6 item 4). Out of scope this session.

2. **Option D — server-side tools allowlist enforcement** (MCP middleware
   reads per-execution allowlist from session metadata). Out of scope.

3. **Planner `create_card` decomposition role** — sibling-card creation
   is a separate role's job. Locked decision keeps `create_card` closed
   off in the planner; a future `decomposer` role with a dedicated
   `decompose_card` lifecycle kind or a `create_card` entry in
   `mcpToolDispatch` is the path forward.

4. **`from_llm_output` legacy alias sunset** — after one deploy in
   which all DEFAULT_PIPELINE_CONFIG callers use `body_from`, drop the
   alias from the schema (errors on `from_llm_output: true`). Two-deploy
   plan.

5. **Reviewer approve-branch verdict note** — locked decisions do not
   specify whether the approve path also writes a `review_verdict`
   note (current default writes none after a817c2b). If yes, add a
   `mcp_call(create_note)` step on the approve branch. Defer to
   smoke-round-6 outcomes.

6. **Tool-specific arg validation in `pipeline_config_validation`** —
   if §3.5 lands the per-tool sub-schema registry, generalize so any
   future `mcp_call` tool can declare its arg shape once and the
   validator picks it up. Otherwise, accept the runner-side hard-error
   contract as the only enforcement and document the seam.

7. **`llmStageResult.rawStdout` field** — flagged in §2.2 as a possible
   prerequisite. If the field doesn't exist today, the work to add it
   (one source line in `wrapGenericOutput` + one field on
   `llmStageResult`) is a sub-card.

---

## Ambiguities flagged for orchestrator resolution

1. **§2.2 — `*llmStageResult.rawStdout`**: investigation §2.2 says the
   raw output is preserved "in execution logs" but does not confirm a
   field on `llmStageResult`. Phase 2 must verify by reading
   `strategy_generic.go:1086-1133`. If absent, add it (cheap) — but
   that's a prerequisite, not a side change.

2. **§3.3.1 — Planner Shape A vs Shape B**: terminal `create_note` vs
   non-terminal `mcp_call(create_note)` for the plan note. Both work.
   Shape B preserves the existing terminal-`apply_label` step pattern.
   Recommendation: Shape B.

3. **§3.3.2 — Reviewer approve-branch verdict note**: locked decisions
   silent. If yes, add a symmetric note step on the approve branch.

4. **§2.4 — `from_llm_output` alias**: keep one deploy, or drop now?
   The runner test plan lists a back-compat case
   (`TestLifecycleCreateNote_HonoursLegacyFromLLMOutput`) — drop it if
   the locked decision is to remove the alias.

5. **§3.2 — MCP `create_note` always-send `kind`**: if the LLM-driven
   path is to remain usable for `plan` notes via prompt, the tool
   should always send the `kind` in the body so a default
   `kind="user_note"` is explicit on the wire rather than implicit on
   the schema default. Recommendation: always send.

No pushback on the locked decisions themselves. The plan above is
consistent with all 10 locked items; the only deltas are the five
ambiguities above and the §2.2 prerequisite.
