// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package git

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var fullCommitSHA = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// CloneExact creates a disposable detached checkout using the same hardened git
// environment and operator credential helpers as ordinary runner git operations.
// No shared repository or worktree is reset, reused, or cleaned.
func (m *Manager) CloneExact(ctx context.Context, remoteURL, sha string) (string, func(), error) {
	noop := func() {}
	if !fullCommitSHA.MatchString(sha) {
		return "", noop, fmt.Errorf("completion source must be a full commit SHA")
	}
	if remoteURL == "" || strings.HasPrefix(remoteURL, "-") {
		return "", noop, fmt.Errorf("completion repository URL is missing or invalid")
	}
	root, err := os.MkdirTemp("", "backplane-completion-")
	if err != nil {
		return "", noop, err
	}
	cleanup := func() { _ = os.RemoveAll(root) }
	isolated := *m
	isolated.BaseDir = root
	dir := filepath.Join(root, "source")
	if _, err = isolated.git(ctx, root, "clone", "--no-checkout", "--", remoteURL, dir); err != nil {
		cleanup()
		return "", noop, fmt.Errorf("completion checkout clone failed; verify repository access and credential configuration")
	}
	if _, err = isolated.git(ctx, dir, "cat-file", "-e", sha+"^{commit}"); err != nil {
		if _, err = isolated.git(ctx, dir, "fetch", "origin", sha); err != nil {
			cleanup()
			return "", noop, fmt.Errorf("completion source commit unavailable; verify repository and accepted revision")
		}
	}
	if _, err = isolated.git(ctx, dir, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", sha); err != nil {
		cleanup()
		return "", noop, fmt.Errorf("completion detached checkout failed")
	}
	if err = isolated.VerifyExactSource(ctx, dir, sha); err != nil {
		cleanup()
		return "", noop, err
	}
	return dir, cleanup, nil
}

func (m *Manager) VerifyExactSource(ctx context.Context, dir, sha string) error {
	if !fullCommitSHA.MatchString(sha) {
		return fmt.Errorf("completion source must be a full commit SHA")
	}
	head, err := m.git(ctx, dir, "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(head) != sha {
		return fmt.Errorf("completion checkout HEAD changed from the accepted source revision")
	}
	if _, err = m.git(ctx, dir, "symbolic-ref", "-q", "HEAD"); err == nil {
		return fmt.Errorf("completion checkout must remain detached")
	}
	// Untracked build outputs are allowed; tracked source modifications are not.
	status, err := m.git(ctx, dir, "status", "--porcelain", "--untracked-files=no")
	if err != nil || strings.TrimSpace(status) != "" {
		return fmt.Errorf("completion checkout contains modified source")
	}
	return nil
}
