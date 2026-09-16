// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"log/slog"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// denyEnforcement is what the launch log says about the shell deny-floor on
// this host: which coding agent runs the stage, whether it holds the floor,
// by which mechanism, and which backend deny entries it cannot apply
// (card 0ac035df). The log is the operator's only view of this.
type denyEnforcement struct {
	Provider   string
	Enforced   bool
	Mechanism  string
	Unenforced []string
}

func describeDenyEnforcement(provider llm.Provider, deny []string) denyEnforcement {
	var e denyEnforcement
	if provider == nil {
		return e
	}
	e.Provider = provider.Name()
	if cp, ok := provider.(llm.CapabilityProvider); ok {
		caps := cp.Capabilities()
		e.Enforced = caps.EnforcesShellDeny
		e.Mechanism = caps.ShellDenyMechanism
	}
	if reporter, ok := provider.(llm.ShellDenyReporter); ok {
		e.Unenforced = reporter.UnenforceableDeny(deny)
	}
	return e
}

// logLevel is WARN when the backend asked for a restriction this host would
// silently not apply, INFO otherwise.
func (e denyEnforcement) logLevel() slog.Level {
	if len(e.Unenforced) > 0 {
		return slog.LevelWarn
	}
	return slog.LevelInfo
}

func (e denyEnforcement) logAttrs() []any {
	return []any{
		"provider", e.Provider,
		"shell_deny_enforced", e.Enforced,
		"shell_deny_mechanism", e.Mechanism,
		"unenforced_deny", e.Unenforced,
	}
}
