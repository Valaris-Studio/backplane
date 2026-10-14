// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"bytes"
	"errors"
	"runtime"
	"testing"

	"golang.org/x/sys/windows"
)

type nativeTokenCleanupProbe struct {
	fixtureCleanupProbe
	log func(string, ...any)
}

func (p *nativeTokenCleanupProbe) Logf(format string, args ...any) { p.log(format, args...) }

func (p *nativeTokenCleanupProbe) run() {
	for i := len(p.cleanup) - 1; i >= 0; i-- {
		p.cleanup[i]()
	}
	p.cleanup = nil
}

func tokenControlInfo(t *testing.T, token windows.Token, class uint32) []byte {
	t.Helper()
	data, result := nativeListingTokenInfo(token, class)
	if result.Status != "ok" {
		t.Fatalf("control token query failed: %+v", result)
	}
	return append([]byte(nil), data...)
}

func tokenControlCurrent(t *testing.T) windows.Token {
	t.Helper()
	var token windows.Token
	if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &token); err != nil {
		t.Fatalf("effective thread token: %v", err)
	}
	return token
}

func tokenControlClose(t *testing.T, token windows.Token) {
	t.Helper()
	if err := token.Close(); err != nil {
		t.Errorf("close control token: %v", err)
	}
}

// Each control owns this thread and starts without a thread token. The outer
// cleanup is a last-resort restoration for an assertion failure in the control.
func tokenControlThread(t *testing.T, prior bool) (windows.Token, []byte) {
	t.Helper()
	runtime.LockOSThread()
	thread := windows.GetCurrentThreadId()
	var existing windows.Token
	err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &existing)
	if !errors.Is(err, windows.ERROR_NO_TOKEN) {
		if err == nil {
			tokenControlClose(t, existing)
		}
		runtime.UnlockOSThread()
		t.Fatalf("control requires an initially unimpersonated thread: %v", err)
	}
	var owned windows.Token
	t.Cleanup(func() {
		if windows.GetCurrentThreadId() != thread {
			t.Error("control moved to another OS thread")
			return
		}
		if err := windows.SetThreadToken(nil, 0); err != nil {
			t.Errorf("INCOMPLETE control thread restoration: %v", err)
			return
		}
		var check windows.Token
		if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &check); !errors.Is(err, windows.ERROR_NO_TOKEN) {
			if err == nil {
				tokenControlClose(t, check)
			}
			t.Errorf("INCOMPLETE control thread token still present: %v", err)
			return
		}
		if owned != 0 {
			tokenControlClose(t, owned)
		}
		runtime.UnlockOSThread()
	})
	if !prior {
		return 0, nil
	}
	var source windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &source); err != nil {
		t.Fatal(err)
	}
	err = windows.DuplicateTokenEx(source, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_IMPERSONATE, nil, windows.SecurityImpersonation, windows.TokenImpersonation, &owned)
	tokenControlClose(t, source)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetThreadToken(nil, owned); err != nil {
		t.Fatal(err)
	}
	return owned, tokenControlInfo(t, owned, windows.TokenStatistics)
}

func TestNativeFixture_OrdinaryTokenRestoresExactPriorContext(t *testing.T) {
	for _, prior := range []bool{false, true} {
		name := "no-prior-token"
		if prior {
			name = "owned-prior-token"
		}
		t.Run(name, func(t *testing.T) {
			owned, before := tokenControlThread(t, prior)
			thread := windows.GetCurrentThreadId()
			processBefore := tokenControlInfo(t, windows.GetCurrentProcessToken(), windows.TokenPrivileges)
			var priorPrivileges []byte
			if prior {
				priorPrivileges = tokenControlInfo(t, owned, windows.TokenPrivileges)
			}
			p := &nativeTokenCleanupProbe{log: t.Logf}
			t.Cleanup(p.run)
			if err := nativeOrdinaryAccess(p, nativeAdjustBackup, nativeSetThreadToken); err != nil {
				t.Fatal(err)
			}
			current := tokenControlCurrent(t)
			during := tokenControlInfo(t, current, windows.TokenStatistics)
			if prior && bytes.Equal(during[:8], before[:8]) {
				t.Error("fixture reused its source token instead of an owned duplicate")
			}
			user, err := windows.GetCurrentProcessToken().GetTokenUser()
			if err != nil {
				t.Fatal(err)
			}
			witness := nativeListingEffectiveToken(user.User.Sid)
			if witness.Source != "thread" || witness.ExpectedUser != "match" || (witness.BackupEnabled != "disabled" && witness.BackupEnabled != "not_present") {
				t.Errorf("ordinary token is not established: %+v", witness)
			}
			tokenControlClose(t, current)
			physicalCleanupRan := false
			p.Cleanup(func() {
				physicalCleanupRan = true
				current := tokenControlCurrent(t)
				defer tokenControlClose(t, current)
				if got := tokenControlInfo(t, current, windows.TokenStatistics); !bytes.Equal(got[:8], during[:8]) {
					t.Error("token restored before physical fixture cleanup")
				}
			})
			p.run()
			if !physicalCleanupRan || p.errors != 0 || windows.GetCurrentThreadId() != thread {
				t.Fatalf("cleanup=%v errors=%d sameThread=%v", physicalCleanupRan, p.errors, windows.GetCurrentThreadId() == thread)
			}
			if prior {
				current := tokenControlCurrent(t)
				defer tokenControlClose(t, current)
				if got := tokenControlInfo(t, current, windows.TokenStatistics); !bytes.Equal(got, before) {
					t.Error("prior token identity/statistics were not restored exactly")
				}
				if got := tokenControlInfo(t, owned, windows.TokenPrivileges); !bytes.Equal(got, priorPrivileges) {
					t.Error("source token privileges changed")
				}
			} else {
				var current windows.Token
				if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &current); !errors.Is(err, windows.ERROR_NO_TOKEN) {
					if err == nil {
						tokenControlClose(t, current)
					}
					t.Errorf("absent prior token not restored: %v", err)
				}
			}
			if got := tokenControlInfo(t, windows.GetCurrentProcessToken(), windows.TokenPrivileges); !bytes.Equal(got, processBefore) {
				t.Error("process token privileges changed")
			}
		})
	}
}

func TestNativeFixture_OrdinaryTokenAttachmentFailureStillRestores(t *testing.T) {
	tokenControlThread(t, false)
	p := &nativeTokenCleanupProbe{log: t.Logf}
	t.Cleanup(p.run)
	want := errors.New("attachment acknowledgement lost")
	attempts := 0
	err := nativeOrdinaryAccess(p, nativeAdjustBackup, func(token windows.Token) error {
		attempts++
		if attempts == 1 && len(p.cleanup) != 1 {
			t.Error("cleanup was not registered before attachment")
		}
		if err := nativeSetThreadToken(token); err != nil {
			return err
		}
		if attempts == 1 {
			return want
		}
		return nil
	})
	if !errors.Is(err, want) {
		t.Errorf("attachment failure lost: %v", err)
	}
	p.run()
	if attempts != 2 || p.errors != 0 {
		t.Errorf("attachment/restoration attempts=%d cleanup errors=%d", attempts, p.errors)
	}
}

func TestNativeFixture_OrdinaryTokenRejectsAdjustmentFailureAndFalseSuccess(t *testing.T) {
	for _, falseSuccess := range []bool{false, true} {
		t.Run(map[bool]string{false: "adjustment-error", true: "readback-mismatch"}[falseSuccess], func(t *testing.T) {
			tokenControlThread(t, false)
			user, err := windows.GetCurrentProcessToken().GetTokenUser()
			if err != nil {
				t.Fatal(err)
			}
			if got := nativeListingEffectiveToken(user.User.Sid); got.BackupEnabled != "enabled" {
				t.Skip("UNQUALIFIED failure control requires backup enabled in the source token")
			}
			p := &nativeTokenCleanupProbe{log: t.Logf}
			t.Cleanup(p.run)
			adjusted, attached := 0, 0
			err = nativeOrdinaryAccess(p, func(windows.Token, windows.LUID, uint32) error {
				adjusted++
				if falseSuccess {
					return nil
				}
				return errors.New("adjustment refused")
			}, func(token windows.Token) error {
				attached++
				return nativeSetThreadToken(token)
			})
			if err == nil || adjusted != 1 || attached != 0 {
				t.Errorf("unsafe setup accepted: err=%v adjustment=%d attachment=%d", err, adjusted, attached)
			}
			p.run()
			if p.errors != 0 {
				t.Errorf("pre-attachment failure cleanup errors=%d", p.errors)
			}
		})
	}
}
