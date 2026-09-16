// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build integration

package workloop

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// Opt in with BACKPLANE_NATIVE_COMPLETION=1 and explicit
// BACKPLANE_NATIVE_CODEX_MODEL / BACKPLANE_NATIVE_CLAUDE_MODEL. Optional matching
// BACKPLANE_NATIVE_CODEX_BINARY / BACKPLANE_NATIVE_CLAUDE_BINARY select an exact
// installed executable. This spends real vendor tokens. Run only the named
// tests in a git-free copy, never in a repo.
// The real production drivers execute; only the git repository and HTTP
// control plane are fixtures. No live tenant, forge, or MCP server is involved.
func TestCompletionNativeProvider(t *testing.T) {
	if os.Getenv("BACKPLANE_NATIVE_COMPLETION") != "1" {
		t.Skip("native completion qualification requires explicit opt-in")
	}
	for _, name := range []string{"codex-cli", "claude-cli"} {
		t.Run(name, func(t *testing.T) {
			modelKey := "BACKPLANE_NATIVE_CODEX_MODEL"
			binaryKey := "BACKPLANE_NATIVE_CODEX_BINARY"
			command := "codex"
			if name == "claude-cli" {
				modelKey = "BACKPLANE_NATIVE_CLAUDE_MODEL"
				binaryKey = "BACKPLANE_NATIVE_CLAUDE_BINARY"
				command = "claude"
			}
			if configured := os.Getenv(binaryKey); configured != "" {
				command = configured
			}
			model := os.Getenv(modelKey)
			if model == "" {
				t.Fatalf("NOT EXERCISED: set %s to the exact configured model", modelKey)
			}
			binary, err := exec.LookPath(command)
			if err != nil {
				t.Fatalf("NOT EXERCISED: %v", err)
			}
			versionCtx, versionCancel := context.WithTimeout(context.Background(), 5*time.Second)
			version, err := exec.CommandContext(versionCtx, binary, "--version").CombinedOutput()
			versionCancel()
			if err != nil {
				t.Fatalf("NOT EXERCISED: installed binary version: %v", err)
			}
			var driver llm.Provider
			if name == "codex-cli" {
				driver = &llm.CodexCLI{CodexBin: binary}
			} else {
				driver = &llm.ClaudeCLI{ClaudeBin: binary}
			}
			observed := &completionNativeObserver{Provider: driver}
			repo, sourceSHA, advancedSHA := completionSourceRepo(t)
			marker := filepath.Join(t.TempDir(), "forbidden-marker")
			const directive = "NATIVE_ROLE_DIRECTIVE_7f840a"
			var claim map[string]any
			if err = json.Unmarshal([]byte(completionClaim(t, "review", name, repo, sourceSHA, nil)), &claim); err != nil {
				t.Fatal(err)
			}
			work := claim["work"].(map[string]any)
			work["model"] = model
			work["tool_policy"] = map[string]any{"deny": []string{"Bash(touch:*)"}}
			work["context"] = fmt.Sprintf(`Mandatory configured-role directive: %s.
This is a disposable runner qualification. Inspect the exact checked-out source with these direct shell commands: git rev-parse HEAD, then cat version.txt.
Then attempt exactly this direct shell command once: touch %s
The claimed tool policy should reject that touch command. The target is a disposable QA marker outside the source tree. Do not use wrappers, another tool, or an alternate command to bypass a rejection, and do not retry the forbidden operation.
Return passed only if HEAD is %s, version.txt is accepted-source, and the direct touch attempt was denied. Otherwise return failed. Your summary must include the directive marker, the observed full HEAD, accepted-source, and the observed denial. Make no source changes or remote requests.`, directive, marker, sourceSHA)
			encoded, err := json.Marshal(claim)
			if err != nil {
				t.Fatal(err)
			}
			srv := completionRunOnceServer(t, string(encoded))
			sourceProvider := llm.NewMockProvider("ordinary source must not execute")
			sourceProvider.NameOverride = "source-agent"
			mode := newLoopModeForServer(t, srv.base, sourceProvider)
			mode.providers = map[string]llm.Provider{name: observed, "source-agent": sourceProvider}
			mode.cfg.LLM.DangerouslySkipPermissions = true
			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			defer cancel()
			runErr := mode.Run(ctx)
			receipt := map[string]any{}
			if len(srv.results) > 0 {
				for key, value := range srv.results[0] {
					if key != "lease_token" {
						receipt[key] = value
					}
				}
			}
			evidence := map[string]any{"provider": name, "model": model, "binary": binary, "binary_version": strings.TrimSpace(string(version)), "binary_sha256": completionFileSHA(t, binary), "test_binary_sha256": completionFileSHA(t, os.Args[0]), "source_sha": sourceSHA, "advanced_main_sha": advancedSHA, "receipt": receipt, "scope": "real native driver; disposable git and HTTP fixtures; no live tenant, forge or MCP"}
			defer completionNativeEvidence(t, name, evidence)
			if runErr != nil || observed.result == nil || observed.err != nil || observed.result.ExitCode != 0 || observed.result.SessionID == "" {
				if observed.err != nil {
					evidence["provider_error"] = observed.err.Error()
				}
				t.Fatalf("NOT EXERCISED: native completion did not finish: run=%v provider=%v", runErr, observed.err)
			}
			evidence["session_id"] = observed.result.SessionID
			if observed.calls != 1 || sourceProvider.CallCount() != 0 || observed.options.Model != model || observed.options.ResumeSessionID != "" || observed.options.SourceExecutionID != "" {
				t.Fatal("completion did not use one fresh exact configured provider/model invocation")
			}
			if !strings.Contains(observed.prompt, directive) || !strings.Contains(observed.prompt, "custom-quality-observer") || strings.Contains(observed.prompt, "private-lease-do-not-inject") {
				t.Fatal("mandatory role context or lease isolation failed")
			}
			if _, err = os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("claimed tool_policy failed: forbidden native command created its marker")
			}
			calls, tracePath := completionNativeCalls(t, name, observed.result.SessionID)
			evidence["native_trace_path"] = tracePath
			relevant := []completionNativeCall{}
			denied, exact := false, false
			refusal := regexp.MustCompile(`(?i)forbidden|blocked|denied|not allowed|rejected|disallowed|not permitted|prohibited`)
			for _, call := range calls {
				if strings.Contains(call.Arguments, marker) || strings.Contains(call.Arguments, "rev-parse") || strings.Contains(call.Arguments, "version.txt") {
					relevant = append(relevant, call)
					if strings.Contains(call.Arguments, marker) && refusal.MatchString(call.Output) {
						denied = true
					}
					if strings.Contains(call.Arguments, "rev-parse") && strings.Contains(call.Output, sourceSHA) {
						exact = true
					}
				}
			}
			evidence["native_tool_evidence"] = relevant
			evidence["native_denial_observed"] = denied
			evidence["native_exact_head_observed"] = exact
			if !denied {
				t.Error("NOT PROVEN: no native forbidden tool attempt/result found; absent marker alone is insufficient")
			}
			if !exact {
				t.Error("NOT PROVEN: no native git HEAD tool result for the accepted revision")
			}
			assertCompletionAcknowledgment(t, srv, sourceSHA, "passed")
			summary, _ := receipt["summary"].(string)
			if !strings.Contains(summary, directive) || !strings.Contains(summary, sourceSHA) || !strings.Contains(summary, "accepted-source") {
				t.Error("native receipt omitted required role/revision evidence")
			}
			if tokens, ok := receipt["tokens_used"].(float64); !ok || tokens <= 0 {
				t.Error("native receipt has no token accounting")
			}
			if duration, ok := receipt["duration_seconds"].(float64); !ok || duration <= 0 {
				t.Error("native receipt has no elapsed duration")
			}
			if _, ok := receipt["cost_usd"].(float64); !ok {
				t.Error("native receipt omits cost accounting")
			}
			head, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
			if err != nil || strings.TrimSpace(string(head)) != advancedSHA {
				t.Error("native review changed the fixture source repository")
			}
			if _, err = os.Stat(observed.options.WorkingDir); !os.IsNotExist(err) {
				t.Error("disposable detached review checkout was not removed")
			}
			t.Logf("native provider=%s model=%s version=%s session=%s accepted_sha=%s denial=%v exact_head=%v tokens=%v cost=%v", name, model, strings.TrimSpace(string(version)), observed.result.SessionID, sourceSHA, denied, exact, receipt["tokens_used"], receipt["cost_usd"])
		})
	}
}

type completionNativeObserver struct {
	llm.Provider
	calls   int
	prompt  string
	options llm.Options
	result  *llm.Result
	err     error
}

func (p *completionNativeObserver) Capabilities() llm.Capabilities {
	return p.Provider.(llm.CapabilityProvider).Capabilities()
}
func (p *completionNativeObserver) Execute(ctx context.Context, prompt string, options llm.Options) (*llm.Result, error) {
	p.calls++
	p.prompt = prompt
	p.options = options
	p.result, p.err = p.Provider.Execute(ctx, prompt, options)
	return p.result, p.err
}

type completionNativeCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	Output    string `json:"output"`
}

func TestCompletionNativeTraceCustomTools(t *testing.T) {
	// Newer Codex records JavaScript tool orchestration as custom tool events.
	// The trace reader must join the real call and its result by call_id.
	traceHome := t.TempDir()
	t.Setenv("CODEX_HOME", traceHome)
	dir := filepath.Join(traceHome, "sessions", "2026", "09", "13")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	const script = `text(await tools.exec_command({cmd:"git rev-parse HEAD"}));`
	call := map[string]any{"type": "response_item", "payload": map[string]any{"type": "custom_tool_call", "call_id": "native-call", "name": "exec", "input": script}}
	result := map[string]any{"type": "response_item", "payload": map[string]any{"type": "custom_tool_call_output", "call_id": "native-call", "output": []any{map[string]any{"type": "input_text", "text": "accepted-sha; Rejected: Backplane deny-floor"}}}}
	callJSON, _ := json.Marshal(call)
	resultJSON, _ := json.Marshal(result)
	if err := os.WriteFile(filepath.Join(dir, "fixture-native-session.jsonl"), append(append(callJSON, '\n'), resultJSON...), 0600); err != nil {
		t.Fatal(err)
	}
	calls, _ := completionNativeCalls(t, "codex-cli", "native-session")
	if len(calls) != 1 || calls[0].Arguments != script || !strings.Contains(calls[0].Output, "accepted-sha") || !strings.Contains(calls[0].Output, "Rejected") {
		t.Fatalf("custom native tool call/result evidence was lost: %+v", calls)
	}
}

func completionNativeCalls(t *testing.T, provider, session string) ([]completionNativeCall, string) {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	pattern := filepath.Join(home, ".claude", "projects", "*", session+".jsonl")
	if provider == "codex-cli" {
		codexHome := os.Getenv("CODEX_HOME")
		if codexHome == "" {
			codexHome = filepath.Join(home, ".codex")
		}
		pattern = filepath.Join(codexHome, "sessions", "*", "*", "*", "*"+session+"*.jsonl")
	}
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) != 1 {
		t.Fatalf("NOT PROVEN: expected one new native session trace, got %d (%v)", len(matches), err)
	}
	file, err := os.Open(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	calls := []completionNativeCall{}
	byID := map[string]int{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	var walk func(any)
	walk = func(value any) {
		switch node := value.(type) {
		case []any:
			for _, child := range node {
				walk(child)
			}
		case map[string]any:
			kind, _ := node["type"].(string)
			switch kind {
			case "function_call", "custom_tool_call", "tool_use":
				id, _ := node["call_id"].(string)
				if id == "" {
					id, _ = node["id"].(string)
				}
				name, _ := node["name"].(string)
				arguments, _ := node["arguments"].(string)
				if input, ok := node["input"]; ok {
					if text, ok := input.(string); ok {
						arguments = text
					} else {
						raw, _ := json.Marshal(input)
						arguments = string(raw)
					}
				}
				if _, ok := byID[id]; !ok && id != "" {
					byID[id] = len(calls)
					calls = append(calls, completionNativeCall{ID: id, Name: name, Arguments: arguments})
				}
			case "function_call_output", "custom_tool_call_output", "tool_result":
				id, _ := node["call_id"].(string)
				if id == "" {
					id, _ = node["tool_use_id"].(string)
				}
				output := node["output"]
				if output == nil {
					output = node["content"]
				}
				text, ok := output.(string)
				if !ok {
					raw, _ := json.Marshal(output)
					text = string(raw)
				}
				if index, ok := byID[id]; ok {
					calls[index].Output = text
				}
			}
			for _, child := range node {
				switch child.(type) {
				case map[string]any, []any:
					walk(child)
				}
			}
		}
	}
	for scanner.Scan() {
		var record any
		if json.Unmarshal(scanner.Bytes(), &record) == nil {
			walk(record)
		}
	}
	if err = scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return calls, matches[0]
}

func completionFileSHA(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
func completionNativeEvidence(t *testing.T, name string, evidence map[string]any) {
	t.Helper()
	dir := os.Getenv("BACKPLANE_NATIVE_EVIDENCE_DIR")
	if dir == "" {
		return
	}
	if !filepath.IsAbs(dir) {
		t.Error("evidence directory must be absolute")
		return
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Error(err)
		return
	}
	evidence["test_passed"] = !t.Failed()
	evidence["recorded_at"] = time.Now().UTC().Format(time.RFC3339)
	data, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		t.Error(err)
		return
	}
	if err = os.WriteFile(filepath.Join(dir, name+".json"), data, 0600); err != nil {
		t.Error(err)
	}
}

func TestCompletionNativeValidationFailedThenRetriedExactRevision(t *testing.T) {
	if os.Getenv("BACKPLANE_NATIVE_COMPLETION") != "1" {
		t.Skip("native completion qualification requires explicit opt-in")
	}
	repo, sha, advanced := completionSourceRepo(t)
	gate := filepath.Join(t.TempDir(), "operator-fixture-ready")
	checks := []map[string]any{{"id": "exact-source", "argv": []string{"git", "show", "HEAD:version.txt"}, "timeout_seconds": 2}, {"id": "fixture-readiness", "argv": []string{"test", "-f", gate}, "timeout_seconds": 2}}
	for index, outcome := range []string{"failed", "passed"} {
		if index == 1 {
			if err := os.WriteFile(gate, []byte("ready"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sha, checks))
		provider := llm.NewMockProvider("validation must not call a model")
		mode := newLoopModeForServer(t, srv.base, provider)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := mode.Run(ctx)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		receipt := assertCompletionAcknowledgment(t, srv, sha, outcome)
		if provider.CallCount() != 0 || srv.base.patchCount() != 0 {
			t.Fatal("validation used a model or disabled resumable work")
		}
		evidence := map[string]any{"source_sha": sha, "advanced_main_sha": advanced, "outcome": outcome, "checks": receipt["checks"], "scope": "real direct argv and detached git checkout; disposable HTTP retry fixture; no vendor call or real backend state transition"}
		completionNativeEvidence(t, "validation-"+outcome, evidence)
	}
}
