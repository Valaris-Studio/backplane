// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestCompletionWorkflowPreflight(t *testing.T) {
	for _, tc := range []struct {
		name, body, missing, want string
		providers                 map[string]llm.Provider
		status                    int
	}{
		{name: "configured_reviewer", body: `{"policy_hash":"policy-hash-1","requirements":[{"kind":"review","role":"custom-auditor","provider":"codex-cli","model":"operator-model","checks":[]}]}`, providers: map[string]llm.Provider{"codex-cli": llm.NewCodexCLI()}},
		{name: "missing_registry", body: `{"policy_hash":"policy-hash-1","requirements":[{"kind":"review","role":"custom-auditor","provider":"codex-cli","model":"operator-model","checks":[]}]}`, want: "custom-auditor"},
		{name: "missing_reviewer_binary", body: `{"policy_hash":"policy-hash-1","requirements":[{"kind":"review","role":"custom-auditor","provider":"codex-cli","model":"operator-model","checks":[]}]}`, providers: map[string]llm.Provider{"codex-cli": llm.NewCodexCLI()}, missing: "codex", want: "codex"},
		{name: "missing_checkout", body: `{"policy_hash":"policy-hash-1","requirements":[]}`, missing: "git", want: "git"},
		{name: "direct_validation_no_model", body: `{"policy_hash":"policy-hash-1","requirements":[{"kind":"validation","role":"custom-checks","provider":"","model":"","checks":[{"id":"guard","argv":["sh","-c","exit 0"],"timeout_seconds":5}]}]}`},
		{name: "missing_direct_executable", body: `{"policy_hash":"policy-hash-1","requirements":[{"kind":"validation","role":"custom-checks","checks":[{"id":"guard","argv":["missing-validator"],"timeout_seconds":5}]}]}`, missing: "missing-validator", want: "guard"},
		{name: "stale", body: `{"policy_hash":"different","requirements":[]}`, want: "changed"},
		{name: "missing_endpoint", status: 404, body: `{"detail":"secret-control-plane-body"}`, want: "404"},
		{name: "missing_catalog", body: `{"policy_hash":"policy-hash-1"}`, want: "requirements"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			codexPath, _, _ := runtimeFixture(t, false, false, false)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.URL.Path != "/api/workspaces/acme/boards/board-1/completion/requirements" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				if tc.status != 0 {
					w.WriteHeader(tc.status)
				}
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Mandatory policy."))
			_, err := PreflightCompletionWorkflow(context.Background(), valaris.NewClient(server.URL, "vlr_fixture"), "acme", "board-1", &cfg, tc.providers, nil, func(name string) (string, error) {
				if name == tc.missing {
					return "", fmt.Errorf("missing")
				}
				if name == "codex" {
					return codexPath, nil
				}
				return "/bin/" + name, nil
			})
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q got %v", tc.want, err)
			}
			if err != nil && strings.Contains(err.Error(), "secret-control-plane-body") {
				t.Fatal("unsafe backend body leaked")
			}
		})
	}
}

func TestCompletionWorkflowPreflightCheckoutRelativeCheckIsUnverified(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"policy_hash":"policy-hash-1","requirements":[{"kind":"validation","role":"project-verifier","checks":[{"id":"repository-script","argv":["./scripts/verify","--token=secret-argument"],"timeout_seconds":20}]}]}`))
	}))
	defer server.Close()
	cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Mandatory policy."))
	report, err := PreflightCompletionWorkflow(context.Background(), valaris.NewClient(server.URL, "vlr_fixture"), "acme", "board-1", &cfg, nil, nil, func(name string) (string, error) {
		if name != "git" {
			t.Fatalf("repository script looked up before checkout: %q", name)
		}
		return "/bin/git", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(report.Unverified, " "), "repository-script") {
		t.Fatalf("missing unverified check: %+v", report)
	}
	if strings.Contains(fmt.Sprint(report), "secret-argument") {
		t.Fatal("argv leaked in report")
	}
}

func TestCompletionWorkflowPreflightRejectsIncompletePolicyRequirements(t *testing.T) {
	for _, body := range []string{`{"policy_hash":"policy-hash-1","requirements":[]}`, `{"policy_hash":"policy-hash-1","requirements":[{"kind":"review","role":"different-role","provider":"codex-cli","model":"operator-model"}]}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
		cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Mandatory policy."))
		role := "custom-auditor"
		cfg.CompletionPolicy.SourceReview = "independent"
		cfg.CompletionPolicy.ReviewRole = &role
		_, err := PreflightCompletionWorkflow(context.Background(), valaris.NewClient(server.URL, "vlr_fixture"), "acme", "board-1", &cfg, map[string]llm.Provider{"codex-cli": llm.NewCodexCLI()}, nil, func(s string) (string, error) { return s, nil })
		server.Close()
		if err == nil || !strings.Contains(err.Error(), role) {
			t.Fatalf("missing role must fail closed: %v", err)
		}
	}
}

func TestCompletionWorkflowPreflightRefreshesBeforeSourceOrClaim(t *testing.T) {
	for _, actionable := range []bool{false, true} {
		t.Run(fmt.Sprint(actionable), func(t *testing.T) {
			cfg := baseLoopConfig()
			cfg.MaxIterations = 1
			srv := newCompletionWorkServer(t, completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory policy."))
			if actionable {
				srv.workBody = `{"pending_count":1,"actionable_count":1,"failed_count":0}`
			}
			reads := 0
			wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/completion/requirements") {
					reads++
					if reads == 1 {
						_, _ = w.Write([]byte(`{"policy_hash":"policy-hash-1","requirements":[]}`))
					} else {
						_, _ = w.Write([]byte(`{"policy_hash":"changed","requirements":[]}`))
					}
					return
				}
				srv.handle(w, r)
			}))
			defer wrapper.Close()
			provider := llm.NewMockProvider("must not execute")
			mode := newLoopModeForServer(t, srv.base, provider)
			mode.client = valaris.NewClient(wrapper.URL, "vlr_fixture")
			err := mode.Run(context.Background())
			if err == nil || !strings.Contains(err.Error(), "changed") || reads < 2 {
				t.Fatalf("stale contract not rejected at next boundary: reads=%d err=%v", reads, err)
			}
			if provider.CallCount() != 0 || len(srv.claims) != 0 || srv.base.executionStartCount() != 0 {
				t.Fatal("stale requirements reached source or claim")
			}
		})
	}
}

func TestCompletionWorkflowPreflightRejectsChangedClaimDispatchBeforePaidReview(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	srv := completionRunOnceServer(t, completionClaim(t, "review", "mock", repo, sha, nil))
	reads := 0
	wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/completion/requirements") {
			reads++
			if reads >= 3 {
				_, _ = w.Write([]byte(`{"policy_hash":"policy-hash-1","requirements":[{"kind":"review","role":"custom-quality-observer","provider":"mock","model":"changed-model","checks":[]}]}`))
				return
			}
		}
		srv.handle(w, r)
	}))
	defer wrapper.Close()
	provider := llm.NewMockProvider("must not execute obsolete model")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	mode := newLoopModeForServer(t, srv.base, provider)
	mode.client = valaris.NewClient(wrapper.URL, "vlr_fixture")
	if err := mode.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if provider.CallCount() != 0 {
		t.Fatal("model executed after its assigned contract changed")
	}
	if len(srv.results) != 1 || !strings.Contains(fmt.Sprint(srv.results[0]["summary"]), "changed") {
		t.Fatalf("stale claim not recorded: %+v", srv.results)
	}
}
