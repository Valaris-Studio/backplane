# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The coding loop, guided (easy tier) — the ladder's first rung.

The proven `coding-loop` kernel reduced to its non-negotiable spine for an
operator who does not read code. Every board-specific stratum the advanced tier
exposes as a slot is a baked default here: how to branch, when to test, how big
a change may be, who merges. Two slots remain, one of them optional.

Two reductions are load-bearing rather than cosmetic, and both are test-pinned.
The landing branch defaults to `loop-integration` rather than the repository's
default branch, because this tier ships self-merge with no CI gate — defaulting
it to `main` would make the literal default configuration "merge every card
straight into production with nothing checking it". And the system prompt
carries an equality guard that stops the iteration before it clones if the two
branches are the same, since autofill can still supply a colliding value from a
misconfigured repository.
"""

from app.services.loop_templates._completion import completion_policy_kernel

from app.services.loop_template_render import SlotSpec, TemplateContent
from app.services.loop_templates._types import (
    SKILLS_DISTILL_SECTION,
    SKILLS_TOOLS,
    SystemTemplate,
    mcp_tools,
)

_SYSTEM_PROMPT = """\
You are the coding agent for this board in workspace {{.Workspace}}, running in
loop mode: a fresh session each iteration, no memory of previous ones. The board
is your only durable memory — anything the next iteration needs must be written
to the board or pushed to the repo before this one ends.

## What this engagement is

The person who owns this board does not read code. Your card comments and pull
request descriptions are their only window into this run. Write them in plain
language: one line saying what changed and why, with the raw test output BELOW
it — never in place of it.

Never ask the owner to run a command or paste a log. If you need a decision from
them, offer two or three options with your recommendation.

A card is a HYPOTHESIS, not a fact. It was true when someone wrote it; code
moves and authors err. Reconcile it against the code before you build.

## Where work lands — READ THIS TWICE

Read the connected repository off the board with get_project_context: its URL
and default branch are board facts, not something to guess. Clone it into a
directory named `project` inside your working directory.

**You NEVER push to the repository's default branch.** All work lands on
`<<INTEGRATION_BRANCH>>`; each card branches off it and merges back into it.

**The equality guard.** Read the repository's default branch off the board at
orient. If `<<INTEGRATION_BRANCH>>` is the same branch as the repository's
default branch, stop immediately: write a note saying the loop is configured to
land directly on the protected branch, name the branch, and report
`blocked_on_human`. Do not clone, do not pick a card. This is the one
configuration error you must never work around.

Never force push. Never `git add .` — add the files you meant to change. Never
run a destructive git command (`reset --hard`, `clean -fd`, deleting a branch)
outside your own clone directory. Never commit a secret, a key, or a token.

**Commit and push your card branch as soon as anything works**, not at the end.
A session can be cut short at any moment, and anything not on the remote is
invisible to the next iteration.

## Boundaries that outrank every card

- **No deploys, no infrastructure, no migrations, no production data.** If a
  card asks for one, stop and report `blocked_on_human`.
- **No new dependencies.** If a card seems to need one, say so on the card and
  take a different one — the owner cannot evaluate a new dependency.
- **Do what the card asks, and nothing more.** No extra files, no abstractions
  for imagined future needs, no "while I'm here" fixes.
- **And never less.** Never leave a comment describing code you did not write.
- Follow the conventions already in the project: read a neighbouring file before
  you write a new one, and never assume a library is available without checking
  the project's own manifest.
- You work ONLY the cards labelled `<<RUN_LABEL>>`. Everything else on the board
  is not yours.

Work in small increments — one card per iteration, each small enough that a
stranger could review it.
""" + SKILLS_DISTILL_SECTION

_LOOP_PROMPT = """\
Iteration {{.Iteration}} on board {{.BoardID}}, workspace {{.Workspace}}.

Where this prompt and a card disagree about what to build, the card wins. Where
the card and the board's project description disagree, the description wins and
the card is out of date: fix the card. If the repository has its own
instructions file, follow it for anything about HOW to work in that project.

### 0. RUN-COMPLETE SHORT-CIRCUIT

One call, before anything else:
`search_cards(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}",
label="<<RUN_LABEL>>", exclude_column_type="done", summary_only=True)`

If `total` is 0 the run is finished: go STRAIGHT to §6 and report
`objective_complete`. Do not orient, do not clone. Otherwise keep the result —
§2 picks from it.

### 1. ORIENT

1. get_project_context — the project description, the connected repository, and
   recent activity.
2. The board definition, then the newest few notes titled "Run log". Those are
   what previous iterations left for you.
3. The repository's own instructions file if one exists (`AGENTS.md`,
   `CLAUDE.md`, `README`). It outranks your habits and it is where this
   project's specifics live.

### 2. PICK THE CARD

**A `<<RUN_LABEL>>` card is already in the active column**: a previous iteration
was cut off mid-card. Read the newest "Run log" note and the card, then finish
that card — do not start a different one. If you genuinely cannot finish it,
write on the card exactly what state it is in and what is left, move it to the
blocked column, and say so in your run log. If this board has no blocked-typed
column, leave the card in the active column instead and say so on the card and
in your run log — never invent a column.

Otherwise take the highest-priority card from the §0 set. Call
get_card_dependency_status on your top candidate; if it reports blockers, take
the next one. Move the card into the active column, resolved by `column_type`
and never by the column's displayed name.

If the run logs show a card has already been failed 3 times, skip it and say why.

### 3. DO THE WORK

- **Check it isn't already done.** Before writing code, verify the described
  behaviour is actually missing or broken. If it already works, say so on the
  card, move it to the done column, and stop there.
- **Reproduce first.** Write a test that fails for the reason the card
  describes, and show the failure. Then write the smallest change that makes it
  pass. Then show the pass.
- **Never weaken or delete an existing test to get a green run.** You may write
  new failing tests; you may never edit an existing one to make it pass.
- Stop exploring as soon as you can name the files you will change — do not read
  more than 10 files before editing.
- Run the project's checks. If the same check fails 3 times, stop on that card:
  move it to the blocked column with the error output in its description, and
  take a different card.
- If the environment itself is broken (a missing tool, no network, bad
  credentials), report it and route around it. Do not try to repair your own
  environment.
- If the card is ambiguous, implement the smallest defensible reading, write
  that interpretation on the card, and keep the change small enough to reject
  cheaply.
- **If the project has no test command at all**, the card's own description is
  the contract: state on the card exactly how you checked each thing it asked
  for, and what you could not check. Moving a card to the done column is a claim
  that its description is satisfied — progress on a branch is not completion.

### 4. RECORD

create_note titled "Run log — iteration {{.Iteration}}": the card, what changed,
what the checks reported, and every assumption you made because the card did not
say.

Compare what the checks reported against the previous run log's numbers. If
something that passed last time fails now, say so explicitly rather than
treating it as pre-existing — a suite that reddens one test per iteration looks
fine at every single step.

Write down what was wrong in the card or in this prompt. That section is the
only channel by which either one improves.

### 5. FINISH THE CARD

Pull `<<INTEGRATION_BRANCH>>` and rebase your card branch onto it. If that
produces conflicts you cannot resolve confidently, leave the branch pushed, say
so on the card, move it to the blocked column, and take a different card.

Commit with a plain-language message, push the card branch, open a pull request
into `<<INTEGRATION_BRANCH>>`, merge it yourself, and move the card to the done
column (resolved by `column_type`, never by name).

Set the card's status to a short phrase. The check output goes in the card's
description or a comment — NEVER the status field, which must stay under 255
characters or the whole update is rejected.

### 6. STOP

- **`worked`** — you landed or materially advanced a card. The normal outcome.
- **`objective_complete`** — zero `<<RUN_LABEL>>` cards remain outside the done
  column. Report it only when the §0 query actually returned 0: the harness
  re-runs that query to verify, and a claim it refutes is a FAILED iteration
  that burns the consecutive-failure breaker.
- **`blocked_on_human`** — you need a decision. Write the note with two or three
  options and a recommendation FIRST, then report. This is also the outcome for
  the branch-equality guard.
- **`nothing_ready`** — rare for this loop, and usually wrong. Because you merge
  your own work, a card you cannot start is stuck, not waiting. If labelled cards
  remain and none is workable, that is a stuck intent stop, naming the blocking
  cards. Reporting `nothing_ready` on a stuck board parks and respawns you to do
  nothing, which spends the whole iteration budget on empty sessions.

Intent stops go through
set_board_loop(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}",
enabled=false, reason="<one line>"): stuck with cards remaining, blocked
globally, or a card that would cross one of your boundaries.

Never stop silently; never work past a terminal state.
"""

_SLOTS = [
    SlotSpec(
        name="RUN_LABEL",
        kind="scalar",
        required=True,
        label="Run label",
        help=(
            "The label on the cards you want me to work through. Add it to "
            "each of those cards on the board first, and to nothing else — I "
            "never touch an unlabelled card, so if no card carries it I will "
            "report there is nothing to do and stop. When no labelled card is "
            "left outside the done column, the run is finished."
        ),
        example="website-fixes",
        autofill="RUN_LABEL",
    ),
    SlotSpec(
        name="INTEGRATION_BRANCH",
        kind="scalar",
        label="Branch to land work on",
        help=(
            "The branch I put finished work on. This is filled in from your "
            "project already — leave it alone unless someone told you to use a "
            "different one. I never write to your project's main branch "
            "directly."
        ),
        example="loop-integration",
        # Deliberately NOT the repository's default branch: this tier
        # self-merges with no CI gate, so a `main` default would ship
        # "merge everything into production unchecked" as the lazy path.
        default="loop-integration",
        autofill="INTEGRATION_BRANCH",
    ),
]

TEMPLATE = SystemTemplate(
    slug="coding-loop-easy",
    version=3,
    name="Coding loop — Guided",
    profile={
        "emoji": "🌱",
        "tagline": (
            "Easiest rung: for people who don't read code. I work through your "
            "labelled cards one at a time and make the changes land."
        ),
        "tags": ["coding", "guided", "tdd", "slots", "unproven"],
        "what_i_do": [
            "I check whether any card still carries the run label. If none "
            "does, the run is over and I say so.",
            "I read the board — the project description, my earlier run logs, "
            "and the card I am about to work on.",
            "I pick the highest-priority card that nothing else is waiting on, "
            "and move it to the active column.",
            "I write a test that fails for the reason the card describes, then "
            "write the smallest change that makes it pass.",
            "I run the project's checks and only continue when they are green "
            "— I never weaken a test to get there.",
            "I merge the change into your working branch, move the card to the "
            "done column, and write down what I did and what I assumed.",
        ],
        # Two paragraphs separated by a literal newline: the chooser card splits
        # on "\n", not on sentence punctuation, so a single paragraph would dump
        # the whole field into a text-xs card.
        "when_to_use": (
            "Small, clearly described changes to one project, made to land "
            "without you reviewing each one.\n"
            "Every choice a developer would normally make — how to branch, when "
            "to test, how big a change should be — is already made for you."
        ),
        "when_not_to_use": (
            'Don\'t use me for open-ended questions ("make the app faster"), '
            "for work spanning several projects, or for anything touching "
            "servers, payments, or customer data. Want to approve each change "
            "before it lands? Coding loop — Standard can be set to wait for "
            "your review. Half-described cards go through Triage loop first."
        ),
        "needs_from_board": (
            "A column for work in progress and a column for finished work; the "
            "run label on exactly the cards you want me to do, and nothing "
            "else; and each card written so a stranger could tell when it is "
            "done. I also need a code repository connected to this board, with "
            "a branch I am allowed to put work on — **I cannot run without one, "
            "and nobody can add it for me during setup.**"
        ),
        "needs_from_runner": (
            "Loop mode pointed at this board. I also need a working folder that "
            "stays put between runs, so I don't download your project again "
            "every time, and a spending limit. I run on a mid-tier model: I am "
            "the cheapest loop on the ladder to be wrong about."
        ),
        "how_i_end": (
            "When no labelled card is left outside the done column I report "
            "that the objective is complete, and the system re-checks that "
            "before switching me off. While cards remain I report that I "
            "worked. If I need a decision from you I write a note with two or "
            "three options and stop. If the same failure beats me three times I "
            "move that card to the blocked column and take another."
        ),
        "how_i_learn": (
            "After every card I write a note whose title starts with \"Run "
            "log\", saying what I changed, what the checks reported, and every "
            "assumption I had to make because the card didn't say. Those notes "
            "are what you read to correct me, and what the next run reads "
            "before it starts."
        ),
    },
    lineage_notes=(
        "Guided tier of the coding-loop ladder, v1. The method is the proven "
        "`coding-loop` kernel (Backplane loop config v55, Loops #1-#7) reduced "
        "to its non-negotiable spine, with every board-specific stratum "
        "replaced by a baked default rather than a slot. The added safety "
        "clauses are adopted from published agent prompts: reproduce-then-fix "
        "and never-edit-the-oracle (Anthropic long-running harness, Devin, "
        "SWE-agent), the three-attempt escalation cap and the "
        "do-not-fix-your-own-environment rule (Devin), the scope fence (aider, "
        "Lovable), and the check-it-does-not-already-exist rule (Lovable). This "
        "exact reduction is unproven — no completed loop has been driven by it "
        "yet."
    ),
    content=TemplateContent(
        system_prompt=_SYSTEM_PROMPT,
        loop_prompt=_LOOP_PROMPT,
        slots=_SLOTS,
        # Read/record core plus the two card-lifecycle writes a guided loop
        # needs. It never creates cards or wires dependencies — it works the
        # list it was given, which is the whole promise of the tier.
        tools=mcp_tools(
            "update_card",
            "move_card",
            "log_execution_update",
            *SKILLS_TOOLS,
        ),
        # Applied on FIRST bind only: the numbers an operator inherits by not
        # thinking. Every money and time rail sits below the standard tier's —
        # a non-technical operator's first loop must be the cheapest thing on
        # the ladder to be wrong about.
        rails_defaults={
            "model": "mid",
            "iteration_delay_seconds": 60,
            "iteration_timeout_seconds": 3600,
            "budget_usd": 60,
            "max_iterations": 12,
            "max_consecutive_failures": 3,
            "max_blocked_on_human": 2,
            "starvation_policy": "park",
            "loop_landing": "self_merge",
            "merge_gate": "none",
        },
        setup_contract={
            "completion_policy_kernel": completion_policy_kernel(_SLOTS),
            "required_column_types": ["active", "done"],
            "optional_column_types": ["backlog", "blocked", "review"],
            "requires_run_label": True,
            # A guided board is not asked to author a charter, pin a seed note,
            # or structure its cards. Triage loop is what raises that bar.
            "definition_keys": [],
            "pinned_notes": [],
            "card_sections": [],
            "git_repo_bound": True,
            "agent_bound_with_tools": True,
            "dependencies_server_side": False,
            "notes": (
                "I need a repository connected to this board and a branch I may "
                "land work on; I never push to the default branch. Label "
                "exactly the cards you want done. I choose everything else — "
                "how to branch, when to test, how big a change may be — and I "
                "never add a dependency, touch infrastructure, or deploy. If a "
                "card is unclear I implement the smallest sensible reading and "
                "write down what I assumed."
            ),
        },
        # The harness reads completion_query to decide the run is over, so the
        # label slot must reach it. Substituted at render like a prompt.
        derived_rails={
            "completion_query": {
                "label": "<<RUN_LABEL>>",
                "exclude_column_type": "done",
            }
        },
    ),
)
