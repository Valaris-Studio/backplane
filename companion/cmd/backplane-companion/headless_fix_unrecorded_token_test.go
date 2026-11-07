// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/binding"
)

// A binding that records no verified token file (one a recovered switch
// wrote, or one written before the field existed) must still hold a config
// switch until the token file changes: which token it verified is unknown,
// so the present file is taken to be its.
func TestHeadlessFixSwitch_ABindingWithoutAVerifiedTokenStillHoldsTheSwitch(t *testing.T) {
	hh := newHeadlessHarness(t)
	second := hh.secondServer(t, headlessOtherInstallationID)
	bound := hh.bindAndStop(t)
	record, err := binding.Load(hh.data)
	if err != nil || record == nil {
		t.Fatalf("bound record: %+v %v", record, err)
	}
	record.VerifiedTokenFile = nil
	if err := binding.Save(hh.data, *record); err != nil {
		t.Fatal(err)
	}

	hh.writeConfig(t, hh.configFor(second.URL, headlessOtherInstallationID))
	hh.start(t)
	hh.waitForLogReason(t, "token_not_replaced_for_switch", 10*time.Second)
	time.Sleep(50 * headlessPoll)
	if sent := second.Requests(); len(sent) != 0 {
		t.Fatalf("a token of unknown provenance was sent to the new origin:\n%s", describeRequests(sent))
	}
	if held := hh.boundRecord(t); held.BindingID != bound.BindingID {
		t.Fatalf("the hold switched the binding: %+v, was %+v", held, bound)
	}

	second.IssueDeviceToken(headlessRotatedToken(), headlessOtherInstallationID, headlessOwnerEmail)
	hh.writeToken(t, headlessRotatedToken())
	hh.waitForSessions(t, 2)
	if stale := withToken(second.Requests(), headlessSentinelToken()); stale != 0 {
		t.Fatalf("the previous token reached the new origin %d times", stale)
	}
	if switched := hh.boundRecord(t); switched.BindingID != hh.identity(second.URL, headlessOtherInstallationID).ID() {
		t.Fatalf("binding after the token was replaced: %+v", switched)
	}
}
