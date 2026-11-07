// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/binding"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// secondServer is another Backplane, issuing the sentinel token for
// installationID of the same owner, with the same mapping.
func (hh *headlessHarness) secondServer(t *testing.T, installationID string) *uplinktest.Server {
	t.Helper()
	other := uplinktest.New(t)
	hh.server.Lock()
	other.Policy.Mappings = hh.server.Policy.Mappings
	hh.server.Unlock()
	other.IssueDeviceToken(headlessSentinelToken(), installationID, headlessOwnerEmail)
	return other
}

type quarantineReport struct {
	BindingID string  `json:"binding_id"`
	Pending   float64 `json:"pending"`
	Bytes     float64 `json:"bytes"`
}

func quarantinedIn(t *testing.T, block map[string]any) []quarantineReport {
	t.Helper()
	encoded, _ := json.Marshal(block["quarantined"])
	var reports []quarantineReport
	if err := json.Unmarshal(encoded, &reports); err != nil {
		t.Fatalf("status quarantined is not a list of {binding_id, pending, bytes}: %s", encoded)
	}
	return reports
}

func activeQueueRecords(t *testing.T, raw []byte) float64 {
	t.Helper()
	var status struct {
		Queue struct {
			Records float64 `json:"records"`
		} `json:"queue"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatalf("status is not JSON: %s", raw)
	}
	return status.Queue.Records
}

func TestHeadlessSwitch_AConfigEditQuarantinesTheOldBindingAndSwitchingBackRestoresIt(t *testing.T) {
	hh := newHeadlessHarness(t)
	first := hh.server
	second := hh.secondServer(t, headlessOtherInstallationID)
	original := hh.bindAndStop(t)
	from := hh.identity(first.URL, headlessInstallationID)
	to := hh.identity(second.URL, headlessOtherInstallationID)
	if original.BindingID != from.ID() {
		t.Fatalf("first binding %s, want %s", original.BindingID, from.ID())
	}

	// Captured under the first binding and not yet acknowledged, plus an
	// inbox item a hook stamped before the switch.
	ids := []string{headlessCaptureID(19), headlessCaptureID(20)}
	hh.enqueue(t, ids...)
	stamped := inbox.Item{Agent: "claude_code", ReceivedAt: time.Now().UTC(), Payload: map[string]any{"cwd": hh.repo}}
	if err := inbox.Write(filepath.Join(hh.data, "inbox"), stamped); err != nil {
		t.Fatal(err)
	}
	owned := []string{"queue", "inbox", "ledger.json", "installation.json", "policy.json"}
	before := digestEntries(t, hh.data, owned...)
	firstMark := len(first.Requests())

	// The operator's explicit switch: the config names another server. The
	// config edit alone holds: the token file verified under the first
	// binding is never presented to the second server.
	hh.writeConfig(t, hh.configFor(second.URL, headlessOtherInstallationID))
	run := hh.start(t)
	hh.controlHeadlessReason(t, "token_not_replaced_for_switch")
	if sent := second.Requests(); len(sent) != 0 {
		t.Fatalf("the unchanged token file was sent to the new origin:\n%s", describeRequests(sent))
	}
	// Replacing the token file completes the operator's switch.
	second.IssueDeviceToken(headlessRotatedToken(), headlessOtherInstallationID, headlessOwnerEmail)
	hh.writeToken(t, headlessRotatedToken())
	hh.waitForSessions(t, 2)
	switched := hh.boundRecord(t)
	if switched.BindingID != to.ID() || switched.Origin != to.Origin || switched.InstallationID != headlessOtherInstallationID {
		t.Fatalf("binding after the switch: %+v, want %s", switched, to.ID())
	}
	quarantine := filepath.Join(hh.data, "quarantine", from.ID())
	assertSameDigest(t, "the first binding's state, quarantined byte for byte", before, digestEntries(t, quarantine, owned...))
	if record, err := binding.Load(quarantine); err != nil || record == nil || record.BindingID != from.ID() {
		t.Fatalf("the quarantine names no binding of its own: %+v %v", record, err)
	}
	if left := digestEntries(t, hh.data, "queue", "inbox"); len(left) != 0 {
		t.Fatalf("the first binding's records stayed active: %v", sortedKeys(left))
	}
	// The new binding starts with no history: its connection starts at bind.
	installation, _ := state.Load[state.Installation](store.Layout{Root: hh.data}.Installation())
	if installation.ID != headlessOtherInstallationID || installation.Endpoint != to.Origin || !installation.ConnectedAt.Equal(switched.BoundAt) {
		t.Fatalf("installation.json after the switch: %+v, bound at %v", installation, switched.BoundAt)
	}

	output, err := hh.cli(t, "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	block, ok := headlessBlock([]byte(output))
	if !ok {
		t.Fatalf("status reports no headless binding:\n%s", output)
	}
	if block["binding_id"] != to.ID() || block["origin"] != to.Origin || block["installation_id"] != headlessOtherInstallationID || block["owner_email"] != headlessOwnerEmail {
		t.Fatalf("status binding: %v", block)
	}
	reports := quarantinedIn(t, block)
	recordBytes := float64(len(headlessRecord(ids[0])) + len(headlessRecord(ids[1])))
	if len(reports) != 1 || reports[0].BindingID != from.ID() || reports[0].Pending != 2 || reports[0].Bytes < recordBytes {
		t.Fatalf("status quarantined %+v, want one entry for %s with 2 pending", reports, from.ID())
	}
	// Quarantined records never count against the active queue.
	if records := activeQueueRecords(t, []byte(output)); records != 0 {
		t.Fatalf("the active queue reports %v records; the quarantine must not count", records)
	}
	_, apiBody := hh.control(t, "GET", "/v1/status", "")
	if apiBlock, ok := headlessBlock(apiBody); !ok || len(quarantinedIn(t, apiBlock)) != 1 {
		t.Fatalf("the control API status reports no quarantine: %s", apiBody)
	}
	time.Sleep(1500 * time.Millisecond)
	assertSameDigest(t, "the quarantine while the new binding captures", before, digestEntries(t, quarantine, owned...))
	if sent := requestsAfter(first, firstMark); len(sent) != 0 {
		t.Fatalf("the old server was contacted after the switch:\n%s", describeRequests(sent))
	}
	if got := receivedCaptureIDs(second); len(got) != 0 {
		t.Fatalf("the new server received records captured before the switch: %v", got)
	}
	if _, err := run.stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}

	// Switching back restores the first binding whole and delivers its
	// records to the first server only, as they were queued.
	secondMark := len(second.Requests())
	hh.writeConfig(t, hh.configFor(first.URL, headlessInstallationID))
	// Re-provisioned for the first server: the second binding's verified
	// token file is not presented back to the first.
	hh.writeToken(t, headlessSentinelToken())
	hh.start(t)
	hh.waitForSessions(t, 3)
	waitForWithin(t, "the restored records to reach the first server", 10*time.Second, func() bool {
		got := receivedCaptureIDs(first)
		return containsID(got, ids[0]) && containsID(got, ids[1])
	}, func() string { return describeRequests(first.Requests()) })
	sent := receivedRaw(first)
	for _, id := range ids {
		if len(sent[id]) == 0 || !bytes.Equal(sent[id][0], headlessRecord(id)) {
			t.Fatalf("record %s reached the first server altered: %s", id, sent[id])
		}
	}
	restored := hh.boundRecord(t)
	if restored.BindingID != from.ID() || !restored.BoundAt.Equal(original.BoundAt) {
		t.Fatalf("switch-back binding %+v, want %s bound at %v", restored, from.ID(), original.BoundAt)
	}
	installation, _ = state.Load[state.Installation](store.Layout{Root: hh.data}.Installation())
	if installation.ID != headlessInstallationID || !installation.ConnectedAt.Equal(original.BoundAt) {
		t.Fatalf("installation.json after switching back: %+v", installation)
	}
	if _, err := os.Stat(quarantine); err == nil {
		t.Fatal("the restored quarantine directory was left behind")
	}
	if _, err := os.Stat(filepath.Join(hh.data, "quarantine", to.ID())); err != nil {
		t.Fatalf("the second binding was not quarantined on switching back: %v", err)
	}
	if sent := requestsAfter(second, secondMark); len(sent) != 0 {
		t.Fatalf("the second server was contacted after switching back:\n%s", describeRequests(sent))
	}
	for _, id := range ids {
		if containsID(receivedCaptureIDs(second), id) {
			t.Fatalf("record %s reached the second server", id)
		}
	}
}

func TestHeadlessSwitch_AnAliasOriginIsASwitch(t *testing.T) {
	hh := newHeadlessHarness(t)
	alias := hh.server.Alias(t)
	original := hh.bindAndStop(t)
	hh.enqueue(t, headlessCaptureID(21))
	before := digestEntries(t, hh.data, "queue")
	mark := len(hh.server.Requests())

	hh.writeConfig(t, hh.configFor(alias, headlessInstallationID))
	hh.start(t)
	// Being a switch, the alias edit holds until the token file is replaced:
	// nothing reaches the alias, or the origin it replaces, with it unchanged.
	hh.controlHeadlessReason(t, "token_not_replaced_for_switch")
	if sent := requestsAfter(hh.server, mark); len(sent) != 0 {
		t.Fatalf("the unchanged token file was sent for the alias switch:\n%s", describeRequests(sent))
	}
	hh.writeToken(t, headlessSentinelToken())
	hh.waitForSessions(t, 2)
	aliased := hh.identity(alias, headlessInstallationID)
	if record := hh.boundRecord(t); record.BindingID != aliased.ID() || record.BindingID == original.BindingID {
		t.Fatalf("binding after the alias edit: %+v, want %s", record, aliased.ID())
	}
	quarantined := digestEntries(t, filepath.Join(hh.data, "quarantine", original.BindingID), "queue")
	assertSameDigest(t, "the first binding's queue, quarantined", before, quarantined)
	time.Sleep(1500 * time.Millisecond)
	if containsID(receivedCaptureIDs(hh.server), headlessCaptureID(21)) {
		t.Fatal("a record of the first origin was uploaded through its alias")
	}
	aliasURL, _ := url.Parse(alias)
	for _, request := range requestsAfter(hh.server, mark) {
		if request.Host != aliasURL.Host {
			t.Errorf("the replaced origin was contacted: %s %s%s", request.Method, request.Host, request.Path)
		}
	}
}

// crashSwitch leaves the data root as a switch from from to to that crashed
// once phase was durable, in the journal layout binding.SwitchTo writes.
func crashSwitch(t *testing.T, root string, active binding.Record, from, to binding.Identity, phase string, startedAt time.Time) {
	t.Helper()
	if phase != "journaled" {
		quarantine := filepath.Join(root, "quarantine", from.ID())
		for _, dir := range []string{filepath.Dir(quarantine), quarantine} {
			if err := store.EnsurePrivateDir(dir); err != nil {
				t.Fatal(err)
			}
		}
		encoded, _ := json.Marshal(active)
		var copied map[string]any
		json.Unmarshal(encoded, &copied)
		copied["quarantined_at"] = startedAt
		if err := store.WriteJSON(filepath.Join(quarantine, "binding.json"), copied); err != nil {
			t.Fatal(err)
		}
		for _, name := range binding.ConnectionScoped {
			if _, err := os.Lstat(filepath.Join(root, name)); err != nil {
				continue
			}
			if err := os.Rename(filepath.Join(root, name), filepath.Join(quarantine, name)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if phase == "bound" {
		record := binding.Record{Version: 1, BindingID: to.ID(), Origin: to.Origin, InstallationID: to.InstallationID, OwnerEmail: to.OwnerEmail, BoundAt: startedAt}
		if err := binding.Save(root, record); err != nil {
			t.Fatal(err)
		}
	}
	journal := map[string]any{"version": 1, "from": from, "to": to, "phase": phase, "started_at": startedAt}
	if err := store.WriteJSON(filepath.Join(root, "binding-switch.json"), journal); err != nil {
		t.Fatal(err)
	}
}

func filesNamed(t *testing.T, root, suffix string) []string {
	t.Helper()
	var found []string
	filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && strings.HasSuffix(path, suffix) {
			found = append(found, strings.TrimPrefix(path, root))
		}
		return nil
	})
	return found
}

func TestHeadlessSwitch_RollsAnInterruptedSwitchForwardBeforeAnyRequest(t *testing.T) {
	for _, phase := range []string{"journaled", "quarantined", "restored", "bound"} {
		t.Run(phase, func(t *testing.T) {
			hh := newHeadlessHarness(t)
			first := hh.server
			second := hh.secondServer(t, headlessOtherInstallationID)
			active := hh.bindAndStop(t)
			from := hh.identity(first.URL, headlessInstallationID)
			to := hh.identity(second.URL, headlessOtherInstallationID)
			id := headlessCaptureID(23)
			hh.enqueue(t, id)
			queued := digestEntries(t, hh.data, "queue")
			crashSwitch(t, hh.data, active, from, to, phase, time.Now().UTC().Truncate(time.Second))
			hh.writeConfig(t, hh.configFor(second.URL, headlessOtherInstallationID))

			journal := filepath.Join(hh.data, "binding-switch.json")
			var whileJournaled atomic.Int32
			noteIfJournaled := func(uplinktest.Request) {
				if _, err := os.Lstat(journal); err == nil {
					whileJournaled.Add(1)
				}
			}
			for _, server := range []*uplinktest.Server{first, second} {
				server.Lock()
				server.OnRequest = noteIfJournaled
				server.Unlock()
			}
			firstMark := len(first.Requests())

			hh.start(t)
			hh.waitForSessions(t, 2)
			if count := whileJournaled.Load(); count != 0 {
				t.Fatalf("%d requests were sent while the switch journal existed", count)
			}
			if _, err := os.Lstat(journal); err == nil {
				t.Fatal("the switch journal was left behind")
			}
			if record := hh.boundRecord(t); record.BindingID != to.ID() {
				t.Fatalf("binding after recovery: %+v, want %s", record, to.ID())
			}
			assertSameDigest(t, "the first binding's queue", queued, digestEntries(t, filepath.Join(hh.data, "quarantine", from.ID()), "queue"))
			if copies := filesNamed(t, hh.data, id+".json"); len(copies) != 1 {
				t.Fatalf("the queued record must exist exactly once across bindings, found %v", copies)
			}
			time.Sleep(time.Second)
			if containsID(receivedCaptureIDs(second), id) {
				t.Fatal("the first binding's record was uploaded to the second server")
			}
			if sent := requestsAfter(first, firstMark); len(sent) != 0 {
				t.Fatalf("the first server was contacted after the switch:\n%s", describeRequests(sent))
			}
		})
	}
}
