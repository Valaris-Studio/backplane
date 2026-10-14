// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

func init() {
	createPhysicalFixtureDirectory = nativeCreateFixtureDirectory
}

func nativeCreateFixtureDirectory(path string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	// A token's default owner can be a group; bind the fixture owner at creation.
	owner := user.User.Sid.String()
	security, err := windows.SecurityDescriptorFromString("O:" + owner + "D:P(A;OICI;FA;;;" + owner + ")(A;OICI;FA;;;SY)")
	if err != nil {
		return err
	}
	attributes := windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: security,
	}
	return windows.CreateDirectory(name, &attributes)
}
