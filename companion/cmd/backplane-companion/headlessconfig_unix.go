// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// readOperatorConfig reads the headless config only if root or this user
// wrote it: the file and its directory must be owned by one of them,
// writable by no one else and not symlinks. The file is opened relative to
// the directory already checked, so neither can be swapped in between.
func readOperatorConfig(path string) ([]byte, error) {
	dir, err := openNoFollow(unix.AT_FDCWD, filepath.Dir(path), unix.O_DIRECTORY)
	if err != nil {
		return nil, headlessConfigRefused("directory")
	}
	defer unix.Close(dir)
	if err := checkOperatorOwned(dir, unix.S_IFDIR); err != nil {
		return nil, err
	}
	// O_NONBLOCK keeps a FIFO from blocking the open; it is then refused as
	// not regular.
	descriptor, err := openNoFollow(dir, filepath.Base(path), unix.O_NONBLOCK)
	if err != nil {
		return nil, headlessConfigRefused("file")
	}
	file := os.NewFile(uintptr(descriptor), path)
	defer file.Close()
	if err := checkOperatorOwned(descriptor, unix.S_IFREG); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, maxHeadlessConfigBytes+1))
	if err != nil || len(data) > maxHeadlessConfigBytes {
		return nil, headlessConfigRefused("file")
	}
	return data, nil
}

// openNoFollow retries EINTR as os.OpenFile does.
func openNoFollow(dir int, name string, flags int) (int, error) {
	for {
		descriptor, err := unix.Openat(dir, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|flags, 0)
		if !errors.Is(err, unix.EINTR) {
			return descriptor, err
		}
	}
}

func checkOperatorOwned(descriptor int, kind uint32) error {
	var info unix.Stat_t
	if err := unix.Fstat(descriptor, &info); err != nil {
		return headlessConfigRefused("stat")
	}
	switch {
	case uint32(info.Mode)&unix.S_IFMT != kind:
		return headlessConfigRefused("type")
	case info.Uid != 0 && int64(info.Uid) != int64(os.Geteuid()):
		return headlessConfigRefused("owner")
	case info.Mode&0o022 != 0:
		return headlessConfigRefused("writable")
	}
	return nil
}
