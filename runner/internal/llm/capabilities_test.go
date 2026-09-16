// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import "testing"

// A CapabilityProvider lets the runner adapt to what a coding-agent backend can
// actually do (cost reporting, structured output, session resume, …) instead of
// assuming the Claude feature set. ClaudeCLI must report its real capabilities.
func TestClaudeCLI_Capabilities(t *testing.T) {
	var p Provider = NewClaudeCLI()

	cp, ok := p.(CapabilityProvider)
	if !ok {
		t.Fatalf("ClaudeCLI must implement CapabilityProvider")
	}

	got := cp.Capabilities()
	want := Capabilities{
		StructuredOutput: true,
		CostUSD:          true,
		Tokens:           true,
		SessionResume:    true,
		NativeMCP:        true,
		AutoCommits:      false,
		BudgetCap:        true,
		// Card 0ac035df: Claude enforces the shell deny-floor via
		// --disallowedTools (Bash(...) prefix rules; nested shells escape).
		EnforcesShellDeny:  true,
		ShellDenyMechanism: "disallowed-tools",
	}
	if got != want {
		t.Errorf("ClaudeCLI.Capabilities() = %+v, want %+v", got, want)
	}
}

// Every provider that claims to enforce the shell deny-floor must NAME its
// mechanism, so the launch log (workloop llmOpts) can tell an operator HOW the
// floor is held on this host — "disallowed-tools" vs "execpolicy-rules" —
// rather than a bare boolean. A nameless claim is treated as a bug.
func TestCapabilities_ShellDenyMechanismNamed(t *testing.T) {
	providers := []CapabilityProvider{NewClaudeCLI(), NewCodexCLI()}
	for _, p := range providers {
		caps := p.Capabilities()
		if !caps.EnforcesShellDeny {
			t.Errorf("%s: EnforcesShellDeny must be true — both shipped coding agents carry the floor", p.Name())
		}
		if caps.EnforcesShellDeny && caps.ShellDenyMechanism == "" {
			t.Errorf("%s: EnforcesShellDeny without a ShellDenyMechanism name", p.Name())
		}
		if !caps.EnforcesShellDeny && caps.ShellDenyMechanism != "" {
			t.Errorf("%s: names mechanism %q but does not enforce", p.Name(), caps.ShellDenyMechanism)
		}
	}
	// The mock declares nothing: no enforcement, no mechanism — consistent.
	mock := NewMockProvider().Capabilities()
	if mock.EnforcesShellDeny || mock.ShellDenyMechanism != "" {
		t.Errorf("MockProvider must not claim enforcement by default, got %+v", mock)
	}
}

// Capabilities must agree with the legacy capability sub-interfaces so callers
// can rely on either without divergence.
func TestClaudeCLI_CapabilitiesMatchLegacyInterfaces(t *testing.T) {
	p := NewClaudeCLI()
	caps := p.Capabilities()

	if caps.SessionResume != p.SupportsResume() {
		t.Errorf("SessionResume=%v but SupportsResume()=%v", caps.SessionResume, p.SupportsResume())
	}
	if caps.CostUSD != p.SupportsCostTracking() {
		t.Errorf("CostUSD=%v but SupportsCostTracking()=%v", caps.CostUSD, p.SupportsCostTracking())
	}
	if caps.NativeMCP != p.SupportsToolConfig() {
		t.Errorf("NativeMCP=%v but SupportsToolConfig()=%v", caps.NativeMCP, p.SupportsToolConfig())
	}
}
