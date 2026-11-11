// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// requestsAfter are the requests server received after the first mark.
func requestsAfter(server *uplinktest.Server, mark int) []uplinktest.Request {
	requests := server.Requests()
	if mark > len(requests) {
		return nil
	}
	return requests[mark:]
}

func nonMe(requests []uplinktest.Request) []uplinktest.Request {
	var others []uplinktest.Request
	for _, request := range requests {
		if request.Path != headlessMePath {
			others = append(others, request)
		}
	}
	return others
}

func withToken(requests []uplinktest.Request, token string) int {
	count := 0
	for _, request := range requests {
		if request.Token == token {
			count++
		}
	}
	return count
}

func assertNoQuarantine(t *testing.T, root string) {
	t.Helper()
	if entries, err := os.ReadDir(filepath.Join(root, "quarantine")); err == nil && len(entries) != 0 {
		t.Fatalf("a hold quarantined connection state: %v", entries)
	}
}

func TestHeadlessRun_AStalledMeHoldsEveryCaptureSource(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.bindAndStop(t)
	hh.enqueue(t, headlessCaptureID(16))
	hh.hookIn(t, hh.repo, "SessionStart")
	if names, _ := inbox.List(filepath.Join(hh.data, "inbox")); len(names) != 1 {
		t.Fatalf("the hook should have left one inbox item, found %d", len(names))
	}
	before := connectionScopedDigest(t, hh.data)
	mark := len(hh.server.Requests())
	release := stall(t, hh.server, headlessMePath)

	hh.start(t)
	waitForWithin(t, "the stalled /me", 10*time.Second, func() bool {
		return len(requestsAfter(hh.server, mark)) > 0
	}, nil)
	time.Sleep(500 * time.Millisecond)
	if others := nonMe(requestsAfter(hh.server, mark)); len(others) != 0 {
		t.Fatalf("requests sent before /me verified:\n%s", describeRequests(others))
	}
	assertSameDigest(t, "the queue, inbox and cursors while /me is stalled", before, connectionScopedDigest(t, hh.data))
	// The 5 s /me deadline turns the stall into a hold.
	hh.waitForLogReason(t, "server_unavailable", 9*time.Second)
	if others := nonMe(requestsAfter(hh.server, mark)); len(others) != 0 {
		t.Fatalf("requests sent while held:\n%s", describeRequests(others))
	}
	assertSameDigest(t, "the queue, inbox and cursors while held", before, connectionScopedDigest(t, hh.data))

	release()
	waitForWithin(t, "the held record to upload once /me answers", 15*time.Second, func() bool {
		return containsID(receivedCaptureIDs(hh.server), headlessCaptureID(16))
	}, func() string { return logText(hh.logPath) })
}

func TestHeadlessRun_MeReportingAnotherIdentityHolds(t *testing.T) {
	cases := map[string]func(identity *uplinktest.DeviceIdentity){
		"installation": func(identity *uplinktest.DeviceIdentity) { identity.InstallationID = headlessOtherInstallationID },
		"owner":        func(identity *uplinktest.DeviceIdentity) { identity.OwnerEmail = headlessOtherOwnerEmail },
	}
	for name, mismatch := range cases {
		t.Run(name+" of a bound root", func(t *testing.T) {
			hh := newHeadlessHarness(t)
			hh.bindAndStop(t)
			hh.enqueue(t, headlessCaptureID(17))
			before := connectionScopedDigest(t, hh.data)
			mark := len(hh.server.Requests())
			hh.server.Lock()
			mismatch(hh.server.DeviceTokens[headlessSentinelToken()])
			hh.server.Unlock()

			hh.start(t)
			hh.waitForLogReason(t, "identity_mismatch", 10*time.Second)
			hh.controlHeadlessReason(t, "identity_mismatch")
			time.Sleep(300 * time.Millisecond)
			if others := nonMe(requestsAfter(hh.server, mark)); len(others) != 0 {
				t.Fatalf("captured under an identity /me did not verify:\n%s", describeRequests(others))
			}
			assertSameDigest(t, "the bound ledger and queue", before, connectionScopedDigest(t, hh.data))
			assertNoQuarantine(t, hh.data)
		})
		t.Run(name+" of a fresh root", func(t *testing.T) {
			hh := newHeadlessHarness(t)
			hh.server.Lock()
			mismatch(hh.server.DeviceTokens[headlessSentinelToken()])
			hh.server.Unlock()
			hh.start(t)
			hh.waitForLogReason(t, "identity_mismatch", 10*time.Second)
			time.Sleep(300 * time.Millisecond)
			if others := nonMe(hh.server.Requests()); len(others) != 0 {
				t.Fatalf("captured under an identity /me did not verify:\n%s", describeRequests(others))
			}
			if _, err := os.Stat(filepath.Join(hh.data, "binding.json")); err == nil {
				t.Fatal("a mismatched identity was bound")
			}
		})
	}
}

func TestHeadlessRun_APolicyForAnotherInstallationHolds(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.bindAndStop(t)
	hh.enqueue(t, headlessCaptureID(18))
	layout := store.Layout{Root: hh.data}
	cachedBefore, err := os.ReadFile(layout.Policy())
	if err != nil {
		t.Fatalf("the bound run cached no policy: %v", err)
	}
	queueBefore := digestEntries(t, hh.data, "queue")
	mark := len(hh.server.Requests())
	hh.server.Lock()
	hh.server.PolicyInstallationID = headlessOtherInstallationID
	hh.server.Unlock()

	hh.start(t)
	hh.waitForLogReason(t, "identity_mismatch", 10*time.Second)
	time.Sleep(300 * time.Millisecond)
	for _, request := range requestsAfter(hh.server, mark) {
		if request.Path != headlessMePath && request.Path != headlessPolicyPath {
			t.Errorf("captured under another installation's policy: %s %s", request.Method, request.Path)
		}
	}
	if cachedAfter, _ := os.ReadFile(layout.Policy()); !bytes.Equal(cachedBefore, cachedAfter) {
		t.Fatal("another installation's policy replaced the cached one")
	}
	assertSameDigest(t, "the queue", queueBefore, digestEntries(t, hh.data, "queue"))
}

// meFault makes GET /me fail one way.
type meFault struct {
	name   string
	reason string
	apply  func(server, redirectTarget *uplinktest.Server)
}

func meFaults() []meFault {
	status := func(code int) func(server, _ *uplinktest.Server) {
		return func(server, _ *uplinktest.Server) { server.Status[headlessMePath] = code }
	}
	canned := func(answer uplinktest.Canned) func(server, _ *uplinktest.Server) {
		return func(server, _ *uplinktest.Server) {
			server.Canned = map[string]uplinktest.Canned{headlessMePath: answer}
		}
	}
	redirect := func(code int) func(server, target *uplinktest.Server) {
		return func(server, target *uplinktest.Server) {
			server.Canned = map[string]uplinktest.Canned{headlessMePath: {Status: code, Header: map[string]string{"Location": target.URL + headlessMePath}}}
		}
	}
	return []meFault{
		{"bare 401", "upstream_unauthorized", status(401)},
		{"html 401", "upstream_unauthorized", canned(uplinktest.Canned{Status: 401, Header: map[string]string{"Content-Type": "text/html"}, Body: "<html><body>Sign in to continue</body></html>"})},
		{"403", "upstream_forbidden", status(403)},
		{"404 companion off", "companion_unavailable", canned(uplinktest.Canned{Status: 404, Header: map[string]string{"Content-Type": "application/json"}, Body: `{"detail":"Not Found","error_code":"not_found"}`})},
		{"307", "endpoint_redirected", redirect(307)},
		{"308", "endpoint_redirected", redirect(308)},
		{"302", "endpoint_redirected", redirect(302)},
		{"429", "server_unavailable", status(429)},
		{"500", "server_unavailable", status(500)},
		{"503", "server_unavailable", status(503)},
		{"network drop", "server_unavailable", func(server, _ *uplinktest.Server) {
			server.Drop = map[string]bool{headlessMePath: true}
		}},
	}
}

func healMe(server *uplinktest.Server) {
	server.Lock()
	defer server.Unlock()
	delete(server.Status, headlessMePath)
	server.Canned = nil
	server.Drop = nil
}

func TestHeadlessRun_ClassifiesEachMeFailureAndCapturesNothingBeforeVerifying(t *testing.T) {
	for _, fault := range meFaults() {
		t.Run(fault.name, func(t *testing.T) {
			hh := newHeadlessHarness(t)
			target := uplinktest.New(t)
			target.IssueDeviceToken(headlessSentinelToken(), headlessInstallationID, headlessOwnerEmail)
			hh.server.Lock()
			fault.apply(hh.server, target)
			hh.server.Unlock()

			hh.start(t)
			hh.waitForLogReason(t, fault.reason, 10*time.Second)
			// The hold polls on; its reason is logged once, not per poll.
			waitForRequests(t, hh.server, headlessMePath, requestsTo(hh.server, headlessMePath)+3)
			if lines := linesContaining(logText(hh.logPath), fault.reason); lines != 1 {
				t.Fatalf("%s logged %d times, want once per change:\n%s", fault.reason, lines, logText(hh.logPath))
			}
			block := hh.controlHeadlessReason(t, fault.reason)
			if since, _ := block["since"].(string); since == "" {
				t.Fatalf("a hold reports since when: %v", block)
			}
			if others := nonMe(hh.server.Requests()); len(others) != 0 {
				t.Fatalf("requests sent before /me verified:\n%s", describeRequests(others))
			}
			if requests := target.Requests(); len(requests) != 0 {
				t.Fatalf("a redirect was followed:\n%s", describeRequests(requests))
			}
			for _, name := range []string{"binding.json", "admission.json", "installation.json"} {
				if _, err := os.Stat(filepath.Join(hh.data, name)); err == nil {
					t.Fatalf("%s written before /me verified", name)
				}
			}

			healMe(hh.server)
			hh.waitForSessions(t, 1)
			hh.boundRecord(t)
			if requests := target.Requests(); len(requests) != 0 {
				t.Fatalf("the redirect target was reached:\n%s", describeRequests(requests))
			}
		})
	}
}

func TestHeadlessRun_ARejectedTokenIsNeverSentAgainUntilTheFileChanges(t *testing.T) {
	hh := newHeadlessHarness(t)
	bound := hh.bindAndStop(t)
	hh.enqueue(t, headlessCaptureID(26))
	before := connectionScopedDigest(t, hh.data)
	tokenBefore, _ := os.ReadFile(hh.tokenPath)
	mark := len(hh.server.Requests())
	hh.server.RevokeDeviceToken(headlessSentinelToken())

	hh.start(t)
	hh.waitForLogReason(t, "credential_rejected", 10*time.Second)
	hh.controlHeadlessReason(t, "credential_rejected")
	admission, err := state.Load[state.Admission](store.Layout{Root: hh.data}.Admission())
	if err != nil || !admission.RevokedFor(headlessInstallationID) {
		t.Fatalf("the rejection was not recorded in admission.json: %+v %v", admission, err)
	}
	if tokenAfter, err := os.ReadFile(hh.tokenPath); err != nil || !bytes.Equal(tokenBefore, tokenAfter) {
		t.Fatalf("the operator's token file was touched: %v", err)
	}
	assertSameDigest(t, "the queue and ledger after a rejection", before, connectionScopedDigest(t, hh.data))
	sent := withToken(hh.server.Requests(), headlessSentinelToken())
	// Fifty poll intervals with the same, unchanged file.
	time.Sleep(50 * headlessPoll)
	if again := withToken(hh.server.Requests(), headlessSentinelToken()); again != sent {
		t.Fatalf("the rejected token was sent %d more times", again-sent)
	}
	if others := nonMe(requestsAfter(hh.server, mark)); len(others) != 0 {
		t.Fatalf("captured with a rejected token:\n%s", describeRequests(others))
	}

	// Rotation: the owner rotated on the web, the operator renamed the new
	// token in. Same identity, so the same binding and ledger resume.
	hh.server.IssueDeviceToken(headlessRotatedToken(), headlessInstallationID, headlessOwnerEmail)
	rotated := len(hh.server.Requests())
	hh.writeToken(t, headlessRotatedToken())
	waitForWithin(t, "the queued record to upload with the rotated token", 10*time.Second, func() bool {
		return containsID(receivedCaptureIDs(hh.server), headlessCaptureID(26))
	}, func() string { return logText(hh.logPath) })
	if stale := withToken(requestsAfter(hh.server, rotated), headlessSentinelToken()); stale != 0 {
		t.Fatalf("the replaced token was sent %d times after the rotation", stale)
	}
	admission, _ = state.Load[state.Admission](store.Layout{Root: hh.data}.Admission())
	if admission.RevokedFor(headlessInstallationID) {
		t.Fatal("a verified rotation must clear the recorded rejection")
	}
	if record := hh.boundRecord(t); record.BindingID != bound.BindingID || !record.BoundAt.Equal(bound.BoundAt) {
		t.Fatalf("rotation changed the binding: %+v, was %+v", record, bound)
	}
	assertNoQuarantine(t, hh.data)
	if calls := hh.keyring.calls.Load(); calls != 0 {
		t.Fatalf("the keyring was called %d times", calls)
	}
}

func TestHeadlessRun_ARevocationMidSessionHoldsAndDeletesNothing(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.start(t)
	hh.waitForSessions(t, 1)
	tokenBefore, _ := os.ReadFile(hh.tokenPath)
	hh.server.RevokeDeviceToken(headlessSentinelToken())
	hh.enqueue(t, headlessCaptureID(27))

	hh.waitForLogReason(t, "credential_rejected", 10*time.Second)
	sent := withToken(hh.server.Requests(), headlessSentinelToken())
	time.Sleep(50 * headlessPoll)
	if again := withToken(hh.server.Requests(), headlessSentinelToken()); again != sent {
		t.Fatalf("the rejected token was sent %d more times", again-sent)
	}
	if tokenAfter, err := os.ReadFile(hh.tokenPath); err != nil || !bytes.Equal(tokenBefore, tokenAfter) {
		t.Fatalf("the operator's token file was touched: %v", err)
	}
	if got := queuedRecords(t, store.Layout{Root: hh.data}); got != 1 {
		t.Fatalf("the unacknowledged record must stay queued, %d left", got)
	}
	if record := hh.boundRecord(t); record.InstallationID != headlessInstallationID {
		t.Fatalf("binding changed: %+v", record)
	}
	if calls := hh.keyring.calls.Load(); calls != 0 {
		t.Fatalf("the keyring was called %d times", calls)
	}
}

// Every refusal and hold reason is a stable code with its own message, as
// every other code the companion logs or answers is.
func TestHeadlessReasons_AreLocalizedCodes(t *testing.T) {
	for _, code := range []string{
		"credential_source_conflict", "headless_operator_managed", "credential_missing", "credential_unsafe",
		"credential_malformed", "credential_rejected", "upstream_unauthorized", "upstream_forbidden",
		"companion_unavailable", "endpoint_redirected", "identity_mismatch", "switch_in_progress",
	} {
		t.Run(code, func(t *testing.T) { assertLocalized(t, code) })
	}
}
