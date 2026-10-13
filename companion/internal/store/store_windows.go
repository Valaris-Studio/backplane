// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package store

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// From <winnt.h>; x/sys does not export them.
const (
	accessAllowedCallbackACEType = 0x9
	accessDeniedCallbackACEType  = 0xA
)

// restrictToOwner verifies, rather than sets, the directory's owner and
// access list: the default one %LOCALAPPDATA% children inherit is already
// user-private, and a directory that inherits more (an Everyone grant up the
// tree) is refused instead of silently narrowed under data other users could
// read.
func restrictToOwner(dir string) error {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	security, err := readDirSecurity(dir)
	if err != nil {
		return err
	}
	return checkPrivateDir(security.owner, security.entries, security.daclPresent, user.User.Sid.String())
}

type dirSecurity struct {
	owner       string
	entries     []aclEntry
	daclPresent bool
}

func readDirSecurity(dir string) (dirSecurity, error) {
	descriptor, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return dirSecurity{}, err
	}
	var security dirSecurity
	if owner, _, err := descriptor.Owner(); err == nil && owner != nil {
		security.owner = owner.String()
	}
	// A DACL that is present but NULL is a null DACL, which grants everyone.
	dacl, _, err := descriptor.DACL()
	if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) || err == nil && dacl == nil {
		return security, nil
	}
	if err != nil {
		return dirSecurity{}, err
	}
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil {
			return dirSecurity{}, err
		}
		entry := aclEntry{Inherited: ace.Header.AceFlags&windows.INHERITED_ACE != 0}
		switch ace.Header.AceType {
		case windows.ACCESS_ALLOWED_ACE_TYPE, accessAllowedCallbackACEType:
		case windows.ACCESS_DENIED_ACE_TYPE, accessDeniedCallbackACEType:
			entry.Deny = true
		default:
			// Object ACEs keep their SID at another offset; a directory
			// should never carry one, so it is refused, not misread.
			return dirSecurity{}, fmt.Errorf("%w: %s has an access entry of type %d", ErrUnsafePath, dir, ace.Header.AceType)
		}
		entry.SID = (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		security.entries = append(security.entries, entry)
	}
	security.daclPresent = true
	return security, nil
}
