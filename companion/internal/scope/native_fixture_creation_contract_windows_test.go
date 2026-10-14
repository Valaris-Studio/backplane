// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestNativeFixture_CreateDirectoryOwnsParentAndChild(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	parent := filepath.Join(t.TempDir(), "owned parent Ω")
	child := filepath.Join(parent, "Child")
	for _, path := range []string{parent, child} {
		if err := createPhysicalFixtureDirectory(path); err != nil {
			t.Fatal(err)
		}
	}
	for _, entry := range []struct{ name, path string }{{"parent", parent}, {"child", child}} {
		t.Run(entry.name, func(t *testing.T) {
			info, sd := readCreatedFixture(t, entry.path)
			if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				t.Fatal("created fixture must be a physical directory")
			}
			owner, _, err := sd.Owner()
			if err != nil || owner == nil || !owner.Equals(user.User.Sid) {
				t.Errorf("new fixture owner must equal TokenUser: %v", err)
			}
			control, _, err := sd.Control()
			if err != nil || control&windows.SE_DACL_PRESENT == 0 || control&windows.SE_DACL_PROTECTED == 0 {
				t.Errorf("new fixture requires a present protected DACL: control=%x err=%v", control, err)
			}
			acl, _, err := sd.DACL()
			if err != nil || acl == nil || acl.AceCount != 2 {
				t.Fatalf("new fixture requires a non-null DACL with exactly two grants: %v", err)
			}
			seen := map[string]bool{}
			for i := uint32(0); i < 2; i++ {
				var ace *windows.ACCESS_ALLOWED_ACE
				if err := windows.GetAce(acl, i, &ace); err != nil {
					t.Fatal(err)
				}
				// FILE_ALL_ACCESS includes the nine file-specific rights (0x1ff).
				const fullAccess = windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1ff
				if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceFlags != windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE || ace.Mask != fullAccess {
					t.Fatalf("unexpected fixture ACE type/flags/rights: %+v", *ace)
				}
				sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
				if !sid.IsValid() || (!sid.Equals(user.User.Sid) && !sid.Equals(system)) || seen[sid.String()] {
					t.Fatal("fixture grants must name current user and SYSTEM exactly once")
				}
				seen[sid.String()] = true
			}
		})
	}
}

func observeExistingFixture(t *testing.T, path string) func() {
	t.Helper()
	beforeInfo, beforeSD := readCreatedFixture(t, path)
	before, err := nativeSecuritySnapshotOf(beforeSD)
	if err != nil {
		t.Fatal(err)
	}
	return func() {
		t.Helper()
		afterInfo, afterSD := readCreatedFixture(t, path)
		after, err := nativeSecuritySnapshotOf(afterSD)
		if err != nil || after != before {
			t.Errorf("refusal changed owner/group/DACL/control: %v", err)
		}
		if afterInfo.VolumeSerialNumber != beforeInfo.VolumeSerialNumber || afterInfo.FileIndexHigh != beforeInfo.FileIndexHigh || afterInfo.FileIndexLow != beforeInfo.FileIndexLow || afterInfo.FileAttributes != beforeInfo.FileAttributes {
			t.Error("refusal changed existing path identity or attributes")
		}
	}
}

func readCreatedFixture(t *testing.T, path string) (windows.ByHandleFileInformation, *windows.SECURITY_DESCRIPTOR) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := windows.CloseHandle(h); err != nil {
			t.Errorf("close fixture observation: %v", err)
		}
	}()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, nativeSecurityFields)
	if err != nil {
		t.Fatal(err)
	}
	return info, sd
}
