// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package richcapture

import (
	"fmt"
	"os"
	"syscall"
)

// fileIdentity is the file's device and inode.
func fileIdentity(_ *os.File, info os.FileInfo) string {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%d", uint64(stat.Dev), stat.Ino)
}
