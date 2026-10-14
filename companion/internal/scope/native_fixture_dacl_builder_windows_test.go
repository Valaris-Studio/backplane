// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func nativeBuildListDeny(saved *windows.SECURITY_DESCRIPTOR, user *windows.SID) (*windows.SECURITY_DESCRIPTOR, error) {
	control, _, err := saved.Control()
	if err != nil {
		return nil, err
	}
	changed, err := windows.BuildSecurityDescriptor(nil, nil, []windows.EXPLICIT_ACCESS{nativeListDeny(user)}, nil, saved)
	if err != nil {
		return nil, err
	}
	// BuildSecurityDescriptor can drop DACL protection; retain original inheritance controls.
	const daclInheritanceControls = windows.SE_DACL_AUTO_INHERIT_REQ | windows.SE_DACL_AUTO_INHERITED | windows.SE_DACL_PROTECTED
	if err := changed.SetControl(daclInheritanceControls, control&daclInheritanceControls); err != nil {
		return nil, err
	}
	return changed, nil
}

type nativeListDenyWitness struct {
	OwnerEqual             bool   `json:"owner_equal"`
	GroupEqual             bool   `json:"group_equal"`
	ControlEqual           bool   `json:"control_equal"`
	OldControl             uint16 `json:"old_control"`
	NewControl             uint16 `json:"new_control"`
	OldACLBounds           bool   `json:"old_acl_bounds"`
	NewACLBounds           bool   `json:"new_acl_bounds"`
	OldACLBytes            int    `json:"old_acl_bytes"`
	NewACLBytes            int    `json:"new_acl_bytes"`
	ACLLengthExpected      bool   `json:"acl_length_expected"`
	OldACECount            uint16 `json:"old_ace_count"`
	NewACECount            uint16 `json:"new_ace_count"`
	ACECountExpected       bool   `json:"ace_count_expected"`
	DenyTypeExpected       bool   `json:"deny_type_expected"`
	DenyFlagsExpected      bool   `json:"deny_flags_expected"`
	DenyACEBytes           uint16 `json:"deny_ace_bytes"`
	ExpectedDenyBytes      int    `json:"expected_deny_bytes"`
	DenySizeExpected       bool   `json:"deny_size_expected"`
	DenyMaskExpected       bool   `json:"deny_mask_expected"`
	DenySIDEqual           bool   `json:"deny_sid_equal"`
	OriginalACESuffixEqual bool   `json:"original_ace_suffix_equal"`
}

func nativeListDenyWitnessFor(before, after nativeSecuritySnapshot, user *windows.SID) nativeListDenyWitness {
	oldACL, newACL := []byte(before.dacl), []byte(after.dacl)
	denySize := 8 + user.Len()
	w := nativeListDenyWitness{
		OwnerEqual: before.owner == after.owner, GroupEqual: before.group == after.group,
		ControlEqual: before.control == after.control, OldControl: before.control, NewControl: after.control,
		OldACLBounds: len(oldACL) >= 8, NewACLBounds: len(newACL) >= 8+denySize,
		OldACLBytes: len(oldACL), NewACLBytes: len(newACL), ExpectedDenyBytes: denySize,
		ACLLengthExpected: len(newACL) == len(oldACL)+denySize,
	}
	if len(oldACL) >= 8 {
		w.OldACECount = binary.LittleEndian.Uint16(oldACL[4:6])
	}
	if len(newACL) >= 8 {
		w.NewACECount = binary.LittleEndian.Uint16(newACL[4:6])
		w.ACECountExpected = w.OldACLBounds && w.NewACECount == w.OldACECount+1
	}
	if w.NewACLBounds {
		w.DenyACEBytes = binary.LittleEndian.Uint16(newACL[10:12])
		w.DenyTypeExpected = newACL[8] == windows.ACCESS_DENIED_ACE_TYPE
		w.DenyFlagsExpected = newACL[9] == 0
		w.DenySizeExpected = int(w.DenyACEBytes) == denySize
		w.DenyMaskExpected = binary.LittleEndian.Uint32(newACL[12:16]) == windows.FILE_LIST_DIRECTORY
		w.DenySIDEqual = bytes.Equal(newACL[16:8+denySize], unsafe.Slice((*byte)(unsafe.Pointer(user)), user.Len()))
		w.OriginalACESuffixEqual = w.OldACLBounds && bytes.Equal(newACL[8+denySize:], oldACL[8:])
	}
	return w
}

func (w nativeListDenyWitness) matches() bool {
	return w.OwnerEqual && w.GroupEqual && w.ControlEqual && w.OldACLBounds && w.NewACLBounds &&
		w.ACLLengthExpected && w.ACECountExpected && w.DenyTypeExpected && w.DenyFlagsExpected &&
		w.DenySizeExpected && w.DenyMaskExpected && w.DenySIDEqual && w.OriginalACESuffixEqual
}

func (w nativeListDenyWitness) log(t *testing.T, context string) {
	t.Helper()
	encoded, err := json.Marshal(w)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("DACL_BUILDER_WITNESS %s %s", context, encoded)
}

func nativeListDenyTestDescriptor(t *testing.T) (*windows.SECURITY_DESCRIPTOR, *windows.SID, nativeSecuritySnapshot) {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	saved, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "G:SYD:P(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;FA;;;SY)")
	if err != nil {
		t.Fatal(err)
	}
	before, err := nativeSecuritySnapshotOf(saved)
	if err != nil {
		t.Fatal(err)
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	sidBytes := func(sid *windows.SID) []byte { return unsafe.Slice((*byte)(unsafe.Pointer(sid)), sid.Len()) }
	if !bytes.Equal([]byte(before.owner), sidBytes(user.User.Sid)) || !bytes.Equal([]byte(before.group), sidBytes(system)) || before.control != windows.SE_DACL_PRESENT|windows.SE_DACL_PROTECTED {
		t.Fatal("synthetic descriptor requires explicit user owner, SYSTEM group and protected DACL")
	}
	acl := []byte(before.dacl)
	if len(acl) < 8 || binary.LittleEndian.Uint16(acl[4:6]) != 2 {
		t.Fatal("synthetic descriptor requires exactly two grants")
	}
	position := 8
	for _, sid := range []*windows.SID{user.User.Sid, system} {
		size := 8 + sid.Len()
		// FILE_ALL_ACCESS includes the nine file-specific rights (0x1ff).
		const fullAccess = windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1ff
		if position+size > len(acl) || acl[position] != windows.ACCESS_ALLOWED_ACE_TYPE || acl[position+1] != windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE ||
			int(binary.LittleEndian.Uint16(acl[position+2:position+4])) != size || binary.LittleEndian.Uint32(acl[position+4:position+8]) != fullAccess ||
			!bytes.Equal(acl[position+8:position+size], sidBytes(sid)) {
			t.Fatal("synthetic grants must be exact inheritable user/SYSTEM full-access ACEs")
		}
		position += size
	}
	if position != len(acl) {
		t.Fatal("synthetic DACL contains unexpected trailing bytes")
	}
	return saved, user.User.Sid, before
}

func TestNativeFixture_ListDenyBuilderPreservesProtectedDescriptor(t *testing.T) {
	saved, user, before := nativeListDenyTestDescriptor(t)
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
	witness := nativeListDenyWitnessFor(before, after, user)
	witness.log(t, "synthetic-protected-descriptor")
	if !witness.matches() {
		t.Fatal("fixture DACL builder changed more than one non-inheritable list-only denial")
	}
}

func TestNativeFixture_ListDenyWitnessReportsExactInsertion(t *testing.T) {
	_, user, before := nativeListDenyTestDescriptor(t)
	oldACL := []byte(before.dacl)
	denySize := 8 + user.Len()
	newACL := make([]byte, len(oldACL)+denySize)
	copy(newACL[:8], oldACL[:8])
	binary.LittleEndian.PutUint16(newACL[2:4], uint16(len(newACL)))
	binary.LittleEndian.PutUint16(newACL[4:6], binary.LittleEndian.Uint16(oldACL[4:6])+1)
	newACL[8] = windows.ACCESS_DENIED_ACE_TYPE
	binary.LittleEndian.PutUint16(newACL[10:12], uint16(denySize))
	binary.LittleEndian.PutUint32(newACL[12:16], windows.FILE_LIST_DIRECTORY)
	copy(newACL[16:8+denySize], unsafe.Slice((*byte)(unsafe.Pointer(user)), user.Len()))
	copy(newACL[8+denySize:], oldACL[8:])
	// Oracle bytes exercise diagnostics only; they are never passed to Windows.
	after := before
	after.dacl = string(newACL)
	if !nativeListDenyWitnessFor(before, after, user).matches() {
		t.Fatal("exact insertion must satisfy every witness term")
	}
	after.control ^= windows.SE_DACL_PROTECTED
	witness := nativeListDenyWitnessFor(before, after, user)
	if witness.ControlEqual || !witness.OwnerEqual || !witness.GroupEqual || !witness.OriginalACESuffixEqual || !witness.DenySIDEqual || witness.matches() {
		t.Fatal("control-only difference must remain distinguishable")
	}
	after = before
	after.dacl = string(newACL[:8+denySize-1])
	witness = nativeListDenyWitnessFor(before, after, user)
	if !witness.OldACLBounds || witness.NewACLBounds || witness.DenySIDEqual || witness.OriginalACESuffixEqual || witness.matches() {
		t.Fatal("truncated denial must be reported without slicing beyond its boundary")
	}
	after.dacl = ""
	before.dacl = ""
	witness = nativeListDenyWitnessFor(before, after, user)
	if witness.OldACLBounds || witness.NewACLBounds || witness.ACECountExpected || witness.matches() {
		t.Fatal("absent ACL headers must be reported without reading beyond their boundary")
	}
}
