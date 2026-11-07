// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/binding"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// fixCrashedSwitchBack leaves the data root as an operator's switch back to
// the first binding that crashed once the second binding's state was
// quarantined: the first's state (firstIDs queued, an inbox item) waits in
// its quarantine, the second's (secondID queued) in its own, and the root
// holds neither. The config already names the first binding again.
func (hh *headlessHarness) fixCrashedSwitchBack(t *testing.T, second *uplinktest.Server) (original binding.Record, firstIDs []string, secondID string) {
	t.Helper()
	original = hh.bindAndStop(t)
	firstIDs = []string{headlessCaptureID(60), headlessCaptureID(61)}
	hh.enqueue(t, firstIDs...)
	stamped := inbox.Item{Agent: "claude_code", ReceivedAt: time.Now().UTC(), Payload: map[string]any{"cwd": hh.repo}}
	if err := inbox.Write(filepath.Join(hh.data, "inbox"), stamped); err != nil {
		t.Fatal(err)
	}
	first := hh.identity(hh.server.URL, headlessInstallationID)
	other := hh.identity(second.URL, headlessOtherInstallationID)
	if err := binding.SwitchTo(hh.data, first, other, time.Now().UTC().Truncate(time.Second)); err != nil {
		t.Fatalf("setting up the switch away: %v", err)
	}
	if _, err := store.Open(hh.data); err != nil {
		t.Fatal(err)
	}
	secondID = headlessCaptureID(62)
	hh.enqueue(t, secondID)
	crashSwitch(t, hh.data, hh.boundRecord(t), other, first, "quarantined", time.Now().UTC().Truncate(time.Second))
	return original, firstIDs, secondID
}

// fixReopenRoot is what `docker exec … status` (or a hook) run before the
// restart does: it recreates inbox/, queue/ and work/ empty where the
// quarantine moved them away.
func (hh *headlessHarness) fixReopenRoot(t *testing.T) {
	t.Helper()
	hh.cli(t, "status")
	if _, err := store.Open(hh.data); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"queue", "inbox", "work"} {
		if entries, err := os.ReadDir(filepath.Join(hh.data, dir)); err != nil || len(entries) != 0 {
			t.Fatalf("precondition: %s/ must be an empty directory: %v %v", dir, entries, err)
		}
	}
}

// fixWords splits text into the words a stable code or entry name is made of.
func fixWords(text string) []string {
	return strings.FieldsFunc(text, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.')
	})
}

func fixHasWord(text, word string) bool {
	for _, found := range fixWords(text) {
		if found == word {
			return true
		}
	}
	return false
}

// fixNamesEntry reports whether any string in a status block names entry.
func fixNamesEntry(value any, entry string) bool {
	switch typed := value.(type) {
	case string:
		return fixHasWord(typed, entry)
	case map[string]any:
		for _, member := range typed {
			if fixNamesEntry(member, entry) {
				return true
			}
		}
	case []any:
		for _, member := range typed {
			if fixNamesEntry(member, entry) {
				return true
			}
		}
	}
	return false
}

// fixLogNames reports whether a log line carrying code also names entry.
func fixLogNames(log, code, entry string) bool {
	for _, line := range strings.Split(log, "\n") {
		if fixHasWord(line, code) && fixHasWord(line, entry) {
			return true
		}
	}
	return false
}

func TestHeadlessFixSwitch_ASwitchBackCompletesOverDirsAWriterRecreatedBeforeTheRestart(t *testing.T) {
	hh := newHeadlessHarness(t)
	first := hh.server
	second := hh.secondServer(t, headlessOtherInstallationID)
	original, firstIDs, secondID := hh.fixCrashedSwitchBack(t, second)
	hh.fixReopenRoot(t)
	// Re-provisioned for the first server, so no token rule holds this start.
	hh.writeToken(t, headlessSentinelToken())
	secondMark := len(second.Requests())

	hh.start(t)
	hh.waitForSessions(t, 2)
	if _, err := os.Lstat(filepath.Join(hh.data, "binding-switch.json")); err == nil {
		t.Fatal("the switch journal was left behind")
	}
	if restored := hh.boundRecord(t); restored.BindingID != original.BindingID || !restored.BoundAt.Equal(original.BoundAt) {
		t.Fatalf("switch-back binding %+v, want %s bound at %v", restored, original.BindingID, original.BoundAt)
	}
	waitForWithin(t, "the restored records to reach the first server", 10*time.Second, func() bool {
		got := receivedCaptureIDs(first)
		return containsID(got, firstIDs[0]) && containsID(got, firstIDs[1])
	}, func() string { return describeRequests(first.Requests()) })
	if _, err := os.Stat(filepath.Join(hh.data, "quarantine", original.BindingID)); err == nil {
		t.Fatal("the restored quarantine directory was left behind")
	}
	otherID := hh.identity(second.URL, headlessOtherInstallationID).ID()
	if copies := filesNamed(t, hh.data, secondID+".json"); len(copies) != 1 || !strings.HasPrefix(copies[0], "/quarantine/"+otherID+"/") {
		t.Fatalf("the second binding's record must stay in its quarantine, once: %v", copies)
	}
	if containsID(receivedCaptureIDs(first), secondID) {
		t.Fatal("the second binding's record reached the first server")
	}
	if sent := requestsAfter(second, secondMark); len(sent) != 0 {
		t.Fatalf("the second server was contacted:\n%s", describeRequests(sent))
	}
}

func TestHeadlessFixSwitch_ANonEmptyStrayBlocksTheSwitchBackAsSwitchBlockedNamingIt(t *testing.T) {
	hh := newHeadlessHarness(t)
	first := hh.server
	second := hh.secondServer(t, headlessOtherInstallationID)
	original, firstIDs, _ := hh.fixCrashedSwitchBack(t, second)
	hh.fixReopenRoot(t)
	// A hook ran meanwhile and left an item in the recreated inbox.
	stray := inbox.Item{Agent: "claude_code", ReceivedAt: time.Now().UTC(), Payload: map[string]any{"cwd": hh.repo}}
	if err := inbox.Write(filepath.Join(hh.data, "inbox"), stray); err != nil {
		t.Fatal(err)
	}
	strayDigest := digestEntries(t, hh.data, "inbox")
	quarantine := filepath.Join(hh.data, "quarantine", original.BindingID)
	firstInbox := digestEntries(t, quarantine, "inbox")
	if len(strayDigest) != 1 || len(firstInbox) == 0 {
		t.Fatalf("precondition: one stray item at the root (%v), the first binding's inbox quarantined (%v)", strayDigest, firstInbox)
	}
	hh.writeToken(t, headlessSentinelToken())
	firstMark, secondMark := len(first.Requests()), len(second.Requests())

	hh.start(t)
	// Startup's own Recover and the gate both meet the stray; neither may
	// discard it or call it a switch still in progress.
	hh.waitForLogReason(t, "switch_blocked", 10*time.Second)
	if !fixLogNames(logText(hh.logPath), "switch_blocked", "inbox") {
		t.Fatalf("no switch_blocked log line names the conflicting entry inbox:\n%s", logText(hh.logPath))
	}
	block := hh.controlHeadlessReason(t, "switch_blocked")
	if !fixNamesEntry(block, "inbox") {
		encoded, _ := json.Marshal(block)
		t.Fatalf("control API status reports switch_blocked without naming inbox: %s", encoded)
	}
	output, _ := hh.cli(t, "status")
	cliBlock, ok := headlessBlock([]byte(output))
	if !ok || cliBlock["reason"] != "switch_blocked" || !fixNamesEntry(cliBlock, "inbox") {
		t.Fatalf("CLI status must report switch_blocked naming inbox:\n%s", output)
	}
	assertLocalized(t, "switch_blocked")
	time.Sleep(300 * time.Millisecond)
	if sent := append(requestsAfter(first, firstMark), requestsAfter(second, secondMark)...); len(sent) != 0 {
		t.Fatalf("requests sent while the switch is blocked:\n%s", describeRequests(sent))
	}
	assertSameDigest(t, "the stray inbox item", strayDigest, digestEntries(t, hh.data, "inbox"))
	assertSameDigest(t, "the first binding's quarantined inbox", firstInbox, digestEntries(t, quarantine, "inbox"))
	if _, err := os.Lstat(filepath.Join(hh.data, "binding-switch.json")); err != nil {
		t.Fatalf("a blocked switch lost its journal: %v", err)
	}

	// The operator moves the named stray out; the switch then finishes
	// without a restart.
	entries, _ := os.ReadDir(filepath.Join(hh.data, "inbox"))
	for _, entry := range entries {
		if err := os.Remove(filepath.Join(hh.data, "inbox", entry.Name())); err != nil {
			t.Fatal(err)
		}
	}
	hh.waitForSessions(t, 2)
	if restored := hh.boundRecord(t); restored.BindingID != original.BindingID || !restored.BoundAt.Equal(original.BoundAt) {
		t.Fatalf("switch-back binding %+v, want %s bound at %v", restored, original.BindingID, original.BoundAt)
	}
	waitForWithin(t, "the restored records to reach the first server", 10*time.Second, func() bool {
		got := receivedCaptureIDs(first)
		return containsID(got, firstIDs[0]) && containsID(got, firstIDs[1])
	}, func() string { return describeRequests(first.Requests()) })
	if sent := requestsAfter(second, secondMark); len(sent) != 0 {
		t.Fatalf("the second server was contacted:\n%s", describeRequests(sent))
	}
}

func TestHeadlessFixSwitch_AConfigSwitchNeverPresentsTheUnchangedTokenFileToTheNewOrigin(t *testing.T) {
	hh := newHeadlessHarness(t)
	first := hh.server
	// The new server would honor the very token: anything sent there with it
	// is a disclosure, however it answers.
	second := hh.secondServer(t, headlessOtherInstallationID)
	bound := hh.bindAndStop(t)
	hh.enqueue(t, headlessCaptureID(70))
	before := connectionScopedDigest(t, hh.data)
	firstMark := len(first.Requests())

	hh.writeConfig(t, hh.configFor(second.URL, headlessOtherInstallationID))
	hh.start(t)
	hh.waitForLogReason(t, "token_not_replaced_for_switch", 10*time.Second)
	hh.controlHeadlessReason(t, "token_not_replaced_for_switch")
	time.Sleep(50 * headlessPoll)
	if sent := second.Requests(); len(sent) != 0 {
		t.Fatalf("the token verified under the previous binding was sent to the new origin:\n%s", describeRequests(sent))
	}
	if sent := requestsAfter(first, firstMark); len(sent) != 0 {
		t.Fatalf("the replaced origin was contacted:\n%s", describeRequests(sent))
	}
	if record := hh.boundRecord(t); record.BindingID != bound.BindingID || !record.BoundAt.Equal(bound.BoundAt) {
		t.Fatalf("the hold switched the binding: %+v, was %+v", record, bound)
	}
	assertNoQuarantine(t, hh.data)
	assertSameDigest(t, "the bound state while held", before, connectionScopedDigest(t, hh.data))
	output, _ := hh.cli(t, "status")
	if block, ok := headlessBlock([]byte(output)); !ok || block["reason"] != "token_not_replaced_for_switch" {
		t.Fatalf("CLI status does not show the hold:\n%s", output)
	}
	assertLocalized(t, "token_not_replaced_for_switch")

	// Replacing the token file is the operator's go-ahead for the switch.
	second.IssueDeviceToken(headlessRotatedToken(), headlessOtherInstallationID, headlessOwnerEmail)
	hh.writeToken(t, headlessRotatedToken())
	hh.waitForSessions(t, 2)
	to := hh.identity(second.URL, headlessOtherInstallationID)
	if record := hh.boundRecord(t); record.BindingID != to.ID() {
		t.Fatalf("binding after the token was replaced: %+v, want %s", record, to.ID())
	}
	if stale := withToken(second.Requests(), headlessSentinelToken()); stale != 0 {
		t.Fatalf("the previous binding's token reached the new origin %d times", stale)
	}
	if _, err := os.Stat(filepath.Join(hh.data, "quarantine", bound.BindingID)); err != nil {
		t.Fatalf("the previous binding was not quarantined: %v", err)
	}
	// What is recorded of the verified token file is metadata only.
	filepath.WalkDir(hh.data, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Type()&os.ModeSocket != 0 {
			return nil
		}
		data, _ := os.ReadFile(path)
		assertNoTokenTrace(t, path, data, headlessSentinelToken(), headlessRotatedToken())
		return nil
	})
}
