// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	journalName    = "binding-switch.json"
	journalVersion = 1
	journalLimit   = 64 << 10
	quarantineName = "quarantine"
	phaseJournaled = "journaled"
)

var (
	ErrQuarantineConflict    = errors.New("quarantine_conflict")
	ErrSwitchInProgress      = errors.New("switch_in_progress")
	ErrActiveBindingMismatch = errors.New("active_binding_mismatch")
	ErrJournalInvalid        = errors.New("binding_journal_invalid")
)

// ConflictError names the connection-scoped entry a switch cannot move
// without replacing something already there; it is ErrQuarantineConflict.
type ConflictError struct{ Entry string }

func (e *ConflictError) Error() string        { return ErrQuarantineConflict.Error() + ": " + e.Entry }
func (e *ConflictError) Is(target error) bool { return target == ErrQuarantineConflict }

type switchJournal struct {
	Version   int       `json:"version"`
	From      Identity  `json:"from"`
	To        Identity  `json:"to"`
	Phase     string    `json:"phase"`
	StartedAt time.Time `json:"started_at"`
}

type quarantinedRecord struct {
	Record
	QuarantinedAt time.Time `json:"quarantined_at"`
}

// afterSwitchPhase runs once a phase is durable, so a test can crash the
// switch right there.
var afterSwitchPhase = func(phase string) {}

// The journal names the last step finished and Recover resumes after it.
// The phase is what makes a re-run safe: once restored entries sit in the
// root, quarantining again would file them under the wrong binding. A step
// interrupted midway is re-run whole, so each one tolerates its own partial
// work.
type switchStep struct {
	phase string
	run   func(root string, journal switchJournal) error
}

var switchSteps = []switchStep{
	{"quarantined", quarantineSource},
	{"restored", restoreTarget},
	{"bound", bindTarget},
}

// SwitchTo moves from's connection state under quarantine/<from.ID()>/,
// restores to's if an earlier switch left it there, and binds the root to
// to. The caller holds the session lock with capture stopped. Nothing is
// deleted but the emptied quarantine directory and the journal.
func SwitchTo(root string, from, to Identity, now time.Time) error {
	switching, err := exists(journalPath(root))
	if err != nil {
		return err
	}
	if switching {
		return ErrSwitchInProgress
	}
	active, err := Load(root)
	if err != nil {
		return err
	}
	if active == nil || active.BindingID != from.ID() {
		return ErrActiveBindingMismatch
	}
	if err := refuseQuarantineConflicts(root, from); err != nil {
		return err
	}
	journal := switchJournal{Version: journalVersion, From: from, To: to, Phase: phaseJournaled, StartedAt: now}
	if err := store.WriteJSON(journalPath(root), journal); err != nil {
		return err
	}
	afterSwitchPhase(phaseJournaled)
	return finishSwitch(root, journal)
}

// Recover finishes a switch a crash interrupted. It reports whether a
// journal was found and completed.
func Recover(root string) (bool, error) {
	var journal switchJournal
	if err := store.ReadJSON(journalPath(root), journalLimit, &journal); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("%w: %v", ErrJournalInvalid, err)
	}
	if journal.Version != journalVersion {
		return false, ErrJournalInvalid
	}
	if err := finishSwitch(root, journal); err != nil {
		return false, err
	}
	return true, nil
}

func finishSwitch(root string, journal switchJournal) error {
	remaining, err := stepsAfter(journal.Phase)
	if err != nil {
		return err
	}
	for _, step := range remaining {
		if err := step.run(root, journal); err != nil {
			return err
		}
		journal.Phase = step.phase
		if err := store.WriteJSON(journalPath(root), journal); err != nil {
			return err
		}
		afterSwitchPhase(step.phase)
	}
	if err := os.Remove(journalPath(root)); err != nil {
		return err
	}
	return store.SyncDir(root)
}

func stepsAfter(phase string) ([]switchStep, error) {
	if phase == phaseJournaled {
		return switchSteps, nil
	}
	for finished, step := range switchSteps {
		if step.phase == phase {
			return switchSteps[finished+1:], nil
		}
	}
	return nil, ErrJournalInvalid
}

// refuseQuarantineConflicts runs before the journal is written, so a refused
// switch leaves nothing behind for Recover to roll forward.
func refuseQuarantineConflicts(root string, from Identity) error {
	destination := quarantineDir(root, from)
	if err := refuseTaken(destination, recordName); err != nil {
		return err
	}
	for _, name := range ConnectionScoped {
		present, err := exists(filepath.Join(root, name))
		if err != nil {
			return err
		}
		if !present {
			continue
		}
		if err := refuseTaken(destination, name); err != nil {
			return err
		}
	}
	return nil
}

// refuseTaken lets an empty directory pass: the root's other writers (every
// CLI command's store.Open, hooks) recreate inbox/, queue/ and work/ empty
// while a switch runs, and such a directory holds nothing to lose.
func refuseTaken(destination, name string) error {
	taken, err := holdsState(filepath.Join(destination, name))
	if err != nil {
		return err
	}
	if taken {
		return &ConflictError{Entry: name}
	}
	return nil
}

// makeRoom clears destination/name for a rename, removing only an empty
// directory; anything else there is never merged into or replaced.
func makeRoom(destination, name string) error {
	if err := refuseTaken(destination, name); err != nil {
		return err
	}
	path := filepath.Join(destination, name)
	// Remove refuses a directory a writer filled meanwhile.
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		if taken, _ := holdsState(path); taken {
			return &ConflictError{Entry: name}
		}
		return err
	}
	return nil
}

func quarantineSource(root string, journal switchJournal) error {
	// binding.json stays from's until bindTarget, also on a re-run.
	active, err := Load(root)
	if err != nil {
		return err
	}
	if active == nil || active.BindingID != journal.From.ID() {
		return ErrActiveBindingMismatch
	}
	destination := quarantineDir(root, journal.From)
	for _, dir := range []string{filepath.Join(root, quarantineName), destination} {
		if err := store.EnsurePrivateDir(dir); err != nil {
			return err
		}
		if err := store.SyncDir(filepath.Dir(dir)); err != nil {
			return err
		}
	}
	copied := quarantinedRecord{Record: *active, QuarantinedAt: journal.StartedAt}
	if err := store.WriteJSON(filepath.Join(destination, recordName), copied); err != nil {
		return err
	}
	if err := moveEntries(root, destination); err != nil {
		return err
	}
	return syncDirs(root, destination)
}

func restoreTarget(root string, journal switchJournal) error {
	source := quarantineDir(root, journal.To)
	if err := store.RejectSymlink(source); err != nil {
		return err
	}
	if held, err := exists(source); err != nil || !held {
		return err
	}
	if err := moveEntries(source, root); err != nil {
		return err
	}
	// The restored record replaces from's, whose copy quarantineSource
	// already filed; bindTarget then keeps its BoundAt.
	restoredRecord := filepath.Join(source, recordName)
	if held, err := exists(restoredRecord); err != nil {
		return err
	} else if held {
		if err := os.Rename(restoredRecord, filepath.Join(root, recordName)); err != nil {
			return err
		}
	}
	if err := syncDirs(root, source); err != nil {
		return err
	}
	// Remove refuses a directory that is not empty, so nothing left in it is
	// ever lost.
	if err := os.Remove(source); err != nil {
		return err
	}
	return store.SyncDir(filepath.Join(root, quarantineName))
}

func bindTarget(root string, journal switchJournal) error {
	active, err := Load(root)
	if err != nil {
		return err
	}
	if active != nil && active.BindingID == journal.To.ID() {
		return Save(root, *active)
	}
	to := journal.To
	return Save(root, Record{
		Version:        recordVersion,
		BindingID:      to.ID(),
		Origin:         to.Origin,
		InstallationID: to.InstallationID,
		OwnerEmail:     to.OwnerEmail,
		BoundAt:        journal.StartedAt,
	})
}

// moveEntries renames each connection-scoped entry of source into
// destination, never over anything but an empty directory. An entry already
// gone from source was moved by an interrupted earlier run.
func moveEntries(source, destination string) error {
	for _, name := range ConnectionScoped {
		present, err := exists(filepath.Join(source, name))
		if err != nil {
			return err
		}
		if !present {
			continue
		}
		if err := makeRoom(destination, name); err != nil {
			return err
		}
		if err := os.Rename(filepath.Join(source, name), filepath.Join(destination, name)); err != nil {
			return err
		}
	}
	return nil
}

func syncDirs(dirs ...string) error {
	for _, dir := range dirs {
		if err := store.SyncDir(dir); err != nil {
			return err
		}
	}
	return nil
}

func journalPath(root string) string { return filepath.Join(root, journalName) }

func quarantineDir(root string, identity Identity) string {
	return filepath.Join(root, quarantineName, identity.ID())
}
