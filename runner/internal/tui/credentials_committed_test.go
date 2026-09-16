// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"errors"
	"testing"
)

// commitFrom fills both fields and presses enter, returning the wizard at the
// connect step with the typed values committed.
func commitFrom(t *testing.T, w Wizard, host, apiKey string) Wizard {
	t.Helper()
	w.credentialsStep.host.SetValue(host)
	w.credentialsStep.apiKey.SetValue(apiKey)
	w = drive(w, key("enter"))
	if w.Step() != StepConnect {
		t.Fatalf("commit should hand off to connect, got %v", w.Step())
	}
	return w
}

// The credentials file and every downstream consumer read Result(), so it must
// report what was COMMITTED (normalized, and what connect actually used) — not
// whatever half-edit is sitting in the text fields when the wizard exits.
func TestResult_ReportsCommittedCredentialsNotFieldState(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Connect = func(ctx context.Context) (Identity, error) {
		return Identity{}, errors.New("backend down")
	}

	w := atCredentials(t, deps)
	w = commitFrom(t, w, "example.com", "vlr_committed_key")

	// Connect fails; the operator re-enters the credentials step and starts
	// editing, then abandons the edit without pressing enter.
	w = drive(w, connectFailedMsg{err: errors.New("backend down")})
	w = drive(w, key("e"))
	if w.Step() != StepCredentials {
		t.Fatalf("e should reopen the credentials step, got %v", w.Step())
	}
	w.credentialsStep.host.SetValue("half-typed-garbage/")
	w = drive(w, key("tab"))
	w = typeRunes(w, "_junk_suffix")

	result := w.Result()
	if result.APIURL != "https://example.com" {
		t.Errorf("Result must report the committed, normalized host, got %q", result.APIURL)
	}
	if result.APIKey != "vlr_committed_key" {
		t.Errorf("Result must report the committed key, got %q", result.APIKey)
	}
}

// The commit is the one gate where normalizeHost runs; Result must return that
// normalized form even though the operator typed a bare domain.
func TestResult_HostIsNormalizedOnCommit(t *testing.T) {
	defer ForcePlain()()

	w := atCredentials(t, testDeps())
	w = commitFrom(t, w, "backplane.example.com", "vlr_key")

	if got := w.Result().APIURL; got != "https://backplane.example.com" {
		t.Errorf("committed host should be normalized, got %q", got)
	}
}

// A wizard that never reached a commit (cancelled at the credentials screen)
// must not smuggle the raw field contents into Result — empty means "the
// operator settled nothing", which overriddenBy treats as keep-what-resolved.
func TestResult_UncommittedCredentialsStayEmpty(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Credentials = CredentialSeed{Host: "http://localhost:8000"}
	w := atCredentials(t, deps)
	w = typeRunes(w, "/extra")

	result := w.Result()
	if result.APIURL != "" || result.APIKey != "" {
		t.Errorf("uncommitted fields must not reach Result, got url=%q key=%q",
			result.APIURL, result.APIKey)
	}
}
