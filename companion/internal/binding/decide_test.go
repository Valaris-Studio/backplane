// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestConnectionScoped_ListsExactlyTheEntriesABindingOwns(t *testing.T) {
	var got []string
	for _, entry := range ConnectionScoped {
		got = append(got, strings.TrimSuffix(entry, "/"))
	}
	want := append(append([]string{}, scopedFiles...), scopedDirs...)
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("ConnectionScoped = %v\nwant %v", got, want)
	}
}

func TestDecision_EveryOutcomeIsDistinct(t *testing.T) {
	seen := map[Decision]string{}
	for _, known := range decisionNames {
		if earlier, taken := seen[known.decision]; taken {
			t.Errorf("%s and %s are the same decision", earlier, known.name)
		}
		seen[known.decision] = known.name
	}
}

func TestDecide_AnUnboundRootWithOnlyDeviceFilesIsFresh(t *testing.T) {
	root := dataRoot(t)
	configured := primary()
	requireDecision(t, root, configured, &configured, Fresh)
	writeDeviceState(t, root)
	requireDecision(t, root, configured, &configured, Fresh)
}

func TestDecide_TheBoundIdentityVerifiedAgainResumes(t *testing.T) {
	root := dataRoot(t)
	configured := primary()
	bind(t, root, configured, firstBoundAt, "first")
	verified := configured
	requireDecision(t, root, configured, &verified, Resume)
}

func TestDecide_ATokenForAnotherIdentityHoldsWithoutMovingAnything(t *testing.T) {
	configured := primary()
	otherInstallation, otherOwner := configured, configured
	otherInstallation.InstallationID = secondary().InstallationID
	otherOwner.OwnerEmail = "someone@example.com"
	for name, verified := range map[string]Identity{"installation": otherInstallation, "owner": otherOwner} {
		t.Run("bound/"+name, func(t *testing.T) {
			root := dataRoot(t)
			bind(t, root, configured, firstBoundAt, "first")
			requireDecision(t, root, configured, &verified, HoldIdentityMismatch)
		})
		t.Run("unbound/"+name, func(t *testing.T) {
			root := dataRoot(t)
			writeDeviceState(t, root)
			requireDecision(t, root, configured, &verified, HoldIdentityMismatch)
		})
	}
}

func TestDecide_OnlyAConfigChangeSwitches(t *testing.T) {
	root := dataRoot(t)
	bind(t, root, primary(), firstBoundAt, "first")
	configured := secondary()
	requireDecision(t, root, configured, &configured, Switch)
}

func TestDecide_ConnectionStateWithoutARecordIsHeldAsUnbound(t *testing.T) {
	configured := primary()
	for _, entry := range append(append([]string{}, scopedFiles...), scopedDirs...) {
		t.Run(entry, func(t *testing.T) {
			root := dataRoot(t)
			writeDeviceState(t, root)
			writeConnectionState(t, root, "legacy", entry)
			requireDecision(t, root, configured, &configured, HoldUnboundState)
		})
	}
}

func TestDecide_AnUnverifiedIdentityHoldsBeforeAnyOtherRow(t *testing.T) {
	for name, prepare := range map[string]func(t *testing.T, root string){
		"unbound":       func(t *testing.T, root string) { writeDeviceState(t, root) },
		"bound":         func(t *testing.T, root string) { bind(t, root, primary(), firstBoundAt, "first") },
		"legacy state":  func(t *testing.T, root string) { writeConnectionState(t, root, "legacy") },
		"other binding": func(t *testing.T, root string) { bind(t, root, secondary(), firstBoundAt, "second") },
	} {
		t.Run(name, func(t *testing.T) {
			root := dataRoot(t)
			prepare(t, root)
			requireDecision(t, root, primary(), nil, HoldUnverified)
		})
	}
}

func TestDecide_AJournalHoldsTheSwitchInProgress(t *testing.T) {
	resetSwitchHook(t)
	root := dataRoot(t)
	from, to := primary(), secondary()
	bind(t, root, from, firstBoundAt, "first")
	switchCrashingAfter(t, "journaled", root, from, to, switchedAt)
	requireDecision(t, root, to, &to, HoldSwitchInProgress)
	requireDecision(t, root, to, nil, HoldSwitchInProgress)
	requireDecision(t, root, from, &from, HoldSwitchInProgress)
}

func TestDecide_AnUnreadableRecordIsAnError(t *testing.T) {
	root := dataRoot(t)
	configured := primary()
	bind(t, root, configured, firstBoundAt, "first")
	requireDecision(t, root, configured, &configured, Resume)
	writeFile(t, filepath.Join(root, "binding.json"), []byte(`{"version":1,`))
	if decision, err := Decide(root, configured, &configured); err == nil {
		t.Fatalf("decided %s over a corrupt binding.json", decisionName(decision))
	}
}
