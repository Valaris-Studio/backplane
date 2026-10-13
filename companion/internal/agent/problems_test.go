// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import "testing"

func TestKnownProblem_AcceptsEveryDocumentedCode(t *testing.T) {
	for _, code := range []string{
		ProblemSettingsInvalid, ProblemHooksInvalid, ProblemConfigInvalid, ProblemConfigUnreadable,
		ProblemConflictExistingOTel, ProblemHookDisabledInCodex, ProblemExtensionUnreadable,
		ProblemExtensionNotOwned, ProblemCompanionExecutableMissing,
		"SessionStart:missing", "Stop:stale", "UserPromptSubmit:invalid", "otel:missing", "otel:stale", "extension:stale",
	} {
		if !KnownProblem(code) {
			t.Errorf("%q must be a known problem", code)
		}
	}
}

func TestKnownProblem_RejectsFreeFormText(t *testing.T) {
	for _, code := range []string{"", "hooks disabled", "Stop:", ":missing", "Stop:broken", "stop:missing now", "a:b:missing"} {
		if KnownProblem(code) {
			t.Errorf("%q must not be a known problem", code)
		}
	}
}
