// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// A key that came from the wizard-written credentials file must be attributed
// to it — an operator debugging a stale key needs to know WHICH file to edit.
func TestCheckCredentials_NamesTheCredentialsFileSource(t *testing.T) {
	creds := Credentials{
		APIKey: "vlr_supersecret", APIKeySource: credSourceCredentialsFile,
		APIURL: "https://backplane.example.com", APIURLSource: credSourceFile,
		Workspace: "valaris", WorkspaceSource: credSourceFile,
	}

	got := checkCredentials(creds)

	if got.State != tui.StateOK {
		t.Fatalf("fully resolved credentials must be OK, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, credSourceCredentialsFile.String()) {
		t.Errorf("the detail should name the credentials file: %q", got.Detail)
	}
	if strings.Contains(got.Detail, "vlr_supersecret") {
		t.Fatalf("the key leaked into the rendered check: %q", got.Detail)
	}
}

// The export-trap hint added in 96249e5 must survive the new source: it is the
// remedy for the single most common cause of an unresolved key.
func TestCheckCredentials_StillNamesTheExportTrapAndTheCredentialsFile(t *testing.T) {
	got := checkCredentials(Credentials{APIURL: "http://localhost:8000"})

	fix := strings.ToLower(got.Fix)
	for _, want := range []string{"export", "child process"} {
		if !strings.Contains(fix, want) {
			t.Errorf("the export-trap hint regressed (missing %q): %q", want, got.Fix)
		}
	}
	if !strings.Contains(fix, "interactive") && !strings.Contains(fix, credentialsFilename) {
		t.Errorf("the fix should point at the wizard or the credentials file it writes: %q", got.Fix)
	}
}

func TestCredSource_StringsAreDistinct(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range []credSource{credSourceNone, credSourceEnv, credSourceFile, credSourceCredentialsFile} {
		if seen[s.String()] {
			t.Errorf("credSource %d shares a label with another: %q", s, s.String())
		}
		seen[s.String()] = true
	}
}
