// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// profileResult is a launched wizard Result that asked to be saved as a
// profile. SaveConfig is on so the tests stay agnostic about whether the
// implementation gates on the toggle, the name, or both.
func profileResult() tui.Result {
	return tui.Result{
		ProfileName: "acme@prod",
		SaveConfig:  true,
		APIKey:      "vlr_acme_key",
		APIURL:      "https://prod.acme.example.com",
		Workspace:   "acme-ws",
		WorkDir:     "/srv/acme-runner/repos",
		Model:       "acme-opus",
		BudgetUSD:   33.5,
	}
}

func TestApplyWizardProfile_NoNameLeavesTheStoreAlone(t *testing.T) {
	store := profile.NewStore(t.TempDir())
	result := profileResult()
	result.ProfileName = ""

	if err := applyWizardProfile(result, result.Apply(nil), store); err != nil {
		t.Fatalf("no profile name is a no-op, not an error: %v", err)
	}
	if profiles, err := store.List(); err != nil || len(profiles) != 0 {
		t.Errorf("nothing should be written without a name, got %d profiles (%v)", len(profiles), err)
	}
}

func TestApplyWizardProfile_WritesANewProfileThroughTheStore(t *testing.T) {
	store := profile.NewStore(t.TempDir())
	result := profileResult()

	if err := applyWizardProfile(result, result.Apply(nil), store); err != nil {
		t.Fatalf("applyWizardProfile: %v", err)
	}

	p, err := store.Load("acme@prod")
	if err != nil {
		t.Fatalf("the profile should exist after a save-enabled launch: %v", err)
	}
	want := profile.Credentials{
		APIKey:    "vlr_acme_key",
		APIURL:    "https://prod.acme.example.com",
		Workspace: "acme-ws",
	}
	if p.Credentials != want {
		t.Errorf("stored credentials = %+v, want %+v", p.Credentials, want)
	}

	yaml, err := os.ReadFile(store.ConfigPath("acme@prod"))
	if err != nil {
		t.Fatalf("the profile's runner.yaml should exist: %v", err)
	}
	if !strings.Contains(string(yaml), tui.APIKeyPlaceholder) {
		t.Errorf("the profile's runner.yaml should carry the env placeholder, got:\n%s", yaml)
	}
	if strings.Contains(string(yaml), "vlr_acme_key") {
		t.Errorf("the raw key must never land in the yaml — it belongs to the credentials file:\n%s", yaml)
	}
	if !strings.Contains(string(yaml), "/srv/acme-runner/repos") {
		t.Errorf("the wizard's choices should be in the profile's runner.yaml, got:\n%s", yaml)
	}
}

func TestApplyWizardProfile_RefusesASilentOverwrite(t *testing.T) {
	store := profile.NewStore(t.TempDir())
	existing := profile.Credentials{APIKey: "vlr_old_key", APIURL: "https://old.example.com", Workspace: "old-ws"}
	if err := store.Save("acme@prod", existing, []byte("valaris: {}\n"), []byte("{}\n")); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	result := profileResult() // ProfileOverwrite deliberately false
	err := applyWizardProfile(result, result.Apply(nil), store)
	if !errors.Is(err, profile.ErrProfileExists) {
		t.Fatalf("an unconfirmed collision must surface ErrProfileExists, got %v", err)
	}
	if p, loadErr := store.Load("acme@prod"); loadErr != nil || p.Credentials != existing {
		t.Errorf("the existing profile must be untouched, got %+v (%v)", p.Credentials, loadErr)
	}
}

func TestApplyWizardProfile_ConfirmedOverwriteReplaces(t *testing.T) {
	store := profile.NewStore(t.TempDir())
	existing := profile.Credentials{APIKey: "vlr_old_key", APIURL: "https://old.example.com", Workspace: "old-ws"}
	if err := store.Save("acme@prod", existing, []byte("valaris: {}\n"), []byte("{}\n")); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	result := profileResult()
	result.ProfileOverwrite = true
	if err := applyWizardProfile(result, result.Apply(nil), store); err != nil {
		t.Fatalf("a confirmed overwrite should succeed: %v", err)
	}
	p, err := store.Load("acme@prod")
	if err != nil {
		t.Fatalf("Load after overwrite: %v", err)
	}
	if p.Credentials.APIKey != "vlr_acme_key" {
		t.Errorf("the overwrite should replace the stored credentials, got %+v", p.Credentials)
	}
}

// -doctor must honor -profile the same way the run path does: through the
// profile store. Pinned at a narrow resolver seam because main's doctor
// branch cannot run without a terminal.
func TestResolveDoctorConfigPath_ProfileFlagRoutesThroughTheStore(t *testing.T) {
	root := t.TempDir()
	store := profile.NewStore(root)
	if err := store.Save("acme", profile.Credentials{APIKey: "vlr_k"}, []byte("valaris: {}\n"), []byte("{}\n")); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	got, err := resolveDoctorConfigPath(root, "", "acme")
	if err != nil {
		t.Fatalf("resolveDoctorConfigPath: %v", err)
	}
	if want := store.ConfigPath("acme"); got != want {
		t.Errorf("doctor should diagnose the profile's runner.yaml, got %q want %q", got, want)
	}
}

func TestResolveDoctorConfigPath_BothFlagsConflict(t *testing.T) {
	_, err := resolveDoctorConfigPath(t.TempDir(), filepath.Join(t.TempDir(), "runner.yaml"), "acme")
	if !errors.Is(err, profile.ErrConflictingFlags) {
		t.Errorf("-config with -profile is the same conflict the run path rejects, got %v", err)
	}
}

func TestResolveDoctorConfigPath_MissingProfileIsNamed(t *testing.T) {
	_, err := resolveDoctorConfigPath(t.TempDir(), "", "no-such-profile")
	if !errors.Is(err, profile.ErrProfileNotFound) {
		t.Errorf("a missing profile should be reported, not silently ignored, got %v", err)
	}
}

func TestResolveDoctorConfigPath_ConfigFlagPassesThrough(t *testing.T) {
	got, err := resolveDoctorConfigPath(t.TempDir(), "/etc/backplane/runner.yaml", "")
	if err != nil || got != "/etc/backplane/runner.yaml" {
		t.Errorf("-config alone passes through verbatim, got %q (%v)", got, err)
	}
	got, err = resolveDoctorConfigPath(t.TempDir(), "", "")
	if err != nil || got != "" {
		t.Errorf("neither flag yields the discovery fallback, got %q (%v)", got, err)
	}
}
