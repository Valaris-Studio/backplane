// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSwitchTo_QuarantinesEveryConnectionEntryByteForByte(t *testing.T) {
	resetSwitchHook(t)
	root := dataRoot(t)
	from, to := primary(), secondary()
	bind(t, root, from, firstBoundAt, "first")
	before := snapshot(t, root)
	if err := SwitchTo(root, from, to, switchedAt); err != nil {
		t.Fatal(err)
	}
	requireTree(t, withoutRecords(snapshot(t, root)), quarantined(before, from.ID()))
	requireActiveRecord(t, root, to, switchedAt)
	requireQuarantinedRecord(t, root, from, firstBoundAt)
	requireOwnerOnlyDir(t, filepath.Join(root, "quarantine"))
	requireOwnerOnlyDir(t, filepath.Join(root, "quarantine", from.ID()))
	requireDecision(t, root, to, &to, Resume)
}

func TestSwitchTo_MovesOnlyTheEntriesThatExist(t *testing.T) {
	resetSwitchHook(t)
	root := dataRoot(t)
	from, to := primary(), secondary()
	writeDeviceState(t, root)
	writeConnectionState(t, root, "first", "ledger.json", "queue")
	if err := Save(root, recordFor(from, firstBoundAt)); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, root)
	if err := SwitchTo(root, from, to, switchedAt); err != nil {
		t.Fatal(err)
	}
	requireTree(t, withoutRecords(snapshot(t, root)), quarantined(before, from.ID()))
	requireActiveRecord(t, root, to, switchedAt)
}

func TestSwitchTo_SwitchingBackRestoresTheExactBytesAndFirstBoundAt(t *testing.T) {
	resetSwitchHook(t)
	root := dataRoot(t)
	first, second := primary(), secondary()
	bind(t, root, first, firstBoundAt, "first")
	original := snapshot(t, root)
	if err := SwitchTo(root, first, second, switchedAt); err != nil {
		t.Fatal(err)
	}
	writeConnectionState(t, root, "second", "installation.json", "ledger.json", "queue", "inbox")
	away := snapshot(t, root)

	if err := SwitchTo(root, second, first, switchedBackAt); err != nil {
		t.Fatal(err)
	}
	want := tree{"quarantine": "dir", "quarantine/" + second.ID(): "dir"}
	for path, entry := range withoutRecords(original) {
		want[path] = entry
	}
	for path, entry := range withoutRecords(away) {
		if isScoped(topLevel(path)) {
			want["quarantine/"+second.ID()+"/"+path] = entry
		}
	}
	requireTree(t, withoutRecords(snapshot(t, root)), want)
	requireActiveRecord(t, root, first, firstBoundAt)
	requireQuarantinedRecord(t, root, second, switchedAt)
	if _, err := os.Lstat(filepath.Join(root, "quarantine", first.ID())); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the restored binding's quarantine is still there: %v", err)
	}
	requireDecision(t, root, first, &first, Resume)
}

// requireNothingLostOrMerged checks a refused switch: every file that was
// in root is still in exactly one place with its bytes, and what already
// sat in a quarantine is untouched.
func requireNothingLostOrMerged(t *testing.T, root string, before tree, fromID string) {
	t.Helper()
	after := snapshot(t, root)
	for path, entry := range before {
		switch {
		case entry == "dir" || isRecordPath(path):
		case strings.HasPrefix(path, "quarantine/"), !isScoped(topLevel(path)):
			if after[path] != entry {
				t.Errorf("%s was changed or removed", path)
			}
		default:
			atRoot := after[path] == entry
			inQuarantine := after["quarantine/"+fromID+"/"+path] == entry
			if atRoot && inQuarantine {
				t.Errorf("%s is duplicated", path)
			} else if !atRoot && !inQuarantine {
				t.Errorf("%s was lost", path)
			}
		}
	}
}

func TestSwitchTo_RefusesAQuarantineThatAlreadyHoldsAnEntry(t *testing.T) {
	resetSwitchHook(t)
	root := dataRoot(t)
	from, to := primary(), secondary()
	bind(t, root, from, firstBoundAt, "first")
	writeFile(t, filepath.Join(root, "quarantine", from.ID(), "ledger.json"), []byte("an older ledger"))
	before := snapshot(t, root)

	if err := SwitchTo(root, from, to, switchedAt); !hasCode(err, "quarantine_conflict") {
		t.Fatalf("switch onto an occupied quarantine: %v, want quarantine_conflict", err)
	}
	requireNothingLostOrMerged(t, root, before, from.ID())
	requireActiveRecord(t, root, from, firstBoundAt)

	// Whether Recover reports the conflict or finds no journal is open; the tree is not.
	_, _ = Recover(root)
	requireNothingLostOrMerged(t, root, before, from.ID())
	requireActiveRecord(t, root, from, firstBoundAt)
}

func TestRecover_WithoutAJournalChangesNothing(t *testing.T) {
	root := dataRoot(t)
	bind(t, root, primary(), firstBoundAt, "first")
	before := snapshot(t, root)
	if recovered, err := Recover(root); recovered || err != nil {
		t.Fatalf("recover with no journal: %t, %v", recovered, err)
	}
	requireTree(t, snapshot(t, root), before)
}

type switchScenario struct {
	name     string
	prepare  func(t *testing.T, root string) (from, to Identity, now time.Time)
	required []string
}

var switchScenarios = []switchScenario{
	{
		name: "switch away",
		prepare: func(t *testing.T, root string) (Identity, Identity, time.Time) {
			bind(t, root, primary(), firstBoundAt, "first")
			return primary(), secondary(), switchedAt
		},
		required: []string{"journaled", "quarantined", "bound"},
	},
	{
		name: "switch back",
		prepare: func(t *testing.T, root string) (Identity, Identity, time.Time) {
			bind(t, root, primary(), firstBoundAt, "first")
			if err := SwitchTo(root, primary(), secondary(), switchedAt); err != nil {
				t.Fatal(err)
			}
			writeConnectionState(t, root, "second", "installation.json", "ledger.json", "queue", "inbox")
			return secondary(), primary(), switchedBackAt
		},
		required: []string{"journaled", "quarantined", "restored", "bound"},
	},
}

// requirePhases checks the phases fired once each, in procedure order, and
// include every required one.
func requirePhases(t *testing.T, fired, required []string) {
	t.Helper()
	order := map[string]int{"journaled": 0, "quarantined": 1, "restored": 2, "bound": 3}
	last := -1
	for _, phase := range fired {
		position, known := order[phase]
		if !known || position <= last {
			t.Fatalf("phases fired %v, want a subsequence of journaled, quarantined, restored, bound", fired)
		}
		last = position
	}
	for _, phase := range required {
		if !strings.Contains(" "+strings.Join(fired, " ")+" ", " "+phase+" ") {
			t.Fatalf("phases fired %v, missing %q", fired, phase)
		}
	}
}

// requireSameSettledTree compares a recovered root with one whose switch ran
// uninterrupted: identical files, and binding records equal in every field
// that does not record when the write happened.
func requireSameSettledTree(t *testing.T, recovered, reference string) {
	t.Helper()
	got, want := snapshot(t, recovered), snapshot(t, reference)
	requireTree(t, withoutRecords(got), withoutRecords(want))
	for path := range want {
		if !isRecordPath(path) {
			continue
		}
		if _, present := got[path]; !present {
			t.Fatalf("missing %s", path)
		}
		gotFields := readJSONObject(t, filepath.Join(recovered, filepath.FromSlash(path)))
		wantFields := readJSONObject(t, filepath.Join(reference, filepath.FromSlash(path)))
		for _, key := range []string{"version", "binding_id", "origin", "installation_id", "owner_email"} {
			if gotFields[key] != wantFields[key] {
				t.Errorf("%s %s = %v, want %v", path, key, gotFields[key], wantFields[key])
			}
		}
		if gotAt, wantAt := timeField(t, gotFields, "bound_at"), timeField(t, wantFields, "bound_at"); !gotAt.Equal(wantAt) {
			t.Errorf("%s bound_at = %v, want %v", path, gotAt, wantAt)
		}
		if path != "binding.json" {
			timeField(t, gotFields, "quarantined_at")
		}
	}
	for path := range got {
		if _, expected := want[path]; isRecordPath(path) && !expected {
			t.Errorf("unexpected %s", path)
		}
	}
}

func TestRecover_FinishesASwitchInterruptedAfterEachPhase(t *testing.T) {
	resetSwitchHook(t)
	for _, scenario := range switchScenarios {
		reference := dataRoot(t)
		from, to, now := scenario.prepare(t, reference)
		var fired []string
		afterSwitchPhase = func(phase string) { fired = append(fired, phase) }
		err := SwitchTo(reference, from, to, now)
		afterSwitchPhase = func(string) {}
		if err != nil {
			t.Fatalf("%s: %v", scenario.name, err)
		}
		requirePhases(t, fired, scenario.required)

		for _, phase := range fired {
			t.Run(scenario.name+"/after "+phase, func(t *testing.T) {
				root := dataRoot(t)
				from, to, now := scenario.prepare(t, root)
				switchCrashingAfter(t, phase, root, from, to, now)
				requireDecision(t, root, to, &to, HoldSwitchInProgress)
				requireDecision(t, root, to, nil, HoldSwitchInProgress)

				recovered, err := Recover(root)
				if err != nil || !recovered {
					t.Fatalf("recover after %q: %t, %v", phase, recovered, err)
				}
				requireSameSettledTree(t, root, reference)
				requireDecision(t, root, to, &to, Resume)
				if again, err := Recover(root); again || err != nil {
					t.Fatalf("a second recover: %t, %v", again, err)
				}
			})
		}
	}
}
