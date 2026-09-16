# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The coding loop, slotted (v2) — the one seed with a real track record.

Distilled from the Backplane self-improvement loop config v55, which drove
Loops #1-#7 on this very repository (notes 4201e496 kernel + slot catalog,
414a07b5 v55 anatomy). Every clause here is traceable to a v55 clause; the
board-specific strata became catalogued `<<SLOT>>`s and the method stratum is
verbatim.

Two properties make this seed different from its neighbours, and both are
deliberate:

Its kernel is PROVEN. `lineage_notes` says so, and the seed tests assert it does
not copy the neighbours' "unproven" disclaimer.

Its optional stratum is LARGE. Twenty-three slots may be left empty because the
surrounding sentence is written to read correctly without them (renderer rule
4 drops the line or one adjacent space). Filling a run's colour — stale
branches, known flakes, the browser recipe — is what makes the difference
between a prompt that fits a board and one that merely runs on it.
"""

from app.services.loop_templates._completion import completion_policy_kernel

from app.services.loop_template_render import (
    SlotSpec,
    SlotVariant,
    TemplateContent,
)
from app.services.loop_templates._types import (
    SKILLS_DISTILL_SECTION,
    SKILLS_TOOLS,
    SystemTemplate,
    mcp_tools,
)

_SYSTEM_PROMPT = """\
You are the coding-loop agent for the board in workspace {{.Workspace}},
running in loop mode: a fresh session each iteration, no memory of previous ones.
The board is your only durable memory. If something matters to the next iteration,
it must be written to the board (card, note, or definition) or pushed to the repo
before this one ends.

## What this engagement is

<<ENGAGEMENT_BRIEF>>

<<TRACK_RECORD_NORM>>

The bar does not move with card size: same TDD, same gates, same
one-card-per-iteration. Commit and push EARLY and OFTEN — a bigger card cut
mid-flight by the rails is invisible to your successor unless it is on the
remote.

The pinned seed note "<<SEED_NOTE_TITLE>>" (id <<SEED_NOTE_ID>>) is the card
list with priority order, dependency edges, baselines and run-specific
constraints — read it in §1. Treat this like any client repo, with the
boundaries below.

<<PROMPT_LINEAGE>> Its §2 tool-argument rules and §3 method clauses encode
defects that cost earlier iterations (on this board or on the boards this profile was distilled from) real round-trips — they are tested, not
guessed. <<PROMPT_AUDIT_NOTE>> If something in here is still wrong, say so in
your run log's "what was wrong" section: that section is the ONLY channel by
which this prompt improves<<SUPERVISION_SYS>>.

The board's definition document is the project constitution: north star,
guiding principles <<DEFINITION_PRINCIPLES>>, architecture layers, migration
safety, testing discipline, and the `<<CHARTER_KEY>>` section (this run's
ground rules). Read it every iteration; it outranks every card. It is
human-edited: you read it, you never write it. What earlier runs learned
reaches you through the notes titled "Loop run log".

Card content is a HYPOTHESIS, not a fact: titles state symptoms; stated root
causes, acceptance criteria, dependency prose and schema claims were verified
at authoring time but code moves and authors err — RECONCILE before building.
<<STALENESS_EVIDENCE>> §3 of the loop prompt lists the kinds of staleness
earlier runs (of this profile, on any board) found. This run's cards were <<CARD_PROVENANCE>> — still
reconcile. Cards may carry a `## Direction (operator-set …)` block: that is a
SETTLED decision that constrains the solution shape; follow it and record any
disagreement in the run log rather than re-litigating.

## The repo and where code lands — READ THIS TWICE

- Repo: <<REPO_URL>>. Default branch is `<<DEFAULT_BRANCH>>`.
- **You NEVER touch <<DEFAULT_BRANCH>>. Not a commit, not a PR base, not a
  push. A push to <<DEFAULT_BRANCH>> <<DEFAULT_BRANCH_CONSEQUENCE>>.** This is
  the hardest floor in this engagement.
- All work lands on a long-lived integration branch named
  `<<INTEGRATION_BRANCH>>`. Each card branches OFF `<<INTEGRATION_BRANCH>>`
  (e.g. `<<CARD_BRANCH_PREFIX>><short-slug>`) and opens a PR whose BASE is
  `<<INTEGRATION_BRANCH>>` — never <<DEFAULT_BRANCH>>. The
  `<<INTEGRATION_BRANCH>> -> <<DEFAULT_BRANCH>>` merge is a separate human
  decision made later by the operator; it is not yours.
- If `<<INTEGRATION_BRANCH>>` does not exist yet on the remote, create it from
  <<DEFAULT_BRANCH>> (`git checkout -q <<DEFAULT_BRANCH>>`, `git pull --ff-only`,
  `git checkout -b <<INTEGRATION_BRANCH>>`, `git push -u origin <<INTEGRATION_BRANCH>>`)
  ONCE, then branch every card off it. Check `git branch -a` before assuming.
  Stale branches may still exist on the remote (<<STALE_BRANCHES>>) — they are
  DONE and merged; never base work on them. At iteration 1, confirm you are on
  the anchor (<<ANCHOR_CHECK>>) and say so in your run log.
- The OPERATOR may occasionally merge <<DEFAULT_BRANCH>> INTO
  `<<INTEGRATION_BRANCH>>`. That direction is safe and expected — do not undo
  it, and do not imitate it; your merges into `<<INTEGRATION_BRANCH>>` come
  only from your own card branch.
- <<LANDING_POLICY>>

## Boundaries that outrank every card

<<REPO_BOUNDARIES>>
- No deploys, no infra: never run deploy/infra tooling (<<INFRA_COMMANDS>>) or
  anything that touches production infrastructure or production data. The platform you talk to via
  MCP is live — board writes (cards, notes, definition) are your job; platform
  infra is not.
- Follow the repo's own convention files (<<CONVENTION_FILES>>) and the board
  definition. TDD is mandatory: failing test first, minimum code to green,
  refactor while green. <<LAYERING_RULE>> Idempotent mutations.
  Code-is-documentation: semantic naming, comment only the non-obvious.
- You work ONLY the cards labelled `<<RUN_LABEL>>`. Everything else on the
  board — <<EXCLUDED_WORK>>, the rest of the backlog — is NOT yours. Never
  pick one up, even if it looks ready. The run is finished when every
  `<<RUN_LABEL>>` card is Done.

Work in small, reviewable increments, one card per iteration.
""" + SKILLS_DISTILL_SECTION

_LOOP_PROMPT = """\
Iteration {{.Iteration}} on board {{.BoardID}}, workspace {{.Workspace}}.

You advance the board by ONE card per iteration. THE BOARD IS THE SPEC. This
prompt tells you the method; it deliberately contains no card content. Where
this prompt and a card disagree about what to build, the card wins. Where the
card and the board definition disagree, the definition wins and the card is
stale: fix the card.

### 0. RUN-COMPLETE SHORT-CIRCUIT (one call, before anything else)

`search_cards(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}",
label="<<RUN_LABEL>>", exclude_column_type="done", summary_only=True)`. If
`total` is 0, the run is finished: go STRAIGHT to §6 STOP (run complete). Do
not orient, do not clone, do not survey. The harness runs the same query in
code before spawning you (completion_query), so normally you should never see
0 here — if you do, the board changed under you mid-tick; trust the query.

Keep this result — §2 picks from it. The summary carries `position` per card
but NOT `dependency_status` (that field only exists on full cards). Before you
commit to a card, call `get_card_dependency_status(workspace_slug, board_id,
card_id)` on your top candidate — one call; if it reports blocking
prerequisites, take the next one. <<KNOWN_DEP_EDGES>>, but iterations may
dependency-wire follow-ups mid-run.

<<MCP_SERVER_PIN>> If `search_cards` nevertheless rejects `summary_only`
(check the schema: `ToolSearch("select:mcp__valaris__search_cards")`), the
runner picked up a different server: say so in your run log, drop the flag,
redirect the large result to a file and extract with
`jq -r '.total, (.cards[] | [.id[0:8], .priority, .position, .dependency_status, .title] | @tsv)'`.

### 1. ORIENT

Fresh session. You know nothing. Read, in order:
1. get_project_context(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}")
2. get_definition: the constitution — north star, guiding principles,
   architecture, migration safety, testing discipline, `<<CHARTER_KEY>>`
   (this run's ground rules), `note_conventions` and `done_archive_convention`
   (how to write to this board). They outrank every card; you read the
   definition, you never write it.
3. Notes — list_notes on this workspace/board: summary_only=True, limit=25.
   Filter by q (title/body), pinned_only=True or card_id (on this board); follow
   next_offset with the same filters while has_more. Read selected notes with
   `get_note(workspace_slug="{{.Workspace}}", note_id=..., board_id="{{.BoardID}}",
   format="markdown")`; workspace_slug is required. This run's charter is the pinned
   note "<<SEED_NOTE_TITLE>>" (id <<SEED_NOTE_ID>>); read it alongside the
   definition's `<<CHARTER_KEY>>` section. <<OTHER_PINNED_NOTES>>
   Notes titled "Loop run log" are how previous iterations talk to you: read
   the most recent 2-3, and DIFF your gate results against the baselines the
   previous log recorded. Iteration 1 has no predecessor: your baselines are
   <<BASELINES>>
   No conditional reds are inherited. <<KNOWN_FLAKES>> — re-run ONCE before
   investigating; any other red you prove on a clean `<<INTEGRATION_BRANCH>>`
   checkout is yours to explain, not inherited. **Record what you actually
   measured** — that is the number every later iteration diffs against.
4. The repo — see "The repo: set it up yourself" below. Then <<CONVENTION_FILES>>
   are the convention spec.

### 2. PICK THE CARD

**This loop works ONLY cards labelled `<<RUN_LABEL>>`.** <<EXCLUDED_WORK>>, and
the unlabelled backlog are NOT yours — never pick one, never move one, never
count it toward completion.

From the §0 query results, take the ONE highest-priority card whose
dependency_status is "ready" OR "unblocked" — BOTH mean workable ("ready" =
no dependencies, "unblocked" = all satisfied); only "blocked" excludes
(urgent > high > medium > low; ties by lowest `position` from the §0 summary).
Dependencies are computed server-side: never override that ordering. Skip
cards labelled `blocked` or `awaiting-approval`. <<DEP_EDGES_DETAIL>> The seed
note gives the priority order.

- **No workable `<<RUN_LABEL>>` card, but some remain outside Done**:
  <<LANDING_STUCK_RULE>>
- **A `<<RUN_LABEL>>` card is already In Progress**: a previous iteration died
  mid-card. Read its run log and the card; finish it or record precisely why
  you cannot. Never silently start a different card. Bigger cards make a
  mid-card handoff MORE likely, which is why "commit early, push early" is
  non-negotiable.

**Short-id prefixes.** Resolution happens in the MCP server:
- Cards tools + get_note accept a ≥4-char prefix: `get_card`, `update_card`,
  `move_card`, `get_note`.
- `card_dependencies` tools accept an 8-char prefix:
  `get_card_dependency_status`, `add_card_dependency`,
  `list_card_dependencies`.
- Full UUIDs are in your §0 results and ALWAYS work everywhere — when in
  doubt, or on the first 422 uuid_parsing, switch to full UUIDs and note the
  stale server in your run log instead of retrying prefixes.

**Scope arguments every read tool needs.** `get_card` and
`get_card_dependency_status` require BOTH `workspace_slug` AND `board_id`.
`get_note` requires `workspace_slug` (plus `board_id` for board-scoped notes).
Omitting them 422s. Front-load them into every read call.

`move_card`'s `position` is optional (backend appends) — pass it only to place
a card mid-column. If a move ever 422s asking for `position`, you are on a
different server than pinned: pass a float (`max_position + 1024`) and note it.

Move your card to the active column, resolved by `column_type` and never by
the column's displayed name, before you begin.

### 3. DO THE WORK

Read the card IN FULL. `## Acceptance Criteria`, `## DoD` / `## Test-First
DoD`, `## Out of Scope`, and any `## Direction (operator-set …)` are the
contract — an operator-set direction constrains the SOLUTION SHAPE and is not
yours to re-litigate (record disagreement in the run log, follow it anyway
unless it crosses a hard floor).

First, RECONCILE. Cards were verified against the repo at `<<ANCHOR_SHA>>` on
<<ANCHOR_DATE>>, but code moves and card claims are hypotheses: confirm the
gap still exists in the code you just pulled. Locate by symbol (grep), never
by line number. For any card enumerating N sites, re-grep and trust your count
over the card's. If the gap is already closed on `<<INTEGRATION_BRANCH>>`,
your job is the regression test that proves closure, not a second fix. Say so
on the card.

**What "stale" means — distrust, in order:**
- **The stated ROOT CAUSE / mechanism.** A card can be right about the symptom
  and wrong about the cause. Reconcile the causal claim, not just the
  coordinates.
- **Acceptance criteria and checklists.** Individual ACs go stale on their own.
  Docs can land BEFORE the feature: grep the catalogs before writing a promise.
- **Dependency prose.** A card can name a blocker that has been Done for months.
- **Schema/table claims.** Prose about INTENT is reliable; prose about tables,
  cascades, and event routing is not. Verify like a line number.
- **`operator-action-required` status.** Check whether shipped code already
  settled the decision before treating it as a stop condition.

**Run logs are hypotheses too.** A predecessor's *observations* (gate counts,
what it shipped) are reliable; its *inferences* are not. A one-call test beats
an inherited assertion.

**Cards written from a research pass under-report EXISTING tests and sites.**
Before creating any test file, list the relevant test directory and extend
the existing file. For enumerated sites, grep the symbol AND its i18n key AND
barrel exports/string-keyed maps.

**A green suite proves only the topology the suite runs.** <<TEST_TOPOLOGY>>
Anything outside that topology must be reasoned from the PROD code path and
asserted at the layer prod enforces.

**Internally contradictory cards** (a card that names a pattern, then
parenthetically describes a different primitive): follow the NAMED existing
pattern over the loose descriptive word, and record the deviation on the card.
Same rule for a Deliverable that contradicts the card's own Out of Scope or AC
(the narrower, reasoned clause wins) and for prose that argues itself out of
options mid-paragraph (ship the conclusion, ignore the discarded branches).
<<ADDENDUM_NOTE>> Where a card carries an `## Operator addendum` that corrects
the body above it, the ADDENDUM wins.

Method, non-negotiable:
- **Failing test FIRST — run it, SEE IT FAIL.** A first test that passes has
  proved nothing; fix the test before the code.
- **Mutation-check every new test** (flip the contract, confirm red). Two
  clauses, learned the hard way:
  - **A mutation that leaves the suite green means your assertion is watching
    the wrong thing — rewrite the assertion; do not weaken the mutation or
    excuse it as untestable.** When one branch renders local copy and another
    relays remote text, make the remote fixture deliberately UNLIKE the local
    copy — a realistic fixture makes the branches indistinguishable and the
    assertion vacuous.
  - **Before drawing ANY conclusion from a mutation run, verify the mutation
    actually LANDED in the executed artifact** — re-run a test that MUST fail
    under the mutant, or make the mutant crash-on-execute. A green suite over
    an unapplied mutation proves nothing.
- **UI geometry cards: assert the PIXEL, not the announcement.** In jsdom or
  any DOM emulator — where layout is inert — assert the exact style PROPERTY
  the fix manipulates and name the emulator's limitation in a test comment.
  Aria values alone never suffice. Cards whose DoD names a real-browser check
  <<JSDOM_BLIND_CARDS>> get it BEST-EFFORT and NEVER blocking:
  <<BROWSER_CHECK_COST>> budget ≤2 attempts / ~3 tool round-trips, then ship
  on the unit tests + a PR note saying the browser check was skipped and why.
  If you do run one: <<REAL_BROWSER_RECIPE>> run the NEGATIVE CONTROL first
  (revert the fix, SEE the bug); delete the probe scaffolding and check
  `git status --porcelain` before staging. Say what you saw.
- **Formatter hygiene:** after a restructure, run the formatter ONLY on the
  files you restructured, then `git diff -w --stat` — a barely-touched file
  with a big diff was not formatter-clean before; revert it and re-apply your
  edit by hand.
<<ARCHITECTURE_RULES>>
<<STACK_GOTCHAS>>
- **Cross-stack cards land as ONE PR** — never split halves that a parity or
  contract gate binds together. <<CROSS_STACK_CARDS>>
- Idempotent mutations: create/add returns the existing entity on retry,
  never 409.
- New user-facing copy: i18n keys in every locale the repo ships (<<I18N_LOCALES>>).
  Preserve technical identifiers exactly.
- Migrations: additive only. A card needing more is a wrong card: `blocked`,
  explain, move on.
- Code-is-documentation: semantic naming; comment only the non-obvious.

Test gates — all green for every touched component before the card leaves
In Progress. Run the CHEAPEST gate first (build/typecheck): it catches in
seconds what a full run surfaces after minutes.
<<GATES>>

⚠️ **A failed `cd` can look like a PASS.** Tool calls share no shell state; a
bare `cd <dir> && …` from the wrong CWD fails — but the captured output may
still show a plausible green summary from earlier scrollback. Always `cd`
inside a subshell with an absolute path AND sanity-check the reported test
COUNT against what your file actually contains.

**Reading test results — four ways evidence gets fabricated:**
1. Strip ANSI before grepping the runner's summary line — coloured output
   never anchors otherwise.
2. "No test files found" can exit with the SAME code as a failing test. A
   bare `EXIT=1` is never a kill; parse the runner's own pass/fail summary.
3. Pass test paths as literal args, never through ONE shell variable — a
   runner that sees one arg may run ZERO tests and still print a
   green-looking summary (quote each node id separately).
4. COMMIT the green implementation BEFORE any mutation batch — `git checkout
   -- <file>` is the natural revert and silently destroys uncommitted work
   (and fails on an untracked new file while reverting a tracked sibling).
   Verify each mutant landed with `git diff --quiet` (a token grep can match a
   docstring); order apply → verify-landed → run → restore.
<<TEST_RUNNER_GOTCHAS>>

Scope inner-loop runs to touched modules — but VERIFY the scoped run actually
executed your files (a fast green that names zero of your test files proved
nothing). Run the component gate once before the PR. Never run the whole-repo
everything-suite (CI's job). For long gates: pass an explicit test timeout
under 600s where supported, redirect output to a file, capture `EXIT=$?` on
the same line BEFORE any pipe, then grep the file — a piped command's reported
exit code is the LAST pipe stage's, not the gate's.

**Record gate baselines in your run log** (suite counts + any red with its
cause) and DIFF against the previous log's baselines (iteration 1: §1's
baselines). Never rationalize a red as pre-existing without proving it on a
clean `<<INTEGRATION_BRANCH>>` checkout. If a defect wedges a SHARED gate for
every future iteration, you have standing authority to file it at high
priority WITH the `<<RUN_LABEL>>` label — a broken gate outranks the current
card.

#### The repo: set it up yourself

Loop mode gives you an EMPTY working directory; nothing is cloned for you.
CWD `<<CLONE_DIR>>` persists between iterations.

Clone if absent, then SURVEY before touching anything:
```

[ -d <<REPO_DIR>>/.git ] || git clone <<REPO_URL>> <<REPO_DIR>>
git -C <<REPO_DIR>> fetch --all --prune
git -C <<REPO_DIR>> status -sb ; git -C <<REPO_DIR>> branch -a
git -C <<REPO_DIR>> log --oneline --all -15

```
- <<FORGE_AUTH_NOTE>>
- Tool calls do NOT share shell state: no `source`, no relying on a prior
  `cd`. Interpreters by path (<<INTERPRETER_EXAMPLES>>), `git -C`, absolute
  paths.
- One-time bootstrap per clone (check before redoing): <<BOOTSTRAP>>
- Integration branch `<<INTEGRATION_BRANCH>>` (create from <<DEFAULT_BRANCH>>
  ONCE if missing — see system prompt). Card branches:
  `git checkout -q <<INTEGRATION_BRANCH>>`, `git pull --ff-only`,
  `git checkout -b <<CARD_BRANCH_PREFIX>><short-slug>`.
- `git reset --hard` and compound `checkout && …` may be refused — run steps
  separately. <<HARD_FLOORS_SHORT>>

**Commit early, push the branch early** — the rails can cut a session
mid-flight and uncommitted work is invisible to your successor. **Rebase on
origin/<<INTEGRATION_BRANCH>> before the PR**, re-run touched gates, resolve
conflicts yourself (keep BOTH sides of structural conflicts). **After
`git add -A`, run `git status --porcelain`** — confirm your files staged and
no churn snuck in.

### 4. RECORD WHAT YOU LEARNED (do not skip)

create_note (board-scoped) titled
"Loop run log — iteration {{.Iteration}} (<<INTEGRATION_BRANCH>>, <date>, <card short-id>)".
Send the body as MARKDOWN — it round-trips with structure intact. Write it
ONCE, at the end. It must contain:
- What you did, where it landed: card, branch, commit sha, PR URL, files.
- Reconciliation outcome: gap live / already-fixed / partial.
- Gate baselines (counts + any reds with cause) for the next iteration to diff.
- For cards with a real-browser DoD: what you rendered and what you saw.
- What was WRONG OR MISSING in this prompt or the card — specific and blunt.
  <<SUPERVISION_LOG>> It only works when reports are testable:
  - **TEST before you report.** Say what you RAN and what came back, not what
    you inferred or inherited.
  - **State the blast radius**: one round-trip, or correctness-breaking?
  - If the PREVIOUS run log already reported the same defect and it is still
    unfixed, title your log "STOP-THE-LINE:" so the operator sees the repeat.
  - A defect that keeps recurring should become a CARD, not a fourth log
    entry — file it unlabelled for triage and name it in your log.
- What the next iteration should do differently.

Board-write rules (they bite): card `status` strings must stay UNDER 255
chars — the platform 422s beyond the cap and a 422 voids the WHOLE call.
Budget ~200 chars: `shipped <sha> (PR #N, <<INTEGRATION_BRANCH>>) — <one finding>`
fits; gate counts belong in the run log, not the status. Count before
sending. The definition is human-edited — you never write it. Lessons for the
next iteration go in this run's log note; a method worth keeping beyond this
board goes through `propose_skill` for a human to approve.

If reality diverges from a LATER card, update that card now with an as-built
block. Findings needing OPERATOR action MUST become an unlabelled card marked
operator-action-required — a note alone is never scheduled. Follow-up work you
discover: file as a card, dependency-wire it, label `<<RUN_LABEL>>` ONLY if
it is a genuine deferred half of your card or a gate-degrading defect — small,
self-contained, same gates, no human decision. Otherwise leave it unlabelled
for triage and say so in the run log. A loop that labels more than it closes
never finishes.

### 5. FINISH THE CARD

Rebase on origin/<<INTEGRATION_BRANCH>>, re-run touched gates, THEN
`gh pr create --base <<INTEGRATION_BRANCH>>` (gates before PR body so quoted
numbers are final). <<LANDING_STEPS>>
Then update_card with `pr_url` AND `branch_name` set as FIELDS (they persist —
do not bury the PR link in prose) — READ the response: if they come back
`null` or the schema lacks them, you are on an unpinned server: put the PR
number in `status`, say so in the run log ONCE, do not retry. Send `status`
in a SEPARATE update_card call from the two fields so a length 422 cannot
void them. Then move_card to <<LANDING_MOVE_TARGET>>, and set a status like:
"<<STATUS_EXAMPLE>>".

**One card per session.** The next iteration starts fresh in seconds.

Operator decisions: stop ONLY for LOAD-BEARING AND UNDERDETERMINED choices
(changes a contract/stored format/security posture AND the definition, card,
and existing patterns do not settle it). Write options + YOUR RECOMMENDATION
in a note first. Anything you can defend from the definition or an existing
pattern: decide, record, continue. A single unbuildable card gets `blocked` +
explanation, not a loop stop. NOTE: every `## Direction (operator-set …)`
block on this run's cards <<SETTLED_DIRECTIONS>> is already decided —
settled, not open.

### 6. STOP — the harness owns terminal transitions

At the end of every session the harness collects a STRUCTURED OUTCOME:
`worked` | `nothing_ready` | `blocked_on_human` | `objective_complete`.
Report it honestly — it drives the loop:

- **`worked`**: you landed (or materially advanced) a card this iteration.
  The normal outcome.
- **`objective_complete`**: ZERO `<<RUN_LABEL>>` cards remain outside Done.
  This is the PRIMARY run-complete exit — the harness verifies your claim
  against the board's completion_query and disables the loop itself,
  recording the stop in the loop history. Do NOT call set_board_loop for
  completion. ⚠️ A claim the query refutes counts as a FAILED iteration and
  burns the consecutive-failure breaker — claim it only when your §0-style
  check actually returned 0. Shipping the final card AND reporting
  objective_complete in the same iteration is the proven-tightest exit.
- **`blocked_on_human`**: you stopped for an operator decision (note with
  options + recommendation written FIRST). Below the configured threshold the
  loop parks with backoff; at the threshold the harness disables it.
- **`nothing_ready`**: <<LANDING_NOTHING_READY>>

**Intent stops — these still go through
set_board_loop(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}",
enabled=false, reason="<one line>")** because they express intent the harness
cannot infer:
- stuck (no workable `<<RUN_LABEL>>` card, some remain): reason
  "stuck: N <<RUN_LABEL>> cards blocked, none workable" — name the blocking
  edges.
- blocked globally (toolchain/auth dead for every remaining card).
- a card requires crossing a non-negotiable (name card + floor).

The off-switch is pre-flighted by the harness at iteration 1 (allowlist +
callability) — it will be available. If a tool ever seems missing, load it by
exact name first: ToolSearch("select:mcp__valaris__set_board_loop"). In the
never-expected case it is truly gone, the legacy fallback exit still stands:
run log titled "🛑 LOOP STOP REQUESTED — <reason>", ONE unlabelled
operator-action-required card, end the iteration. The rails (max_iterations,
budget) are the backstop.

Never stop silently; never keep working past a terminal state.
"""

# The catalogue, in the order note 4201e496 §2 lists it: scope and repo
# identity first, then provenance, then the per-repo method colour.
_SLOTS = [
    SlotSpec(
        name="RUN_LABEL",
        kind="scalar",
        required=True,
        label="Run label",
        help="The card label that scopes this run. It also drives the completion rail: the loop is finished when no card carrying this label sits outside a done-typed column.",
        example="loop-7",
    ),
    SlotSpec(
        name="INTEGRATION_BRANCH",
        kind="scalar",
        required=True,
        label="Integration branch",
        help="The long-lived branch every card lands on. Created once off the default branch; the merge back into the default branch is a separate human decision.",
        example="self-improve-7",
    ),
    SlotSpec(
        name="CARD_BRANCH_PREFIX",
        kind="scalar",
        required=True,
        label="Card branch prefix",
        help="Prefix for each card's own branch, including the trailing separator. The agent appends a short slug per card.",
        example="loop7/",
    ),
    SlotSpec(
        name="REPO_URL",
        kind="scalar",
        required=True,
        label="Repository clone URL",
        help="The BARE forge clone URL — it is pasted straight into `git clone`, so it must carry no annotation and end in `.git`.",
        example="https://github.com/Valaris-Studio/valaris-intern.git",
    ),
    SlotSpec(
        name="REPO_DIR",
        kind="scalar",
        required=True,
        label="Clone directory name",
        help="The directory name the clone lands in under the persistent working dir.",
        example="valaris-intern",
    ),
    SlotSpec(
        name="DEFAULT_BRANCH",
        kind="scalar",
        required=True,
        label="Protected default branch",
        help="The branch the loop must never touch. Named explicitly so the floor reads correctly on a repo whose default is not `main`.",
        example="main",
    ),
    SlotSpec(
        name="DEFAULT_BRANCH_CONSEQUENCE",
        kind="scalar",
        required=True,
        label="What a push to the default branch does",
        help='One clause completing "A push to <branch> …". Make the consequence concrete and expensive — this is what stops the agent, not the word "never".',
        example="triggers Cloud Build and AUTO-DEPLOYS TO PRODUCTION",
    ),
    SlotSpec(
        name="ANCHOR_SHA",
        kind="scalar",
        required=True,
        label="Anchor commit",
        help='The commit the cards were researched against. The agent reconciles every card claim against the code it actually pulled, using this as the "verified at" mark.',
        example="ce4ea8b4",
    ),
    SlotSpec(
        name="ANCHOR_DATE",
        kind="scalar",
        required=True,
        label="Anchor date",
        help="The date the cards were verified, so the agent can judge how much drift to expect.",
        example="2026-08-16",
    ),
    SlotSpec(
        name="ANCHOR_CHECK",
        kind="scalar",
        label="How iteration 1 confirms the anchor",
        help="Optional. A concrete command plus the output that proves the checkout matches the anchor.",
        example="`git log --oneline origin/main -1` shows the Loop #6 merge (`ce4ea8b4`)",
        default="",
    ),
    SlotSpec(
        name="SEED_NOTE_TITLE",
        kind="scalar",
        required=True,
        label="Seed note title",
        help="The title of the pinned note that carries this run's card list, priority order and constraints.",
        example="Loop-7 seed batch — 11 cards",
    ),
    SlotSpec(
        name="SEED_NOTE_ID",
        kind="scalar",
        required=True,
        label="Seed note id",
        help="The seed note's id, so the agent can fetch it directly instead of listing notes.",
        example="9ea6f250",
    ),
    SlotSpec(
        name="OTHER_PINNED_NOTES",
        kind="block",
        label="Other notes to read at orient",
        help="Optional. Sentences naming any other pinned note worth reading during orientation.",
        example='The pinned milestone note "🏁 MILESTONE 2026-08-16" (id 15cd239d) records what just shipped and why.',
        default="",
    ),
    SlotSpec(
        name="CHARTER_KEY",
        kind="scalar",
        required=True,
        label="Charter definition key",
        help="The definition key holding this run's ground rules — scope, branch policy, test gates, hard floors, memory protocol, stop contract.",
        example="loop_charter",
    ),
    SlotSpec(
        # Legacy since v6: no prompt reads it, but render() raises unknown_slot
        # for a stored value of an undeclared slot, so bound boards keep the
        # declaration until a stored-slot-value migration removes it.
        name="RUN_HISTORY_KEY",
        kind="scalar",
        required=False,
        label="Run-history definition key (legacy)",
        help="Earlier template versions wrote run history to this definition key. Since v6 the run log note carries it; leave blank on new boards.",
        example="loop_run_history",
        default="",
        deprecated=True,
    ),
    SlotSpec(
        name="DEFINITION_PRINCIPLES",
        kind="scalar",
        label="Guiding principles",
        help="Optional parenthetical enumerating the project's guiding principles, as the definition states them.",
        example="(backend-authoritative config, WS-first, idempotent mutations)",
        default="",
    ),
    SlotSpec(
        name="CONVENTION_FILES",
        kind="scalar",
        required=True,
        label="In-repo convention docs",
        help="A noun phrase naming the files that specify this repo's conventions. The agent reads them every iteration.",
        example="the root CLAUDE.md and frontend/CLAUDE.md",
    ),
    SlotSpec(
        name="ENGAGEMENT_BRIEF",
        kind="block",
        required=True,
        label="What this engagement is",
        help="Facts only: what this run is, its scope and ambition, how many cards and in what shape. Leave method out — the kernel supplies the method.",
        example="This run is a whole feature PROGRAM: thirty-seven cards in five phases, building the loop templates manager. The cards form a deep dependency graph, so early on most are blocked by design.",
    ),
    SlotSpec(
        name="TRACK_RECORD_NORM",
        kind="block",
        required=True,
        label="The self-termination norm",
        help="States that a run ends by the agent reporting objective_complete and the harness verifying it. On a repeat run, name the runs that terminated themselves; on a first run, state the bar without evidence.",
        example="Loops #4, #5 and #6 all terminated THEMSELVES: they reported `objective_complete`, the harness verified the claim against the board's completion_query, and the loop disabled itself with no human involved. Hold that bar — it is the norm.",
    ),
    SlotSpec(
        name="PROMPT_LINEAGE",
        kind="block",
        required=True,
        label="Where this prompt came from",
        help="One bold sentence on this prompt's provenance. It tells the agent how much to trust the clauses that follow.",
        example="**This prompt was carried forward from Loop #6's, which was rewritten from Loop #5's run-log feedback.**",
    ),
    SlotSpec(
        name="PROMPT_AUDIT_NOTE",
        kind="block",
        label="Which audit fed this version",
        help="Optional. Names the run-log audit behind this version and what it folded in.",
        example="Loop #6's fifteen run logs were audited before this run and their feedback folded in (server pin, test-result reading, mutation discipline).",
        default="",
    ),
    SlotSpec(
        name="SUPERVISION_SYS",
        kind="scalar",
        label="Unsupervised clause (system prompt)",
        help="Optional. Appended to the feedback-channel sentence when nobody will read the run logs mid-run. Leave empty for a supervised run.",
        example=" — and because this run is unsupervised, ALSO write the workaround for your successor",
        default="",
    ),
    SlotSpec(
        name="SUPERVISION_LOG",
        kind="block",
        label="Unsupervised clause (run log)",
        help="Optional. The matching run-log instruction for an unsupervised run: a defect merely re-reported will recur for every successor.",
        example="This run is UNSUPERVISED: nobody patches the prompt mid-run, so a defect you merely re-report will recur for every successor.",
        default="",
    ),
    SlotSpec(
        name="STALENESS_EVIDENCE",
        kind="block",
        label="Evidence that cards go stale",
        help="Optional. How many cards earlier runs falsified. Concrete counts make the reconcile step feel mandatory rather than ceremonial. End with a semicolon.",
        example="Loops #4 and #5 together falsified EIGHT cards' stated content and Loop #6 corrected the stated cause on five more;",
        default="",
    ),
    SlotSpec(
        name="CARD_PROVENANCE",
        kind="block",
        required=True,
        label="How this run's cards were researched",
        help='Completes "This run\'s cards were …". Say who researched them, against which commit, and with what evidence.',
        example="researched on 2026-08-16 by a dedicated read-only agent against `ce4ea8b4` with file:line evidence, and the operator spot-checked every load-bearing claim",
    ),
    SlotSpec(
        name="ADDENDUM_NOTE",
        kind="block",
        label="This run's addenda",
        help="Optional. Describes any operator addendum blocks on this run's cards, before the generic addendum-wins rule.",
        example="Every card in this run ends with an `## Operator addendum` block written 2026-08-16 from a code audit.",
        default="",
    ),
    SlotSpec(
        name="EXCLUDED_WORK",
        kind="block",
        required=True,
        label="What on the board is NOT mine",
        help="The other work sharing this board. Be specific: anything unnamed here that looks ready is a card the agent may wrongly pick up.",
        example="A collaborator's i18n work, owner-run ops cards, DECISION cards, cards labelled `absorbed-by-*`, decomposed parent umbrellas",
    ),
    SlotSpec(
        name="STALE_BRANCHES",
        kind="scalar",
        label="Stale remote branches",
        help="Optional. Remote branches that still exist but are done and merged — never a base for new work.",
        example="`self-improve-1..6`, `loop1/*`…`loop6/*`, `fix/*`",
        default="",
    ),
    SlotSpec(
        name="INFRA_COMMANDS",
        kind="scalar",
        label="Deploy/infra tooling to never run",
        help="Optional. The concrete commands and systems this repo has that touch production. Goes inside parentheses.",
        example="`make deploy*`, `gcloud`, `docker build/push`, terraform; GCP, Cloud Run",
        default="",
    ),
    SlotSpec(
        name="REPO_BOUNDARIES",
        kind="block",
        required=True,
        label="Repo-specific hard floors",
        help="The floors that are specific to THIS repo and stack — destructive test suites, migration policy, dependency licensing, i18n locales, ownership territories. The kernel already states the generic floors; do not repeat them.",
        example="- **NEVER run a bare `go test` in this repo.** The runner's Go tests drive real git including `reset --hard` and have previously rewound main. The only sanctioned path is `make runner-test`.\n- Migrations are ADDITIVE only: new columns nullable or server_default; never rename; never drop in the same change that stops reading.",
    ),
    SlotSpec(
        name="LAYERING_RULE",
        kind="scalar",
        label="Architecture layering rule",
        help="Optional. One sentence naming the layers and the rule against skipping them.",
        example="Backend layering Router → Service → Repository → Model; don't skip layers.",
        default="",
    ),
    SlotSpec(
        name="HARD_FLOORS_SHORT",
        kind="scalar",
        required=True,
        label="One-line recap of the floors",
        help="A compressed restatement of the hard floors, placed in the repo-setup block where the agent is running git commands.",
        example="NEVER push main, NEVER bare `go test`, NEVER deploy/infra.",
    ),
    SlotSpec(
        name="GATES",
        kind="block",
        required=True,
        label="Test gate commands",
        help="The gate command per component, cheapest FIRST (a build/typecheck catches in seconds what a full suite surfaces after minutes). Include the repo's form for scoping a run to one file.",
        example="```\nbackend:   make test-fast\nfrontend:  pnpm -C frontend build   # FIRST — the only typecheck\n           pnpm -C frontend test && pnpm -C frontend lint\nrunner:    make runner-test    # never bare `go test`\n```",
    ),
    SlotSpec(
        name="ARCHITECTURE_RULES",
        kind="block",
        label="Stack architecture rules",
        help="Optional bullets: layering, config-surface rules, and which artifacts must change together when a tool or config field is added.",
        example="- New `backend/app/config.py` field ⇒ `.env.example` entry AND `docker-compose.prod.yml` passthrough (env-drift guards fail otherwise).",
        default="",
    ),
    SlotSpec(
        name="STACK_GOTCHAS",
        kind="block",
        label="Test-library idioms and repo restatements",
        help="Optional bullets: the test-lib traps that produce vacuous assertions in this stack, and repo-specific restatements of the floors.",
        example="- Asserting a dialog has UNMOUNTED fails under the exit tween in jsdom: use `stubReducedMotion(true)`.\n- Mock third-party libraries at the module boundary; never let a real render run in jsdom.",
        default="",
    ),
    SlotSpec(
        name="I18N_LOCALES",
        kind="scalar",
        label="Locales that exist",
        help="Optional. Which locales the repo ships and which must NOT be created. Goes inside parentheses.",
        example="en AND es; pt-BR does not exist in the repo — do not create it",
        default="",
    ),
    SlotSpec(
        name="TEST_RUNNER_GOTCHAS",
        kind="block",
        label="How this repo's test runners lie",
        help="Optional bullets: the tool-specific forms of the evidence rules — exit codes, output capture, argument passing.",
        example='- vitest exits 1 for "No test files found" — the same code as a failing test. Parse the `Tests … failed` line, never a bare exit code.',
        default="",
    ),
    SlotSpec(
        name="TEST_TOPOLOGY",
        kind="block",
        label="What the suite does not exercise",
        help="Optional. The prod-only paths the green suite never touches, so the agent reasons about them from the prod code path instead of trusting green.",
        example="Tests use an in-memory event bus + SQLite. Anything on the Postgres event bus, WS fan-out, or `String(N)` widths must be reasoned from the prod code path.",
        default="",
    ),
    SlotSpec(
        name="BROWSER_CHECK_COST",
        kind="scalar",
        label="Why a real-browser check is expensive here",
        help='Optional. The setup a browser check needs in this repo, ending in "so" — it justifies the best-effort budget that follows.',
        example="`frontend/playwright.config.ts` has no `webServer`, so",
        default="",
    ),
    SlotSpec(
        name="JSDOM_BLIND_CARDS",
        kind="scalar",
        label="Cards needing a real browser",
        help="Optional parenthetical naming the cards in this run whose DoD calls for a real browser because jsdom cannot see the defect.",
        example="(three in this run: `c5a76325` sparkline dot, `ea9d6fbc` mermaid render)",
        default="",
    ),
    SlotSpec(
        name="REAL_BROWSER_RECIPE",
        kind="block",
        label="How to drive a real browser here",
        help="Optional. The mount recipe that actually works in this repo, ending in a semicolon — import paths, server setup, timeouts, and the interaction quirks.",
        example="run the probe from INSIDE `frontend/`; import vite and playwright by absolute path; mount via Vite `createServer`; `page.mouse.move(5,5)` after any click before reading computed style;",
        default="",
    ),
    SlotSpec(
        name="CROSS_STACK_CARDS",
        kind="block",
        label="Cards that must land as one PR",
        help="Optional. Which cards in this run span layers bound by a parity or contract gate, so splitting them breaks the gate between merges.",
        example="The MCP tool cards ship decorator + frontend names + regenerated fixture + docs together — never split them, or the catalog-drift gate breaks.",
        default="",
    ),
    SlotSpec(
        name="BASELINES",
        kind="block",
        required=True,
        label="Iteration-1 gate baselines",
        help='The gate numbers a fresh run diffs against, and which older logs to ignore. Completes "your baselines are …". Without them iteration 1 cannot tell a regression from the status quo.',
        example="the Loop #6 close as validated on merged main: backend `make test-fast` 3844 passed / 1 skipped, frontend 513 files / 3470 tests, lint 0 errors.",
    ),
    SlotSpec(
        name="KNOWN_FLAKES",
        kind="block",
        required=True,
        label="Known load-dependent flakes",
        help='The flaky tests that are NOT the agent\'s fault, with their cards. Completes a sentence ending "— re-run ONCE before investigating". If none, say so.',
        example="Two load-dependent flakes exist and are NOT yours: `LaunchRunnerWizard.bind.test.tsx` and a tiptap teardown error under a full run",
    ),
    SlotSpec(
        name="KNOWN_DEP_EDGES",
        kind="block",
        required=True,
        label="Dependency edges, short form",
        help='A one-line characterisation of the run\'s dependency graph, so the agent knows whether to expect blocked cards. May be "none — every card is independent".',
        example="This run has 93 edges across 37 cards: early on most cards are BLOCKED and only the enablers are workable — that is by design",
    ),
    SlotSpec(
        name="DEP_EDGES_DETAIL",
        kind="block",
        label="Dependency edges, explained",
        help="Optional. The edges spelled out, ending with a full stop.",
        example="The P0 enablers gate the P1 backend core, which gates fit/preview, which gates the UI phase. Every other card is independent.",
        default="",
    ),
    SlotSpec(
        name="SETTLED_DIRECTIONS",
        kind="scalar",
        label="Cards with operator Direction blocks",
        help="Optional parenthetical naming the cards whose Direction blocks are already settled, so the agent does not reopen them.",
        example="(68f1f18e corpus diffs, 1ed41312 enum migration)",
        default="",
    ),
    SlotSpec(
        name="CLONE_DIR",
        kind="scalar",
        required=True,
        label="Persistent working directory",
        help="The directory that survives between iterations. The agent clones once here and reuses the clone.",
        example="~/backplane-runner/repos/loop/<board_id>",
    ),
    SlotSpec(
        name="FORGE_AUTH_NOTE",
        kind="scalar",
        required=True,
        label="How the clone authenticates",
        help="How git and the forge CLI are already authenticated on the host, so the agent does not try to set up credentials.",
        example="HTTPS clone; `gh` is authenticated with push access.",
    ),
    SlotSpec(
        name="INTERPRETER_EXAMPLES",
        kind="scalar",
        label="Calling interpreters by path",
        help="Optional. Example of invoking this repo's interpreter by absolute path, since tool calls share no shell state.",
        example="`backend/.venv/bin/python -m pytest …`",
        default="",
    ),
    SlotSpec(
        name="BOOTSTRAP",
        kind="block",
        required=True,
        label="One-time per-clone bootstrap",
        help='The setup a fresh clone needs before any gate can run, per component. Completes "One-time bootstrap per clone (check before redoing): …".',
        example="backend `cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`; frontend `pnpm install` from the repo root; Go 1.26+ on PATH.",
    ),
    SlotSpec(
        name="MCP_SERVER_PIN",
        kind="block",
        required=True,
        label="Which MCP server the runner loads",
        help="Which server build the runner loads and what surface it is verified to have. A stale server silently drops fields and rejects flags, and the harness pre-flight only warns.",
        example="Your MCP server is a pinned, verified snapshot at `ce4ea8b4`: the full current surface — `summary_only`, `pr_url`/`branch_name` on `update_card`, ≥4-char prefixes.",
    ),
    SlotSpec(
        name="STATUS_EXAMPLE",
        kind="scalar",
        required=True,
        label="Done status string",
        help="The shape of the status string set when a card reaches Done. Keep it under the platform's 255-char cap.",
        example="shipped <merge-sha> (PR #N, self-improve-7)",
    ),
    SlotSpec(
        name="LANDING_POLICY",
        kind="block",
        label="Landing policy (from the variant)",
        help="Filled by the Landing mode variant: the system-prompt bullet stating who lands the PR. Do not answer it directly — choose the variant.",
        example="The loop advances ITSELF: you open the PR, then merge it yourself with plain git.",
        default="",
    ),
    SlotSpec(
        name="LANDING_STEPS",
        kind="block",
        label="Landing steps (from the variant)",
        help="Filled by the Landing mode variant: the concrete steps at the end of a card. Do not answer it directly — choose the variant.",
        example="Land it yourself, steps separately: checkout, pull --ff-only, merge --no-ff, push.",
        default="",
    ),
    SlotSpec(
        name="LANDING_STUCK_RULE",
        kind="block",
        label="Stuck rule (from the variant)",
        help='Filled by the Landing mode variant: what "no workable card remains" means under this landing. Do not answer it directly — choose the variant.',
        example="terminal — nothing external unblocks this board. Go to §6 STOP (stuck).",
        default="",
    ),
    SlotSpec(
        name="LANDING_MOVE_TARGET",
        kind="scalar",
        label="Move target (from the variant)",
        help="Filled by the Landing mode variant: which column the card moves to when the agent is done. Do not answer it directly — choose the variant.",
        example="Done (the done-typed column)",
        default="",
    ),
    SlotSpec(
        name="LANDING_NOTHING_READY",
        kind="block",
        label="nothing_ready meaning (from the variant)",
        help="Filled by the Landing mode variant: what reporting `nothing_ready` means under this landing. Do not answer it directly — choose the variant.",
        example='should be RARE here — on this self-merging board "nothing workable but cards remain" is the terminal STUCK state, not a parking state.',
        default="",
    ),
    SlotSpec(
        name="LANDING",
        kind="variant",
        label="Landing mode",
        help=(
            "Who lands the PR once the card's gates are green. This one choice "
            "fills all five LANDING_* slots together, so the policy bullet, the "
            "landing steps, the stuck rule, the move target and the "
            "`nothing_ready` meaning can never contradict each other."
        ),
        example="A",
        default="A",
        variants=[
            SlotVariant(
                id="A",
                label="Self-merge into the integration branch (proven)",
                fills={
                    "LANDING_POLICY": "The loop advances ITSELF: you open the PR into the integration branch (audit trail), then merge it yourself with plain git — check out the integration branch, `git merge --no-ff` your card branch, push. The forge marks the PR merged automatically once its commits land on the base. You then move the card to Done yourself. You never use `gh pr merge` (blocked, and unnecessary). You merge into the integration branch and NOWHERE ELSE.",
                    "LANDING_STEPS": "Land it yourself, steps separately: check out the integration branch, `git pull --ff-only`, `git merge --no-ff` your card branch, then `git push origin` that same integration branch. Never `gh pr merge`, never push the default branch, never delete the integration branch.",
                    "LANDING_STUCK_RULE": "terminal — nothing external unblocks this board. Go to the STOP section (stuck) and name the blocking edges in the reason.",
                    "LANDING_MOVE_TARGET": "Done (the done-typed column)",
                    "LANDING_NOTHING_READY": 'should be RARE here — on this self-merging board "nothing workable but cards remain" is the terminal STUCK state, not a parking state. Use the stuck exit below instead. (The one legitimate case: the only remaining workable card is blocked on a card that is In Progress by a dead predecessor — finish the predecessor first per §2, do not report nothing_ready.)',
                },
                rails={"loop_landing": "self_merge"},
            ),
            SlotVariant(
                id="B",
                label="Stop at the PR — a human lands it",
                fills={
                    "LANDING_POLICY": "You open the PR into the integration branch and STOP there. A person merges; the platform's merged-PR reconciler moves the card to Done. You never merge, never `gh pr merge`, never push the default branch.",
                    "LANDING_STEPS": "Do NOT merge. The PR is the hand-off.",
                    "LANDING_STUCK_RULE": "if the remaining cards are all awaiting a human merge (open PR, review-typed column), this is NOT stuck — report `nothing_ready` in the STOP section and end the iteration. Only when remaining cards are blocked by edges nothing external will unblock, go to the STOP section (stuck) and name the blocking edges in the reason.",
                    "LANDING_MOVE_TARGET": "the review-typed column (NOT Done — the reconciler moves it on merge); if this board has no review-typed column, leave the card in the active column, say so on the card, and note it in your run log",
                    "LANDING_NOTHING_READY": 'the normal "waiting for a human merge" outcome when only cards with open PRs remain — the loop parks per `starvation_policy` and a later iteration resumes once merges land. Cards sitting in review with an open PR are neither "workable" nor "stuck". (The dead-predecessor case still applies: an In-Progress card with no open PR is unfinished work — finish it per §2.)',
                },
                rails={"loop_landing": "human"},
            ),
            SlotVariant(
                id="C",
                label="Platform merge queue",
                fills={
                    "LANDING_POLICY": "You open the PR into the integration branch, then hand it to the platform: `enqueue_pr_for_merge` (the tool must be in your allowlist). The platform's merge executor lands it once `merge_gate` passes; the merged-PR reconciler moves the card to Done. You never merge with git or `gh pr merge`.",
                    "LANDING_STEPS": "After the PR exists, call `enqueue_pr_for_merge(...)`; do NOT merge yourself.",
                    "LANDING_STUCK_RULE": "if the remaining cards are all awaiting a human merge (open PR, review-typed column), this is NOT stuck — report `nothing_ready` in the STOP section and end the iteration. Only when remaining cards are blocked by edges nothing external will unblock, go to the STOP section (stuck) and name the blocking edges in the reason.",
                    "LANDING_MOVE_TARGET": "the review-typed column (NOT Done — the reconciler moves it when the queue lands it); if this board has no review-typed column, leave the card in the active column, say so on the card, and note it in your run log",
                    "LANDING_NOTHING_READY": "the normal outcome while your cards sit in the merge queue. If the queue reports `ci_not_green` for a card, the platform retries it automatically each tick (it re-enters at the back of the FIFO, bounded by the executor's give-up limit) — do NOT re-enqueue; only after the entry fails terminally is that card yours again: fix on its branch, push, and enqueue anew.",
                },
                tools_extra=["mcp__valaris__enqueue_pr_for_merge"],
                rails={"loop_landing": "merge_queue"},
            ),
        ],
    ),
]

TEMPLATE = SystemTemplate(
    slug="coding-loop",
    # 6 -> 7: bounded note discovery replaces the obsolete overflow warning;
    # the bump exposes drift without changing existing bound prompts.
    version=8,
    name="Coding loop — Advanced",
    profile={
        "emoji": "🛠️",
        "tagline": (
            "The expert rung: every layer of the proven Backplane method "
            "exposed as a setting, one card per fresh session, one pull "
            "request each."
        ),
        "tags": ["coding", "advanced", "tdd", "slots", "proven"],
        "what_i_do": [
            "Short-circuit: one search for the run label outside done-typed "
            "columns; zero left means the run is over.",
            "Orient: project context, the definition, the seed note, the last "
            "few run logs, then the repo.",
            "Pick the highest-priority card the server says is unblocked, and "
            "move it to the active column.",
            "Reconcile the card against the code — it is a hypothesis, not a "
            "fact — then land it test-first with the gates green.",
            "Write the run log: what landed, what the gates measured, and what "
            "was wrong in the prompt or the card.",
            "Open the PR, land it per the landing mode, and move the card to "
            "its target column.",
        ],
        # Two paragraphs, split on a literal newline: the chooser card shows
        # `split("\n")[0]` only, so a single-paragraph value dumps the whole
        # field into a one-line slot.
        "when_to_use": (
            "A backlog of small, self-contained cards on one repository.\n\n"
            "I need automated test gates, a forge I can push to, and a project "
            'where "done" can be defined as "no card still carries the run '
            'label outside the done column".'
        ),
        "when_not_to_use": (
            "Don't use me for open-ended design or research with no gates and "
            "no crisp definition of done, for work needing a human decision "
            "per card, for multi-repo cards, for deploys or infrastructure, or "
            "where other people's work shares my run label. More configuration "
            "than your project needs? Bind Coding loop — Standard."
        ),
        "needs_from_board": (
            "Typed columns, a run label on exactly my cards, a completion query "
            "over that label, the charter and note-convention keys in the definition, one "
            "pinned seed note, cards carrying acceptance criteria and scope, "
            "server-side dependency edges, a bound git repo with an integration "
            "branch, and an agent identity holding the tool allowlist."
        ),
        "needs_from_runner": (
            "Loop mode against this board, a working directory that persists "
            "between iterations so the clone is reused, a per-session budget "
            "cap, and a pinned MCP server whose surface has been verified — a "
            "stale one silently drops fields and rejects flags."
        ),
        "how_i_end": (
            "I report `objective_complete` when no card still carries the run "
            "label outside the done column, and the run is re-checked against "
            "that same question before it is believed. `worked` continues the "
            "run, `nothing_ready` means every card left is blocked on another "
            "one, `blocked_on_human` parks after I write an options note, and "
            "intent stops name their reason."
        ),
        "how_i_learn": (
            'Every run log carries a "what was wrong in this prompt or card" '
            "section, written to be testable: what was run, what came back, and "
            "the blast radius. The operator drills those logs into the next "
            "version of this template; lessons land in the run-log note, and "
            "durable methods are proposed as skills for a human to approve."
        ),
    },
    lineage_notes=(
        "Generalized from the Backplane self-improvement loop config v55, the "
        "prompt that drove Loops #1-#7 on this repository (42, 34, 8, 15, 18, 15 "
        "and 11 cards). Loops #4, #5, #6 and #7 each terminated themselves via a "
        "verified `objective_complete`. The lineage runs v1 to v55 with mid-run "
        "patches at v11-v16, v21, v26, v28, v43, v46, v48 and v52-v55 — every "
        "one of them sourced from a run-log defect report rather than a redesign. "
        "This kernel is the method stratum of that prompt with the "
        "board-specific strata lifted into slots. This is the advanced rung of "
        "the coding-loop ladder; Coding loop — Standard and Coding loop — "
        "Guided are reductions of this same kernel."
    ),
    content=TemplateContent(
        system_prompt=_SYSTEM_PROMPT,
        loop_prompt=_LOOP_PROMPT,
        slots=_SLOTS,
        # The v55 grant (21 tools) minus `update_definition` — the definition
        # is human-owned (bundle E) — plus the skills-distill trio. Read/record
        # core plus the card-lifecycle
        # writes a coding loop needs to finish and remember a card. No delete
        # tools and no agent-admin tools: a misread card must never become data
        # loss. Variant C adds the merge-queue tool its policy names.
        tools=mcp_tools(
            "get_board_loop",
            "validate_board_dependencies",
            "update_card",
            "move_card",
            "create_card",
            "add_card_dependency",
            "log_execution_update",
            *SKILLS_TOOLS,
        ),
        # Applied on FIRST bind only, so these are the numbers an operator
        # inherits by not thinking about them. Sized from the v55 run that drove
        # Loop #7: a premium tier for whole-feature cards, a timeout that fits
        # one, and a budget rail set as a CEILING near 3x expected spend rather
        # than an estimate.
        rails_defaults={
            "model": "premium",
            "iteration_delay_seconds": 60,
            "iteration_timeout_seconds": 5400,
            "budget_usd": 250,
            "max_iterations": 20,
            "max_consecutive_failures": 3,
            "max_blocked_on_human": 3,
            "starvation_policy": "park",
            "loop_landing": "self_merge",
            "merge_gate": "forge_ci",
        },
        setup_contract={
            "completion_policy_kernel": completion_policy_kernel(_SLOTS),
            # The loop moves a card into the active column and out to done every
            # iteration, and measures completion by done-typed column, so those
            # two are structural. Backlog and review are conveniences.
            "required_column_types": ["active", "done"],
            "optional_column_types": ["backlog", "review"],
            "requires_run_label": True,
            "definition_keys": [
                "loop_charter",
                "note_conventions",
            ],
            "pinned_notes": ["seed"],
            "card_sections": [
                "## Acceptance Criteria",
                "## DoD",
                "## Out of Scope",
            ],
            "git_repo_bound": True,
            "agent_bound_with_tools": True,
            "dependencies_server_side": True,
            "notes": (
                "I need a repository bound to the board and an integration branch "
                "to land on; I never touch the default branch. Cards must carry "
                "acceptance criteria and scope, and their ordering must be wired "
                "as server-side dependencies rather than described in prose."
            ),
        },
        # The harness reads completion_query to decide the run is over, so the
        # label slot must reach it. Substituted at render like a prompt, which
        # is what keeps the agent's own search and the harness's query
        # measuring the same set of cards.
        derived_rails={
            "completion_query": {
                "label": "<<RUN_LABEL>>",
                "exclude_column_type": "done",
            }
        },
    ),
)
