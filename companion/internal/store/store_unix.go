// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package store

import "os"

// restrictToOwner also narrows a directory that already existed.
func restrictToOwner(dir string) error { return os.Chmod(dir, 0o700) }
