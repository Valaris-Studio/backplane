// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package richcapture

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// fileIdentity is the file's volume serial and file index.
func fileIdentity(file *os.File, _ os.FileInfo) string {
	var information windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &information) != nil {
		return ""
	}
	return fmt.Sprintf("%d:%d:%d", information.VolumeSerialNumber, information.FileIndexHigh, information.FileIndexLow)
}
