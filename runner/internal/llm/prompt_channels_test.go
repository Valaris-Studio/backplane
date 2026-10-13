// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import "testing"

// CheckPromptChannels judges a launch by the declaration alone: version 0
// is the legacy launch, version 1 needs the entry point's own channels, and
// any other version is refused.
func TestCheckPromptChannels(t *testing.T) {
	all := PromptChannels{Version: 1, FreshInput: true, FreshSystem: true, ResumeInput: true, ResumeSystem: true}
	freshSystemOnly := PromptChannels{Version: 1, FreshInput: true, FreshSystem: true, ResumeInput: true}
	resumeSystemOnly := PromptChannels{Version: 1, FreshInput: true, ResumeInput: true, ResumeSystem: true}
	noFreshInput := PromptChannels{Version: 1, FreshSystem: true, ResumeInput: true, ResumeSystem: true}
	noResumeInput := PromptChannels{Version: 1, FreshInput: true, FreshSystem: true, ResumeSystem: true}
	inputOnly := PromptChannels{Version: 1, FreshInput: true, ResumeInput: true}
	cases := []struct {
		name     string
		channels PromptChannels
		version  int
		resume   bool
		system   string
		refused  bool
	}{
		{"legacy ignores an undeclared adapter", PromptChannels{}, 0, false, "system", false},
		{"legacy ignores an undeclared adapter on resume", PromptChannels{}, 0, true, "system", false},
		{"required refuses an undeclared adapter", PromptChannels{}, 1, false, "", true},
		{"required refuses an undeclared adapter on resume", PromptChannels{}, 1, true, "", true},
		{"required refuses a declaration of another version", PromptChannels{Version: 2, FreshInput: true, ResumeInput: true}, 1, false, "", true},
		{"required accepts every declared channel", all, 1, false, "system", false},
		{"required accepts every declared channel on resume", all, 1, true, "system", false},
		{"fresh system declared, fresh launch", freshSystemOnly, 1, false, "system", false},
		{"fresh system declared, resumed launch", freshSystemOnly, 1, true, "system", true},
		{"resume system declared, resumed launch", resumeSystemOnly, 1, true, "system", false},
		{"resume system declared, fresh launch", resumeSystemOnly, 1, false, "system", true},
		{"no fresh input", noFreshInput, 1, false, "", true},
		{"no fresh input still allows resume", noFreshInput, 1, true, "", false},
		{"no resume input", noResumeInput, 1, true, "", true},
		{"no resume input still allows fresh", noResumeInput, 1, false, "", false},
		{"empty system needs no system channel", inputOnly, 1, false, "", false},
		{"empty system needs no system channel on resume", inputOnly, 1, true, "", false},
		{"system without a system channel", inputOnly, 1, false, "system", true},
		{"system without a system channel on resume", inputOnly, 1, true, "system", true},
		{"negative version", all, -1, false, "", true},
		{"version 2", all, 2, false, "", true},
		{"huge version", all, 1 << 30, true, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := CheckPromptChannels(c.channels, c.resume, Options{ContextDispatchVersion: c.version, SystemPrompt: c.system})
			if refused := err != nil; refused != c.refused {
				t.Fatalf("refused = %v (%v), want %v", refused, err, c.refused)
			}
		})
	}
}
