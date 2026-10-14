// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"errors"
	"os"
	"testing"
)

var createPhysicalFixtureDirectory = func(path string) error { return os.Mkdir(path, 0o700) }
var prepareNativeOrdinaryAccess = func(t *testing.T) error { return nil }

func mkdirPhysicalFixture(t *testing.T, path string) {
	t.Helper()
	if err := createPhysicalFixtureDirectory(path); err != nil {
		t.Fatal(err)
	}
}

// Register before the call: a failed write may already have changed the fixture.
func mutateOwnedFixture(t interface {
	Cleanup(func())
	Errorf(string, ...any)
}, write, restore func() error) error {
	t.Cleanup(func() {
		if err := restore(); err != nil {
			t.Errorf("INCOMPLETE native fixture restoration: %v", err)
		}
	})
	return write()
}

type fixtureCleanupProbe struct {
	cleanup []func()
	errors  int
}

func (p *fixtureCleanupProbe) Cleanup(f func())      { p.cleanup = append(p.cleanup, f) }
func (p *fixtureCleanupProbe) Errorf(string, ...any) { p.errors++ }

func TestNativeFixture_RestorationRegisteredBeforePartialWriteError(t *testing.T) {
	p := &fixtureCleanupProbe{}
	writeErr := errors.New("write may have applied before failing")
	restored := false
	err := mutateOwnedFixture(p, func() error {
		if len(p.cleanup) != 1 {
			t.Fatal("restoration not registered before write")
		}
		return writeErr
	}, func() error { restored = true; return nil })
	if !errors.Is(err, writeErr) {
		t.Fatalf("write error lost: %v", err)
	}
	for _, cleanup := range p.cleanup {
		cleanup()
	}
	if !restored || p.errors != 0 {
		t.Fatalf("restored=%v errors=%d", restored, p.errors)
	}
}

func TestNativeFixture_RestorationFailureIsReportedAfterSuccessfulWrite(t *testing.T) {
	p := &fixtureCleanupProbe{}
	if err := mutateOwnedFixture(p, func() error { return nil }, func() error { return errors.New("restore mismatch") }); err != nil {
		t.Fatal(err)
	}
	for _, cleanup := range p.cleanup {
		cleanup()
	}
	if p.errors != 1 {
		t.Fatalf("restore failure reported %d times", p.errors)
	}
}
