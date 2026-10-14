// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func init() {
	prepareNativeSensitiveDirectory = nativeSensitiveDirectory
	prepareNativeUnreadableParent = nativeUnreadableParent
}

func TestNativeFixture_DenyEntryOnlyRemovesParentListing(t *testing.T) {
	entry := nativeListDeny(nil)
	if entry.AccessPermissions != windows.FILE_LIST_DIRECTORY || entry.AccessMode != windows.DENY_ACCESS || entry.Inheritance != windows.NO_INHERITANCE {
		t.Fatalf("deny entry broadens the fixture: %+v", entry)
	}
	if entry.Trustee.TrusteeForm != windows.TRUSTEE_IS_SID || entry.Trustee.TrusteeType != windows.TRUSTEE_IS_USER {
		t.Fatalf("deny entry must name only its current-user SID: %+v", entry.Trustee)
	}
}

func nativePrerequisite(t *testing.T, operation string, err error) {
	t.Helper()
	if err == nil {
		return
	}
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) || errors.Is(err, windows.ERROR_NOT_SUPPORTED) || errors.Is(err, windows.ERROR_INVALID_FUNCTION) {
		t.Skipf("UNQUALIFIED native fixture prerequisite %s: %v", operation, err)
	}
	t.Fatalf("native fixture %s: %v", operation, err)
}

func ownedNativeDirectory(t *testing.T, path string, access uint32) (windows.Handle, *windows.SID) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, access|windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	nativePrerequisite(t, "owned directory handle", err)
	var info windows.ByHandleFileInformation
	t.Cleanup(func() {
		var final windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(h, &final); err != nil || final.VolumeSerialNumber != info.VolumeSerialNumber || final.FileIndexHigh != info.FileIndexHigh || final.FileIndexLow != info.FileIndexLow {
			t.Errorf("INCOMPLETE owned fixture handle identity: %v", err)
		}
		if err := windows.CloseHandle(h); err != nil {
			t.Errorf("close owned fixture handle: %v", err)
		}
	})
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		t.Fatal(err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		t.Fatal("native fixture is not a physical directory")
	}
	var filesystem [32]uint16
	var serial, maximum, flags uint32
	nativePrerequisite(t, "filesystem identity", windows.GetVolumeInformationByHandle(h, nil, 0, &serial, &maximum, &flags, &filesystem[0], uint32(len(filesystem))))
	if windows.UTF16ToString(filesystem[:]) != "NTFS" {
		t.Skip("UNQUALIFIED native fixture requires an owned NTFS directory")
	}
	token, err := windows.GetCurrentProcessToken().GetTokenUser()
	nativePrerequisite(t, "current user", err)
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	nativePrerequisite(t, "owner identity", err)
	owner, _, err := sd.Owner()
	if err != nil {
		t.Fatal(err)
	}
	if !owner.Equals(token.User.Sid) {
		t.Skip("UNQUALIFIED native fixture owner differs from current user")
	}
	t.Logf("OWNED native fixture %q volume=%x file=%x:%x NTFS non-reparse current-user", path, info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow)
	return h, token.User.Sid
}

func nativeCaseFlags(h windows.Handle) (uint32, error) {
	var flags uint32
	err := windows.GetFileInformationByHandleEx(h, windows.FileCaseSensitiveInfo, (*byte)(unsafe.Pointer(&flags)), uint32(unsafe.Sizeof(flags)))
	return flags, err
}

func nativeSetCaseFlags(h windows.Handle, flags uint32) error {
	return windows.SetFileInformationByHandle(h, windows.FileCaseSensitiveInfo, (*byte)(unsafe.Pointer(&flags)), uint32(unsafe.Sizeof(flags)))
}

func nativeSensitiveDirectory(t *testing.T, parent string) bool {
	t.Helper()
	h, _ := ownedNativeDirectory(t, parent, windows.FILE_WRITE_ATTRIBUTES)
	initial, err := nativeCaseFlags(h)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		t.Skipf("UNQUALIFIED native case-sensitivity query: %v", err)
	}
	nativePrerequisite(t, "case-sensitivity query", err)
	if initial & ^uint32(windows.FILE_CS_FLAG_CASE_SENSITIVE_DIR) != 0 {
		t.Fatalf("unknown case-sensitivity flags: %x", initial)
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatalf("case fixture must start empty: entries=%d err=%v", len(entries), err)
	}
	if initial == windows.FILE_CS_FLAG_CASE_SENSITIVE_DIR {
		t.Logf("UNCHANGED native case fixture %q flags=%x; no feature write", parent, initial)
		return true
	}
	err = mutateOwnedFixture(t, func() error { return nativeSetCaseFlags(h, windows.FILE_CS_FLAG_CASE_SENSITIVE_DIR) }, func() error {
		// Child handle cleanups register later and run first. Never recurse.
		for _, name := range []string{"Repo", "repo"} {
			for _, path := range []string{filepath.Join(parent, name, "child"), filepath.Join(parent, name)} {
				if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
					return fmt.Errorf("remove owned case fixture %q: %w", path, err)
				}
			}
		}
		if err := nativeSetCaseFlags(h, initial); err != nil {
			return err
		}
		got, err := nativeCaseFlags(h)
		if err != nil || got != initial {
			return fmt.Errorf("case flag restore: got=%x want=%x err=%v", got, initial, err)
		}
		t.Logf("RESTORED native case fixture %q flags=%x", parent, got)
		return nil
	})
	if err != nil {
		t.Fatalf("native case flag write attempted: %v", err)
	}
	got, err := nativeCaseFlags(h)
	if err != nil || got != windows.FILE_CS_FLAG_CASE_SENSITIVE_DIR {
		t.Fatalf("native case flag not enabled after write: %x %v", got, err)
	}
	return true
}

const nativeSecurityFields = windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION
const nativeSecurityControls = windows.SE_OWNER_DEFAULTED | windows.SE_GROUP_DEFAULTED | windows.SE_DACL_PRESENT | windows.SE_DACL_DEFAULTED | windows.SE_DACL_AUTO_INHERIT_REQ | windows.SE_DACL_AUTO_INHERITED | windows.SE_DACL_PROTECTED

type nativeSecuritySnapshot struct {
	owner, group, dacl string
	control            uint16
}

// GetSecurityInfo supplies a self-relative descriptor; capture only the exact
// requested owner/group/DACL bytes and their controls. SACL is never requested.
func nativeSecuritySnapshotOf(sd *windows.SECURITY_DESCRIPTOR) (nativeSecuritySnapshot, error) {
	var result nativeSecuritySnapshot
	if sd == nil || !sd.IsValid() || sd.Length() < 20 || sd.Length() > 65536 {
		return result, errors.New("invalid fixture security descriptor")
	}
	raw := unsafe.Slice((*byte)(unsafe.Pointer(sd)), int(sd.Length()))
	controls := binary.LittleEndian.Uint16(raw[2:4])
	if controls&windows.SE_SELF_RELATIVE == 0 {
		return result, errors.New("fixture security descriptor is not self-relative")
	}
	component := func(at int, acl bool) (string, error) {
		offset := int(binary.LittleEndian.Uint32(raw[at : at+4]))
		if offset < 20 || offset+8 > len(raw) {
			return "", errors.New("missing or invalid fixture security component")
		}
		length := 8 + 4*int(raw[offset+1])
		if acl {
			length = int(binary.LittleEndian.Uint16(raw[offset+2 : offset+4]))
		}
		if length < 8 || offset+length > len(raw) {
			return "", errors.New("invalid fixture security component size")
		}
		return string(raw[offset : offset+length]), nil
	}
	var err error
	if result.owner, err = component(4, false); err != nil {
		return result, err
	}
	if result.group, err = component(8, false); err != nil {
		return result, err
	}
	if result.dacl, err = component(16, true); err != nil {
		return result, err
	}
	result.control = controls & nativeSecurityControls
	return result, nil
}

func nativeListDeny(sid *windows.SID) windows.EXPLICIT_ACCESS {
	return windows.EXPLICIT_ACCESS{AccessPermissions: windows.FILE_LIST_DIRECTORY, AccessMode: windows.DENY_ACCESS, Inheritance: windows.NO_INHERITANCE,
		Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeType: windows.TRUSTEE_IS_USER, TrusteeValue: windows.TrusteeValueFromSID(sid)}}
}

func nativeDACLFields(control uint16) windows.SECURITY_INFORMATION {
	if control&windows.SE_DACL_PROTECTED != 0 {
		return windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION
	}
	return windows.DACL_SECURITY_INFORMATION | windows.UNPROTECTED_DACL_SECURITY_INFORMATION
}

func nativeUnreadableParent(t *testing.T, parent, child string) bool {
	t.Helper()
	h, user := ownedNativeDirectory(t, parent, windows.WRITE_DAC)
	saved, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, nativeSecurityFields)
	nativePrerequisite(t, "original DACL", err)
	before, err := nativeSecuritySnapshotOf(saved)
	if err != nil {
		t.Skipf("UNQUALIFIED native DACL snapshot: %v", err)
	}
	if err := nativeListing(t, "before-deny", parent, h, user); err != nil {
		t.Fatalf("owned parent must be listable initially: %v", err)
	}
	childBefore := openDirectoryInfo(t, child)
	childHandle, _ := ownedNativeDirectory(t, child, 0)
	childSecurity, err := windows.GetSecurityInfo(childHandle, windows.SE_FILE_OBJECT, nativeSecurityFields)
	nativePrerequisite(t, "original child DACL", err)
	childSnapshot, err := nativeSecuritySnapshotOf(childSecurity)
	if err != nil {
		t.Skipf("UNQUALIFIED native child DACL snapshot: %v", err)
	}
	verifyChild := func() error {
		sd, err := windows.GetSecurityInfo(childHandle, windows.SE_FILE_OBJECT, nativeSecurityFields)
		if err != nil {
			return err
		}
		got, err := nativeSecuritySnapshotOf(sd)
		if err != nil || got != childSnapshot {
			return fmt.Errorf("child owner/group/DACL/control changed: %v", err)
		}
		return nil
	}
	var pin runtime.Pinner
	pin.Pin(user)
	defer pin.Unpin()
	changed, err := nativeBuildListDeny(saved, user)
	if err != nil {
		t.Fatal(err)
	}
	after, err := nativeSecuritySnapshotOf(changed)
	if err != nil {
		t.Fatal(err)
	}
	oldACL, newACL := []byte(before.dacl), []byte(after.dacl)
	denySize := 8 + user.Len()
	nativeListDenyWitnessFor(before, after, user).log(t, "physical-prewrite")
	if before.owner != after.owner || before.group != after.group || before.control != after.control ||
		len(newACL) != len(oldACL)+denySize || binary.LittleEndian.Uint16(newACL[4:6]) != binary.LittleEndian.Uint16(oldACL[4:6])+1 ||
		newACL[8] != windows.ACCESS_DENIED_ACE_TYPE || newACL[9] != 0 || int(binary.LittleEndian.Uint16(newACL[10:12])) != denySize ||
		binary.LittleEndian.Uint32(newACL[12:16]) != windows.FILE_LIST_DIRECTORY || !bytes.Equal(newACL[16:8+denySize], unsafe.Slice((*byte)(unsafe.Pointer(user)), user.Len())) ||
		!bytes.Equal(newACL[8+denySize:], oldACL[8:]) {
		t.Fatal("fixture DACL builder changed more than one non-inheritable list-only denial")
	}
	err = mutateOwnedFixture(t, func() error { return windows.SetKernelObjectSecurity(h, nativeDACLFields(before.control), changed) }, func() error {
		if err := windows.SetKernelObjectSecurity(h, nativeDACLFields(before.control), saved); err != nil {
			return err
		}
		restored, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, nativeSecurityFields)
		if err != nil {
			return err
		}
		got, err := nativeSecuritySnapshotOf(restored)
		if err != nil || got != before {
			return fmt.Errorf("owner/group/DACL/control restore mismatch: %v", err)
		}
		if err := nativeListing(t, "restored", parent, h, user); err != nil {
			return fmt.Errorf("restored parent listing: %w", err)
		}
		if err := verifyChild(); err != nil {
			return err
		}
		t.Logf("RESTORED native DACL fixture %q owner/group/DACL/control bytes", parent)
		return nil
	})
	if err != nil {
		t.Fatalf("native DACL write attempted: %v", err)
	}
	observed, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, nativeSecurityFields)
	if err != nil {
		t.Fatal(err)
	}
	got, err := nativeSecuritySnapshotOf(observed)
	if err != nil || got != after {
		t.Fatalf("native DACL write changed unexpected security components: %v", err)
	}
	if err := verifyChild(); err != nil {
		t.Fatal(err)
	}
	if err := nativeListing(t, "after-deny", parent, h, user); !os.IsPermission(err) {
		t.Fatalf("native fixture did not deny parent listing: %v", err)
	}
	if !os.SameFile(childBefore, openDirectoryInfo(t, child)) {
		t.Fatal("list denial changed child traversal identity")
	}
	return true
}
