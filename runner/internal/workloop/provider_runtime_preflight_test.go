// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// The real incident used a symlink to an app-bundled CLI. Its version command
// worked, but inspection depended on a companion beside the launch path.
func runtimeFixture(t *testing.T, bundled, companionAtLaunch, hangs bool) (launch, canonical, calls string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable fixture")
	}
	root := t.TempDir()
	calls = filepath.Join(root, "calls")
	t.Setenv("RUNTIME_FIXTURE_CALLS", calls)
	launch = filepath.Join(root, "bin", "codex")
	canonical = launch
	if bundled {
		canonical = filepath.Join(root, "Fixture.app", "Contents", "Resources", "codex")
	}
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	body := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RUNTIME_FIXTURE_CALLS\"\ncase \"$*\" in\n--version) printf 'codex-cli 0.144.1\\n';;\n*) printf 'PAID_OR_UNEXPECTED_INVOCATION\\n' >> \"$RUNTIME_FIXTURE_CALLS\"; exit 93;;\nesac\n"
	if hangs {
		body = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RUNTIME_FIXTURE_CALLS\"\nwhile :; do :; done\n"
	}
	write(canonical, body)
	if bundled {
		if err := os.MkdirAll(filepath.Dir(launch), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(canonical, launch); err != nil {
			t.Fatal(err)
		}
		companion := filepath.Join(filepath.Dir(canonical), "codex-code-mode-host")
		write(companion, "#!/bin/sh\nprintf 'companion:%s\\n' \"$*\" >> \"$RUNTIME_FIXTURE_CALLS\"\n[ \"$*\" = '--help' ] || exit 94\nprintf 'fixture inspection host\\n'\n")
		if companionAtLaunch {
			if err := os.Symlink(companion, filepath.Join(filepath.Dir(launch), "codex-code-mode-host")); err != nil {
				t.Fatal(err)
			}
		}
	}
	return
}

func TestRuntimeHealthCompletionPreflight(t *testing.T) {
	for _, tc := range []struct {
		name                                                                        string
		bundled, companion, hangs, sourceOnly, noPolicy, sameSource, wrongCompanion bool
		wantError                                                                   string
	}{
		{name: "standalone_does_not_require_bundled_companion"},
		{name: "healthy_bundle_reports_selected_installation", bundled: true, companion: true},
		{name: "missing_bundled_companion_blocks_custom_reviewer", bundled: true, wantError: "codex-code-mode-host"},
		{name: "runtime_probe_timeout_blocks_before_paid_work", hangs: true, wantError: "runtime"},
		{name: "source_runtime_checked_without_review_roles", bundled: true, sourceOnly: true, wantError: "codex-code-mode-host"},
		{name: "source_runtime_checked_without_completion_policy", bundled: true, sourceOnly: true, noPolicy: true, wantError: "codex-code-mode-host"},
		{name: "source_and_reviewer_share_one_diagnostic", sameSource: true},
		{name: "unrelated_companion_is_not_a_verified_bundle", bundled: true, companion: true, wrongCompanion: true, wantError: "codex-code-mode-host"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			launch, canonical, calls := runtimeFixture(t, tc.bundled, tc.companion, tc.hangs)
			if tc.wrongCompanion {
				path := filepath.Join(filepath.Dir(launch), "codex-code-mode-host")
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			body := `{"policy_hash":"policy-hash-1","requirements":[{"kind":"review","role":"operator-quality-observer","provider":"codex-cli","model":"operator-model","checks":[]}]}`
			if tc.sourceOnly {
				body = `{"policy_hash":"policy-hash-1","requirements":[]}`
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/completion/requirements") {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Mandatory context."))
			source := llm.NewMockProvider("source must never execute in preflight")
			source.NameOverride = "operator-source"
			var fallback llm.Provider = source
			cfg.Provider = "operator-source"
			cfg.Model = "operator-source-model"
			codex := llm.NewCodexCLI()
			providers := map[string]llm.Provider{"codex-cli": codex, source.Name(): source}
			if tc.sourceOnly || tc.sameSource {
				cfg.Provider = "codex-cli"
				fallback = codex
			}
			if tc.noPolicy {
				cfg.CompletionPolicy = nil
			}
			deadline := 5 * time.Second
			if tc.hangs {
				deadline = 250 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), deadline)
			defer cancel()
			started := time.Now()
			report, err := PreflightCompletionWorkflow(ctx, valaris.NewClient(server.URL, "vlr_fixture"), "acme", "board-1", &cfg, providers, fallback, func(name string) (string, error) {
				if name == "codex" {
					return launch, nil
				}
				if name == "git" {
					return "/fixture/git", nil
				}
				return "", fmt.Errorf("unexpected executable lookup %q", name)
			})
			if tc.hangs && time.Since(started) > 2*time.Second {
				t.Fatal("runtime preflight exceeded bounded deadline")
			}
			if source.CallCount() != 0 {
				t.Fatal("preflight invoked source model")
			}
			data, _ := os.ReadFile(calls)
			if strings.Contains(string(data), "PAID_OR_UNEXPECTED_INVOCATION") {
				t.Fatalf("unsafe provider invocation: %s", data)
			}
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("want actionable runtime failure containing %q, got %v", tc.wantError, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			shown := strings.Join(append(report.Assignments, report.Unverified...), " ")
			for _, want := range []string{launch, canonical, "0.144.1"} {
				if !strings.Contains(shown, want) {
					t.Errorf("runtime report omits %q: %s", want, shown)
				}
			}
			if !strings.Contains(string(data), "--version") {
				t.Fatal("executable discovery was reported as runtime health without a probe")
			}
			if tc.sameSource && strings.Count(string(data), "--version") != 1 {
				t.Fatal("same provider was probed repeatedly for source and review")
			}
			if tc.bundled && !strings.Contains(string(data), "companion:--help") {
				t.Fatal("bundled inspection host was not checked")
			}
		})
	}
}
