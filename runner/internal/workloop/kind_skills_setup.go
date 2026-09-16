// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleSkillsSetup copies the board's bound skills into the working tree
// at the coding agent's own discovery path, so the agent finds them the way it
// finds any project-local skill. The runner writes published files VERBATIM: it
// never parses a SKILL.md, never injects skill text into a prompt, and has no
// opinion on what a skill says.
//
// Runs after git_setup (it needs the clone) and before the llm step (the agent
// must see the files at launch). Three conditions make it a silent no-op: an
// empty manifest, a pre-registry backend, or a provider that declares no
// discovery directory — none of which is a card failure.
//
// The materialized tree is BOTH excluded from git (so `git clean -fd`, which
// every git_setup runs, leaves it alone) AND removed by the wrapped cleanup —
// belt and braces, because a skill leaking into a commit would put workspace
// content into a customer PR.
func lifecycleSkillsSetup(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}
	if ws.RepoDir == "" {
		return "", "", fmt.Errorf("step %q (%s) requires a working tree but no prior git_setup set one",
			step.Name, step.Kind)
	}

	logger := walkLogger(ws)
	if len(card.Skills) == 0 {
		logger.Debug("skills_setup: no skills bound to this board", "card_id", card.CardID)
		return "", "", nil
	}

	locator, ok := l.providerFor(card.AssignmentLLM).(llm.SkillsLocator)
	if !ok {
		logger.Info("skills_setup: provider declares no skills directory — skipping materialization",
			"card_id", card.CardID, "skills", len(card.Skills))
		return "", "", nil
	}
	skillsRelDir := locator.SkillsRelDir()

	// Exclude FIRST: it is idempotent and cheap, and writing it up front means
	// there is no window where skills exist on disk but `git add -A` can still
	// see them (a crash mid-materialization would otherwise leave them exposed).
	excludeFromGit(ws.RepoDir, skillsRelDir)

	materializer := newSkillsMaterializer(l.client)
	dirs, err := materializer.Materialize(ctx, l.cfg.Valaris.WorkspaceSlug, card.Skills, ws.RepoDir, skillsRelDir)
	if err != nil {
		return "", "", fmt.Errorf("materializing skills: %w", err)
	}

	wrapCleanupWithSkillsRemoval(ws, ws.RepoDir, skillsRelDir, dirs)

	logger.Info("skills_setup: materialized board skills",
		"card_id", card.CardID, "dir", skillsRelDir, "count", len(dirs))
	return "", "", nil
}

// excludeFromGit appends relDir to .git/info/exclude so the materialized
// skills survive the `git clean -fd` that git_setup and Cleanup both run, and
// never show up as untracked files the agent might commit. info/exclude is the
// right lever over .gitignore: it is local-only and never appears in a diff.
//
// Idempotent and best-effort, modelled on ensureGitignore — a repo we cannot
// write the exclude for still gets its skills, and the cleanup wrapper is the
// second line of defence.
func excludeFromGit(repoDir, relDir string) {
	entry := strings.TrimSuffix(filepath.ToSlash(relDir), "/") + "/"
	excludePath := filepath.Join(repoDir, ".git", "info", "exclude")

	existing, err := os.ReadFile(excludePath)
	if err != nil && !os.IsNotExist(err) {
		slog.Warn("skills_setup: cannot read .git/info/exclude", "repo", repoDir, "error", err)
		return
	}
	for _, line := range strings.Split(string(existing), "\n") {
		if strings.TrimSpace(line) == entry {
			return
		}
	}

	if err := os.MkdirAll(filepath.Dir(excludePath), 0o755); err != nil {
		slog.Warn("skills_setup: cannot create .git/info", "repo", repoDir, "error", err)
		return
	}
	appended := string(existing)
	if appended != "" && !strings.HasSuffix(appended, "\n") {
		appended += "\n"
	}
	appended += entry + "\n"
	if err := os.WriteFile(excludePath, []byte(appended), 0o644); err != nil {
		slog.Warn("skills_setup: cannot write .git/info/exclude", "repo", repoDir, "error", err)
	}
}

// wrapCleanupWithSkillsRemoval replaces the walk's git_cleanup closure with one
// that deletes EXACTLY the dirs Materialize created, then runs whatever cleanup
// git_setup stashed. Removing first means the original's `git clean`/reset sees
// an already-clean tree. A walk with no stashed cleanup still gets the removal.
//
// Removing only what we created is the load-bearing part: a blanket RemoveAll
// of the skills root would delete tracked project files the runner never wrote
// (a repo may legitimately track .claude/skills/<other>), and a commit landing
// between cleanup and the next reset would ship that deletion to the customer.
func wrapCleanupWithSkillsRemoval(ws *lifecycle.WalkState, repoDir, skillsRelDir string, createdDirs []string) {
	var original func()
	if prev, ok := ws.Get("git_cleanup"); ok {
		original, _ = prev.(func())
	}
	skillsRoot := filepath.Join(repoDir, filepath.FromSlash(skillsRelDir))

	ws.Set("git_cleanup", func() {
		for _, rel := range createdDirs {
			dir := filepath.Join(repoDir, filepath.FromSlash(rel))
			if err := os.RemoveAll(dir); err != nil {
				slog.Warn("skills_setup: failed to remove materialized skill", "dir", dir, "error", err)
			}
		}
		// Prune the scaffolding we may have created, innermost first. Each
		// Remove fails harmlessly (and stops the walk up) the moment a dir
		// still holds something — i.e. anything the runner did not create.
		pruneEmptyParents(skillsRoot, repoDir)
		if original != nil {
			original()
		}
	})
}

// pruneEmptyParents removes dir and its ancestors while they are empty,
// stopping below stopAt. Non-empty dirs (a tracked sibling, the repo itself)
// end the walk — os.Remove refuses a non-empty directory, which is exactly the
// guard we want.
func pruneEmptyParents(dir, stopAt string) {
	for dir != stopAt && strings.HasPrefix(dir, stopAt+string(os.PathSeparator)) {
		if err := os.Remove(dir); err != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}
