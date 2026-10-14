// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"bytes"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

// From <sys/unistd.h> and <sys/fcntl.h>; x/sys does not export them.
const (
	pcCaseSensitive = 11
	oExec           = 0x40000000
)

var canonicalizationQualified = true

func platformCaseSensitivity(dir string) (sensitive, known bool) {
	value, err := unix.Pathconf(dir, pcCaseSensitive)
	if err != nil {
		return false, false
	}
	return value != 0, true
}

// directorySpelling asks the kernel for the path of the directory's vnode,
// which carries each component's on-disk case and Unicode form. O_SEARCH
// (O_EXEC|O_DIRECTORY) needs only search permission, so a folder the user
// cannot list still resolves.
func directorySpelling(dir string) (string, bool) {
	fd, err := unix.Open(dir, oExec|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", false
	}
	defer unix.Close(fd)
	buffer := make([]byte, unix.PathMax)
	_, err = unix.FcntlInt(uintptr(fd), unix.F_GETPATH, int(uintptr(unsafe.Pointer(&buffer[0]))))
	runtime.KeepAlive(buffer)
	if err != nil {
		return "", false
	}
	end := bytes.IndexByte(buffer, 0)
	if end <= 0 {
		return "", false
	}
	return string(buffer[:end]), true
}
