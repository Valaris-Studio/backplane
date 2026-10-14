// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package scope decides, before anything is retained, whether an agent
// session's working directory is in capture scope. Decisions are
// deterministic: exclusions, then explicit mappings, then git-remote
// auto-match, otherwise unmapped.
package scope

import (
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"golang.org/x/text/unicode/norm"
)

type Reason string

const (
	ReasonMapped           Reason = "mapped"
	ReasonAutoMatchPending Reason = "auto_match_pending"
	ReasonLocalPaused      Reason = "local_paused"
	ReasonNotConnected     Reason = "not_connected"
	ReasonUnauthorized     Reason = "unauthorized"
	ReasonPolicyStale      Reason = "policy_stale"
	ReasonServerPaused     Reason = "server_paused"
	ReasonAgentDisabled    Reason = "agent_disabled"
	ReasonInvalidCwd       Reason = "invalid_cwd"
	ReasonHomeOrRoot       Reason = "home_or_root"
	ReasonTempDir          Reason = "temp_dir"
	ReasonExcluded         Reason = "excluded"
	ReasonIgnored          Reason = "ignored"
	ReasonMappingDisabled  Reason = "mapping_disabled"
	ReasonUnmapped         Reason = "unmapped"
)

// Transient reports whether the reason is an admission state that may clear
// on its own (credential, policy freshness) rather than a privacy exclusion.
// Already-admitted observations wait out a transient state; they are never
// kept past a privacy exclusion.
func (r Reason) Transient() bool {
	switch r {
	case ReasonUnauthorized, ReasonPolicyStale, ReasonNotConnected:
		return true
	}
	return false
}

type Input struct {
	Policy       *policy.Cached // nil when the device was never connected
	LocalPaused  bool
	Unauthorized bool
	// IgnoredPaths are local "never capture" roots; UnmatchedRoots are repos
	// the server already refused to auto-map.
	IgnoredPaths   []string
	UnmatchedRoots []string
	AgentID        string
	Cwd            string
	Home           string
	TempDirs       []string
	Now            time.Time
}

type PendingAutoMatch struct {
	Root    string `json:"root"`
	RepoURL string `json:"repo_url"`
}

type Project struct {
	Root    string `json:"root"`
	RepoURL string `json:"repo_url,omitempty"`
}

type Decision struct {
	InScope          bool
	Reason           Reason
	Cwd              string
	MappingID        string
	PendingAutoMatch *PendingAutoMatch
	ContentLevel     privacy.ContentLevel
	// Place locates an in-scope session's project for its uploaded events.
	Place privacy.Place
	// Discovered is set for an unmapped git repository so it can be offered
	// for mapping. It carries a path and a remote, never content.
	Discovered *Project
}

func out(reason Reason) Decision { return Decision{Reason: reason} }

func Decide(in Input) Decision {
	if decision, excluded := exclusion(in); excluded {
		return decision
	}
	cwd, ok := CanonicalDir(in.Cwd)
	if !ok {
		return out(ReasonInvalidCwd)
	}
	if reason, excluded := locationExclusion(in, cwd); excluded {
		return Decision{Reason: reason, Cwd: cwd}
	}
	decision := resolve(in, cwd)
	decision.Cwd = cwd
	if decision.InScope {
		decision.Place.Roots = withSpelling(decision.Place.Roots[0], cwd, in.Cwd)
		decision.Place.Homes = homeSpellings(in.Home)
	}
	return decision
}

// withSpelling adds the root as the agent spelled it when its cwd reached the
// canonical root through a symlink or in another case, so both spellings
// become relative.
func withSpelling(root, cwd, rawCwd string) []string {
	roots := []string{root}
	relative, err := filepath.Rel(root, cwd)
	if err != nil {
		return roots
	}
	spelled := filepath.Clean(rawCwd)
	if relative != "." {
		trimmed, found := trimRelative(spelled, relative, !volumeIsCaseSensitive(cwd))
		if !found {
			return roots
		}
		spelled = trimmed
	}
	if spelled != root {
		roots = append(roots, spelled)
	}
	return roots
}

// trimRelative drops relative's trailing components from spelled when they
// spell the same names.
func trimRelative(spelled, relative string, folds bool) (string, bool) {
	trimmed := spelled
	for range strings.Count(relative, string(filepath.Separator)) + 1 {
		trimmed = filepath.Dir(trimmed)
	}
	rest, err := filepath.Rel(trimmed, spelled)
	if err != nil || rest != relative && !(folds && foldName(rest) == foldName(relative)) {
		return "", false
	}
	return trimmed, true
}

func homeSpellings(home string) []string {
	if home == "" || !filepath.IsAbs(home) {
		return nil
	}
	homes := []string{filepath.Clean(home)}
	if canonical, ok := CanonicalDir(home); ok && canonical != homes[0] {
		homes = append(homes, canonical)
	}
	return homes
}

// Admits reports whether in allows capture for its agent anywhere, before
// any working directory is considered.
func Admits(in Input) bool {
	_, excluded := exclusion(in)
	return !excluded
}

func exclusion(in Input) (Decision, bool) {
	switch {
	case in.LocalPaused:
		return out(ReasonLocalPaused), true
	case in.Policy == nil:
		return out(ReasonNotConnected), true
	case in.Unauthorized:
		return out(ReasonUnauthorized), true
	case in.Policy.Stale(in.Now):
		return out(ReasonPolicyStale), true
	case in.Policy.Policy.Installation.Paused:
		return out(ReasonServerPaused), true
	case !in.Policy.Policy.AgentEnabled(in.AgentID):
		return out(ReasonAgentDisabled), true
	}
	return Decision{}, false
}

func locationExclusion(in Input, cwd string) (Reason, bool) {
	home, _ := CanonicalDir(in.Home)
	if cwd == home || cwd == filepath.VolumeName(cwd)+string(filepath.Separator) {
		return ReasonHomeOrRoot, true
	}
	for _, temp := range in.TempDirs {
		if canonicalTemp, ok := CanonicalDir(temp); ok && within(canonicalTemp, cwd) {
			return ReasonTempDir, true
		}
	}
	folds := !volumeIsCaseSensitive(cwd)
	for _, pattern := range in.Policy.Policy.Installation.ExcludeGlobs {
		if matchesGlob(pattern, cwd, home, folds) {
			return ReasonExcluded, true
		}
	}
	for _, ignored := range in.IgnoredPaths {
		if within(CanonicalOrClean(ignored), cwd) {
			return ReasonIgnored, true
		}
	}
	return "", false
}

func resolve(in Input, cwd string) Decision {
	repo, found := FindRepo(cwd)
	if mapping, mappedRoot := longestRootMapping(in.Policy.Policy.Mappings, cwd); mappedRoot {
		repoURL := mapping.RepoURLNormalized
		if repoURL == "" {
			repoURL = repo.RemoteURL
		}
		return mapped(mapping, privacy.Place{Roots: []string{CanonicalOrClean(mapping.RootPath)}, RepoURL: repoURL, Branch: repo.Branch})
	}
	if !found {
		return out(ReasonUnmapped)
	}
	place := privacy.Place{Roots: []string{repo.Root}, RepoURL: repo.RemoteURL, Branch: repo.Branch}
	if repo.RemoteURL != "" {
		for _, mapping := range in.Policy.Policy.Mappings {
			if mapping.RootPath == "" && mapping.RepoURLNormalized == repo.RemoteURL {
				return mapped(mapping, place)
			}
		}
		if in.Policy.Policy.Installation.AutoMatchRepos && inCatalog(in.Policy.Policy.RepoCatalog, repo.RemoteURL) && !containsPath(in.UnmatchedRoots, repo.Root) {
			return Decision{InScope: true, Reason: ReasonAutoMatchPending, ContentLevel: privacy.Standard, Place: place, PendingAutoMatch: &PendingAutoMatch{Root: repo.Root, RepoURL: repo.RemoteURL}}
		}
	}
	return Decision{Reason: ReasonUnmapped, Discovered: &Project{Root: repo.Root, RepoURL: repo.RemoteURL}}
}

func mapped(mapping policy.Mapping, place privacy.Place) Decision {
	if !mapping.Enabled {
		return out(ReasonMappingDisabled)
	}
	level, err := privacy.ParseContentLevel(mapping.ContentLevel)
	if err != nil {
		// A level this build does not know must never widen what is retained.
		level = privacy.Metadata
	}
	return Decision{InScope: true, Reason: ReasonMapped, MappingID: mapping.ID, ContentLevel: level, Place: place}
}

func longestRootMapping(mappings []policy.Mapping, cwd string) (policy.Mapping, bool) {
	var best policy.Mapping
	bestLength := -1
	for _, mapping := range mappings {
		if mapping.RootPath == "" || !filepath.IsAbs(mapping.RootPath) {
			continue
		}
		root := CanonicalOrClean(mapping.RootPath)
		if within(root, cwd) && len(root) > bestLength {
			best, bestLength = mapping, len(root)
		}
	}
	return best, bestLength >= 0
}

func inCatalog(catalog []policy.CatalogRepo, remote string) bool {
	for _, repo := range catalog {
		if repo.RepoURLNormalized == remote {
			return true
		}
	}
	return false
}

func containsPath(paths []string, path string) bool {
	for _, candidate := range paths {
		if CanonicalOrClean(candidate) == path {
			return true
		}
	}
	return false
}

func within(root, path string) bool {
	if !filepath.IsAbs(root) || !filepath.IsAbs(path) {
		return false
	}
	rootVolume, pathVolume := filepath.VolumeName(root), filepath.VolumeName(path)
	if !strings.EqualFold(rootVolume, pathVolume) {
		return false
	}
	root, path = root[len(rootVolume):], path[len(pathVolume):]
	if root == path {
		return true
	}
	// Only volumes fold case; canonical directory components retain exact spelling.
	prefix := strings.TrimSuffix(root, string(filepath.Separator)) + string(filepath.Separator)
	return strings.HasPrefix(path, prefix)
}

// matchesGlob reports whether pattern matches path or any of its ancestors.
// "~/" expands to home, "**" spans directories, "*" and "?" stay within one
// segment, and a relative pattern may match at any depth. Case is ignored
// where the volume folds it. Unicode normalization is always ignored: a
// pattern typed in NFC must match a folder stored in NFD, and on a volume that
// keeps both forms apart the cost is only a wider exclusion.
func matchesGlob(pattern, path, home string, foldsCase bool) bool {
	pattern = norm.NFC.String(strings.TrimSpace(filepath.ToSlash(pattern)))
	if pattern == "" {
		return false
	}
	if strings.HasPrefix(pattern, "~/") && home != "" {
		pattern = filepath.ToSlash(home) + pattern[1:]
	}
	if !strings.HasPrefix(pattern, "/") && !hasVolume(pattern) {
		pattern = "**/" + pattern
	}
	flags := ""
	if foldsCase {
		flags = "(?i)"
	}
	expression, err := regexp.Compile(flags + "^" + globExpression(strings.TrimSuffix(pattern, "/")) + "$")
	if err != nil {
		return false
	}
	for candidate := path; ; {
		if expression.MatchString(norm.NFC.String(filepath.ToSlash(candidate))) {
			return true
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return false
		}
		candidate = parent
	}
}

// ExcludedPath reports whether a placed path (relative to its project, or
// ~/…) matches an exclude glob, as the server matches a display path.
func ExcludedPath(globs []string, path string) bool {
	for _, pattern := range globs {
		if matchesGlob(pattern, filepath.FromSlash(path), "", false) {
			return true
		}
	}
	return false
}

func hasVolume(pattern string) bool { return len(pattern) > 1 && pattern[1] == ':' }

func globExpression(pattern string) string {
	var builder strings.Builder
	for index := 0; index < len(pattern); index++ {
		switch {
		case strings.HasPrefix(pattern[index:], "**/"):
			builder.WriteString("(?:.*/)?")
			index += 2
		case strings.HasPrefix(pattern[index:], "**"):
			builder.WriteString(".*")
			index++
		case pattern[index] == '*':
			builder.WriteString("[^/]*")
		case pattern[index] == '?':
			builder.WriteString("[^/]")
		default:
			builder.WriteString(regexp.QuoteMeta(pattern[index : index+1]))
		}
	}
	return builder.String()
}
