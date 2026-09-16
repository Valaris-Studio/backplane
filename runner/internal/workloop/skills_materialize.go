// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// skillFetcher is the client seam the materializer needs — narrow enough that
// tests fake it without standing up an HTTP server.
type skillFetcher interface {
	FetchSkillVersionFiles(ctx context.Context, workspaceSlug, skillSlug string, version int) (*valaris.SkillVersionFiles, error)
}

// skillsMaterializer copies board-bound skills into a coding agent's working
// tree at the location that agent discovers them from. It writes published
// files VERBATIM: the runner never parses a SKILL.md body, never rewrites it,
// and never injects its content into a prompt. The agent reads the files
// itself — the platform only puts them within reach.
type skillsMaterializer struct {
	fetcher skillFetcher
	// cacheDir holds one directory per content hash. Injected rather than
	// derived from $HOME so tests stay off the developer's real cache.
	cacheDir string
}

// skillsCacheDirOverride redirects the cache root. Tests set it so a package
// run never reads or writes the developer's real ~/.backplane-runner — a
// cross-test cache hit would otherwise make a fetch silently not happen.
var skillsCacheDirOverride string

// defaultSkillsCacheDir is the on-disk cache root, alongside the runner's
// existing sessions.json state. Falls back to a temp dir when $HOME is
// unavailable so materialization degrades instead of failing.
func defaultSkillsCacheDir() string {
	if skillsCacheDirOverride != "" {
		return skillsCacheDirOverride
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "backplane-runner", "skills-cache")
	}
	return filepath.Join(home, ".backplane-runner", "skills-cache")
}

func newSkillsMaterializer(fetcher skillFetcher) *skillsMaterializer {
	return &skillsMaterializer{fetcher: fetcher, cacheDir: defaultSkillsCacheDir()}
}

// cacheCompleteMarker names the file written last in a cache entry. Its
// presence is what makes a cache hit trustworthy: a fetch interrupted midway
// leaves files but no marker, so the next run re-fetches instead of serving a
// half-written skill.
const cacheCompleteMarker = ".complete"

// Materialize writes every skill in manifest into destRoot/skillsRelDir/<slug>/
// and returns the repo-relative directories it created. An empty manifest is a
// no-op that touches neither the network nor the filesystem.
func (m *skillsMaterializer) Materialize(
	ctx context.Context, workspaceSlug string, manifest []valaris.AssignmentSkill,
	destRoot, skillsRelDir string,
) ([]string, error) {
	if len(manifest) == 0 {
		return nil, nil
	}

	materialized := make([]string, 0, len(manifest))
	for _, skill := range manifest {
		if err := validateSkillSlug(skill.Slug); err != nil {
			return nil, err
		}
		relDir := filepath.Join(skillsRelDir, skill.Slug)
		destDir := filepath.Join(destRoot, relDir)

		// Refuse before fetching: a repo that TRACKS this path (Backplane's own
		// repo tracks .claude/) would have its project files overwritten, and
		// .git/info/exclude never applies to tracked paths — the implementer's
		// `git add -A` would then commit workspace skill content into the
		// customer's PR. A card without its skills beats a corrupted PR.
		tracked, err := hasTrackedFiles(destRoot, relDir)
		if err != nil {
			return nil, fmt.Errorf("checking whether %s is tracked: %w", relDir, err)
		}
		if tracked {
			return nil, fmt.Errorf(
				"skill %q would overwrite git-tracked files at %s — refusing to materialize",
				skill.Slug, relDir)
		}

		cached, err := m.ensureCached(ctx, workspaceSlug, skill)
		if err != nil {
			return nil, fmt.Errorf("caching skill %q: %w", skill.Slug, err)
		}
		if err := copyTree(cached, destDir); err != nil {
			return nil, fmt.Errorf("materializing skill %q: %w", skill.Slug, err)
		}
		materialized = append(materialized, filepath.ToSlash(relDir))
	}
	return materialized, nil
}

// validateSkillSlug refuses anything that is not a single safe path segment.
// The backend's slug regex makes a hostile slug unreachable today; this is the
// defence that still holds if a future ingress forgets to validate, and it
// runs BEFORE any fetch or write so a bad slug touches nothing.
func validateSkillSlug(slug string) error {
	if slug == "" {
		return fmt.Errorf("skill slug is empty")
	}
	if slug == "." || slug == ".." {
		return fmt.Errorf("skill slug %q is a relative path element", slug)
	}
	if strings.ContainsRune(slug, '/') || strings.ContainsRune(slug, os.PathSeparator) {
		return fmt.Errorf("skill slug %q contains a path separator", slug)
	}
	if slug != filepath.Clean(slug) {
		return fmt.Errorf("skill slug %q is not a clean path segment", slug)
	}
	return nil
}

// hasTrackedFiles reports whether git tracks anything under relDir. A non-repo
// destination (loop mode's plain workdir) tracks nothing, which is why a failed
// git invocation is not an error here — only a real listing counts.
func hasTrackedFiles(repoDir, relDir string) (bool, error) {
	if _, err := os.Stat(filepath.Join(repoDir, ".git")); err != nil {
		return false, nil // not a repo (or unreadable): nothing can be tracked
	}
	cmd := exec.Command("git", "ls-files", "--", filepath.ToSlash(relDir))
	cmd.Dir = repoDir
	out, err := cmd.Output()
	if err != nil {
		// A git that cannot list is not a licence to overwrite: fail closed.
		return false, fmt.Errorf("git ls-files: %w", err)
	}
	return len(bytes.TrimSpace(out)) > 0, nil
}

// ensureCached returns the local directory holding the skill's files, fetching
// and writing it on the first miss. Keyed on content hash, so two boards
// binding the same published version share one download.
func (m *skillsMaterializer) ensureCached(
	ctx context.Context, workspaceSlug string, skill valaris.AssignmentSkill,
) (string, error) {
	key := skill.ContentHash
	if key == "" {
		// A backend that omitted the hash still gets correct behavior, just
		// without cross-card reuse.
		key = fmt.Sprintf("%s-v%d", skill.Slug, skill.Version)
	}
	entry := filepath.Join(m.cacheDir, key, skill.Slug)
	if _, err := os.Stat(filepath.Join(entry, cacheCompleteMarker)); err == nil {
		return entry, nil
	}

	version, err := m.fetcher.FetchSkillVersionFiles(ctx, workspaceSlug, skill.Slug, skill.Version)
	if err != nil {
		return "", err
	}
	// The manifest hash is the cache key, so a served version that disagrees
	// would poison every later card that trusts that key. Compare only when
	// both sides carry one — an older backend may omit it on the payload.
	if skill.ContentHash != "" && version.ContentHash != "" && skill.ContentHash != version.ContentHash {
		return "", fmt.Errorf(
			"skill %q content hash mismatch: manifest %q, served %q",
			skill.Slug, skill.ContentHash, version.ContentHash)
	}

	// Stage into a private temp dir and publish with one rename. A concurrent
	// runner either sees no entry or a complete one — never the half-written
	// tree that a RemoveAll+rewrite in place would expose it to.
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		return "", err
	}
	staging, err := os.MkdirTemp(filepath.Dir(entry), skill.Slug+".tmp-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging) // no-op once the rename has moved it away

	for _, file := range version.Files {
		target, err := safeJoin(staging, file.Path)
		if err != nil {
			return "", err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(target, []byte(file.Content), 0o644); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(filepath.Join(staging, cacheCompleteMarker), []byte(key), 0o644); err != nil {
		return "", err
	}

	if err := os.Rename(staging, entry); err != nil {
		// Losing the race is the expected outcome, not a failure: whoever won
		// published an identical tree (same content hash), so use theirs.
		if _, statErr := os.Stat(filepath.Join(entry, cacheCompleteMarker)); statErr == nil {
			return entry, nil
		}
		return "", fmt.Errorf("publishing skill cache entry: %w", err)
	}
	return entry, nil
}

// safeJoin resolves rel under base and refuses anything that climbs out.
// The backend validates skill file paths on publish; this is the defence that
// still holds if a future ingress forgets to.
func safeJoin(base, rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("skill file path %q is absolute, escapes the skill dir", rel)
	}
	target := filepath.Join(base, filepath.Clean(rel))
	if target != base && !strings.HasPrefix(target, base+string(os.PathSeparator)) {
		return "", fmt.Errorf("skill file path %q escapes the skill dir", rel)
	}
	return target, nil
}

// copyTree mirrors src into dst, replacing whatever was there. Replacing
// rather than merging keeps a re-run from leaving files behind that the
// current skill version no longer publishes.
func copyTree(src, dst string) error {
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	return filepath.WalkDir(src, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		if rel == cacheCompleteMarker {
			return nil // cache bookkeeping, not skill content
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), content, 0o644)
	})
}
