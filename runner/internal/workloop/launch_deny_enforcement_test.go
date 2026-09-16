// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Card 0ac035df — the launch log is the operator's only view of whether the
// shell deny-floor is actually held on this host. The existing "resolved tool
// deny-list for stage" line (llmOpts) must also say WHICH provider runs the
// stage, whether it enforces the floor, by which mechanism, and which backend
// deny entries that provider cannot enforce (Codex has no equivalent for
// Claude built-ins such as WebFetch). A non-empty unenforced list is a WARN:
// the backend asked for a restriction the host silently would not apply.

func captureLaunchLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// denyLogLine returns the resolved-deny launch line, failing if it is missing.
func denyLogLine(t *testing.T, buf *bytes.Buffer) string {
	t.Helper()
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, "resolved tool deny-list for stage") {
			return line
		}
	}
	t.Fatalf("no 'resolved tool deny-list for stage' launch line; log:\n%s", buf.String())
	return ""
}

func newDenyEnforcementLoop(t *testing.T) *Loop {
	t.Helper()
	loop := newModelTestLoop(t, "yaml-default")
	loop.SetProviders(map[string]llm.Provider{
		"claude-cli": llm.NewClaudeCLI(),
		"codex-cli":  llm.NewCodexCLI(),
	})
	return loop
}

func TestLoop_LaunchLogReportsDenyEnforcement(t *testing.T) {
	denyWithBuiltin := append(append([]string{}, llm.SafeToolDenyFloor...), "WebFetch")

	t.Run("codex_with_unenforceable_entry_warns", func(t *testing.T) {
		loop := newDenyEnforcementLoop(t)
		buf := captureLaunchLog(t)
		assignment := valaris.AssignmentLLM{Provider: "codex-cli", Model: "gpt-5-codex", PromptSlug: "implement"}
		assignment.ToolPolicy.Deny = denyWithBuiltin
		loop.SetAssignmentLLM(assignment)

		loop.llmOpts("implement")

		line := denyLogLine(t, buf)
		for _, want := range []string{
			"provider=codex-cli",
			"shell_deny_enforced=true",
			"shell_deny_mechanism=execpolicy-rules",
			"unenforced_deny=",
			"WebFetch",
			"level=WARN",
		} {
			if !strings.Contains(line, want) {
				t.Errorf("launch line missing %q:\n%s", want, line)
			}
		}
	})

	t.Run("codex_all_enforceable_is_info", func(t *testing.T) {
		loop := newDenyEnforcementLoop(t)
		buf := captureLaunchLog(t)
		assignment := valaris.AssignmentLLM{Provider: "codex-cli", Model: "gpt-5-codex", PromptSlug: "implement"}
		assignment.ToolPolicy.Deny = append(append([]string{}, llm.SafeToolDenyFloor...), "mcp__valaris__update_card")
		loop.SetAssignmentLLM(assignment)

		loop.llmOpts("implement")

		line := denyLogLine(t, buf)
		for _, want := range []string{
			"provider=codex-cli",
			"shell_deny_enforced=true",
			"shell_deny_mechanism=execpolicy-rules",
			"level=INFO",
		} {
			if !strings.Contains(line, want) {
				t.Errorf("launch line missing %q (fully enforceable deny logs at INFO with the enforcement fields):\n%s", want, line)
			}
		}
		if strings.Contains(line, "WebFetch") || strings.Contains(line, "unenforced_deny=[mcp") {
			t.Errorf("Bash and mcp__valaris__ entries are enforceable on Codex; none may be reported unenforced:\n%s", line)
		}
	})

	t.Run("claude_enforces_builtins_no_warn", func(t *testing.T) {
		loop := newDenyEnforcementLoop(t)
		buf := captureLaunchLog(t)
		assignment := valaris.AssignmentLLM{Provider: "claude-cli", Model: "sonnet", PromptSlug: "implement"}
		assignment.ToolPolicy.Deny = denyWithBuiltin
		loop.SetAssignmentLLM(assignment)

		loop.llmOpts("implement")

		line := denyLogLine(t, buf)
		for _, want := range []string{
			"provider=claude-cli",
			"shell_deny_enforced=true",
			"shell_deny_mechanism=disallowed-tools",
			"level=INFO",
		} {
			if !strings.Contains(line, want) {
				t.Errorf("launch line missing %q:\n%s", want, line)
			}
		}
		// --disallowedTools takes WebFetch verbatim: nothing is unenforced on Claude.
		if strings.Contains(line, "unenforced_deny=[WebFetch]") || strings.Contains(line, `unenforced_deny="[WebFetch]"`) {
			t.Errorf("WebFetch is enforceable on Claude and must not be reported unenforced:\n%s", line)
		}
	})
}
