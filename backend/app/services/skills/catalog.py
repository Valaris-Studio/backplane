# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The starter skill catalog.

Catalog entries are CODE, not seed rows: they ship with the app, version with
it, and are never written to the database. Activation copies an entry into a
workspace as an already-published version 1 — after that the workspace copy is
independent and the catalog holds no reference to it.

Every entry is a valid SKILL.md bundle under the open standard: `name` and
`description` frontmatter plus Backplane's one key, `toolsets` — the MCP hand
the playbook plays in. The catalog contract (tests) blocks an entry whose
prose names a tool outside its declared toolsets.
"""

from app.services.skills.catalog_entries import (
    agentic_board_setup,
    autonomous_run_monitoring,
    coding_principles,
    mcp_coordination_rulebook,
    plan_authoring,
    project_bootstrap,
    run_postmortem_audit,
    visual_testing,
)

# Re-exported so existing importers keep working after the split.
from app.services.skills.catalog_types import CatalogEntry, CatalogFile

__all__ = ["CatalogEntry", "CatalogFile", "SKILL_CATALOG", "get_catalog_entry"]


_COMMIT_MESSAGES = CatalogEntry(
    catalog_id="commit-message-conventions",
    catalog_version=2,
    name="Commit Message Conventions",
    description="Write commit messages that keep history searchable and reviews fast.",
    files=(
        CatalogFile(
            path="SKILL.md",
            content="""\
---
name: Commit Message Conventions
description: Write commit messages that keep history searchable and reviews fast.
toolsets: [work-management]
---

# Commit Message Conventions

Follow these rules for every commit you author.

## Subject line

1. Use the form `type(scope): summary` — for example `fix(auth): reject expired session cookies`.
2. Allowed types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `build`.
3. Scope is the module or feature area touched, lowercase, one word where possible.
4. Keep the subject at or under 72 characters, imperative mood ("add", not "added"), no trailing period.
5. Summarize the EFFECT of the change, not the activity. "fix(cards): stop drag from duplicating a card" beats "fix bug in drag handler".

## Body

1. Leave one blank line after the subject.
2. Explain WHY the change exists: the failure observed, the constraint honored, the alternative rejected. The diff already shows what changed.
3. Wrap body lines at roughly 72 characters.
4. Reference the tracking card or issue id on its own line at the end, e.g. `Card: 1a2b3c4d`.

## Splitting work

1. One logical change per commit. If the message needs "and", split the commit.
2. Never mix a refactor with a behavior change in one commit — the reviewer cannot separate them.
3. A pure rename or move gets its own commit so the diff stays readable.

## What to avoid

- Vague subjects: "fix stuff", "wip", "address review comments".
- Bodies that restate the diff line by line.
- Squashing unrelated fixes into a commit because they were on hand.
""",
        ),
    ),
)

_PR_DESCRIPTIONS = CatalogEntry(
    catalog_id="pr-description-conventions",
    catalog_version=2,
    name="PR Description Conventions",
    description="Structure pull request descriptions so a reviewer can verify intent, risk, and proof.",
    files=(
        CatalogFile(
            path="SKILL.md",
            content="""\
---
name: PR Description Conventions
description: Structure pull request descriptions so a reviewer can verify intent, risk, and proof.
toolsets: [work-management]
---

# PR Description Conventions

A pull request description is written for the reviewer first and the future
archaeologist second. Both need intent, risk, and proof — not a diff recap.

## Structure

Write these sections, in this order:

1. **What & why** — two to five sentences: the problem, the user-visible or
   system-visible effect of the fix, and why this approach over the obvious
   alternative if one exists.
2. **How** — only the non-obvious mechanics: new invariants, data migrations,
   ordering constraints, feature flags. Skip anything the diff makes plain.
3. **Testing** — the exact commands run and their outcomes, plus anything
   verified manually. "Tests pass" without the command is not proof.
4. **Risk & rollback** — what breaks if this is wrong, who notices, and how to
   revert (plain revert, or does a migration need a counterpart?).

## Rules

1. Link the tracking card or issue in the first line.
2. Keep the title under 72 characters and matching the merge commit subject.
3. Call out breaking changes and config changes in **bold** near the top.
4. If the PR includes a schema migration, state whether it is additive and
   rolling-deploy safe.
5. Screenshots or terminal output for any UI or CLI change.
6. If review must happen in a certain file order, say so.

## What to avoid

- Descriptions that paraphrase the commit list.
- "Misc fixes" bundles — split them.
- Leaving CI failures unexplained, even flaky ones.
""",
        ),
    ),
)

_BOARD_HYGIENE = CatalogEntry(
    catalog_id="board-hygiene-for-agents",
    catalog_version=2,
    name="Board Hygiene for Agents",
    description="Keep a kanban board a truthful, current record of the work while acting on it.",
    files=(
        CatalogFile(
            path="SKILL.md",
            content="""\
---
name: Board Hygiene for Agents
description: Keep a kanban board a truthful, current record of the work while acting on it.
toolsets: [work-management, knowledge-content]
---

# Board Hygiene for Agents

The board is the durable memory of the project. If something you did or
learned is not on the board, it did not happen. Act accordingly.

## Claiming and moving cards

1. Claim a card before working on it: move it to the in-progress column and
   add yourself as a participant. Never work on an unclaimed card.
2. Move cards THROUGH columns in order — never teleport a card straight to
   done. The column history is the audit trail.
3. One card in progress per agent at a time. Finish or park before claiming
   the next.

## Writing back

1. Comment on the card when you start, when you finish, and whenever the plan
   changes — include concrete artifacts: branch names, PR links, test output.
2. Record decisions where they were made. A decision that lives only in a
   chat thread is lost; copy the conclusion onto the card.
3. When blocked, say so ON THE CARD: what you tried, what you need, who can
   unblock. Then park it — do not sit on a blocked card silently.

## Card quality

1. Keep the card description current: if scope changed, edit it, and note
   what changed and why in a comment.
2. Split a card the moment it holds two independent deliverables.
3. Before closing, verify the acceptance criteria line by line and state the
   evidence for each in a closing comment.

## What to avoid

- Closing a card without linking the artifact that satisfies it.
- Creating duplicate cards instead of searching first.
- Letting a card's title drift from what is actually being done.
""",
        ),
        CatalogFile(
            path="references/checklists.md",
            content="""\
# Quick checklists

## Before claiming
- [ ] Card is unclaimed and its prerequisites are done
- [ ] I understand the acceptance criteria
- [ ] No duplicate card exists

## Before closing
- [ ] Acceptance criteria verified, evidence linked
- [ ] Artifacts (PR, docs, notes) linked on the card
- [ ] Follow-up work captured as new cards, not left implicit
""",
        ),
    ),
)

_RELEASE_CHECKLIST = CatalogEntry(
    catalog_id="release-checklist",
    catalog_version=2,
    name="Release Checklist",
    description="A pre-flight and post-flight outline for shipping a release safely.",
    files=(
        CatalogFile(
            path="SKILL.md",
            content="""\
---
name: Release Checklist
description: A pre-flight and post-flight outline for shipping a release safely.
toolsets: [work-management]
---

# Release Checklist

Work through this outline top to bottom for every release. Skipping a step is
a decision — record it and its reason, don't just omit it.

## Before the release

1. Confirm the release branch or tag points at the exact commit you verified.
   Re-run the full test suite AT that commit, not near it.
2. Read the diff since the last release end to end. Every schema migration in
   it must be additive and safe under a rolling deploy.
3. Take a backup or snapshot of anything the release mutates (database,
   object storage layout) and note the restore command next to it.
4. Verify configuration for the target environment: new env vars set,
   secrets present, feature flags in their intended launch position.
5. Write the release notes now, while the diff is fresh: user-facing changes,
   operational changes, and explicit rollback steps.
6. Announce the window to whoever is on the receiving end.

## Shipping

1. Deploy to the smallest real environment first and run the smoke skeleton:
   log in, exercise one write path, one read path, one background job.
2. Watch error rates and latency for at least ten minutes before widening.
3. Ship the remaining surface only after the first slice is verifiably quiet.

## After the release

1. Verify the deployed version identifier matches the tag everywhere.
2. Run the post-deploy checks: migrations applied, queues draining, no new
   error classes in the logs.
3. Close the release card with links: tag, build, notes, backup id.
4. If anything was rolled back or hot-fixed, write the incident note the same
   day — memory of the details does not survive the week.

## Rollback triggers

Roll back immediately, without debate, if any of these appear:
- Error rate above the pre-release baseline and climbing.
- A migration that old code cannot run against.
- Login, payment, or data-write paths failing for any tenant.
""",
        ),
    ),
)

SKILL_CATALOG: tuple[CatalogEntry, ...] = (
    _COMMIT_MESSAGES,
    _PR_DESCRIPTIONS,
    _BOARD_HYGIENE,
    _RELEASE_CHECKLIST,
    mcp_coordination_rulebook.ENTRY,
    project_bootstrap.ENTRY,
    agentic_board_setup.ENTRY,
    autonomous_run_monitoring.ENTRY,
    run_postmortem_audit.ENTRY,
    plan_authoring.ENTRY,
    coding_principles.ENTRY,
    visual_testing.ENTRY,
)

_BY_ID = {entry.catalog_id: entry for entry in SKILL_CATALOG}


def get_catalog_entry(catalog_id: str) -> CatalogEntry | None:
    return _BY_ID.get(catalog_id)
