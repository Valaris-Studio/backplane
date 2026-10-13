// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package state

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func TestRecordMappedRoot_KeepsTheLatestMappingPerRoot(t *testing.T) {
	layout := store.Layout{Root: t.TempDir()}
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	if err := RecordMappedRoot(context.Background(), layout, "/src/app", "m1", now); err != nil {
		t.Fatal(err)
	}
	RecordMappedRoot(context.Background(), layout, "/src/app", "m2", now.Add(time.Minute))
	roots, err := Load[MappedRoots](layout.MappedRoots())
	if err != nil || roots.Roots["/src/app"].MappingID != "m2" {
		t.Fatalf("mapped roots %+v %v", roots, err)
	}
}

func TestRecordMappedRoot_UnchangedAndFreshWritesNothing(t *testing.T) {
	layout := store.Layout{Root: t.TempDir()}
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	RecordMappedRoot(context.Background(), layout, "/src/app", "m1", now)
	info, _ := os.Stat(layout.MappedRoots())
	os.Chtimes(layout.MappedRoots(), info.ModTime().Add(-time.Hour), info.ModTime().Add(-time.Hour))
	before, _ := os.Stat(layout.MappedRoots())
	RecordMappedRoot(context.Background(), layout, "/src/app", "m1", now.Add(time.Minute))
	if after, _ := os.Stat(layout.MappedRoots()); !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("an unchanged, fresh root was rewritten on the hot path")
	}
}

func TestRecordMappedRoot_IsBounded(t *testing.T) {
	layout := store.Layout{Root: t.TempDir()}
	now := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	for index := range maxMappedRoots + 5 {
		RecordMappedRoot(context.Background(), layout, fmt.Sprintf("/src/app%d", index), "m1", now.Add(time.Duration(index)*time.Second))
	}
	roots, _ := Load[MappedRoots](layout.MappedRoots())
	if len(roots.Roots) != maxMappedRoots {
		t.Fatalf("%d roots kept", len(roots.Roots))
	}
	if _, oldest := roots.Roots["/src/app0"]; oldest {
		t.Fatal("the least recently seen root was kept")
	}
}
