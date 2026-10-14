// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package store

import (
	"os"

	"golang.org/x/sys/windows"
)

// openOwned opens the reparse point itself rather than its target, so a
// link or junction is seen (and refused) instead of followed.
func openOwned(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}

// ownedAlone refuses reparse points and files with several names. Owner
// and access-list checks are the profile directory's own.
func ownedAlone(file *os.File, _ os.FileInfo) bool {
	var information windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &information) != nil {
		return false
	}
	return information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 && information.NumberOfLinks == 1
}
