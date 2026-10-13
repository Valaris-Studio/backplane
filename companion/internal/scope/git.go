// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"bufio"
	"bytes"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const maxGitMetadataBytes = 1 << 20

type Repo struct {
	Root string
	// RemoteURL is the normalized origin URL, or empty when there is none.
	RemoteURL string
	// Branch is the checked-out branch, a detached HEAD's short commit id,
	// or empty.
	Branch string
}

// FindRepo walks up from dir to the nearest git working tree and reads its
// origin remote and HEAD from git metadata. It never executes git.
func FindRepo(dir string) (Repo, bool) {
	for current := dir; ; {
		marker := filepath.Join(current, ".git")
		if info, err := os.Lstat(marker); err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				// A .git symlinked to the git directory (or a gitdir file).
				if target, err := os.Stat(marker); err == nil {
					info = target
				}
			}
			gitDir, ok := resolveGitDir(current, marker, info)
			if !ok {
				return Repo{}, false
			}
			return Repo{Root: current, RemoteURL: NormalizeRemote(originURL(commonDir(gitDir))), Branch: headBranch(gitDir)}, true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return Repo{}, false
		}
		current = parent
	}
}

// resolveGitDir handles both a .git directory and the .git file that linked
// worktrees and submodules use ("gitdir: <path>").
func resolveGitDir(worktree, marker string, info os.FileInfo) (string, bool) {
	if info.IsDir() {
		return marker, true
	}
	if !info.Mode().IsRegular() {
		return "", false
	}
	content, ok := readBounded(marker)
	if !ok {
		return "", false
	}
	line := strings.TrimSpace(string(content))
	if !strings.HasPrefix(line, "gitdir:") {
		return "", false
	}
	target := strings.TrimSpace(strings.TrimPrefix(line, "gitdir:"))
	if !filepath.IsAbs(target) {
		target = filepath.Join(worktree, target)
	}
	return filepath.Clean(target), true
}

// commonDir follows a linked worktree's "commondir" file to the repository
// that owns the shared config.
func commonDir(gitDir string) string {
	content, ok := readBounded(filepath.Join(gitDir, "commondir"))
	if !ok {
		return gitDir
	}
	common := strings.TrimSpace(string(content))
	if common == "" {
		return gitDir
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(gitDir, common)
	}
	return filepath.Clean(common)
}

const shortCommitLength = 7

var commitID = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// headBranch reads HEAD from the worktree's own git directory (a linked
// worktree has its own HEAD; the config is shared).
func headBranch(gitDir string) string {
	content, ok := readBounded(filepath.Join(gitDir, "HEAD"))
	if !ok {
		return ""
	}
	head := strings.TrimSpace(string(content))
	if ref, symbolic := strings.CutPrefix(head, "ref:"); symbolic {
		branch, isBranch := strings.CutPrefix(strings.TrimSpace(ref), "refs/heads/")
		if !isBranch {
			return ""
		}
		return branch
	}
	if commitID.MatchString(head) {
		return head[:shortCommitLength]
	}
	return ""
}

func originURL(gitDir string) string {
	content, ok := readBounded(filepath.Join(gitDir, "config"))
	if !ok {
		return ""
	}
	inOrigin := false
	scanner := bufio.NewScanner(bytes.NewReader(content))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		if line[0] == '[' {
			inOrigin = isOriginSection(line)
			continue
		}
		if !inOrigin {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if found && strings.EqualFold(strings.TrimSpace(key), "url") {
			return strings.Trim(strings.TrimSpace(value), `"`)
		}
	}
	return ""
}

// isOriginSection matches `[remote "origin"]`; the section name is
// case-insensitive while the subsection name is not.
func isOriginSection(header string) bool {
	inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(header, "["), "]"))
	name, subsection, found := strings.Cut(inner, " ")
	return found && strings.EqualFold(name, "remote") && strings.TrimSpace(subsection) == `"origin"`
}

func readBounded(path string) ([]byte, bool) {
	file, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxGitMetadataBytes+1))
	if err != nil || len(content) > maxGitMetadataBytes {
		return nil, false
	}
	return content, true
}

// NormalizeRemote reduces the common remote spellings to a lowercase
// "host/owner/repo" without credentials, port, trailing slash or ".git".
// The backend normalizes bound repository URLs the same way.
// Local paths and file URLs normalize to "" because they identify no hosted
// repository.
func NormalizeRemote(remote string) string {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ""
	}
	var host, path string
	if strings.Contains(remote, "://") {
		parsed, err := url.Parse(remote)
		if err != nil || parsed.Scheme == "file" || parsed.Hostname() == "" {
			return ""
		}
		host, path = parsed.Hostname(), parsed.Path
	} else {
		// scp-like syntax: [user@]host:path. A drive letter or a slash before
		// the colon means a local path instead.
		colon := strings.Index(remote, ":")
		slash := strings.Index(remote, "/")
		if colon <= 1 || slash >= 0 && slash < colon {
			return ""
		}
		host = remote[:colon]
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
		path = remote[colon+1:]
	}
	path = strings.Trim(path, "/")
	path = strings.TrimSuffix(path, ".git")
	path = strings.Trim(path, "/")
	if host == "" || path == "" {
		return ""
	}
	return strings.ToLower(host + "/" + path)
}
