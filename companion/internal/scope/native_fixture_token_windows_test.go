// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import "golang.org/x/sys/windows"

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

func nativeOrdinaryAccess(t nativeOrdinaryTokenFixture, adjust func(windows.Token, windows.LUID, uint32) error, attach func(windows.Token) error) error {
	return nil
}
