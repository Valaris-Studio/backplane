// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestClaudeCLIName(t *testing.T) {
	cli := NewClaudeCLI()
	if cli.Name() != "claude-cli" {
		t.Errorf("Name() = %q, want %q", cli.Name(), "claude-cli")
	}
}

func TestBuildArgsMinimal(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{})

	assertContains(t, args, "-p")
	assertContains(t, args, "--output-format")
	assertContains(t, args, "stream-json")
}

func TestBuildArgsFullOptions(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{
		Model:          "opus",
		MCPConfigPath:  "/opt/mcp.json",
		SystemPrompt:   "You are a coding agent.",
		MaxBudgetUSD:   2.50,
		PermissionMode: "auto",
		OutputFormat:   "json",
		AllowedTools:   []string{"mcp__valaris__list_boards", "mcp__valaris__search_cards"},
	})

	assertContains(t, args, "--model")
	assertContains(t, args, "opus")
	assertContains(t, args, "--mcp-config")
	assertContains(t, args, "/opt/mcp.json")
	assertContains(t, args, "--strict-mcp-config")
	assertContains(t, args, "--system-prompt")
	assertContains(t, args, "--max-budget-usd")
	assertContains(t, args, "2.50")
	assertContains(t, args, "--permission-mode")
	assertContains(t, args, "auto")
	assertContains(t, args, "--output-format")
	assertContains(t, args, "stream-json")
	assertContains(t, args, "--allowedTools")
	assertContains(t, args, "mcp__valaris__list_boards")
}

// The headless-autonomous path overrides any caller PermissionMode: it always
// renders --permission-mode bypassPermissions + a --disallowedTools deny-list,
// never the raw --dangerously-skip-permissions flag and never dontAsk
// (card 7f1d289d / runner deny-list fix).
func TestBuildArgsDangerouslySkipPermissions(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{
		DangerouslySkipPermissions: true,
		PermissionMode:             "auto", // ignored — autonomous path forces bypassPermissions
		DisallowedTools:            SafeToolDenyFloor,
	})

	for _, a := range args {
		if a == "--dangerously-skip-permissions" {
			t.Error("--dangerously-skip-permissions must not be emitted; deny-list replaces it")
		}
		if a == "dontAsk" {
			t.Error("dontAsk must not be emitted; bypassPermissions + deny-list replaces it")
		}
	}
	if mode := argValue(args, "--permission-mode"); mode != "bypassPermissions" {
		t.Errorf("--permission-mode = %q, want bypassPermissions (overrides caller auto)", mode)
	}
}

func TestBuildArgsWithResume(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{ResumeSessionID: "sess-abc-123"})

	assertContains(t, args, "--resume")
	assertContains(t, args, "sess-abc-123")
}

func TestBuildArgsWithContextDirs(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{ContextDirs: []string{"/opt/prompts", "/opt/skills"}})

	addDirCount := 0
	for _, a := range args {
		if a == "--add-dir" {
			addDirCount++
		}
	}
	if addDirCount != 2 {
		t.Errorf("expected 2 --add-dir flags, got %d", addDirCount)
	}
	assertContains(t, args, "/opt/prompts")
	assertContains(t, args, "/opt/skills")
}

func TestBuildArgsWithOutputSchema(t *testing.T) {
	cli := NewClaudeCLI()
	schema := `{"type":"object","properties":{"decision":{"type":"string"}}}`
	args := cli.buildArgs("review this", Options{OutputSchema: schema})

	assertContains(t, args, "--json-schema")
	assertContains(t, args, schema)
}

func TestBuildArgsNoOutputSchemaWhenEmpty(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("review this", Options{})

	for _, a := range args {
		if a == "--json-schema" {
			t.Error("--json-schema should not be present when OutputSchema is empty")
		}
	}
}

func TestBuildArgsNoResumeWhenEmpty(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{})

	for _, a := range args {
		if a == "--resume" {
			t.Error("--resume should not be present when ResumeSessionID is empty")
		}
	}
}

// argValue returns the argument immediately following flag, or "" if absent.
func argValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// variadicValues returns the args following flag up to (but not including) the
// next "--"-prefixed flag. Matches the CLI's space-separated variadic form,
// e.g. `--disallowedTools "Bash(a)" "Bash(b)"`.
func variadicValues(args []string, flag string) []string {
	for i, a := range args {
		if a != flag {
			continue
		}
		var vals []string
		for j := i + 1; j < len(args); j++ {
			if strings.HasPrefix(args[j], "--") {
				break
			}
			vals = append(vals, args[j])
		}
		return vals
	}
	return nil
}

// The headless-autonomous path emits bypassPermissions (so Write/Edit/Read/Bash/
// MCP all work) PLUS a --disallowedTools deny-list. Deny always wins regardless
// of permission mode, so the implementer still cannot `gh pr merge` or push to
// main (card 7f1d289d). The earlier dontAsk + --settings allow-list blocked
// Write/Edit and broke every implement card — it must be gone.
func TestBuildArgs_SkipPermissions_EmitsBypassAndDisallowedTools(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{
		DangerouslySkipPermissions: true,
		DisallowedTools:            SafeToolDenyFloor,
	})

	if mode := argValue(args, "--permission-mode"); mode != "bypassPermissions" {
		t.Errorf("--permission-mode = %q, want bypassPermissions", mode)
	}

	for _, a := range args {
		if a == "--dangerously-skip-permissions" {
			t.Error("--dangerously-skip-permissions must NOT be present")
		}
		if a == "dontAsk" {
			t.Error("dontAsk must NOT be present")
		}
		if a == "--settings" {
			t.Error("--settings allow-list must NOT be present (it blocked Write/Edit)")
		}
	}

	deny := variadicValues(args, "--disallowedTools")
	if len(deny) == 0 {
		t.Fatal("expected a --disallowedTools deny-list")
	}
	for _, d := range SafeToolDenyFloor {
		if !slicesContains(deny, d) {
			t.Errorf("--disallowedTools missing %q; got %v", d, deny)
		}
	}
	// No allow-list may sneak in via any path.
	if v := variadicValues(args, "--allowedTools"); len(v) != 0 {
		t.Errorf("no --allowedTools expected on autonomous path, got %v", v)
	}
}

// A backend-supplied deny-list flows verbatim into --disallowedTools.
func TestBuildArgs_SkipPermissions_UsesBackendDeny(t *testing.T) {
	cli := NewClaudeCLI()
	backendDeny := []string{"Bash(rm -rf:*)", "Bash(gh pr merge:*)"}
	args := cli.buildArgs("test prompt", Options{
		DangerouslySkipPermissions: true,
		DisallowedTools:            backendDeny,
	})

	deny := variadicValues(args, "--disallowedTools")
	for _, d := range backendDeny {
		if !slicesContains(deny, d) {
			t.Errorf("--disallowedTools missing backend entry %q; got %v", d, deny)
		}
	}
}

// ---------------------------------------------------------------------------
// Card 1e315263 — SafeToolDenyFloor applies to EVERY session, not only the
// DangerouslySkipPermissions branch. A loop session with skip-permissions
// false previously launched with no --disallowedTools at all — whether the
// agent could `gh pr merge` depended on the MCP allowlist and permission
// mode, neither of which governs shell. The floor's rationale (the reviewer
// is the only quality gate; no branch protection) applies to a loop agent
// exactly as much as to a pipeline implementer.
// ---------------------------------------------------------------------------

// TestBuildArgs_DenyFloorAppliesWithoutSkipPermissions proves the floor rides
// on a plain permission-mode session — the loop-mode YAML default.
func TestBuildArgs_DenyFloorAppliesWithoutSkipPermissions(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{PermissionMode: "auto"})

	deny := variadicValues(args, "--disallowedTools")
	if len(deny) == 0 {
		t.Fatal("expected --disallowedTools on a non-bypass session — the floor is unconditional")
	}
	for _, d := range SafeToolDenyFloor {
		if !slicesContains(deny, d) {
			t.Errorf("--disallowedTools missing floor entry %q; got %v", d, deny)
		}
	}
	if mode := argValue(args, "--permission-mode"); mode != "auto" {
		t.Errorf("--permission-mode = %q, want the caller's %q untouched", mode, "auto")
	}
}

// TestBuildArgs_DenyFloorOnMinimalOptions proves even a zero-value Options
// session carries the floor.
func TestBuildArgs_DenyFloorOnMinimalOptions(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{})

	deny := variadicValues(args, "--disallowedTools")
	for _, d := range SafeToolDenyFloor {
		if !slicesContains(deny, d) {
			t.Errorf("--disallowedTools missing floor entry %q; got %v", d, deny)
		}
	}
}

// TestBuildArgs_BackendDenyMergedWithFloor proves a backend-supplied deny-list
// EXTENDS the floor, never replaces it: a backend that ships only its own
// entries must not silently drop `gh pr merge` protection.
func TestBuildArgs_BackendDenyMergedWithFloor(t *testing.T) {
	cli := NewClaudeCLI()
	backendDeny := []string{"Bash(rm -rf:*)", "mcp__custom__delete_everything"}
	args := cli.buildArgs("test prompt", Options{
		DangerouslySkipPermissions: true,
		DisallowedTools:            backendDeny,
	})

	deny := variadicValues(args, "--disallowedTools")
	for _, d := range backendDeny {
		if !slicesContains(deny, d) {
			t.Errorf("--disallowedTools missing backend entry %q; got %v", d, deny)
		}
	}
	for _, d := range SafeToolDenyFloor {
		if !slicesContains(deny, d) {
			t.Errorf("--disallowedTools missing floor entry %q (backend list must MERGE with the floor, not replace it); got %v", d, deny)
		}
	}
}

// TestBuildArgs_DenyListDeduplicated proves overlapping backend + floor
// entries appear once — duplicated argv entries are noise in every log line.
func TestBuildArgs_DenyListDeduplicated(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{
		DisallowedTools: []string{SafeToolDenyFloor[0]},
	})

	deny := variadicValues(args, "--disallowedTools")
	count := 0
	for _, d := range deny {
		if d == SafeToolDenyFloor[0] {
			count++
		}
	}
	if count != 1 {
		t.Errorf("floor entry %q appears %d times, want 1", SafeToolDenyFloor[0], count)
	}
}

// Defense in depth: even if DisallowedTools is empty, buildArgs must NEVER emit
// bypassPermissions with no deny-list — it backstops with SafeToolDenyFloor.
func TestBuildArgs_SkipPermissions_EmptyDenyBackstopsToFloor(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{
		DangerouslySkipPermissions: true,
		DisallowedTools:            nil,
	})

	if mode := argValue(args, "--permission-mode"); mode != "bypassPermissions" {
		t.Errorf("--permission-mode = %q, want bypassPermissions", mode)
	}
	deny := variadicValues(args, "--disallowedTools")
	if len(deny) == 0 {
		t.Fatal("bypassPermissions must never launch with an empty deny-list")
	}
	for _, d := range SafeToolDenyFloor {
		if !slicesContains(deny, d) {
			t.Errorf("floor backstop missing %q; got %v", d, deny)
		}
	}
}

// Without the autonomous flag, no bypassPermissions is injected — the
// caller's explicit PermissionMode still wins — but the deny floor rides
// regardless (card 1e315263 overturned the old "deny only on the autonomous
// path" rule: it left loop sessions with no shell guardrails at all).
func TestBuildArgs_NoSkipPermissions_KeepsCallerModeWithFloor(t *testing.T) {
	cli := NewClaudeCLI()
	args := cli.buildArgs("test prompt", Options{
		PermissionMode:  "auto",
		DisallowedTools: SafeToolDenyFloor,
	})

	if v := argValue(args, "--settings"); v != "" {
		t.Errorf("--settings must not appear, got %q", v)
	}
	if mode := argValue(args, "--permission-mode"); mode != "auto" {
		t.Errorf("--permission-mode = %q, want caller's auto", mode)
	}
	deny := variadicValues(args, "--disallowedTools")
	for _, d := range SafeToolDenyFloor {
		if !slicesContains(deny, d) {
			t.Errorf("--disallowedTools missing %q; got %v", d, deny)
		}
	}
}

func slicesContains(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

func TestExecuteWithMissingBinary(t *testing.T) {
	cli := &ClaudeCLI{ClaudeBin: "nonexistent-binary-that-does-not-exist"}
	_, err := cli.Execute(context.Background(), "hello", Options{})
	if err == nil {
		t.Fatal("expected error for missing binary")
	}
}

func TestExecuteWithEcho(t *testing.T) {
	// Use 'echo' as a stand-in to verify process execution works.
	// This tests the full Execute path without requiring claude.
	echoPath, err := exec.LookPath("echo")
	if err != nil {
		t.Skip("echo not found on PATH")
	}

	cli := &ClaudeCLI{ClaudeBin: echoPath}
	result, err := cli.Execute(context.Background(), "hello world", Options{})
	if err != nil {
		t.Fatal(err)
	}

	// echo receives all args — the prompt is the last arg after the flags.
	// It will print them all separated by spaces.
	if result.Output == "" {
		t.Error("expected non-empty output from echo")
	}
	if result.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", result.ExitCode)
	}
	if result.Duration <= 0 {
		t.Error("duration should be > 0")
	}
}

func TestClaudeCLI_ImplementsSessionProvider(t *testing.T) {
	var p Provider = NewClaudeCLI()
	sp, ok := p.(SessionProvider)
	if !ok {
		t.Fatal("ClaudeCLI should implement SessionProvider")
	}
	if !sp.SupportsResume() {
		t.Error("ClaudeCLI.SupportsResume() should return true")
	}
}

func TestClaudeCLI_ImplementsCostProvider(t *testing.T) {
	var p Provider = NewClaudeCLI()
	cp, ok := p.(CostProvider)
	if !ok {
		t.Fatal("ClaudeCLI should implement CostProvider")
	}
	if !cp.SupportsCostTracking() {
		t.Error("ClaudeCLI.SupportsCostTracking() should return true")
	}
}

func TestClaudeCLI_ImplementsToolProvider(t *testing.T) {
	var p Provider = NewClaudeCLI()
	tp, ok := p.(ToolProvider)
	if !ok {
		t.Fatal("ClaudeCLI should implement ToolProvider")
	}
	if !tp.SupportsToolConfig() {
		t.Error("ClaudeCLI.SupportsToolConfig() should return true")
	}
}

func TestClaudeCLI_ResumeSessionDelegatesToExecute(t *testing.T) {
	// ResumeSession should set ResumeSessionID on opts and call Execute.
	// Using a missing binary to verify the call path reaches Execute.
	cli := &ClaudeCLI{ClaudeBin: "nonexistent-binary-that-does-not-exist"}
	sp, ok := any(cli).(SessionProvider)
	if !ok {
		t.Fatal("ClaudeCLI should implement SessionProvider")
	}
	_, err := sp.ResumeSession(context.Background(), "sess-42", "continue", Options{})
	if err == nil {
		t.Fatal("expected error for missing binary (proves Execute was called)")
	}
}

func TestOptionsExtraMapDefaultsNil(t *testing.T) {
	opts := Options{}
	if opts.Extra != nil {
		t.Error("Extra should default to nil")
	}
}

func TestOptionsExtraMapStoresValues(t *testing.T) {
	opts := Options{
		Extra: map[string]any{
			"custom_key": "custom_value",
			"numeric":    42,
		},
	}
	if v, ok := opts.Extra["custom_key"]; !ok || v != "custom_value" {
		t.Errorf("Extra[custom_key] = %v, want 'custom_value'", v)
	}
	if v, ok := opts.Extra["numeric"]; !ok || v != 42 {
		t.Errorf("Extra[numeric] = %v, want 42", v)
	}
}

// TestExecute_NonZeroExitDiscardsStructuredOutput covers the claude-CLI
// crash-mid-stream case: a subprocess that starts emitting a structured_output
// event then exits non-zero cannot be trusted — the payload may be
// half-written or reflect an aborted thought. Reviewer and other callers
// rely on StructuredOutput being null to fall back to free-text parsing,
// which is safer than trusting partial JSON.
func TestExecute_NonZeroExitDiscardsStructuredOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}

	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-claude.sh")
	script := `#!/bin/sh
cat <<'EOF'
{"type":"result","subtype":"success","result":"partial text","structured_output":{"decision":"approve","summary":"lgtm"},"session_id":"s1","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}
EOF
exit 42
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}

	cli := &ClaudeCLI{ClaudeBin: fake}
	result, err := cli.Execute(context.Background(), "prompt", Options{})
	if err == nil {
		t.Fatal("expected error for non-zero exit")
	}
	if result.ExitCode != 42 {
		t.Errorf("ExitCode = %d, want 42", result.ExitCode)
	}
	if len(result.StructuredOutput) != 0 {
		t.Errorf("StructuredOutput must be empty on non-zero exit, got %q", string(result.StructuredOutput))
	}
}

func TestTailBuffer_UnderCapKeepsAll(t *testing.T) {
	tb := &tailBuffer{cap: stderrTailCap}
	payload := bytes.Repeat([]byte("a"), 1024)
	n, err := tb.Write(payload)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != len(payload) {
		t.Errorf("Write n = %d, want %d", n, len(payload))
	}
	got := tb.String()
	if got != string(payload) {
		t.Errorf("String() did not match payload; len=%d want=%d", len(got), len(payload))
	}
	if strings.Contains(got, "truncated") {
		t.Error("truncation marker must not appear when under cap")
	}
}

func TestTailBuffer_OverCapKeepsLastN(t *testing.T) {
	tb := &tailBuffer{cap: stderrTailCap}
	total := 100 << 10 // 100 KiB
	payload := make([]byte, total)
	for i := range payload {
		payload[i] = byte(i % 256)
	}
	// Write in smaller chunks to exercise the sliding-window path.
	chunk := 4096
	for off := 0; off < total; off += chunk {
		end := off + chunk
		if end > total {
			end = total
		}
		if _, err := tb.Write(payload[off:end]); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}

	got := tb.String()
	if !strings.HasPrefix(got, "[stderr truncated to 65536 bytes]\n") {
		t.Errorf("missing truncation marker prefix; got start=%q", got[:min(len(got), 60)])
	}
	body := strings.TrimPrefix(got, "[stderr truncated to 65536 bytes]\n")
	if len(body) != stderrTailCap {
		t.Errorf("body len = %d, want %d", len(body), stderrTailCap)
	}
	// Last 64 KiB of the payload should match the body exactly.
	tail := payload[total-stderrTailCap:]
	if body != string(tail) {
		t.Error("body does not match expected last-N bytes of payload")
	}
}

func TestTailBuffer_ExactlyCapNoTruncation(t *testing.T) {
	tb := &tailBuffer{cap: stderrTailCap}
	payload := bytes.Repeat([]byte("x"), stderrTailCap)
	if _, err := tb.Write(payload); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got := tb.String()
	if strings.Contains(got, "truncated") {
		t.Error("no truncation marker expected at exactly cap")
	}
	if len(got) != stderrTailCap {
		t.Errorf("len = %d, want %d", len(got), stderrTailCap)
	}
}

func TestTailBuffer_SingleOverSizedWrite(t *testing.T) {
	tb := &tailBuffer{cap: stderrTailCap}
	total := stderrTailCap * 2
	payload := make([]byte, total)
	for i := range payload {
		payload[i] = byte(i % 256)
	}
	n, err := tb.Write(payload)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != total {
		t.Errorf("Write n = %d, want %d", n, total)
	}
	got := tb.String()
	if !strings.HasPrefix(got, "[stderr truncated to 65536 bytes]\n") {
		t.Error("expected truncation marker for oversized single write")
	}
	body := strings.TrimPrefix(got, "[stderr truncated to 65536 bytes]\n")
	if len(body) != stderrTailCap {
		t.Errorf("body len = %d, want %d", len(body), stderrTailCap)
	}
	if body != string(payload[total-stderrTailCap:]) {
		t.Error("body must be the tail of the oversized chunk")
	}
}

func TestExecute_StderrCappedOnVerboseFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}

	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-claude.sh")
	// Emit ~200 KiB of stderr (well past the 64 KiB cap), then exit 1.
	// `yes` prints an endless stream of the given string; `head -c` caps it.
	script := `#!/bin/sh
yes "stacktrace-line-padding-to-inflate-stderr-size" | head -c 204800 >&2
exit 1
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}

	cli := &ClaudeCLI{ClaudeBin: fake}
	result, err := cli.Execute(context.Background(), "prompt", Options{})
	if err == nil {
		t.Fatal("expected error for non-zero exit")
	}
	if result.ExitCode != 1 {
		t.Errorf("ExitCode = %d, want 1", result.ExitCode)
	}
	msg := result.Error.Error()
	if !strings.Contains(msg, "[stderr truncated to 65536 bytes]") {
		t.Errorf("expected truncation marker in error, got: %q", msg)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func assertContains(t *testing.T, args []string, want string) {
	t.Helper()
	for _, a := range args {
		if a == want {
			return
		}
	}
	t.Errorf("args %v does not contain %q", args, want)
}

func assertNotContains(t *testing.T, args []string, notWant string) {
	t.Helper()
	for i, a := range args {
		if a == notWant {
			t.Errorf("args %v must not contain %q (found at %d)", args, notWant, i)
			return
		}
	}
}
