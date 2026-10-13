// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package store

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ErrNotOwnedFile: a file failed a descriptor check of ReadOwnedFile.
var ErrNotOwnedFile = errors.New("not_an_owned_file")

// afterOwnedLstat runs between the path check and the open, so a test can
// swap the file in that window.
var afterOwnedLstat = func() {}

// ReadOwnedFile reads a file another program keeps for this user (an
// agent's body store or session sidecar) through a descriptor proven to be
// the file named: its canonical path lies within the directory, the path is
// no link, and the opened descriptor is that same regular file, owned by
// this user alone, writable by no one else and known by one name. It reads
// at most limit bytes; a larger file is refused.
func ReadOwnedFile(path, within string, limit int64) ([]byte, error) {
	if !filepath.IsAbs(path) || !filepath.IsAbs(within) {
		return nil, ErrNotOwnedFile
	}
	within, err := filepath.EvalSymlinks(within)
	if err != nil {
		return nil, ErrNotOwnedFile
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(filepath.Clean(path)))
	if err != nil {
		return nil, ErrNotOwnedFile
	}
	path = filepath.Join(dir, filepath.Base(path))
	if relative, err := filepath.Rel(within, path); err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, ErrNotOwnedFile
	}
	checked, err := os.Lstat(path)
	if err != nil || !checked.Mode().IsRegular() || checked.Size() > limit {
		return nil, ErrNotOwnedFile
	}
	afterOwnedLstat()
	file, err := openOwned(path)
	if err != nil {
		return nil, ErrNotOwnedFile
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(checked, opened) || !ownedAlone(file, opened) {
		return nil, ErrNotOwnedFile
	}
	body, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, ErrNotOwnedFile
	}
	return body, nil
}
