// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import "strings"

// Problem codes in IntegrationStatus.Problems (and status.agents[].
// integration.problems). They are a stable contract: clients switch on
// them, so a new one is added here, never phrased ad hoc.
const (
	// ProblemSettingsInvalid: Claude Code's settings.json is not JSON the
	// companion can edit.
	ProblemSettingsInvalid = "settings_invalid"
	// ProblemHooksInvalid: Codex's hooks.json is invalid.
	ProblemHooksInvalid = "hooks_invalid"
	// ProblemConfigInvalid: Codex's config.toml does not parse, or its
	// telemetry section cannot be planned.
	ProblemConfigInvalid = "config_invalid"
	// ProblemConfigUnreadable: Codex's config.toml cannot be read.
	ProblemConfigUnreadable = "config_unreadable"
	// ProblemConflictExistingOTel: another OpenTelemetry exporter is set up;
	// the companion leaves it alone and exports nothing.
	ProblemConflictExistingOTel = "conflict_existing_otel"
	// ProblemHookDisabledInCodex: the user disabled a companion hook in Codex.
	ProblemHookDisabledInCodex = "hook_disabled_in_codex"
	// ProblemExtensionUnreadable / ProblemExtensionNotOwned: pi's extension
	// file cannot be read, or is not the companion's.
	ProblemExtensionUnreadable = "extension_unreadable"
	ProblemExtensionNotOwned   = "extension_not_owned"
	// ProblemCompanionExecutableMissing: hooks name a companion binary that
	// no longer exists (the app moved or was removed).
	ProblemCompanionExecutableMissing = "companion_executable_missing"
	// ProblemRestartRequired: the agent's desktop app started before the
	// companion last changed its integration and has not loaded it yet.
	// Quitting and reopening the app fixes it; the integration itself is
	// fine, so the state is not broken.
	ProblemRestartRequired = "restart_required"
	// ProblemDaemonRestartRequired is the same for the agent's background
	// app-server daemon, which outlives its desktop app.
	ProblemDaemonRestartRequired = "daemon_restart_required"
)

// Component problems are "<component>:<condition>": a hook event name
// (SessionStart, Stop, …), "otel" or "extension", then one of these.
const (
	ProblemMissing = "missing"
	ProblemStale   = "stale"
	ProblemInvalid = "invalid"
)

var namedProblems = map[string]bool{
	ProblemSettingsInvalid: true, ProblemHooksInvalid: true, ProblemConfigInvalid: true,
	ProblemConfigUnreadable: true, ProblemConflictExistingOTel: true, ProblemHookDisabledInCodex: true,
	ProblemExtensionUnreadable: true, ProblemExtensionNotOwned: true, ProblemCompanionExecutableMissing: true,
	ProblemRestartRequired: true, ProblemDaemonRestartRequired: true,
}

// ComponentProblem is the "<component>:<condition>" code.
func ComponentProblem(component, condition string) string { return component + ":" + condition }

// KnownProblem reports whether code is one of the documented codes.
func KnownProblem(code string) bool {
	if namedProblems[code] {
		return true
	}
	component, condition, found := strings.Cut(code, ":")
	if !found || component == "" || strings.ContainsAny(component, ": ") {
		return false
	}
	return condition == ProblemMissing || condition == ProblemStale || condition == ProblemInvalid
}
