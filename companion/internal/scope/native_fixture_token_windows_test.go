// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"encoding/binary"
	"errors"
	"fmt"
	"reflect"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func init() {
	prepareNativeOrdinaryAccess = func(t *testing.T) error {
		return nativeOrdinaryAccess(t, nativeAdjustBackup, nativeSetThreadToken)
	}
}

type nativeOrdinaryTokenFixture interface {
	Cleanup(func())
	Errorf(string, ...any)
	Logf(string, ...any)
}

func nativeSetThreadToken(token windows.Token) error { return windows.SetThreadToken(nil, token) }

func nativeAdjustBackup(token windows.Token, luid windows.LUID, attributes uint32) error {
	state := windows.Tokenprivileges{PrivilegeCount: 1, Privileges: [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: attributes}}}
	return windows.AdjustTokenPrivileges(token, false, &state, 0, nil, nil)
}

type nativeOrdinaryTokenState struct {
	statistics     string
	user           string
	userAttributes uint32
	groups         map[string]uint32
	privileges     map[windows.LUID]uint32
	kind, level    uint32
}

func nativeTokenData(token windows.Token, class uint32) ([]byte, error) {
	data, status := nativeListingTokenInfo(token, class)
	if status.Status != "ok" {
		return nil, fmt.Errorf("bounded token query %d: %s code=%d", class, status.Status, status.Code)
	}
	return data, nil
}

func nativeTokenSID(data []byte, sid *windows.SID) (string, error) {
	if len(data) < 8 {
		return "", errors.New("token SID buffer too small")
	}
	base, address := uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(sid))
	if address < base || address-base > uintptr(len(data)-8) {
		return "", errors.New("token SID outside query buffer")
	}
	offset := int(address - base)
	length := 8 + 4*int(data[offset+1])
	if length > len(data)-offset || !sid.IsValid() {
		return "", errors.New("invalid token SID")
	}
	return string(data[offset : offset+length]), nil
}

func nativeReadOrdinaryToken(token windows.Token) (state nativeOrdinaryTokenState, err error) {
	statistics, err := nativeTokenData(token, windows.TokenStatistics)
	if err != nil {
		return state, err
	}
	if len(statistics) < 56 {
		return state, errors.New("token statistics buffer too small")
	}
	state.statistics = string(statistics)
	state.kind = binary.LittleEndian.Uint32(statistics[24:28])
	state.level = binary.LittleEndian.Uint32(statistics[28:32])
	user, err := nativeTokenData(token, windows.TokenUser)
	if err != nil {
		return state, err
	}
	if len(user) < int(unsafe.Sizeof(windows.Tokenuser{})) {
		return state, errors.New("token user buffer too small")
	}
	info := (*windows.Tokenuser)(unsafe.Pointer(&user[0]))
	state.user, err = nativeTokenSID(user, info.User.Sid)
	state.userAttributes = info.User.Attributes
	runtime.KeepAlive(user)
	if err != nil {
		return state, err
	}
	groups, err := nativeTokenData(token, windows.TokenGroups)
	if err != nil {
		return state, err
	}
	if len(groups) < int(unsafe.Offsetof(windows.Tokengroups{}.Groups)) {
		return state, errors.New("token groups buffer too small")
	}
	groupOffset := int(unsafe.Offsetof(windows.Tokengroups{}.Groups))
	groupSize := int(unsafe.Sizeof(windows.SIDAndAttributes{}))
	count := binary.LittleEndian.Uint32(groups[:4])
	if uint64(count) > uint64((len(groups)-groupOffset)/groupSize) {
		return state, errors.New("invalid bounded token group count")
	}
	state.groups = make(map[string]uint32, count)
	for i := 0; i < int(count); i++ {
		group := (*windows.SIDAndAttributes)(unsafe.Pointer(&groups[groupOffset+i*groupSize]))
		sid, err := nativeTokenSID(groups, group.Sid)
		if err != nil {
			return state, err
		}
		if _, duplicate := state.groups[sid]; duplicate {
			return state, errors.New("duplicate token group")
		}
		state.groups[sid] = group.Attributes
	}
	runtime.KeepAlive(groups)
	privileges, err := nativeTokenData(token, windows.TokenPrivileges)
	if err != nil {
		return state, err
	}
	if len(privileges) < 4 {
		return state, errors.New("token privileges buffer too small")
	}
	count = binary.LittleEndian.Uint32(privileges[:4])
	if uint64(count) > uint64((len(privileges)-4)/12) {
		return state, errors.New("invalid bounded token privilege count")
	}
	state.privileges = make(map[windows.LUID]uint32, count)
	for i := 0; i < int(count); i++ {
		entry := privileges[4+i*12:][:12]
		luid := windows.LUID{LowPart: binary.LittleEndian.Uint32(entry[:4]), HighPart: int32(binary.LittleEndian.Uint32(entry[4:8]))}
		if _, duplicate := state.privileges[luid]; duplicate {
			return state, errors.New("duplicate token privilege")
		}
		state.privileges[luid] = binary.LittleEndian.Uint32(entry[8:12])
	}
	return state, nil
}

func nativeSameTokenAccess(a, b nativeOrdinaryTokenState) bool {
	return a.user == b.user && a.userAttributes == b.userAttributes && reflect.DeepEqual(a.groups, b.groups) && reflect.DeepEqual(a.privileges, b.privileges)
}

func nativeOrdinaryAccess(t nativeOrdinaryTokenFixture, adjust func(windows.Token, windows.LUID, uint32) error, attach func(windows.Token) error) error {
	runtime.LockOSThread()
	thread := windows.GetCurrentThreadId()
	var prior, process, duplicate windows.Token
	var priorState, processState nativeOrdinaryTokenState
	var havePriorState, haveProcessState, attachmentAttempted bool
	// Registered first: the DACL, handles and fixture cleanup must run under
	// the reduced token before restoring this thread's original identity.
	t.Cleanup(func() {
		restored := windows.GetCurrentThreadId() == thread
		if !restored {
			t.Errorf("INCOMPLETE token restoration: OS thread changed")
		} else if attachmentAttempted {
			if err := attach(prior); err != nil {
				t.Errorf("INCOMPLETE token restoration: %v", err)
				restored = false
			}
			var current windows.Token
			err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &current)
			if prior == 0 {
				if !errors.Is(err, windows.ERROR_NO_TOKEN) {
					t.Errorf("INCOMPLETE absent thread token restoration: %v", err)
					restored = false
				}
			} else if err != nil {
				t.Errorf("INCOMPLETE prior thread token query: %v", err)
				restored = false
			} else if got, err := nativeReadOrdinaryToken(current); err != nil || !reflect.DeepEqual(got, priorState) {
				t.Errorf("INCOMPLETE exact prior token restoration: %v", err)
				restored = false
			}
			if current != 0 {
				if err := current.Close(); err != nil {
					t.Errorf("close restored token query: %v", err)
				}
			}
		}
		for _, saved := range []struct {
			token windows.Token
			state nativeOrdinaryTokenState
			known bool
		}{{prior, priorState, havePriorState}, {process, processState, haveProcessState}} {
			if saved.known {
				if got, err := nativeReadOrdinaryToken(saved.token); err != nil || !reflect.DeepEqual(got, saved.state) {
					t.Errorf("INCOMPLETE unchanged source/process token: %v", err)
					restored = false
				}
			}
		}
		for _, token := range []windows.Token{duplicate, prior, process} {
			if token != 0 {
				if err := token.Close(); err != nil {
					t.Errorf("close owned token handle: %v", err)
				}
			}
		}
		if restored {
			if attachmentAttempted {
				t.Logf("TOKEN_RESTORED prior=%t same_thread=true exact=true source_unchanged=true process_unchanged=true", prior != 0)
			} else {
				t.Logf("TOKEN_SETUP_CLEANED attachment_attempted=false same_thread=true")
			}
			runtime.UnlockOSThread()
		}
		// On unverified restoration, let the locked test goroutine exit. Its
		// altered OS thread must never return to the runtime's thread pool.
	})
	err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_IMPERSONATE, true, &prior)
	if err != nil && !errors.Is(err, windows.ERROR_NO_TOKEN) {
		return fmt.Errorf("open original thread token: %w", err)
	}
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &process); err != nil {
		return fmt.Errorf("open read-only process token: %w", err)
	}
	processState, err = nativeReadOrdinaryToken(process)
	if err != nil {
		return err
	}
	haveProcessState = true
	source, sourceState, level := process, processState, uint32(windows.SecurityImpersonation)
	if prior != 0 {
		priorState, err = nativeReadOrdinaryToken(prior)
		if err != nil {
			return err
		}
		havePriorState = true
		if priorState.kind != windows.TokenImpersonation || priorState.level < windows.SecurityImpersonation || priorState.level > windows.SecurityDelegation || priorState.user != processState.user {
			return errors.New("unsupported original thread identity or impersonation level")
		}
		source, sourceState, level = prior, priorState, priorState.level
	}
	if err := windows.DuplicateTokenEx(source, windows.TOKEN_QUERY|windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_IMPERSONATE, nil, level, windows.TokenImpersonation, &duplicate); err != nil {
		return fmt.Errorf("duplicate effective fixture token: %w", err)
	}
	initial, err := nativeReadOrdinaryToken(duplicate)
	if err != nil {
		return err
	}
	if !nativeSameTokenAccess(initial, sourceState) || initial.kind != windows.TokenImpersonation || initial.level != level || initial.statistics[:8] == sourceState.statistics[:8] {
		return errors.New("duplicate changed source access or identity was not distinct")
	}
	name, err := windows.UTF16PtrFromString("SeBackupPrivilege")
	if err != nil {
		return err
	}
	var backup windows.LUID
	if err := windows.LookupPrivilegeValue(nil, name, &backup); err != nil {
		return err
	}
	attributes, present := initial.privileges[backup]
	if attributes&windows.SE_PRIVILEGE_ENABLED != 0 {
		if err := adjust(duplicate, backup, attributes & ^uint32(windows.SE_PRIVILEGE_ENABLED)); err != nil {
			return fmt.Errorf("disable backup on owned duplicate: %w", err)
		}
		initial.privileges[backup] = attributes & ^uint32(windows.SE_PRIVILEGE_ENABLED)
	}
	reduced, err := nativeReadOrdinaryToken(duplicate)
	if err != nil {
		return err
	}
	if !nativeSameTokenAccess(reduced, initial) || reduced.kind != initial.kind || reduced.level != initial.level || reduced.statistics[:8] != initial.statistics[:8] {
		return errors.New("owned duplicate privilege readback differs from backup-only reduction")
	}
	attachmentAttempted = true
	if err := attach(duplicate); err != nil {
		return fmt.Errorf("attach ordinary fixture token: %w", err)
	}
	var effective windows.Token
	if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &effective); err != nil {
		return err
	}
	got, queryErr := nativeReadOrdinaryToken(effective)
	closeErr := effective.Close()
	if queryErr != nil || closeErr != nil {
		return errors.Join(queryErr, closeErr)
	}
	if windows.GetCurrentThreadId() != thread || !reflect.DeepEqual(got, reduced) {
		return errors.New("effective fixture token identity or access differs from owned duplicate")
	}
	t.Logf("TOKEN_ORDINARY prior=%t same_thread=true owned_duplicate=true backup_present=%t backup_disabled=true other_access_unchanged=true", prior != 0, present)
	return nil
}
