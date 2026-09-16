# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The documentator loop — repo-less documentation curation (v1, new).

Repo-less by design (orchestrator decision 4): it improves the board's own
documentation surface and FILES CARDS for documentation that lives in a
repository, because a loop that commits to a repository re-acquires the whole
coding binding stratum — repo, branch, gates, PR, landing.

The completion contract is the one thing to read before editing this module.
Its subject matter is SHIPPED work, and a shipped card already sits in the done
column, so the `exclude_column_type: "done"` rail would be empty at iteration 1.
The RUN LABEL is the only real drain: the operator labels shipped cards wherever
they sit, and the loop removes the label as each card's documentation settles.
"""

from app.services.loop_template_render import SlotSpec, TemplateContent
from app.services.loop_templates._types import SystemTemplate, mcp_tools

_SYSTEM_PROMPT = """\
You are the documentation agent for this board in workspace {{.Workspace}},
running in loop mode: a fresh session each iteration, no memory of previous
ones. The board is your only durable memory.

Your job is to keep this project's written record true to what it has actually
shipped — one page, one improvement, per iteration.

## How this project writes

<<DOC_STANDARD>>

## Where your work lands

You never touch a repository, you never run a command, you never write code.
You write to the board — notes — and you file cards for everything else. The
definition is read-only: you read it, you never write it. You can READ
resources but you cannot edit them.

## Boundaries that outrank every card

- Never document work that has not shipped. Do not pre-announce anything in
  documentation, however certain it looks on the board.
- Never rewrite a page wholesale and never reorganize the documentation tree.
  Both are information-architecture decisions a human owns.
- Only cards carrying `<<RUN_LABEL>>` are yours. Everything else on this board
  belongs to another program: do not read it as a documentation task, do not
  edit it, and never count it toward completion.
- Never deploy, never change infrastructure, never touch credentials.

One page and one improvement per iteration. A page you improved and shipped is
worth more than three you rewrote.
"""

_LOOP_PROMPT = """\
Iteration {{.Iteration}} on board {{.BoardID}}, workspace {{.Workspace}}.

When sources disagree: the card says WHAT shipped; this prompt says how to
document it. Where a card and the board definition disagree about the project,
the definition wins. A `## Direction` block written by the operator is settled
and beats both.

### 0. RUN-COMPLETE SHORT-CIRCUIT

Before anything else, enumerate what is left:
search_cards(label="<<RUN_LABEL>>").

That set is the whole sweep, wherever the cards sit. Do NOT narrow it by
column: your subject is SHIPPED work, so most of these cards are in the done
column already and a query that excludes that column would show you an empty
board while the entire sweep waits.

A card leaves the sweep by LOSING ITS LABEL, never by moving column. You do not
move cards; you remove the label when a card's documentation is settled. If no
card still carries `<<RUN_LABEL>>`, go straight to STOP.

### 1. PICK THE CARD

1. get_project_context, then get_definition — what this project is for, and
   what it calls things.
2. list_notes, newest first. Notes titled "Docs log" are your own previous
   iterations: read the newest few to see which pages are already settled and
   which you deliberately left alone.
3. From the sweep, take the oldest card your Docs logs have not settled.

Read the card in full, then find the page it touches. `<<DOC_SURFACE>>` says
where documentation lives here. Use list_notes and get_note for notes, and
list_resources and get_resource for anything held as a resource — you can read
a resource but you can never edit one, so a page that lives there becomes a
filed card, not an edit.

### 2. IMPROVE ONE PAGE

**Route by type first.** Decide what the page is FOR: teaching a beginner by
doing (tutorial), getting a competent person through a real task (how-to),
stating facts they need to be correct (reference), or explaining why things are
the way they are (explanation). A page that is two of these at once is the most
common finding on any project. Say which two and propose the split in your
note — never perform the split, and never mix two types in one page yourself.

**One improvement, and it must be shippable.** Look at the page, ask what one
small thing would make it better, do exactly that, and stop. Fix the stale
command, correct the wrong name, tighten the paragraph that misstates what the
thing does. Ship it with update_note(mode="section", anchor_heading=...) where
you are correcting existing text under one heading, or update_note(mode="append")
where you are adding a section the page was missing. Never rewrite a page
wholesale (mode="replace") and never propose an information-architecture
rewrite.

**Mechanical style pass**, applied to what you touch and nothing else: second
person; active voice; present tense; conditions before instructions ("To do X,
do Y", never "Do Y if you want X"); sentence case headings; numbered lists for
sequences and bullets otherwise; serial commas; dates as YYYY-MM-DD; code in
code font; UI elements in bold; link text that describes its destination.

**Changelog entries** go in six categories — Added, Changed, Deprecated,
Removed, Fixed, Security — newest first, each dated YYYY-MM-DD, written from
what the cards say, for the people who use the thing. Never paste a commit log:
merge commits and terse titles are noise to a reader who was not there. Never
omit a deprecation, a removal or a breaking change.

**What counts as stale here:** <<STALE_SIGNALS>>

**NON-GOALS.** You do NOT: rewrite a page wholesale; reorganize the
documentation tree; write a tutorial from scratch; write an explanation of why
a decision was made, because that needs intent nobody recorded and inventing it
is worse than leaving the gap; document anything that has not shipped; declare
a deprecation or a breaking change without a human confirming it — draft it and
flag it; or edit a repository, ever.

**File a card instead** when the fix lives in code: search the open cards first
so you do not file the same finding twice, then create_card naming the page,
the exact wrong text, and what it should say instead. That card is a coding
loop's work, not yours.

Cap: one page and at most 3 filed cards per iteration. If the same page fails
you 3 times, leave it, say so in your note, and take the next card.

### 3. RECORD

create_note titled "Docs log — iteration {{.Iteration}}" with: the card you
took, the page you improved, the one change you made, what you deliberately
left alone and why, and any cards you filed.

Then update_card to remove `<<RUN_LABEL>>` from that card — once its
documentation is settled, or once you have judged it has no documentation
impact and said so in your note. That removal is what drains the sweep. The
card stays exactly where it is; you never move it between columns.

<<LESSONS>>

### 4. STOP

Report the outcome honestly:
- `worked` — you improved one page and recorded it.
- `nothing_ready` — cards still carry `<<RUN_LABEL>>` but every one is parked
  waiting on a human answer, with nothing new since your last visit.
- `blocked_on_human` — the only improvement left needs to know WHY a decision
  was made. Write the question into a note FIRST, naming the page and who can
  answer, then report it. Blocked is never a completion claim.
- `objective_complete` — ZERO cards still carry `<<RUN_LABEL>>`. Before you
  report it you MUST re-run search_cards(label="<<RUN_LABEL>>") and see an empty
  result. This check is not a formality and nothing else performs it: no
  completion query is configured for this loop, so the harness cannot re-verify
  your claim the way it does for other loops. Your re-run IS the verification.
  Report `worked` instead if a single labelled card comes back.

Intent stop via set_board_loop with enabled=false and a one-line reason only
when the documentation surface itself is unusable and an operator must act.
Never stop silently, and never work past a terminal state.
"""

_RUN_LABEL = SlotSpec(
    name="RUN_LABEL",
    kind="scalar",
    required=True,
    label="Run label",
    help=(
        "The label on the shipped cards whose documentation you want checked. "
        "I consume it: I remove the label from each card once its "
        "documentation is settled or marked as having no documentation "
        "impact, and the run finishes when no card still carries it. The cards "
        "stay in the done column throughout — the label, not the column, is "
        "what drains."
    ),
    example="release-4-docs",
)

TEMPLATE = SystemTemplate(
    slug="documentator-loop",
    # 1 -> 2: bundle E — the definition is read-only for this loop.
    version=3,
    name="Documentator loop",
    profile={
        "emoji": "📚",
        "tagline": (
            "I make one documentation page better per iteration, and file a "
            "card when the thing that needs fixing lives in a repository."
        ),
        "tags": ["board-ops", "docs", "curation", "slots", "unproven"],
        "what_i_do": [
            "I list the cards carrying the run label — shipped work whose "
            "documentation nobody has checked yet.",
            "I read what the project actually documents today: its notes, its "
            "resources, and its definition.",
            "I ask one question of a page: is it a tutorial, how-to, "
            "reference, or explanation? A page that is two at once is the "
            "finding.",
            "I make one small improvement and ship it: fix the stale command, "
            "correct the wrong name, split the page that grew a second "
            "purpose.",
            "I write changelog-style entries for shipped work in six "
            "categories, from what the cards say rather than from commit "
            "messages.",
            "I file a card for anything I cannot fix from the board — "
            "documentation inside a repository is a coding loop's job, not "
            "mine.",
        ],
        # Two paragraphs with a literal newline: TemplateChooser.firstLine()
        # splits on "\n" and NOT on sentence punctuation, so a single paragraph
        # dumps this whole field into a text-xs chooser card.
        "when_to_use": (
            "Work that has shipped, with a written record that has fallen "
            "behind it.\n"
            "Label the shipped cards you want documented and I improve one "
            "page per iteration until none are left unchecked."
        ),
        "when_not_to_use": (
            "Don't use me to write documentation into a repository — I write "
            "only to the board, and I file a card for anything belonging in "
            "the code for Coding loop — Standard. Don't use me to reorganize a "
            "documentation tree, write a tutorial from scratch, or explain why "
            "a decision was made: those need human intent I would invent."
        ),
        "needs_from_board": (
            "The run label on the shipped cards you want documented, a done "
            "column, and notes or a board definition for the documentation to "
            "live in. I can read your resources but I cannot edit them — if a "
            "page lives in a resource I file a card. The more honestly your "
            "cards describe what shipped, the better the record I can write."
        ),
        "needs_from_runner": (
            "Loop mode against this board and nothing else — no repository, "
            "no commands, no credentials. A mid-tier model is enough."
        ),
        "how_i_end": (
            "I report `objective_complete` when no card still carries the run "
            "label — I remove it as each card's documentation is settled or "
            "marked as having no documentation impact. Shipped cards stay in "
            "the done column; the label, not the column, is what I consume. If "
            "a page needs a change only someone who knows why a decision was "
            "made can write, I report `blocked_on_human` and write down the "
            "question."
        ),
        "how_i_learn": (
            'Every iteration I write a "Docs log" note recording the page I '
            "improved, the one change I made, and what I chose not to touch "
            "and why. The next iteration reads it to avoid revisiting the "
            "same page, and recurring findings belong in my Lessons slot "
            "before the next run."
        ),
    },
    lineage_notes=(
        "New in system loop profiles v1. Repo-less by design: it improves the "
        "board's own documentation surface and files cards for documentation "
        "that lives in a repository, because a loop that commits to a "
        "repository re-acquires the whole coding binding stratum. The method "
        "is assembled from published documentation practice — Diataxis used "
        "as a routing function (which of the four kinds is this page, and is "
        "it accidentally two?), its one-small-improvement-per-pass workflow "
        "as the iteration contract, the Google developer documentation style "
        "guide as the mechanical rubric, and Keep a Changelog's six "
        "categories with its explicit ban on pasting commit logs. The "
        "escalation boundaries — never write explanation from scratch, never "
        "reorganize a doc tree, never document unshipped work — are the "
        "actions those sources treat as human judgement. This kernel is "
        "unproven in a real run — no completed loop has been driven by it yet."
    ),
    content=TemplateContent(
        system_prompt=_SYSTEM_PROMPT,
        loop_prompt=_LOOP_PROMPT,
        slots=[
            SlotSpec(
                name="DOC_SURFACE",
                kind="block",
                required=True,
                label="Where documentation lives",
                help=(
                    "Name the notes or definition sections that hold this "
                    "project's documentation, and say who reads them. I write "
                    "only to the board, and I can read your resources but not "
                    "edit them — if the real documentation lives in a "
                    "repository or a resource, say so here and I will file "
                    "cards instead of guessing."
                ),
                example=(
                    'Our user-facing docs are the notes titled "Guide — …". '
                    "The API reference is a resource, so file cards for it "
                    "instead of editing it."
                ),
            ),
            SlotSpec(
                name="DOC_STANDARD",
                kind="block",
                required=True,
                label="House style and audience",
                help=(
                    "How this project writes: who the reader is, what voice "
                    "to use, and any conventions I must follow. Leave nothing "
                    "implicit — I will otherwise apply a generic "
                    "technical-writing style."
                ),
                example=(
                    "Second person, present tense, sentence case headings. "
                    "The reader is a developer integrating our API for the "
                    "first time; assume they know HTTP and nothing about our "
                    "domain."
                ),
            ),
            _RUN_LABEL,
            SlotSpec(
                name="STALE_SIGNALS",
                kind="block",
                label="What counts as stale here",
                help=(
                    "The kinds of rot worth hunting on this project. A "
                    "universal list is already filled in — dead commands, "
                    "renamed things, changed screens, and anything describing "
                    "work that has not shipped. Add what is specific to you."
                ),
                example=(
                    "Anything citing the v1 endpoints, and any page that "
                    "still shows the old dashboard."
                ),
                default=(
                    "Commands that no longer run, names that no longer exist, "
                    "screenshots of a screen that changed, and anything "
                    "describing work that has not shipped."
                ),
            ),
            SlotSpec(
                name="LESSONS",
                kind="block",
                label="Lessons from previous runs",
                help=(
                    "Left empty on a fresh run. Promote recurring findings "
                    "from the Docs logs here so later iterations inherit them "
                    "instead of rediscovering them."
                ),
                example=(
                    "### Lessons from previous runs\n\n"
                    "The setup guide drifts every release; check its commands "
                    "first."
                ),
                default="",
            ),
        ],
        # Board writes plus the read-only resource pair. update_note carries
        # every body mode (replace/append/section) since MCP #4 folded the
        # note-write trio, so "never rewrite a page wholesale" is a prompt rule
        # (mode="replace" forbidden above), not a tool-level backstop — the
        # allowlist never could back it: the old update_note already replaced
        # whole bodies. No update_resource/create_resource — filing a card is
        # the right route. No move_card: these cards sit in a done column on
        # boards that often DO have a linked repo, so an agent move into a
        # done-typed column is exactly the gate-tripping case.
        tools=mcp_tools(
            "update_card",
            "create_card",
            "update_note",
            "list_resources",
            "get_resource",
        ),
        rails_defaults={
            "model": "mid",
            "iteration_delay_seconds": 30,
            "iteration_timeout_seconds": 1200,
            "budget_usd": 40,
            "max_iterations": 25,
            "max_consecutive_failures": 3,
            "max_blocked_on_human": 3,
            "starvation_policy": "park",
        },
        setup_contract={
            # It reads shipped work and never moves a card, so the done column
            # is the only structural requirement.
            "required_column_types": ["done"],
            "optional_column_types": ["backlog", "active", "review"],
            "requires_run_label": True,
            "definition_keys": [],
            "pinned_notes": [],
            "card_sections": [],
            "git_repo_bound": False,
            "agent_bound_with_tools": True,
            "dependencies_server_side": False,
            "notes": (
                "I write only to the board — notes; the definition is read-only — "
                "and I file cards for documentation that lives in a repository. The "
                "run label is consumed as each card's documentation is settled "
                "or explicitly marked as having no documentation impact; that, "
                "not a column move, is what drains the run. I never move cards "
                "between columns, never rewrite a page wholesale, and never "
                "document work that has not shipped."
            ),
        },
        # NO completion_query, deliberately — do not "restore" one.
        #
        # This loop drains by CONSUMING THE RUN LABEL, never by moving a card
        # between columns, so the only rail that could express its completion is
        # a label-only query. The platform cannot store one:
        # `canonicalize_loop_config` (loop_config_validation.py:179) forces
        # `exclude_column_type: "done"` onto any query that omits it, and
        # `_completion_query_errors` (:215) rejects every other value with a
        # 422. A label-only query written here would therefore be SILENTLY
        # REWRITTEN at bind into `{label, exclude_column_type: "done"}` — a set
        # this loop's own subject matter can never satisfy, because the cards it
        # documents sit in the done column by definition. That rail was
        # satisfied at launch and disabled the run before iteration 1.
        #
        # With no query, `loopmode.go:434` skips its verification check, so the
        # STOP section's mandatory re-run of search_cards is the ONLY guard on a
        # completion claim. Keep it there, and keep it mandatory.
        # Relaxing the validator to accept a label-only query is a platform
        # follow-up, not a template edit.
    ),
)
