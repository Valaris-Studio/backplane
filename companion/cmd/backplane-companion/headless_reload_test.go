// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func TestHeadlessRun_DeletingTheTokenEndsTheSessionInBoundAndRecreatingResumes(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.start(t)
	hh.waitForSessions(t, 1)
	bound := hh.boundRecord(t)

	deleted := time.Now()
	if err := os.Remove(hh.tokenPath); err != nil {
		t.Fatal(err)
	}
	hh.waitForLogReason(t, "credential_missing", sessionEndBound+time.Second)
	if elapsed := time.Since(deleted); elapsed > sessionEndBound {
		t.Fatalf("the session outlived its deleted token by %v (bound ~2.2 s)", elapsed)
	}
	mark := len(hh.server.Requests())
	hh.enqueue(t, headlessCaptureID(29))
	time.Sleep(500 * time.Millisecond)
	if sent := requestsAfter(hh.server, mark); len(sent) != 0 {
		t.Fatalf("requests sent with no token file:\n%s", describeRequests(sent))
	}
	if got := queuedRecords(t, store.Layout{Root: hh.data}); got != 1 {
		t.Fatalf("the queue must be kept while held, %d records", got)
	}
	hh.controlHeadlessReason(t, "credential_missing")

	hh.writeToken(t, headlessSentinelToken())
	waitForWithin(t, "the record queued while held to upload once the file is back", 10*time.Second, func() bool {
		return containsID(receivedCaptureIDs(hh.server), headlessCaptureID(29))
	}, func() string { return logText(hh.logPath) })
	hh.waitForSessions(t, 2)
	if record := hh.boundRecord(t); record.BindingID != bound.BindingID || !record.BoundAt.Equal(bound.BoundAt) {
		t.Fatalf("the recreated file changed the binding: %+v, was %+v", record, bound)
	}
}

func TestHeadlessRun_AnUnsafeOrMalformedTokenHoldsUntilFixed(t *testing.T) {
	malformed := "bpc_" + strings.Repeat("Mf3", 14)
	cases := []struct {
		name, reason string
		breakFile    func(t *testing.T, hh *headlessHarness)
		fixFile      func(t *testing.T, hh *headlessHarness)
	}{
		{"readable by others", "credential_unsafe",
			func(t *testing.T, hh *headlessHarness) { mustChmod(t, hh.tokenPath, 0o644) },
			func(t *testing.T, hh *headlessHarness) { mustChmod(t, hh.tokenPath, 0o600) }},
		{"group writable", "credential_unsafe",
			func(t *testing.T, hh *headlessHarness) { mustChmod(t, hh.tokenPath, 0o620) },
			func(t *testing.T, hh *headlessHarness) { mustChmod(t, hh.tokenPath, 0o400) }},
		{"malformed content", "credential_malformed",
			func(t *testing.T, hh *headlessHarness) { hh.writeToken(t, malformed) },
			func(t *testing.T, hh *headlessHarness) { hh.writeToken(t, headlessSentinelToken()) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHeadlessHarness(t)
			hh.start(t)
			hh.waitForSessions(t, 1)
			broken := time.Now()
			tc.breakFile(t, hh)
			hh.waitForLogReason(t, tc.reason, sessionEndBound+time.Second)
			if elapsed := time.Since(broken); elapsed > sessionEndBound {
				t.Fatalf("the session outlived its unusable token by %v", elapsed)
			}
			mark := len(hh.server.Requests())
			hh.enqueue(t, headlessCaptureID(30))
			time.Sleep(500 * time.Millisecond)
			if sent := requestsAfter(hh.server, mark); len(sent) != 0 {
				t.Fatalf("requests sent with an unusable token file:\n%s", describeRequests(sent))
			}
			assertNoTokenTrace(t, "the log", []byte(logText(hh.logPath)), headlessSentinelToken(), malformed)

			tc.fixFile(t, hh)
			waitForWithin(t, "capture to resume once the file is fixed", 10*time.Second, func() bool {
				return containsID(receivedCaptureIDs(hh.server), headlessCaptureID(30))
			}, func() string { return logText(hh.logPath) })
		})
	}
}

func mustChmod(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func TestHeadlessRun_ATokenOfAnotherInstallationHoldsWithoutQuarantine(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.server.IssueDeviceToken(headlessForeignToken(), headlessOtherInstallationID, headlessOwnerEmail)
	hh.start(t)
	hh.waitForSessions(t, 1)
	bound := hh.boundRecord(t)
	hh.enqueue(t, headlessCaptureID(32))
	waitForWithin(t, "the first record to upload", 10*time.Second, func() bool {
		return containsID(receivedCaptureIDs(hh.server), headlessCaptureID(32))
	}, nil)
	mark := len(hh.server.Requests())

	swapped := time.Now()
	hh.writeToken(t, headlessForeignToken())
	hh.waitForLogReason(t, "identity_mismatch", sessionEndBound+5*time.Second)
	if elapsed := time.Since(swapped); elapsed > sessionEndBound+5*time.Second {
		t.Fatalf("the swapped token was noticed after %v", elapsed)
	}
	held := connectionScopedDigest(t, hh.data)
	hh.enqueue(t, headlessCaptureID(33))
	time.Sleep(500 * time.Millisecond)
	for _, request := range requestsAfter(hh.server, mark) {
		if request.Token == headlessForeignToken() && request.Path != headlessMePath {
			t.Errorf("captured with another installation's token: %s %s", request.Method, request.Path)
		}
	}
	if containsID(receivedCaptureIDs(hh.server), headlessCaptureID(33)) {
		t.Fatal("a record captured after the swap was uploaded")
	}
	// Only the config can switch a binding: the token alone moves nothing.
	assertNoQuarantine(t, hh.data)
	if record := hh.boundRecord(t); record.BindingID != bound.BindingID || !record.BoundAt.Equal(bound.BoundAt) {
		t.Fatalf("a swapped token changed the binding: %+v, was %+v", record, bound)
	}
	after := connectionScopedDigest(t, hh.data)
	for path, digest := range held {
		if !strings.HasPrefix(path, "queue") && after[path] != digest {
			t.Errorf("%s changed while held under a token of another installation", path)
		}
	}
}

func TestHeadlessControlAPI_ProbeCacheDoesNotOutliveTheTokenFile(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.start(t)
	hh.waitForSessions(t, 1)
	connected := func() bool {
		_, body := hh.control(t, "GET", "/v1/status", "")
		var status struct {
			Connected bool `json:"connected"`
		}
		json.Unmarshal(body, &status)
		return status.Connected
	}
	if !connected() {
		t.Fatal("a verified headless session reports connected")
	}
	deleted := time.Now()
	if err := os.Remove(hh.tokenPath); err != nil {
		t.Fatal(err)
	}
	waitForWithin(t, "the control API to stop reporting a connection whose token file is gone", sessionEndBound+2*time.Second, func() bool {
		return !connected()
	}, nil)
	if elapsed := time.Since(deleted); elapsed > sessionEndBound+2*time.Second {
		t.Fatalf("the control API kept a cached token-bearing probe for %v", elapsed)
	}
}
