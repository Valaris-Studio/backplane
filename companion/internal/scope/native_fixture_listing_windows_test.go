// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

type nativeListingResult struct {
	Status string `json:"status"`
	Code   uint32 `json:"code,omitempty"`
}

func nativeListingResultOf(err error) nativeListingResult {
	if err == nil {
		return nativeListingResult{Status: "ok"}
	}
	var code syscall.Errno
	if errors.As(err, &code) {
		return nativeListingResult{Status: "win32_error", Code: uint32(code)}
	}
	return nativeListingResult{Status: "other_error"}
}

type nativeListingToken struct {
	Source         string              `json:"source"`
	ThreadOpen     nativeListingResult `json:"thread_open"`
	ProcessOpen    nativeListingResult `json:"process_open"`
	UserQuery      nativeListingResult `json:"user_query"`
	PrivilegeQuery nativeListingResult `json:"privilege_query"`
	PrivilegeLUID  nativeListingResult `json:"privilege_luid"`
	Close          nativeListingResult `json:"close"`
	ExpectedUser   string              `json:"expected_user"`
	BackupPresent  string              `json:"backup_present"`
	BackupEnabled  string              `json:"backup_enabled"`
}

// One fixed, aligned buffer per query; an oversized or malformed response is
// unknown evidence, never an absent privilege or a mismatched user.
func nativeListingTokenInfo(token windows.Token, class uint32) ([]byte, nativeListingResult) {
	var aligned [512]uint64
	buffer := unsafe.Slice((*byte)(unsafe.Pointer(&aligned[0])), int(unsafe.Sizeof(aligned)))
	var length uint32
	err := windows.GetTokenInformation(token, class, &buffer[0], uint32(len(buffer)), &length)
	if err != nil {
		return nil, nativeListingResultOf(err)
	}
	if length == 0 || length > uint32(len(buffer)) {
		return nil, nativeListingResult{Status: "invalid_response"}
	}
	return buffer[:length], nativeListingResultOf(nil)
}

func nativeListingEffectiveToken(expected *windows.SID) (result nativeListingToken) {
	unattempted := nativeListingResult{Status: "not_attempted"}
	result = nativeListingToken{
		Source: "unknown", ProcessOpen: unattempted, UserQuery: unattempted,
		PrivilegeQuery: unattempted, PrivilegeLUID: unattempted, Close: unattempted,
		ExpectedUser: "unknown", BackupPresent: "unknown", BackupEnabled: "unknown",
	}
	var token windows.Token
	err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &token)
	result.ThreadOpen = nativeListingResultOf(err)
	if errors.Is(err, windows.ERROR_NO_TOKEN) {
		err = windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token)
		result.ProcessOpen = nativeListingResultOf(err)
		if err == nil {
			result.Source = "process"
		}
	} else if err == nil {
		result.Source = "thread"
	}
	if err != nil {
		return result
	}
	defer func() { result.Close = nativeListingResultOf(token.Close()) }()
	user, status := nativeListingTokenInfo(token, windows.TokenUser)
	result.UserQuery = status
	if status.Status == "ok" {
		result.UserQuery.Status = "invalid_response"
		if len(user) >= int(unsafe.Sizeof(windows.Tokenuser{})) {
			sid := (*windows.Tokenuser)(unsafe.Pointer(&user[0])).User.Sid
			base, address := uintptr(unsafe.Pointer(&user[0])), uintptr(unsafe.Pointer(sid))
			if address >= base && address-base <= uintptr(len(user)-8) {
				offset := int(address - base)
				length := 8 + 4*int(user[offset+1])
				if length <= len(user)-offset && sid.IsValid() && expected != nil && expected.IsValid() {
					result.UserQuery.Status = "ok"
					result.ExpectedUser = "different"
					if sid.Equals(expected) {
						result.ExpectedUser = "match"
					}
				}
			}
		}
	}
	runtime.KeepAlive(user)
	privileges, status := nativeListingTokenInfo(token, windows.TokenPrivileges)
	result.PrivilegeQuery = status
	if status.Status != "ok" {
		return result
	}
	if len(privileges) < 4 || uint64(binary.LittleEndian.Uint32(privileges[:4])) > uint64((len(privileges)-4)/12) {
		result.PrivilegeQuery.Status = "invalid_response"
		return result
	}
	name, err := windows.UTF16PtrFromString("SeBackupPrivilege")
	if err != nil {
		result.PrivilegeLUID = nativeListingResultOf(err)
		return result
	}
	var luid windows.LUID
	err = windows.LookupPrivilegeValue(nil, name, &luid)
	result.PrivilegeLUID = nativeListingResultOf(err)
	if err != nil {
		return result
	}
	result.BackupPresent, result.BackupEnabled = "absent", "not_present"
	for index := uint32(0); index < binary.LittleEndian.Uint32(privileges[:4]); index++ {
		entry := privileges[4+int(index)*12:][:12]
		if binary.LittleEndian.Uint32(entry[:4]) == luid.LowPart && int32(binary.LittleEndian.Uint32(entry[4:8])) == luid.HighPart {
			result.BackupPresent, result.BackupEnabled = "present", "disabled"
			if binary.LittleEndian.Uint32(entry[8:12])&windows.SE_PRIVILEGE_ENABLED != 0 {
				result.BackupEnabled = "enabled"
			}
			break
		}
	}
	return result
}

func nativeListing(t *testing.T, phase, path string, retained windows.Handle, user *windows.SID) error {
	t.Helper()
	// Thread-token selection and the actual directory open must share a thread.
	// No token or privilege is changed, and diagnostic errors do not change the
	// original open/read/close result or close-before-read error precedence.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	unattempted := nativeListingResult{Status: "not_attempted"}
	witness := struct {
		Phase          string              `json:"phase"`
		Token          nativeListingToken  `json:"token"`
		Open           nativeListingResult `json:"open"`
		Read           nativeListingResult `json:"read"`
		Close          nativeListingResult `json:"close"`
		RetainedInfo   nativeListingResult `json:"retained_info"`
		OpenedInfo     nativeListingResult `json:"opened_info"`
		HandleIdentity string              `json:"handle_identity"`
		ReturnedCount  int                 `json:"returned_count"`
		SyntheticChild string              `json:"synthetic_child"`
	}{Phase: phase, Token: nativeListingEffectiveToken(user), Open: unattempted, Read: unattempted, Close: unattempted,
		RetainedInfo: unattempted, OpenedInfo: unattempted, HandleIdentity: "unknown", ReturnedCount: -1, SyntheticChild: "unknown"}
	defer func() {
		encoded, err := json.Marshal(witness)
		if err != nil {
			t.Log("LISTING_WITNESS encoding_failed")
			return
		}
		t.Logf("LISTING_WITNESS %s", encoded)
	}()
	directory, err := os.Open(path)
	witness.Open = nativeListingResultOf(err)
	if err != nil {
		return err
	}
	var retainedInfo, openedInfo windows.ByHandleFileInformation
	retainedErr := windows.GetFileInformationByHandle(retained, &retainedInfo)
	openedErr := windows.GetFileInformationByHandle(windows.Handle(directory.Fd()), &openedInfo)
	witness.RetainedInfo, witness.OpenedInfo = nativeListingResultOf(retainedErr), nativeListingResultOf(openedErr)
	if retainedErr == nil && openedErr == nil {
		witness.HandleIdentity = "different"
		if retainedInfo.VolumeSerialNumber == openedInfo.VolumeSerialNumber && retainedInfo.FileIndexHigh == openedInfo.FileIndexHigh && retainedInfo.FileIndexLow == openedInfo.FileIndexLow {
			witness.HandleIdentity = "match"
		}
	}
	names, readErr := directory.Readdirnames(-1)
	witness.Read, witness.ReturnedCount = nativeListingResultOf(readErr), len(names)
	if readErr == nil {
		witness.SyntheticChild = "absent"
	}
	for _, name := range names {
		if name == "Child" {
			witness.SyntheticChild = "present"
			break
		}
	}
	closeErr := directory.Close()
	witness.Close = nativeListingResultOf(closeErr)
	if closeErr != nil {
		return fmt.Errorf("close listing handle: %w", closeErr)
	}
	return readErr
}
