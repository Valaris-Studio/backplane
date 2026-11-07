// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// A switch does not stop the root's other writers: every CLI command opens
// the store (recreating inbox/, queue/ and work/ empty), hooks write the
// inbox, and the control API writes discovered.json. An empty directory a
// writer recreated holds nothing to lose, so it never blocks a switch; a
// destination with anything in it is still a conflict, never merged into.

// recreateStoreDirsAfter makes phase's hook do what a CLI command run during
// the switch does to the root, then whatever else extra writes.
func recreateStoreDirsAfter(t *testing.T, phase, root string, extra func()) *bool {
	t.Helper()
	fired := false
	afterSwitchPhase = func(reached string) {
		if reached != phase || fired {
			return
		}
		fired = true
		if _, err := store.Open(root); err != nil {
			t.Errorf("store.Open during the switch: %v", err)
		}
		if extra != nil {
			extra()
		}
	}
	return &fired
}

// switchedBackTree is what a completed switch-back from second to first
// leaves: first's original entries in place, second's under its quarantine.
func switchedBackTree(original, away tree, secondID string) tree {
	want := tree{"quarantine": "dir", "quarantine/" + secondID: "dir"}
	for path, entry := range withoutRecords(original) {
		want[path] = entry
	}
	for path, entry := range withoutRecords(away) {
		if isScoped(topLevel(path)) {
			want["quarantine/"+secondID+"/"+path] = entry
		}
	}
	return want
}

// prepareSwitchBack binds root to first, switches it to second and gives
// second some state of its own, as switchScenarios' "switch back" does.
func prepareSwitchBack(t *testing.T, root string) (original, away tree) {
	t.Helper()
	bind(t, root, primary(), firstBoundAt, "first")
	original = snapshot(t, root)
	if err := SwitchTo(root, primary(), secondary(), switchedAt); err != nil {
		t.Fatal(err)
	}
	writeConnectionState(t, root, "second", "installation.json", "ledger.json", "queue", "inbox")
	return original, snapshot(t, root)
}

func requireNoJournal(t *testing.T, root string) {
	t.Helper()
	if _, err := os.Lstat(filepath.Join(root, "binding-switch.json")); err == nil {
		t.Fatal("the switch journal was left behind")
	}
}

func TestSwitchTo_FixSwitchBackCompletesOverEmptyDirsAWriterRecreated(t *testing.T) {
	resetSwitchHook(t)
	root := dataRoot(t)
	first, second := primary(), secondary()
	original, away := prepareSwitchBack(t, root)
	fired := recreateStoreDirsAfter(t, "quarantined", root, nil)

	if err := SwitchTo(root, second, first, switchedBackAt); err != nil {
		t.Fatalf("switch back over the empty inbox/, queue/ and work/ a CLI command recreated: %v", err)
	}
	if !*fired {
		t.Fatal("the switch never reached the quarantined phase")
	}
	requireTree(t, withoutRecords(snapshot(t, root)), switchedBackTree(original, away, second.ID()))
	requireActiveRecord(t, root, first, firstBoundAt)
	requireQuarantinedRecord(t, root, second, switchedAt)
	requireNoJournal(t, root)
	requireDecision(t, root, first, &first, Resume)
}

func TestRecover_FixFinishesASwitchBackWhoseRootACLIReopenedAfterACrash(t *testing.T) {
	resetSwitchHook(t)
	var scenario *switchScenario
	for index := range switchScenarios {
		if switchScenarios[index].name == "switch back" {
			scenario = &switchScenarios[index]
		}
	}
	if scenario == nil {
		t.Fatal("no switch back scenario")
	}
	reference := dataRoot(t)
	from, to, now := scenario.prepare(t, reference)
	if err := SwitchTo(reference, from, to, now); err != nil {
		t.Fatal(err)
	}

	root := dataRoot(t)
	from, to, now = scenario.prepare(t, root)
	switchCrashingAfter(t, "quarantined", root, from, to, now)
	// Between the crash and the restart, `status` (or any command) opens the
	// store and recreates what the quarantine step moved away.
	if _, err := store.Open(root); err != nil {
		t.Fatal(err)
	}
	recovered, err := Recover(root)
	if err != nil || !recovered {
		t.Fatalf("recover after a CLI reopened the root: %t, %v", recovered, err)
	}
	requireSameSettledTree(t, root, reference)
	requireDecision(t, root, to, &to, Resume)
}

func TestSwitchTo_FixQuarantineReplacesAnEmptyDirectoryAtItsDestination(t *testing.T) {
	resetSwitchHook(t)
	root := dataRoot(t)
	from, to := primary(), secondary()
	bind(t, root, from, firstBoundAt, "first")
	destination := filepath.Join(root, "quarantine", from.ID())
	for _, dir := range []string{filepath.Dir(destination), destination, filepath.Join(destination, "queue"), filepath.Join(destination, "inbox")} {
		if err := store.EnsurePrivateDir(dir); err != nil {
			t.Fatal(err)
		}
	}
	before := snapshot(t, root)

	if err := SwitchTo(root, from, to, switchedAt); err != nil {
		t.Fatalf("switch onto a quarantine holding only empty directories: %v", err)
	}
	requireTree(t, withoutRecords(snapshot(t, root)), quarantined(before, from.ID()))
	requireActiveRecord(t, root, to, switchedAt)
	requireQuarantinedRecord(t, root, from, firstBoundAt)
	requireNoJournal(t, root)
}

// conflictedEntries are the connection-scoped names a quarantine_conflict
// error names.
func conflictedEntries(err error) []string {
	var named []string
	for _, link := range errorChain(err) {
		text := link.Error()
		if !strings.HasPrefix(text, "quarantine_conflict") {
			continue
		}
		words := strings.FieldsFunc(text, func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.')
		})
		for _, word := range words {
			for _, scoped := range ConnectionScoped {
				if word == scoped {
					named = append(named, word)
				}
			}
		}
		return named
	}
	return named
}

func requireConflictOn(t *testing.T, err error, entry string) {
	t.Helper()
	if !hasCode(err, "quarantine_conflict") {
		t.Fatalf("got %v, want quarantine_conflict on %s", err, entry)
	}
	if named := conflictedEntries(err); len(named) != 1 || named[0] != entry {
		t.Fatalf("the conflict names %v (%v), want only %s: the empty directories ahead of it must not block", named, err, entry)
	}
}

// requireEachInOnePlace checks a blocked switch-back lost and merged
// nothing: every file of first's is at the root or in its quarantine with
// its bytes, never both; every file of second's is in second's quarantine.
func requireEachInOnePlace(t *testing.T, root string, original, away tree, firstID, secondID string) {
	t.Helper()
	now := snapshot(t, root)
	for path, entry := range withoutRecords(original) {
		if entry == "dir" || !isScoped(topLevel(path)) {
			continue
		}
		atRoot := now[path] == entry
		quarantined := now["quarantine/"+firstID+"/"+path] == entry
		if atRoot == quarantined {
			t.Errorf("first's %s: at the root %t, in quarantine %t; want exactly one", path, atRoot, quarantined)
		}
	}
	for path, entry := range withoutRecords(away) {
		if entry == "dir" || !isScoped(topLevel(path)) {
			continue
		}
		if now["quarantine/"+secondID+"/"+path] != entry {
			t.Errorf("second's %s is not in its quarantine unchanged", path)
		}
	}
}

func TestSwitchTo_FixANonEmptyStrayBlocksTheSwitchBackNamesItAndFinishesOnceRemoved(t *testing.T) {
	cases := []struct {
		name  string
		entry string
		// stray is what a writer left; clear undoes it as the operator would.
		stray func(t *testing.T, root string)
		clear func(t *testing.T, root string)
	}{
		{"a hook's inbox item", "inbox",
			func(t *testing.T, root string) {
				writeFile(t, filepath.Join(root, "inbox", "00000000000000000001-stray.json"), []byte(`{"stray":true}`))
			},
			func(t *testing.T, root string) {
				if err := os.Remove(filepath.Join(root, "inbox", "00000000000000000001-stray.json")); err != nil {
					t.Fatal(err)
				}
			}},
		{"a directory holding only an empty directory", "work",
			func(t *testing.T, root string) {
				if err := os.Mkdir(filepath.Join(root, "work", "nested"), 0o700); err != nil {
					t.Fatal(err)
				}
			},
			func(t *testing.T, root string) {
				if err := os.Remove(filepath.Join(root, "work", "nested")); err != nil {
					t.Fatal(err)
				}
			}},
		{"a Codex hook's threads.json", "threads.json",
			func(t *testing.T, root string) {
				writeFile(t, filepath.Join(root, "threads.json"), []byte(`{"threads":{"stray":"x"}}`))
			},
			func(t *testing.T, root string) {
				if err := os.Remove(filepath.Join(root, "threads.json")); err != nil {
					t.Fatal(err)
				}
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetSwitchHook(t)
			root := dataRoot(t)
			first, second := primary(), secondary()
			original, away := prepareSwitchBack(t, root)
			var strayTree tree
			recreateStoreDirsAfter(t, "quarantined", root, func() {
				tc.stray(t, root)
				strayTree = snapshot(t, root)
			})

			err := SwitchTo(root, second, first, switchedBackAt)
			requireConflictOn(t, err, tc.entry)
			afterSwitchPhase = func(string) {}
			// What the writer left is neither moved, merged into nor removed.
			blocked := snapshot(t, root)
			for path, entry := range strayTree {
				if topLevel(path) == tc.entry && blocked[path] != entry {
					t.Errorf("the stray %s was changed or removed", path)
				}
			}
			for path := range blocked {
				if topLevel(path) == tc.entry && path != tc.entry {
					if _, stray := strayTree[path]; !stray {
						t.Errorf("%s was merged into the stray %s", path, tc.entry)
					}
				}
			}
			requireEachInOnePlace(t, root, original, away, first.ID(), second.ID())
			requireDecision(t, root, first, &first, HoldSwitchInProgress)

			// Retrying is refused the same way and changes nothing.
			if recovered, err := Recover(root); recovered {
				t.Fatal("recover reported a blocked switch as finished")
			} else {
				requireConflictOn(t, err, tc.entry)
			}
			requireTree(t, snapshot(t, root), blocked)

			// Once the operator takes the named stray away, the switch finishes.
			tc.clear(t, root)
			recovered, err := Recover(root)
			if err != nil || !recovered {
				t.Fatalf("recover once the stray was removed: %t, %v", recovered, err)
			}
			requireTree(t, withoutRecords(snapshot(t, root)), switchedBackTree(original, away, second.ID()))
			requireActiveRecord(t, root, first, firstBoundAt)
			requireNoJournal(t, root)
			requireDecision(t, root, first, &first, Resume)
		})
	}
}
