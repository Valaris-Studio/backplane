// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package store

// Windows cannot fsync a directory handle; NTFS rename durability is qualified in CR-9.
func SyncDir(string) error { return nil }
