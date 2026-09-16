# Auto-Merge Loop — Operator Reference

> **Status: Superseded and non-authoritative (2026-08-16).** The runner no
> longer arms GitHub auto-merge through `enable_auto_merge`; that lifecycle kind
> is a compatibility no-op. Current pipelines use `merge_pr`, optionally routed
> through `merge_via_queue`. See `docs/loop-mode-contract.md` and the lifecycle
> kind catalog. The material below is retained only as historical context.

How Backplane runners ship code end-to-end without a human tick on GitHub. What
gets configured, where, and what fails if it's missing.

## The loop

```
the runner clones repo
   ↓
EnsureBranchProtection applies baseline policy on default branch
   ↓
implementer opens PR (push → gh pr create)
   ↓
CI workflow runs on PR branch — publishes check named "ci"
   ↓
the runner runs gh pr merge <url> --auto --squash  (arms against the check)
   ↓
CI goes green → GitHub auto-merges the PR
   ↓
reviewer LLM posts decision as a comment + platform note (no GitHub review API call)
```

The loop does **not** use GitHub's formal review API. A single `gh` identity
can't approve its own PR (`Can not approve your own pull request`), and we
refuse to require a second PAT from operators. The merge gate is therefore
**status checks**, not approvals — a concept every major git host supports.

## What the runner configures automatically

On first clone of a linked repo with `require_branch_protection=true` (the
backend default), `git.Manager.EnsureBranchProtection` applies this
policy to the default branch via `gh api PUT`:

```json
{
  "required_status_checks": {"strict": true, "contexts": ["ci"]},
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null
}
```

Key points:
- `required_approving_review_count: 0` — no human or bot approval needed.
- `required_status_checks.contexts: ["ci"]` — one status check must pass.
  The context name is **hardcoded to `"ci"`** today (see [Gotchas](#gotchas)).
- `strict: true` — branch must be up-to-date with base before merging.
- The policy is idempotent: re-applying each tick is a no-op when unchanged.
- JSON body sent via `gh api --input -` (not `-F` flags). `-F restrictions=`
  trips GitHub's schema with HTTP 422 — `anyOf` wants a typed object or
  `null`, not empty string.

## What the operator must configure (today)

Two one-shot setup steps per repo — future work folds them into the runner:

### 1. Enable repo-level auto-merge

GitHub refuses `pr merge --auto` unless the repo allows it:

```bash
gh api -X PATCH repos/<owner>/<repo> -F allow_auto_merge=true
```

Or via UI: **Settings → Pull Requests → Allow auto-merge**.

Without this, the runner's arming attempt fails with:
`GraphQL: Pull request Auto merge is not allowed for this repository (enablePullRequestAutoMerge)`.

### 2. Ship a CI workflow publishing a check named `ci`

The status-check context is hardcoded to `"ci"`. For a Python/pytest repo:

```yaml
# .github/workflows/ci.yml
name: ci

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install -e . pytest
      - run: pytest -q
```

The job name (`ci:`) becomes the status-check context. Must match what
branch protection is gated on. If you rename the job, branch protection
won't arm — `--auto` waits forever.

**pytest exits 5 when zero tests are collected.** If the repo is scaffolding
without tests yet, add a sanity test (`def test_scaffold(): assert True`) so
the initial CI run can go green and register the context with GitHub.

## Gotchas

### `allow_auto_merge` is a silent no-op on free-plan private repos

`PATCH /repos/{owner}/{repo}` with `{"allow_auto_merge": true}` returns
**HTTP 200 while the stored value stays `false`** on private repos under the
GitHub Free plan — auto-merge (like branch protection) is plan-gated there,
and the API acknowledges the write without applying it. There is no error to
catch; the only tell is reading the setting back. This cost a real field run
(field report 2026-08-07) operator + runner diagnosis time: `gh pr merge --auto`
kept failing with "auto merge is not allowed" on a repo that had seemingly
just enabled it.

If you are on a free-plan private repo, don't fight this: use the platform's
own merge queue (`enqueue_for_merge` → server-side merge executor), which
performs a real rebase + merge on any plan and never depends on
`allow_auto_merge` or branch protection. See `docs/loop-mode-contract.md`
(loop landing) and the merge-queue section of the pipeline docs.

### Self-approval refusal

A single `gh` identity cannot approve its own PR:
`GraphQL: Review Can not approve your own pull request (addPullRequestReview)`.

This is why:
- `Git.ReviewMode` defaults to `"platform"` (comment-only reviews).
- Branch protection has `required_approving_review_count: 0`.
- The merge gate is status checks, not reviews.

If you set `Git.ReviewMode: "github"` anyway, the runner will call
`gh pr review --approve` and log a WARN. The PR stays open; `--auto` can't
arm (no blockers to wait for).

### Status-check context name

Hardcoded to `"ci"` in `runner/internal/git/git.go` — see the TODO at the
top of `branchProtectionRequest`. If the operator's CI job publishes under
a different name (e.g. `pytest`, `build`, `test`), auto-merge won't arm.
Backend-configurable version is tracked but not shipped.

### First CI run registers the context

Before the first successful CI run on `main`, the `"ci"` status-check
context doesn't exist on the repo yet. Branch protection referencing a
non-existent context is still valid — but PRs can't merge because the
"check must pass" predicate is unsatisfiable. Fix: run CI on `main` once
before seeding runner cards (push a scaffold commit that triggers CI).

### Arming happens once

Intern attempts `gh pr merge --auto --squash` once after pushing the
implementer's branch. If that call fails (transient config mismatch, repo
setting not yet flipped, etc.), the next tick on the same card does NOT
re-attempt arming — the card has already moved past the implementer stage.
The PR sits open while the card sits in Done.

Workaround: arm manually (`gh pr merge <url> --auto --squash`) once the
blocker is fixed. Permanent fix is tracked as a T2.5 followup — reviewer
tick should check `autoMergeRequest` and re-arm if null.

### Direct-merge fallback was removed

When `--auto` fails, the runner does NOT fall back to a direct `gh pr merge`
(T2.3, commit `25fcb3c`). Rationale: a direct merge bypasses branch
protection entirely, defeating the whole review/CI gate. Failure is logged
and the PR stays open — human or follow-up tick resolves it.

### Full-replace overwrites stricter manual rules

`gh api PUT .../protection` replaces the whole policy on every call. If an
operator hand-adds `required_approving_review_count: 2` via the GitHub UI,
the runner's next tick resets it to `0`. Document your stricter policy in
runner config if you need it; don't layer via UI.

## Verification

Run the Alpha smoke test (`runner/configs/alpha-validation.yaml`) against
a fresh repo. Expected observable signals, in order:

| Signal | Where | Meaning |
|---|---|---|
| `ensured branch protection` INFO | runner stderr | Policy applied on first clone |
| PR opened | GitHub | implementer pushed |
| CI run on PR branch | GitHub Actions tab | Workflow triggered |
| `pr merge ... --auto --squash` DEBUG | runner stderr | Arming attempted |
| `autoMergeRequest: {…}` | `gh pr view <url>` | Arming succeeded |
| CI status `SUCCESS` | PR UI | Check passed |
| `mergedAt` populated | `gh pr view <url>` | PR auto-merged |

If `--auto` arming fails, the WARN message in runner stderr names the exact
GraphQL error — use it to identify which setup step is missing (repo-level
auto-merge, branch protection, check context).

## Provider neutrality

The loop is provider-neutral by design even though today's implementation
uses `gh`. Conceptual mapping for future provider abstraction (T1.4):

| Concept | GitHub | GitLab | Bitbucket |
|---|---|---|---|
| Branch protection | `branch-protection` API | `protected_branches` API | `branch-restrictions` API |
| Required status check | `required_status_checks.contexts` | `approvals_before_merge` on pipeline success | `merge_checks.minimum_successful_builds` |
| Auto-merge when checks pass | `gh pr merge --auto` | `merge_when_pipeline_succeeds` | Build-status-gated merges |

None of these require a second identity. When T1.4 lands, the policy shape
(status-checks-gated, zero approvals) ports mechanically.

## Related code

- `runner/internal/git/git.go` — `EnsureBranchProtection`, `branchProtectionRequest`
- `runner/internal/workloop/strategy_generic.go` — `shouldEnsureBranchProtection` gate, `ensureBranchProtectionIfConfigured` dispatch
- `runner/internal/workloop/loop.go` — `newDiscoverResultFromRepo` constructor (propagates `RequireBranchProtection` through all 4 seed sites)
- `backend/app/models/git_repo.py` — `require_branch_protection` column (default `True`, `server_default='true'`)
- `backend/alembic/versions/044_add_git_repo_branch_protection_flag.py`
