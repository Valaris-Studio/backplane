// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import "golang.org/x/sys/windows"

var canonicalizationQualified = true

// From <fileapi.h>; x/sys does not export them. Both are the zero flag.
const (
	fileNameNormalized = 0x0
	volumeNameDOS      = 0x0
)

// NTFS can make single directories case-sensitive, and nothing cheaper than
// the lookup probe tells, so the probe decides.
func platformCaseSensitivity(string) (sensitive, known bool) { return false, false }

// directorySpelling asks for the final path of the directory's handle, which
// carries each component's on-disk case and long (not 8.3) name. Backup
// semantics is what lets CreateFile open a directory; read-attributes access
// is enough, so a folder the user cannot list still resolves.
func directorySpelling(dir string) (string, bool) {
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return "", false
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), fileNameNormalized|volumeNameDOS)
	if err != nil || length == 0 || int(length) >= len(buffer) {
		return "", false
	}
	return dosPathFromFinal(windows.UTF16ToString(buffer[:length]))
}
