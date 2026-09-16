// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Manager handles git operations for the runner.
// The runner's Go binary owns git directly (clone, branch, push, PR)
// rather than delegating to the LLM, because git state management
// needs deterministic control — not LLM judgment calls.
type Manager struct {
	BaseDir       string // Root directory where repos are cloned.
	DefaultRemote string // Git remote name (typically "origin").
	BranchPrefix  string // Prefix for runner-created branches (e.g., "runner/").
	RoleToken     string // When set, injected as GH_TOKEN into gh/git subprocess env.
}

// CloneOrOpen clones a remote repo into BaseDir/name, or opens it if already cloned.
// Returns the local repo directory path.
func (m *Manager) CloneOrOpen(ctx context.Context, remoteURL, name string) (string, error) {
	repoDir := filepath.Join(m.BaseDir, name)

	if isGitRepo(repoDir) {
		slog.Debug("repo already exists, fetching", "dir", repoDir)
		// --prune: a branch deleted on the remote must not survive here as a
		// remote-tracking ref. --force-with-lease derives its lease from that
		// ref, so a stale one rejects the next push with "(stale info)" only
		// AFTER the implement pass has run — a wasted paid tick per occurrence.
		if _, err := m.git(ctx, repoDir, "fetch", "--prune", m.remote()); err != nil {
			// The dir looked like a repo but the fetch failed — most often a
			// subtly corrupt clone (e.g. a missing pack/ref) that rev-parse
			// can't catch. Discard and re-clone rather than stranding the card.
			slog.Warn("fetch failed on existing repo, re-cloning", "dir", repoDir, "error", err)
			if rmErr := os.RemoveAll(repoDir); rmErr != nil {
				return "", fmt.Errorf("removing corrupt repo %s after fetch failure (%v): %w", name, err, rmErr)
			}
		} else {
			return repoDir, nil
		}
	} else if _, err := os.Stat(repoDir); err == nil {
		// A directory exists at the target path but is not a valid git repo
		// (corrupt .git, or unrelated leftover). `git clone` refuses a
		// non-empty destination, so clear it first to recover automatically.
		slog.Warn("stale non-repo dir at clone target, removing before clone", "dir", repoDir)
		if rmErr := os.RemoveAll(repoDir); rmErr != nil {
			return "", fmt.Errorf("removing stale dir %s before clone: %w", name, rmErr)
		}
	}

	slog.Info("cloning repo", "remote", remoteURL, "dir", repoDir)
	if _, err := m.git(ctx, "", "clone", remoteURL, repoDir); err != nil {
		return "", fmt.Errorf("cloning %s: %w", remoteURL, err)
	}

	return repoDir, nil
}

// FetchAndResetDefault refreshes the local default branch from origin.
// It fetches the branch, checks it out, and hard-resets to origin/<branch>.
// Any local commits on <defaultBranch> that aren't on origin are discarded —
// the harness never accumulates work on the default branch locally, so this
// is the desired behavior (a warning is logged if the reset rewinds commits).
// Returns the underlying error on fetch/checkout failure — callers should
// treat this as transient (network/auth blip) and retry the tick.
func (m *Manager) FetchAndResetDefault(ctx context.Context, repoDir, defaultBranch string) error {
	if _, err := m.git(ctx, repoDir, "fetch", m.remote(), defaultBranch); err != nil {
		return fmt.Errorf("fetching %s/%s: %w", m.remote(), defaultBranch, err)
	}

	if _, err := m.git(ctx, repoDir, "checkout", defaultBranch); err != nil {
		return fmt.Errorf("checkout %s: %w", defaultBranch, err)
	}

	// Detect rewound local commits so we can warn before discarding them.
	// Best-effort: if the rev-list query fails we still proceed with the reset.
	remoteRef := m.remote() + "/" + defaultBranch
	if ahead, err := m.git(ctx, repoDir, "rev-list", "--count", remoteRef+".."+defaultBranch); err == nil {
		if n := strings.TrimSpace(ahead); n != "" && n != "0" {
			slog.Warn("FetchAndResetDefault discarding local commits on default branch",
				"branch", defaultBranch, "discarded_commits", n)
		}
	}

	if _, err := m.git(ctx, repoDir, "reset", "--hard", remoteRef); err != nil {
		return fmt.Errorf("reset --hard %s: %w", remoteRef, err)
	}

	return nil
}

// CheckoutIntegrationHead positions the working tree on the integration HEAD —
// the default branch as it currently exists on origin. It is the post-merge
// audit counterpart to CheckoutBranch (which deliberately keeps a frozen PR
// branch for pre-merge review): a post-merge auditor (e.g. ui_validator on a
// DONE card) must validate what SHIPS, which is main HEAD = the card's own work
// PLUS every fix merged after it — never the merge-time PR branch, which is
// frozen and missing later fixes (the phantom-fix-card root cause).
//
// It first removes build artifacts (a reused board clone may carry a prior
// card's residue that would block the checkout), then fetch + checkout +
// reset --hard origin/<default>. The error is propagated, never swallowed:
// if we cannot position on integration HEAD the audit would run against a
// stale/wrong tree, so the caller must hard-fail the stage rather than file
// findings against code that doesn't ship.
func (m *Manager) CheckoutIntegrationHead(ctx context.Context, repoDir, defaultBranch string) error {
	m.cleanArtifacts(ctx, repoDir)
	return m.FetchAndResetDefault(ctx, repoDir, defaultBranch)
}

// CreateBranch creates and checks out a new branch.
// Before creating the branch, it refreshes the local default from origin
// (see FetchAndResetDefault) — new branches always fork from the latest
// origin ref, never from a stale local HEAD. This eliminates the class of
// collisions where two concurrent agents both fork from the same pre-update
// commit.
// If the branch already exists (from a prior failed attempt), it checks out the
// existing branch. A branch carrying commits from a prior attempt is PRESERVED
// (the commit is the card's work — resetting it makes a post-commit failure
// re-implement from zero forever); only a branch with no commits ahead of
// defaultBranch is reset to give a clean slate.
// Applies BranchPrefix if not already present.
// Returns the full branch name and whether recovery was needed (branch pre-existed).
// When recovered=true, the remote may still have old commits so the caller
// should use ForceWithLeasePush instead of Push.
// Side effect: discards any uncommitted changes on the default branch when
// refreshing. Safe in the harness because CreateBranch is only called on
// fresh clones or after ResetToDefault.
func (m *Manager) CreateBranch(ctx context.Context, repoDir, name, defaultBranch string) (branch string, recovered bool, err error) {
	branch = m.prefixedBranch(name)

	if err := m.FetchAndResetDefault(ctx, repoDir, defaultBranch); err != nil {
		return "", false, fmt.Errorf("refreshing %s before branch: %w", defaultBranch, err)
	}

	if _, err := m.git(ctx, repoDir, "checkout", "-b", branch); err != nil {
		if !strings.Contains(err.Error(), "already exists") {
			return "", false, fmt.Errorf("creating branch %s: %w", branch, err)
		}

		slog.Warn("branch already exists, recovering", "branch", branch)
		if _, err := m.git(ctx, repoDir, "checkout", branch); err != nil {
			return "", false, fmt.Errorf("checking out existing branch %s: %w", branch, err)
		}
		// A pre-existing branch may carry a VALID commit from a prior attempt
		// that failed downstream (e.g. the implement LLM committed 1091 lines,
		// then the pass errored after commit). Hard-resetting to default here
		// destroys that work, so the retry re-implements from zero and — for a
		// card that keeps failing post-commit — never converges (M7-03 burned
		// ~$30 across 5 passes this way). Only reset a branch that is NOT ahead
		// of default (truly stale/empty); otherwise keep the commit and let the
		// caller ForceWithLeasePush it so the downstream clean-tree+ahead path
		// ships it to review.
		ahead, aheadErr := m.CommitsAhead(ctx, repoDir, defaultBranch)
		if aheadErr != nil {
			slog.Warn("recovery: could not count commits ahead; preserving branch to avoid discarding work",
				"branch", branch, "error", aheadErr)
			ahead = 1 // fail safe: assume there may be work, do NOT reset
		}
		if ahead > 0 {
			slog.Info("recovered branch with prior commits — preserving", "branch", branch, "commits_ahead", ahead, "dir", repoDir)
			return branch, true, nil
		}
		if _, err := m.git(ctx, repoDir, "reset", "--hard", defaultBranch); err != nil {
			return "", false, fmt.Errorf("resetting branch %s to %s: %w", branch, defaultBranch, err)
		}
		slog.Info("recovered branch (no prior commits, reset to default)", "branch", branch, "dir", repoDir)
		return branch, true, nil
	}

	// New local branch created successfully (from base). Check if the remote
	// already has this branch from a prior attempt — the caller needs to know so
	// it can use force-with-lease push instead of regular push.
	lsOut, lsErr := m.git(ctx, repoDir, "ls-remote", "--heads", m.remote(), branch)
	if lsErr == nil && strings.TrimSpace(lsOut) != "" {
		slog.Warn("remote branch already exists, recovering its work", "branch", branch)
		// The local branch we just cut sits at BASE, but the remote branch may
		// carry pushed work — most importantly a budget-suspend WIP checkpoint
		// committed+pushed by a prior pass on a now-discarded clone. Leaving the
		// tree at base would make a resume re-implement from zero, re-burning the
		// budget the suspend saved. Fetch the remote branch and fast-forward the
		// local branch onto it so the working tree carries the prior work. Mirror
		// the local-recovery guard: only adopt remote HEAD when it is ahead of
		// base (real work); a remote branch identical to base resets to base.
		if _, ferr := m.git(ctx, repoDir, "fetch", m.remote(), branch); ferr != nil {
			slog.Warn("recovery: fetch of remote branch failed; tree stays at base", "branch", branch, "error", ferr)
			return branch, true, nil
		}
		// How far the fetched remote tip is ahead of base: <base>..FETCH_HEAD.
		// >0 means the remote branch carries real work (a suspend WIP checkpoint
		// or a prior post-commit pass). Identical to base → nothing to adopt,
		// leave the local branch at base.
		remoteAhead := 0
		if out, rlErr := m.git(ctx, repoDir, "rev-list", "--count", defaultBranch+"..FETCH_HEAD"); rlErr != nil {
			slog.Warn("recovery: could not measure remote branch work; adopting it to avoid discarding a checkpoint",
				"branch", branch, "error", rlErr)
			remoteAhead = 1 // fail-safe: assume work present, do NOT discard
		} else if n, convErr := strconv.Atoi(strings.TrimSpace(out)); convErr == nil {
			remoteAhead = n
		}
		if remoteAhead > 0 {
			if _, rerr := m.git(ctx, repoDir, "reset", "--hard", "FETCH_HEAD"); rerr != nil {
				slog.Warn("recovery: reset to remote WIP failed; tree stays at base", "branch", branch, "error", rerr)
				return branch, true, nil
			}
			slog.Info("recovered remote branch with prior work — adopted its HEAD", "branch", branch, "commits_ahead", remoteAhead, "dir", repoDir)
		}
		return branch, true, nil
	}

	slog.Info("created branch", "branch", branch, "dir", repoDir)
	return branch, false, nil
}

// CheckoutBranch fetches and checks out an existing remote branch.
// Used by the reviewer to switch to a PR branch after cloning.
func (m *Manager) CheckoutBranch(ctx context.Context, repoDir, branch string) error {
	// Fetch latest to ensure remote branch is available. --prune drops refs for
	// branches the forge has since deleted (e.g. a merged PR's branch).
	if _, err := m.git(ctx, repoDir, "fetch", "--prune", m.remote()); err != nil {
		return fmt.Errorf("fetching before checkout: %w", err)
	}

	// Remove build artifacts that would block checkout ("untracked files would be overwritten").
	m.cleanArtifacts(ctx, repoDir)

	// Try local checkout first (branch may already exist locally).
	if _, err := m.git(ctx, repoDir, "checkout", branch); err != nil {
		// Fall back to creating a tracking branch from remote.
		if _, err := m.git(ctx, repoDir, "checkout", "-b", branch, m.remote()+"/"+branch); err != nil {
			return fmt.Errorf("checking out %s: %w", branch, err)
		}
	}

	slog.Info("checked out branch", "branch", branch, "dir", repoDir)
	return nil
}

// CurrentBranch returns the name of the currently checked-out branch.
func (m *Manager) CurrentBranch(ctx context.Context, repoDir string) (string, error) {
	out, err := m.git(ctx, repoDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", fmt.Errorf("getting current branch: %w", err)
	}
	return strings.TrimSpace(out), nil
}

// HasChanges returns true if the working tree has uncommitted changes
// (tracked modifications, untracked files, or staged changes).
func (m *Manager) HasChanges(ctx context.Context, repoDir string) (bool, error) {
	out, err := m.git(ctx, repoDir, "status", "--porcelain")
	if err != nil {
		return false, fmt.Errorf("checking status: %w", err)
	}
	return strings.TrimSpace(out) != "", nil
}

// CommitsAhead returns how many commits the currently-checked-out HEAD
// has ahead of `base`. Used by the rework flow to distinguish
// "branch contains the fix already — just needs the reviewer to re-run"
// from "branch is truly empty and the executor made no progress."
//
// If the base ref can't be resolved (e.g. `origin/main` missing because
// the remote hasn't been fetched), the call returns 0, nil — we
// intentionally don't propagate the error because this is a best-effort
// heuristic feeding circuit-breaker logic, not a correctness gate.
func (m *Manager) CommitsAhead(ctx context.Context, repoDir, base string) (int, error) {
	out, err := m.git(ctx, repoDir, "rev-list", "--count", base+"..HEAD")
	if err != nil {
		return 0, nil
	}
	n := strings.TrimSpace(out)
	if n == "" {
		return 0, nil
	}
	count, convErr := strconv.Atoi(n)
	if convErr != nil {
		return 0, fmt.Errorf("parsing rev-list count %q: %w", n, convErr)
	}
	return count, nil
}

// CommitsAheadOfRemoteDefault returns commits ahead of origin/<defaultBranch>,
// the concrete case the rework flow cares about. Thin wrapper around
// CommitsAhead that resolves the remote-tracking ref internally so callers
// don't need to know the remote name.
func (m *Manager) CommitsAheadOfRemoteDefault(ctx context.Context, repoDir, defaultBranch string) (int, error) {
	return m.CommitsAhead(ctx, repoDir, m.remote()+"/"+defaultBranch)
}

// CommitAll stages all changes and commits with the given message.
// Returns an error if there are no changes to commit.
// Ensures a .gitignore exists before staging to prevent committing
// build artifacts like __pycache__, .pyc files, etc.
func (m *Manager) CommitAll(ctx context.Context, repoDir, message string) error {
	has, err := m.HasChanges(ctx, repoDir)
	if err != nil {
		return err
	}
	if !has {
		return fmt.Errorf("no changes to commit")
	}

	m.ensureGitignore(repoDir)

	if _, err := m.git(ctx, repoDir, "add", "-A"); err != nil {
		return fmt.Errorf("staging changes: %w", err)
	}

	if _, err := m.git(ctx, repoDir, "commit", "-m", message); err != nil {
		return fmt.Errorf("committing: %w", err)
	}

	slog.Info("committed", "message", message, "dir", repoDir)
	return nil
}

// Push pushes the current branch to the remote with --set-upstream.
func (m *Manager) Push(ctx context.Context, repoDir string) error {
	branch, err := m.CurrentBranch(ctx, repoDir)
	if err != nil {
		return err
	}

	if _, err := m.git(ctx, repoDir, "push", "-u", m.remote(), branch); err != nil {
		return fmt.Errorf("pushing %s: %w", branch, err)
	}

	slog.Info("pushed", "branch", branch, "remote", m.remote())
	return nil
}

// ResetToDefault checks out the default branch and pulls latest.
// Used between card executions to start from a clean state.
func (m *Manager) ResetToDefault(ctx context.Context, repoDir, defaultBranch string) error {
	m.cleanArtifacts(ctx, repoDir)

	if _, err := m.git(ctx, repoDir, "checkout", defaultBranch); err != nil {
		return fmt.Errorf("checking out %s: %w", defaultBranch, err)
	}

	if _, err := m.git(ctx, repoDir, "pull", m.remote(), defaultBranch); err != nil {
		return fmt.Errorf("pulling %s: %w", defaultBranch, err)
	}

	return nil
}

// Cleanup resets the repo to a clean state: discards uncommitted changes,
// checks out the default branch, and deletes the specified feature branch.
// Best-effort — errors are logged but do not fail the caller.
func (m *Manager) Cleanup(ctx context.Context, repoDir, featureBranch, defaultBranch string) {
	if _, err := m.git(ctx, repoDir, "checkout", "--", "."); err != nil {
		slog.Warn("cleanup: discard tracked changes failed", "error", err)
	}
	if _, err := m.git(ctx, repoDir, "clean", "-fd"); err != nil {
		slog.Warn("cleanup: remove untracked files failed", "error", err)
	}
	if _, err := m.git(ctx, repoDir, "checkout", defaultBranch); err != nil {
		slog.Warn("cleanup: checkout default branch failed", "branch", defaultBranch, "error", err)
	}
	if featureBranch != "" && featureBranch != defaultBranch {
		if _, err := m.git(ctx, repoDir, "branch", "-D", featureBranch); err != nil {
			slog.Warn("cleanup: delete branch failed", "branch", featureBranch, "error", err)
		}
	}
}

// WipeToHead discards everything in the working tree that is not committed on
// the CURRENT branch: tracked modifications (reset --hard HEAD) AND untracked
// files (clean -fd). It deliberately resets to HEAD — not to the default branch
// — so a card's own legitimately-committed work (incl. a recovered prior
// attempt) is preserved while cross-card residue is removed.
//
// This runs at STAGE ENTRY (before the implementer's LLM writes + the runner's
// `git add -A` commit) to close the shared-clone contamination hole: the runner
// reuses one clone per board, so a prior card's untracked files (e.g. a foreign
// pnpm-lock.yaml from an out-of-order build) would otherwise be swept into the
// next card's commit by `add -A`. The runner does this itself (outside the LLM
// sandbox, where reset --hard is deny-listed). Best-effort with hard errors:
// a failure here means the tree is NOT clean, so the caller must treat it as a
// setup failure rather than proceed and risk contamination.
func (m *Manager) WipeToHead(ctx context.Context, repoDir string) error {
	if _, err := m.git(ctx, repoDir, "reset", "--hard", "HEAD"); err != nil {
		return fmt.Errorf("wipe: reset --hard HEAD: %w", err)
	}
	if _, err := m.git(ctx, repoDir, "clean", "-fd"); err != nil {
		return fmt.Errorf("wipe: clean -fd: %w", err)
	}
	return nil
}

// CreatePR creates a pull request using the gh CLI.
// Returns the PR URL on success.
// If a PR already exists for this branch, extracts and returns the existing URL
// instead of failing — gh pr create embeds the URL in its stderr message.
//
// baseBranch is required. When empty, gh defaults to the GitHub repo's web-UI
// default branch (typically main), which silently breaks the integration_branch
// flow: the runner branches off integration_branch but the PR targets main, so
// the merge queue ends up merging into main even though the workspace is
// configured to land on integration_branch. Caller passes the same ref it
// resolved for CreateBranch (see workloop.resolveBaseRef).
func (m *Manager) CreatePR(ctx context.Context, repoDir, title, body, baseBranch string) (string, error) {
	args := []string{"pr", "create",
		"--title", title,
		"--body", body,
		"--fill=false",
	}
	if baseBranch != "" {
		args = append(args, "--base", baseBranch)
	}
	out, err := m.run(ctx, repoDir, "gh", args...)
	if err != nil {
		if url := extractExistingPRURL(err.Error()); url != "" {
			slog.Info("PR already exists, using existing", "url", url)
			return url, nil
		}
		return "", fmt.Errorf("creating PR: %w", err)
	}

	prURL := strings.TrimSpace(out)
	slog.Info("created PR", "url", prURL, "base", baseBranch)
	return prURL, nil
}

// extractExistingPRURL parses the "already exists" error from gh pr create.
// The stderr format is: "a pull request for branch "..." already exists:\nhttps://github.com/..."
// Returns the URL if found, empty string otherwise.
func extractExistingPRURL(errMsg string) string {
	marker := "already exists:"
	idx := strings.Index(errMsg, marker)
	if idx < 0 {
		return ""
	}
	rest := errMsg[idx+len(marker):]
	// Find the URL — scan for "https://" then take everything until whitespace or end.
	urlStart := strings.Index(rest, "https://")
	if urlStart < 0 {
		return ""
	}
	rest = rest[urlStart:]
	// Trim at first whitespace or newline.
	if end := strings.IndexAny(rest, " \t\n\r"); end >= 0 {
		rest = rest[:end]
	}
	return strings.TrimSpace(rest)
}

// ForceWithLeasePush pushes with --force-with-lease for rework scenarios.
// Safety: refuses to force-push main or any branch without the configured prefix.
func (m *Manager) ForceWithLeasePush(ctx context.Context, repoDir string) error {
	branch, err := m.CurrentBranch(ctx, repoDir)
	if err != nil {
		return err
	}

	if branch == "main" || branch == "master" {
		return fmt.Errorf("refuse to force-push protected branch %q", branch)
	}
	if m.BranchPrefix != "" && !strings.HasPrefix(branch, m.BranchPrefix) {
		return fmt.Errorf("refuse to force-push branch %q without prefix %q", branch, m.BranchPrefix)
	}

	if _, err := m.git(ctx, repoDir, "push", "--force-with-lease", "-u", m.remote(), branch); err != nil {
		return fmt.Errorf("force-with-lease push %s: %w", branch, err)
	}

	slog.Info("force-with-lease pushed", "branch", branch, "remote", m.remote())
	return nil
}

// SquashOnto collapses all commits on the current branch into a single commit
// relative to the base branch. Used during rework to prevent commit accumulation.
// Safety: refuses to operate on main/master.
func (m *Manager) SquashOnto(ctx context.Context, repoDir, baseBranch, message string) error {
	branch, err := m.CurrentBranch(ctx, repoDir)
	if err != nil {
		return err
	}

	if branch == "main" || branch == "master" {
		return fmt.Errorf("refuse to squash on protected branch %q", branch)
	}

	// Soft reset to base: un-commits all branch-specific changes but keeps them staged.
	if _, err := m.git(ctx, repoDir, "reset", "--soft", "origin/"+baseBranch); err != nil {
		return fmt.Errorf("reset --soft origin/%s: %w", baseBranch, err)
	}

	// Re-stage everything (handles any edge cases from soft reset).
	if _, err := m.git(ctx, repoDir, "add", "-A"); err != nil {
		return fmt.Errorf("staging after reset: %w", err)
	}

	// Check there's something to commit.
	has, err := m.HasChanges(ctx, repoDir)
	if err != nil {
		return err
	}
	if !has {
		return fmt.Errorf("no changes after squash onto %s", baseBranch)
	}

	// Single squashed commit.
	if _, err := m.git(ctx, repoDir, "commit", "-m", message); err != nil {
		return fmt.Errorf("squash commit: %w", err)
	}

	slog.Info("squashed onto base", "base", baseBranch, "message", message, "dir", repoDir)
	return nil
}

// ReviewPR submits a GitHub PR review via the gh CLI.
// decision must be one of: "approve", "request-changes", "comment".
// Body is piped via stdin (--body-file -) to avoid shell argument length limits.
func (m *Manager) ReviewPR(ctx context.Context, repoDir, prURL, decision, body string) error {
	validDecisions := map[string]bool{"approve": true, "request-changes": true, "comment": true}
	if !validDecisions[decision] {
		return fmt.Errorf("invalid review decision %q (want approve, request-changes, or comment)", decision)
	}

	args := []string{"pr", "review", prURL, "--" + decision}
	if body != "" {
		args = append(args, "--body-file", "-")
		if _, err := m.runWithStdin(ctx, repoDir, body, "gh", args...); err != nil {
			return fmt.Errorf("reviewing PR %s: %w", prURL, err)
		}
	} else {
		if _, err := m.run(ctx, repoDir, "gh", args...); err != nil {
			return fmt.Errorf("reviewing PR %s: %w", prURL, err)
		}
	}

	slog.Info("submitted PR review", "url", prURL, "decision", decision)
	return nil
}

// CommentPR posts an informational comment on a GitHub PR via gh CLI.
// Used in platform review mode where Valaris owns review decisions and
// GitHub is just a display surface.
func (m *Manager) CommentPR(ctx context.Context, repoDir, prURL, body string) error {
	if body == "" {
		return nil
	}
	args := []string{"pr", "comment", prURL, "--body-file", "-"}
	if _, err := m.runWithStdin(ctx, repoDir, body, "gh", args...); err != nil {
		return fmt.Errorf("commenting on PR %s: %w", prURL, err)
	}
	slog.Info("posted PR comment", "url", prURL)
	return nil
}

// PRStatus holds the merge state of a GitHub PR.
type PRStatus struct {
	State            string // OPEN, MERGED, CLOSED
	MergeStateStatus string // CLEAN, DIRTY, BLOCKED, BEHIND, UNKNOWN, etc.
}

// CheckPRStatus queries a PR's merge state via gh CLI.
func (m *Manager) CheckPRStatus(ctx context.Context, repoDir, prURL string) (PRStatus, error) {
	out, err := m.run(ctx, repoDir, "gh", "pr", "view", prURL, "--json", "state,mergeStateStatus")
	if err != nil {
		return PRStatus{}, fmt.Errorf("checking PR status %s: %w", prURL, err)
	}
	return parsePRStatus(out, prURL)
}

// parsePRStatus extracts PRStatus from gh pr view JSON output.
func parsePRStatus(jsonOutput, prURL string) (PRStatus, error) {
	var result struct {
		State            string `json:"state"`
		MergeStateStatus string `json:"mergeStateStatus"`
	}
	if err := json.Unmarshal([]byte(jsonOutput), &result); err != nil {
		return PRStatus{}, fmt.Errorf("parsing PR status %s: %w", prURL, err)
	}
	return PRStatus{State: result.State, MergeStateStatus: result.MergeStateStatus}, nil
}

// PullRequestFiles is the projection of `gh pr list --json files,headRefName,number`
// that callers need today. Extended fields can be added without breaking
// consumers — they read the shape they know and ignore the rest.
type PullRequestFiles struct {
	Number      int
	HeadRefName string
	Files       []string
}

// ListOpenPRs returns open PRs with their changed file paths. repoSlug
// may be empty — `gh` will then auto-detect the repo from repoDir's
// remote. This is the one-stop wrapper so callers (notably the
// pr-overlap sensor) never shell to `gh` themselves; keeps all host-CLI
// surface area in this package ahead of the T1.4 GitHostProvider split.
func (m *Manager) ListOpenPRs(ctx context.Context, repoDir, repoSlug string) ([]PullRequestFiles, error) {
	args := []string{
		"pr", "list",
		"--state", "open",
		"--json", "files,headRefName,number",
		"--limit", "100",
	}
	if repoSlug != "" {
		args = append(args, "--repo", repoSlug)
	}
	out, err := m.run(ctx, repoDir, "gh", args...)
	if err != nil {
		return nil, fmt.Errorf("gh pr list: %w", err)
	}
	return parseOpenPRList(out)
}

// parseOpenPRList decodes gh's per-PR file list into the flat PullRequestFiles
// shape callers consume. Missing files arrays are tolerated (gh occasionally
// omits the field on PRs with zero file changes).
func parseOpenPRList(jsonOutput string) ([]PullRequestFiles, error) {
	var raws []struct {
		Number      int    `json:"number"`
		HeadRefName string `json:"headRefName"`
		Files       []struct {
			Path string `json:"path"`
		} `json:"files"`
	}
	if err := json.Unmarshal([]byte(jsonOutput), &raws); err != nil {
		return nil, fmt.Errorf("parsing open PR list: %w", err)
	}
	prs := make([]PullRequestFiles, 0, len(raws))
	for _, r := range raws {
		files := make([]string, 0, len(r.Files))
		for _, f := range r.Files {
			files = append(files, f.Path)
		}
		prs = append(prs, PullRequestFiles{
			Number:      r.Number,
			HeadRefName: r.HeadRefName,
			Files:       files,
		})
	}
	return prs, nil
}

// EnsureBranchProtection applies a status-checks-gated branch-protection
// policy on the given branch of the remote configured in repoDir. Idempotent:
// `gh api PUT` overwrites the existing rule with the same shape on every call.
//
// Policy: require the "ci" status check (strict mode — branch must be
// up-to-date), zero approving reviews required. Approvals are NOT required
// because runner runs as a single `gh` identity: the same bot opens the PR
// and would cast the approval, and GitHub refuses self-approval
// ("Can not approve your own pull request"). Gating auto-merge on status
// checks instead of reviews sidesteps that constraint and is also
// provider-neutral — GitLab's "only merge when pipeline succeeds" and
// Bitbucket's "merge checks" map to the same concept, so this survives the
// T1.4 GitHostProvider abstraction. Reviewer LLM remains an internal
// approve/request_changes gate but stops calling the host's review API.
//
// Status-check gating and review gating are independent on GitHub's side
// and coexist in the same PUT body (required_status_checks and
// required_pull_request_reviews are sibling fields). Operators wanting
// stricter rules can layer reviews on top via runner config, but be
// aware:
//
// FULL-REPLACE WARNING: `gh api PUT .../protection` replaces the entire
// policy on every call. If an operator hand-adds rules via the GitHub UI
// (e.g. required_approving_review_count=2, required_linear_history=true)
// the next runner tick resets them to the shape below. Pin stricter
// policy in runner config so it re-applies on every tick, not the UI.
//
// Today backed by gh's GitHub-only API. The signature stays provider-neutral
// (no owner/repo args — resolved from `git remote get-url origin`) so other
// providers can slot in later without rewiring callers.
//
// TODO(T2.5-followup): the "ci" context name is hardcoded. The
// backend-configurable version lives in git_repos.required_status_checks
// (array — GitHub allows multiple required contexts) and will be threaded
// through when that column lands; until then, repos must expose a check
// named exactly "ci". One hardcoded value + this TODO is honest; a
// configuration ladder here would be debt.
func (m *Manager) EnsureBranchProtection(ctx context.Context, repoDir, branch string) error {
	if branch == "" {
		return fmt.Errorf("EnsureBranchProtection: branch is required")
	}

	ownerRepo, err := m.ownerRepoFromRemote(ctx, repoDir)
	if err != nil {
		return fmt.Errorf("resolving origin for branch protection: %w", err)
	}

	args, body := branchProtectionRequest(ownerRepo, branch)
	if _, err := m.runWithStdin(ctx, repoDir, body, "gh", args...); err != nil {
		return fmt.Errorf("ensuring branch protection on %s of %s: %w", branch, ownerRepo, err)
	}

	slog.Info("ensured branch protection", "repo", ownerRepo, "branch", branch)
	return nil
}

// branchProtectionRequest builds the `gh api` args + JSON body for the
// status-checks-gated policy. Extracted so the policy shape is unit-testable
// without mocking exec. See EnsureBranchProtection for rationale on the
// policy choices.
//
// We send a JSON body via `gh api --input -` rather than `-F key=value` flags
// because several top-level fields on the branch-protection PUT schema
// (`restrictions`, `required_pull_request_reviews`) must be either a typed
// object or JSON null — and `-F key=` coerces to empty string, which trips
// the schema's `anyOf` validation with `"" is not an object / "" is not a
// null` (HTTP 422). A JSON body is the unambiguous way to express null.
func branchProtectionRequest(ownerRepo, branch string) (args []string, body string) {
	args = []string{
		"api",
		"--method", "PUT",
		fmt.Sprintf("repos/%s/branches/%s/protection", ownerRepo, branch),
		"--input", "-",
	}
	body = `{` +
		`"required_status_checks":{"strict":true,"contexts":["ci"]},` +
		`"enforce_admins":false,` +
		`"required_pull_request_reviews":{"required_approving_review_count":0,"dismiss_stale_reviews":true},` +
		`"restrictions":null` +
		`}`
	return args, body
}

// Cluster III: EnsureAutoMergeEnabled + allowAutoMergeRequest removed. The
// runner no longer arms GitHub auto-merge, so the proprietary repo-level
// `allow_auto_merge=true` toggle they flipped is dead. EnsureBranchProtection
// (a separate concern) keeps using ownerRepoFromRemote below.

// ownerRepoFromRemote extracts "owner/repo" from the origin URL of repoDir.
// Handles both https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git).
func (m *Manager) ownerRepoFromRemote(ctx context.Context, repoDir string) (string, error) {
	remote := m.DefaultRemote
	if remote == "" {
		remote = "origin"
	}
	out, err := m.run(ctx, repoDir, "git", "remote", "get-url", remote)
	if err != nil {
		return "", fmt.Errorf("reading remote %q: %w", remote, err)
	}
	return OwnerRepoFromURL(strings.TrimSpace(out))
}

// OwnerRepoFromURL parses "owner/repo" out of a git remote URL string, without
// touching a local clone. Handles https://host/owner/repo(.git) and
// git@host:owner/repo(.git). Callers that have a URL from the backend
// (e.g. GitRepo.URL returned by the API) can use this instead of shelling out
// to `git remote get-url`.
//
// Rejects single-segment inputs like "https://example/r" — those are invalid
// owner/repo slugs. Accepting them silently causes downstream `gh --repo r`
// shell-outs that fail at the CLI layer, flaking tests and masking real bugs.
func OwnerRepoFromURL(raw string) (string, error) {
	trimmed := strings.TrimSuffix(raw, ".git")
	var candidate string
	if idx := strings.Index(trimmed, "://"); idx >= 0 {
		rest := trimmed[idx+3:]
		if slash := strings.Index(rest, "/"); slash >= 0 {
			candidate = rest[slash+1:]
		}
	} else if colon := strings.Index(trimmed, ":"); colon >= 0 && !strings.Contains(trimmed[:colon], "/") {
		candidate = trimmed[colon+1:]
	}
	if candidate == "" {
		return "", fmt.Errorf("cannot parse owner/repo from remote URL %q", raw)
	}
	parts := strings.Split(candidate, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", fmt.Errorf("remote URL %q does not have owner/repo shape (got %q)", raw, candidate)
	}
	return candidate, nil
}

// Cluster III: IsAutoMergeArmed, parseAutoMergeArmed, and EnableAutoMerge were
// removed. The runner is git-provider-agnostic and never arms GitHub's
// proprietary auto-merge; the reviewer's MergePR after an approve verdict is
// the only merge path. The "no direct-merge fallback bypassing the reviewer"
// invariant those carried now lives entirely in MergePR.

// CurrentPRForBranch returns the URL of the open PR whose head is <branch>,
// or "" if there is none. Used as a stale-PR guard before merge: re-claimed
// cards accumulate branch/PR blocks in the description and extractPRURL walks
// top-down, returning the stale entry. This query consults GitHub directly.
func (m *Manager) CurrentPRForBranch(ctx context.Context, repoDir, branch string) (string, error) {
	out, err := m.run(ctx, repoDir,
		"gh", "pr", "list",
		"--head", branch,
		"--state", "open",
		"--json", "url",
		"--jq", ".[0].url",
	)
	if err != nil {
		return "", fmt.Errorf("gh pr list --head %s: %w", branch, err)
	}
	return strings.TrimSpace(out), nil
}

// PRBaseBranch returns the base branch name of the given PR (e.g., "main").
func (m *Manager) PRBaseBranch(ctx context.Context, repoDir, prURL string) (string, error) {
	out, err := m.run(ctx, repoDir,
		"gh", "pr", "view", prURL,
		"--json", "baseRefName",
		"--jq", ".baseRefName",
	)
	if err != nil {
		return "", fmt.Errorf("gh pr view %s: %w", prURL, err)
	}
	return strings.TrimSpace(out), nil
}

// RebaseOnBase rebases <branch> onto origin/<baseBranch> and force-pushes
// with --force-with-lease. Invoked by applyApproveMergeGate when GitHub
// reports "Base branch was modified" — the merge is re-attempted after the
// rebase resolves the divergence.
func (m *Manager) RebaseOnBase(ctx context.Context, repoDir, branch, baseBranch string) error {
	if _, err := m.git(ctx, repoDir, "fetch", m.remote(), baseBranch); err != nil {
		return fmt.Errorf("fetch %s/%s: %w", m.remote(), baseBranch, err)
	}
	if _, err := m.git(ctx, repoDir, "checkout", branch); err != nil {
		return fmt.Errorf("checkout %s: %w", branch, err)
	}
	if _, err := m.git(ctx, repoDir, "rebase", m.remote()+"/"+baseBranch); err != nil {
		return fmt.Errorf("rebase %s/%s: %w", m.remote(), baseBranch, err)
	}
	if _, err := m.git(ctx, repoDir, "push", "--force-with-lease"); err != nil {
		return fmt.Errorf("push --force-with-lease: %w", err)
	}
	return nil
}

// MergePR performs a direct (non-auto) merge on a PR.
// strategy: "squash" (default), "rebase", or "merge".
func (m *Manager) MergePR(ctx context.Context, repoDir, prURL, strategy string) error {
	if strategy == "" {
		strategy = "squash"
	}

	validStrategies := map[string]bool{"squash": true, "rebase": true, "merge": true}
	if !validStrategies[strategy] {
		return fmt.Errorf("invalid merge strategy %q (want squash, rebase, or merge)", strategy)
	}

	if _, err := m.run(ctx, repoDir, "gh", "pr", "merge", prURL, "--"+strategy, "--delete-branch"); err != nil {
		return fmt.Errorf("merge PR %s: %w", prURL, err)
	}

	slog.Info("merged PR", "url", prURL, "strategy", strategy)
	return nil
}

// artifactPatterns are common build/runtime artifacts that should never be committed.
// Used by ensureGitignore to seed a .gitignore when one doesn't exist.
var artifactPatterns = []string{
	"__pycache__/",
	"*.pyc",
	"*.pyo",
	".pytest_cache/",
	".mypy_cache/",
	".ruff_cache/",
	"node_modules/",
	".env",
	".venv/",
	"*.egg-info/",
}

// ensureGitignore creates a .gitignore at the repo root with common artifact
// exclusions if one does not already exist. Idempotent — never overwrites
// an existing .gitignore.
func (m *Manager) ensureGitignore(repoDir string) {
	gitignorePath := filepath.Join(repoDir, ".gitignore")

	if _, err := os.Stat(gitignorePath); err == nil {
		return // already exists
	}

	content := strings.Join(artifactPatterns, "\n") + "\n"
	if err := os.WriteFile(gitignorePath, []byte(content), 0644); err != nil {
		slog.Warn("failed to create .gitignore", "dir", repoDir, "error", err)
		return
	}
	slog.Info("created .gitignore with artifact exclusions", "dir", repoDir)
}

// cleanArtifacts removes known build artifact directories from the working tree.
// Prevents "untracked files would be overwritten" errors during checkout.
// Best-effort — failures are logged but not propagated.
func (m *Manager) cleanArtifacts(ctx context.Context, repoDir string) {
	artifactDirs := []string{"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules"}
	for _, dir := range artifactDirs {
		target := filepath.Join(repoDir, dir)
		if info, err := os.Stat(target); err == nil && info.IsDir() {
			if err := os.RemoveAll(target); err != nil {
				slog.Warn("cleanArtifacts: failed to remove", "dir", dir, "error", err)
			} else {
				slog.Debug("cleanArtifacts: removed", "dir", dir)
			}
		}
	}

	// Remove nested artifact dirs matching known patterns. Uses find+rm which is
	// faster than filepath.WalkDir on large repos with node_modules etc. because it
	// skips .git and prunes early.
	for _, pattern := range []string{"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"} {
		if _, err := m.run(ctx, repoDir, "find", ".", "-path", "./.git", "-prune", "-o",
			"-name", pattern, "-type", "d", "-exec", "rm", "-rf", "{}", "+"); err != nil {
			slog.Debug("cleanArtifacts: find+rm skipped", "pattern", pattern)
		}
	}
}

// git runs a git command in the given directory and returns stdout.
func (m *Manager) git(ctx context.Context, dir string, args ...string) (string, error) {
	return m.run(ctx, dir, "git", args...)
}

// gitAllowedProtocols is the transport allowlist pinned onto every git child.
// It closes the remote-helper class: `ext::sh -c <cmd>` makes git execute
// <cmd>, so a repo URL reaching git unvalidated is RCE. The backend rejects
// such URLs at the schema layer — this is the defence that still holds when a
// future ingress forgets to validate.
//
// `file` is included because the runner clones local mirrors (and the test
// harness clones bare repos from tmpdirs). Unlike ext::/fd:: it carries no
// code-execution primitive, so it costs nothing that this pin is buying.
const gitAllowedProtocols = "https:http:ssh:git:file"

// gitContextVars name the repository a git child operates on, outranking
// cmd.Dir entirely: with GIT_DIR set, git ignores the working directory and
// mutates the pointed-at repo instead. Git exports GIT_DIR itself inside hooks,
// so a runner launched from one inherits a live override for free — and a
// `reset --hard` aimed at a throwaway clone would land on someone's real
// repository. They are stripped rather than blanked because git treats a
// set-but-empty GIT_DIR as an override in its own right.
var gitContextVars = []string{
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_CEILING_DIRECTORIES",
}

// gitConfigVars let the ambient environment inject arbitrary git configuration.
// Where gitContextVars decide *which* repository git touches, these decide *what
// git runs*: the reachable prize is core.hooksPath, which has no env var of its
// own but is settable through the GIT_CONFIG_* family — point it at an
// attacker-writable directory and every `git commit` the runner makes executes
// an arbitrary pre-commit binary with the runner's credentials. GIT_SSH,
// GIT_SSH_COMMAND and GIT_EXTERNAL_DIFF are direct command hooks, and
// GIT_TEMPLATE_DIR plants hooks into every new clone.
//
// The GIT_CONFIG_* members are covered by prefix (see gitConfigPrefixes) rather
// than named here: that namespace is unbounded and has already proven it cannot
// be enumerated safely.
var gitConfigVars = []string{
	// No trailing underscore, so the GIT_CONFIG_ prefix does not cover it.
	"GIT_CONFIG",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_ASKPASS",
	"GIT_EXTERNAL_DIFF",
	"GIT_TEMPLATE_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	// Runs as the transport for git:// remotes, which gitAllowedProtocols
	// deliberately still permits.
	"GIT_PROXY_COMMAND",
	// Relocates the directory git loads its helper binaries from. Built-in
	// subcommands are compiled in and unaffected, but git-remote-https is a real
	// executable behind every https clone, fetch and push the runner makes.
	"GIT_EXEC_PATH",
	// The loader injects these into every child, git or gh, on Linux and on
	// macOS whenever the binary is unsigned — Homebrew's git is.
	"LD_PRELOAD",
	"DYLD_INSERT_LIBRARIES",
}

// gitConfigPrefixes close the config-injection namespace by construction. An
// enumerated list kept missing members: GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>
// take arbitrary indices, and GIT_CONFIG_PARAMETERS — git's internal transport
// for `-c` — reaches core.hooksPath with GIT_CONFIG_COUNT unset entirely, so
// gating on the counter is not enough. Matching the prefix also covers whatever
// a future git release adds to the family.
var gitConfigPrefixes = []string{
	"GIT_CONFIG_",
}

// SubprocessEnv builds a hardened environment for a git or gh child process,
// for callers outside this type: the harness sensors and the free-function
// isGitRepo cannot reach Manager.subprocessEnv, and inheriting os.Environ() at
// those sites let an ambient GIT_DIR decide which repository they read.
//
// ceilingDir bounds git's upward discovery walk. Pass the directory the command
// runs in, or its parent when the command must still be able to inspect that
// directory itself — a ceiling entry excludes itself and everything above from
// the walk, but the starting directory is always checked. An empty or relative
// value skips the pin: git ignores non-absolute ceiling entries silently, so a
// pin that lies is worse than none.
//
// Carries no role-scoped GH_TOKEN. An ambient one still passes through, so a
// caller needing role-scoped auth degrades to the ambient identity rather than
// failing loudly — use Manager for anything that must authenticate as the role.
func SubprocessEnv(ceilingDir string) []string {
	return hardenedEnv(ceilingDir, "")
}

// subprocessEnv builds the environment for every git/gh child process.
func (m *Manager) subprocessEnv() []string {
	return hardenedEnv(m.BaseDir, m.RoleToken)
}

// hardenedEnv is the single definition of a safe git environment. Ambient
// repository-discovery and config-injection vars are dropped first, then the
// runner's own values appended — exec resolves a duplicated key to its final
// occurrence, so appending last is what makes these beat anything that survived.
//
// Takes the ceiling and token explicitly rather than a *Manager so the exported
// entry point cannot pick up Manager semantics a future field might add.
func hardenedEnv(ceilingDir, roleToken string) []string {
	env := withoutKeys(os.Environ(), gitContextVars...)
	env = withoutKeys(env, gitConfigVars...)
	env = withoutPrefixes(env, gitConfigPrefixes...)
	if roleToken != "" {
		env = append(env, "GH_TOKEN="+roleToken)
	}
	// Stops git's upward discovery walk from leaving the clone root: an emptied
	// or corrupt clone dir is a plain directory, and without a ceiling git keeps
	// walking up and binds to whatever repository encloses it. Only a prefix of
	// the walk is truncated, so this is a backstop for that path — not a general
	// containment boundary.
	//
	// Absolute only: git silently ignores a relative ceiling entry, so pinning
	// one would yield an env that reads as contained while discovery still
	// escapes. Config load absolutises git.base_dir; a caller that supplies a
	// relative one gets a warning rather than a pin that lies. An empty ceiling
	// is a caller with nothing to pin — no warning owed.
	switch {
	case filepath.IsAbs(ceilingDir):
		env = append(env, "GIT_CEILING_DIRECTORIES="+ceilingDir)
	case ceilingDir != "":
		slog.Warn("relative git ceiling leaves discovery uncontained; git ignores non-absolute GIT_CEILING_DIRECTORIES",
			"ceiling_dir", ceilingDir)
	}
	return append(env, "GIT_ALLOW_PROTOCOL="+gitAllowedProtocols)
}

// withoutPrefixes drops every entry whose key starts with one of prefixes, for
// namespaces where the member set is unbounded and exact matching cannot cover
// it. Matching the whole entry is safe because an env key cannot contain "=", so
// a prefix can only ever land in the key.
func withoutPrefixes(env []string, prefixes ...string) []string {
	kept := make([]string, 0, len(env))
	for _, entry := range env {
		drop := false
		for _, prefix := range prefixes {
			if strings.HasPrefix(entry, prefix) {
				drop = true
				break
			}
		}
		if !drop {
			kept = append(kept, entry)
		}
	}
	return kept
}

// withoutKeys drops every `KEY=VALUE` entry whose key matches one of keys.
func withoutKeys(env []string, keys ...string) []string {
	kept := make([]string, 0, len(env))
	for _, entry := range env {
		drop := false
		for _, key := range keys {
			if strings.HasPrefix(entry, key+"=") {
				drop = true
				break
			}
		}
		if !drop {
			kept = append(kept, entry)
		}
	}
	return kept
}

// runWithStdin executes a command with data piped to stdin and returns stdout.
func (m *Manager) runWithStdin(ctx context.Context, dir, stdin, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = m.subprocessEnv()

	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	slog.Debug("exec+stdin", "cmd", name, "args", args, "dir", dir, "stdin_len", len(stdin))

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s %s: %w\nstderr: %s", name, strings.Join(args, " "), err, stderr.String())
	}

	return stdout.String(), nil
}

// run executes a command and returns its stdout. Stderr is included in errors.
func (m *Manager) run(ctx context.Context, dir, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = m.subprocessEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	slog.Debug("exec", "cmd", name, "args", args, "dir", dir)

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s %s: %w\nstderr: %s", name, strings.Join(args, " "), err, stderr.String())
	}

	return stdout.String(), nil
}

func (m *Manager) remote() string {
	if m.DefaultRemote != "" {
		return m.DefaultRemote
	}
	return "origin"
}

// PrefixedBranch returns the branch name with BranchPrefix applied.
// Idempotent — does not double-prefix names that already start with the prefix.
func (m *Manager) PrefixedBranch(name string) string {
	return m.prefixedBranch(name)
}

func (m *Manager) prefixedBranch(name string) string {
	if m.BranchPrefix != "" && !strings.HasPrefix(name, m.BranchPrefix) {
		return m.BranchPrefix + name
	}
	return name
}

// isGitRepo reports whether dir is a usable git working tree. A bare
// os.Stat(".git") is not enough: a half-deleted clone can leave a ".git"
// directory with objects/refs but no HEAD/config, which passes the stat yet
// makes every real git command fail with "not a git repository" (exit 128).
// We ask git itself via `rev-parse --git-dir`, the canonical liveness check.
func isGitRepo(dir string) bool {
	if info, err := os.Stat(filepath.Join(dir, ".git")); err != nil || !info.IsDir() {
		return false
	}
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--git-dir")
	// The ceiling is the PARENT: dir must remain inspectable, but discovery must
	// not climb past it. A wiped clone is a plain directory, and without this the
	// walk reaches the enclosing repository and reports it as dir's own — the
	// answer CloneOrOpen then acts on, up to os.RemoveAll.
	cmd.Env = SubprocessEnv(filepath.Dir(dir))
	return cmd.Run() == nil
}
