// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package richcapture

import (
	"os"
	"syscall"
)

// openSource opens without blocking: a FIFO swapped in for a session file
// would otherwise hold the open, and the daemon's tick, until a writer
// came along. Reads of the regular file it must be then block as usual.
func openSource(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	if err := syscall.SetNonblock(int(file.Fd()), false); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
