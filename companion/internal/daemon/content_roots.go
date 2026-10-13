// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
)

var errSourceRefused = errors.New("daemon: session file outside its agent's content roots")

// openConfined opens a session file only where its agent keeps them: its
// directory, links resolved and spelled as on disk, within one of roots,
// and the file itself regular there and still that file once opened.
// The path is the source's key, its one spelling, never a sighting's raw
// name: that is what its cursor is kept under.
func openConfined(path string, roots []string, cursor richcapture.Cursor, known bool) (*richcapture.SourceFile, richcapture.Change, error) {
	if !filepath.IsAbs(path) {
		return nil, richcapture.FirstSeen, errSourceRefused
	}
	dir, ok := scope.CanonicalDir(filepath.Dir(path))
	if !ok {
		return nil, richcapture.FirstSeen, richcapture.ErrSourceMissing
	}
	if !withinAny(roots, dir) {
		return nil, richcapture.FirstSeen, errSourceRefused
	}
	expected, err := os.Lstat(filepath.Join(dir, filepath.Base(path)))
	if errors.Is(err, os.ErrNotExist) {
		return nil, richcapture.FirstSeen, richcapture.ErrSourceMissing
	}
	if err != nil || !expected.Mode().IsRegular() {
		return nil, richcapture.FirstSeen, errSourceRefused
	}
	file, change, err := richcapture.OpenSource(path, cursor, known)
	if err != nil {
		return nil, change, err
	}
	if !os.SameFile(file.Info(), expected) {
		file.Close()
		return nil, change, errSourceRefused
	}
	return file, change, nil
}

func withinAny(roots []string, dir string) bool {
	for _, root := range roots {
		if canonical, ok := scope.CanonicalDir(root); ok && pathWithin(canonical, dir) {
			return true
		}
	}
	return false
}
