// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Records the real runner/client HTTP boundary while reusing the legacy loop
// fixture for execution, heartbeat, readiness and completion-query responses.
type completionWorkServer struct {
	base       *loopModeServer
	mu         sync.Mutex
	requests   []string
	workStatus int
	workBody   string
	workBodies []string
	workCalls  int
	claimBody  string
	claims     []map[string]any
	results    []map[string]any
}

func newCompletionWorkServer(t *testing.T, configs ...string) *completionWorkServer {
	t.Helper()
	s := &completionWorkServer{
		base:       &loopModeServer{getLoopBodies: configs},
		workStatus: http.StatusOK,
		workBody:   `{"pending_count":0,"actionable_count":0,"failed_count":0}`,
		claimBody:  `{"work":null}`,
	}
	s.base.srv = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.base.srv.Close)
	return s
}

func (s *completionWorkServer) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.requests = append(s.requests, r.Method+" "+r.URL.Path)
	s.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/completion/requirements"):
		s.base.mu.Lock()
		index := s.base.getLoopCalls - 1
		if index < 0 {
			index = 0
		}
		if index >= len(s.base.getLoopBodies) {
			index = len(s.base.getLoopBodies) - 1
		}
		var cfg valaris.BoardLoopConfig
		if index >= 0 {
			_ = json.Unmarshal([]byte(s.base.getLoopBodies[index]), &cfg)
		}
		s.base.mu.Unlock()
		requirements := []valaris.CompletionRequirement{}
		var claim struct {
			Work *valaris.CompletionWork `json:"work"`
		}
		_ = json.Unmarshal([]byte(s.claimBody), &claim)
		if claim.Work != nil {
			work := claim.Work
			requirement := valaris.CompletionRequirement{Kind: work.Kind, Role: work.Role, Provider: work.Provider, Model: work.Model, Checks: work.Checks}
			requirement.ToolPolicy.Deny = work.ToolPolicy.Deny
			requirements = append(requirements, requirement)
		}
		_ = json.NewEncoder(w).Encode(valaris.CompletionRequirements{PolicyHash: cfg.CompletionPolicyHash, Requirements: requirements})
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/completion/readiness"):
		s.base.mu.Lock()
		index := s.base.getLoopCalls - 1
		if index < 0 {
			index = 0
		}
		if index >= len(s.base.getLoopBodies) {
			index = len(s.base.getLoopBodies) - 1
		}
		var cfg valaris.BoardLoopConfig
		if index >= 0 {
			_ = json.Unmarshal([]byte(s.base.getLoopBodies[index]), &cfg)
		}
		s.base.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"policy_hash": cfg.CompletionPolicyHash, "ready": true, "checks": []map[string]any{{"operation": "repository_binding", "repo_id": "repo-1", "required": true, "status": "verified", "code": "verified", "credential_source": "workspace_connection", "connection_id": "connection-1"}, {"operation": "repository_read", "repo_id": "repo-1", "required": true, "status": "verified", "code": "verified", "credential_source": "workspace_connection", "connection_id": "connection-1"}, {"operation": "pull_requests_read", "repo_id": "repo-1", "required": true, "status": "verified", "code": "verified", "credential_source": "workspace_connection", "connection_id": "connection-1"}, {"operation": "forge_write", "repo_id": "repo-1", "required": false, "status": "unverified", "code": "write_unverified"}}})
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/completion/work"):
		s.mu.Lock()
		body := s.workBody
		if len(s.workBodies) > 0 {
			index := s.workCalls
			if index >= len(s.workBodies) {
				index = len(s.workBodies) - 1
			}
			body = s.workBodies[index]
		}
		s.workCalls++
		s.mu.Unlock()
		w.WriteHeader(s.workStatus)
		_, _ = w.Write([]byte(body))
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/completion/work/claim"):
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		s.claims = append(s.claims, body)
		s.mu.Unlock()
		_, _ = w.Write([]byte(s.claimBody))
	case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/completion/work/") && strings.HasSuffix(r.URL.Path, "/result"):
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		s.results = append(s.results, body)
		s.mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"accepted"}`))
	default:
		s.base.handle(w, r)
	}
}

func (s *completionWorkServer) requestIndex(suffix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, request := range s.requests {
		if strings.HasSuffix(request, suffix) {
			return i
		}
	}
	return -1
}

func TestPostmergeAcceptance_PendingWorkPrecedesCompletionQueryAndParking(t *testing.T) {
	for _, completionQuery := range []bool{false, true} {
		t.Run(map[bool]string{false: "readiness_would_park", true: "query_would_complete"}[completionQuery], func(t *testing.T) {
			cfg := baseLoopConfig()
			if completionQuery {
				cfg.CompletionQuery = &valaris.LoopCompletionQuery{Label: "run-1", ExcludeColumnType: "done"}
			}
			disabled := cfg
			disabled.Enabled = false
			srv := newCompletionWorkServer(t,
				completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Complete outstanding acceptance first."),
				completionPolicyConfigJSON(t, disabled, completionPolicyV1, "Paused by operator."))
			srv.workBody = `{"pending_count":1,"actionable_count":1,"failed_count":0}`
			srv.base.readinessBodies = []string{readinessJSON(false, 0, 0, 0, 0)}
			srv.base.searchBodies = []string{`[]`}
			provider := llm.NewMockProvider("ordinary iteration must not run")
			m := newLoopModeForServer(t, srv.base, provider)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := m.Run(ctx); err != nil && ctx.Err() == nil {
				t.Fatalf("Run: %v", err)
			}
			workIndex := srv.requestIndex("/completion/work")
			claimIndex := srv.requestIndex("/completion/work/claim")
			if workIndex < 0 || claimIndex < 0 {
				t.Fatalf("pending acceptance was never fetched/claimed before parking/completion: work=%d claim=%d", workIndex, claimIndex)
			}
			if readinessIndex := srv.requestIndex("/loop/readiness"); readinessIndex >= 0 && readinessIndex < claimIndex {
				t.Error("readiness ran before pending completion work was claimed")
			}
			if provider.CallCount() != 0 {
				t.Error("an ordinary iteration ran while completion work remained pending")
			}
			if srv.base.patchCount() != 0 {
				t.Errorf("loop was disabled with outstanding acceptance: %+v", srv.base.statePatches())
			}
		})
	}
}

func TestPostmergeAcceptance_ExplicitPolicyProbeFailureCannotFallBack(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusNotFound, http.StatusInternalServerError} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			cfg := baseLoopConfig()
			cfg.MaxIterations = 1
			srv := newCompletionWorkServer(t, completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory acceptance."))
			srv.workStatus = status
			srv.workBody = `{"detail":"completion capability unavailable"}`
			provider := llm.NewMockProvider("must not execute")
			m := newLoopModeForServer(t, srv.base, provider)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := m.Run(ctx)
			if err == nil {
				t.Error("explicit completion policy capability failure was silently accepted")
			}
			if provider.CallCount() != 0 {
				t.Errorf("completion probe HTTP %d fell back to ordinary execution", status)
			}
			if srv.base.patchCount() != 0 {
				t.Error("failed capability probe disabled the board instead of leaving it resumable")
			}
		})
	}
}

func TestPostmergeAcceptance_LegacyConfigDoesNotProbeCompletionWork(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newCompletionWorkServer(t, loopConfigJSON(t, cfg))
	provider := llm.NewMockProvider("legacy work")
	m := newLoopModeForServer(t, srv.base, provider)
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if provider.CallCount() != 1 || srv.requestIndex("/completion/work") >= 0 {
		t.Fatal("absent policy must preserve legacy execution without a completion-work dependency")
	}
}

func TestPostmergeAcceptance_ObjectiveCompleteRechecksOutstandingWork(t *testing.T) {
	for _, remaining := range []string{
		`{"pending_count":1,"actionable_count":1,"failed_count":0}`,
		`{"pending_count":1,"actionable_count":0,"failed_count":1}`,
	} {
		t.Run(remaining, func(t *testing.T) {
			cfg := baseLoopConfig()
			disabled := cfg
			disabled.Enabled = false
			srv := newCompletionWorkServer(t,
				completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Outstanding acceptance prevents completion."),
				completionPolicyConfigJSON(t, disabled, completionPolicyV1, "Paused by operator."))
			srv.workBodies = []string{`{"pending_count":0,"actionable_count":0,"failed_count":0}`, remaining}
			provider := llm.NewMockProvider("claims complete")
			provider.Caps = llm.Capabilities{StructuredOutput: true}
			provider.QueueStructured([]byte(`{"outcome":"objective_complete","summary":"source merged"}`))
			m := newLoopModeForServer(t, srv.base, provider)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := m.Run(ctx); err != nil && ctx.Err() == nil {
				t.Fatal(err)
			}
			if provider.CallCount() != 1 {
				t.Fatalf("expected one ordinary iteration before new completion work: %d", provider.CallCount())
			}
			if srv.workCalls < 2 {
				t.Error("objective_complete was not verified against completion work created during the iteration")
			}
			if srv.base.patchCount() != 0 {
				t.Errorf("loop completed while acceptance remained outstanding: %+v", srv.base.statePatches())
			}
		})
	}
}

func completionClaim(t *testing.T, kind, provider, repoURL, sourceSHA string, checks []map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"work": map[string]any{
		"attempt_id":    "attempt-1",
		"lease_token":   "private-lease-do-not-inject",
		"candidate_id":  "candidate-1",
		"card_id":       "card-1",
		"kind":          kind,
		"role":          "custom-quality-observer",
		"provider":      provider,
		"model":         "operator-selected-inspection-model",
		"repo_url":      repoURL,
		"source_sha":    sourceSHA,
		"policy_hash":   "policy-hash-1",
		"contract_hash": "checks-hash-1",
		"context":       "MANDATORY CLAIM CONTEXT: inspect this immutable candidate independently; card-1 source " + sourceSHA,
		"checks":        checks,
		"expires_at":    time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339),
	}})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func completionRunOnceServer(t *testing.T, claim string) *completionWorkServer {
	t.Helper()
	cfg := baseLoopConfig()
	disabled := cfg
	disabled.Enabled = false
	srv := newCompletionWorkServer(t,
		completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Completion claims run before ordinary work."),
		completionPolicyConfigJSON(t, disabled, completionPolicyV1, "Paused by operator."))
	srv.workBody = `{"pending_count":1,"actionable_count":1,"failed_count":0}`
	srv.claimBody = claim
	srv.base.readinessBodies = []string{readinessJSON(false, 0, 0, 0, 0)}
	return srv
}

func TestPostmergeAcceptance_IndependentReviewUsesExactConfiguredProviderAndNoSourceSession(t *testing.T) {
	for _, kind := range []string{"review", "evidence_review"} {
		t.Run(kind, func(t *testing.T) {
			repo, sourceSHA, _ := completionSourceRepo(t)
			claim := completionClaim(t, kind, "independent-agent", repo, sourceSHA, nil)
			srv := completionRunOnceServer(t, claim)
			sourceProvider := llm.NewMockProvider("must not execute source provider")
			sourceProvider.NameOverride = "source-agent"
			reviewProvider := llm.NewMockProvider("independent review passed")
			reviewProvider.NameOverride = "independent-agent"
			reviewProvider.Caps = llm.Capabilities{StructuredOutput: true}
			reviewProvider.QueueStructured([]byte(`{"outcome":"passed","summary":"independent inspection complete"}`))
			m := newLoopModeForServer(t, srv.base, sourceProvider)
			m.providers = map[string]llm.Provider{"source-agent": sourceProvider, "independent-agent": reviewProvider}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := m.Run(ctx); err != nil {
				t.Fatalf("Run: %v", err)
			}
			if reviewProvider.CallCount() != 1 || sourceProvider.CallCount() != 0 {
				t.Fatalf("claim provider selection: independent=%d source=%d", reviewProvider.CallCount(), sourceProvider.CallCount())
			}
			call := reviewProvider.Calls[0]
			if call.Options.Model != "operator-selected-inspection-model" {
				t.Errorf("operator model replaced: %q", call.Options.Model)
			}
			if call.Options.ResumeSessionID != "" {
				t.Error("independent review resumed an inherited source session")
			}
			prompt := call.Prompt + "\n" + call.Options.SystemPrompt
			if !strings.Contains(prompt, "MANDATORY CLAIM CONTEXT") || !strings.Contains(prompt, "custom-quality-observer") || !strings.Contains(prompt, sourceSHA) {
				t.Error("backend claim context, arbitrary role or exact source revision missing from fresh review")
			}
			if strings.Contains(prompt, "private-lease-do-not-inject") {
				t.Error("control-plane lease leaked into coding-agent prompt")
			}
			assertCompletionAcknowledgment(t, srv, sourceSHA, "passed")
			if len(srv.claims) != 1 {
				t.Fatalf("expected exactly one claim request, got %d", len(srv.claims))
			}
			capabilities, _ := srv.claims[0]["capabilities"].(map[string]any)
			providers, _ := capabilities["providers"].([]any)
			found := map[string]bool{}
			for _, provider := range providers {
				name, _ := provider.(string)
				found[name] = true
			}
			if !found["source-agent"] || !found["independent-agent"] || len(found) != 2 || capabilities["exact_checkout"] != true || capabilities["argv_checks"] != true {
				t.Errorf("claim must advertise real supported capabilities: %#v", capabilities)
			}
		})
	}
}

func TestPostmergeAcceptance_UnavailableClaimProviderDoesNotFallBack(t *testing.T) {
	repo, sourceSHA, _ := completionSourceRepo(t)
	srv := completionRunOnceServer(t, completionClaim(t, "review", "not-installed", repo, sourceSHA, nil))
	provider := llm.NewMockProvider("must not rubber-stamp using default provider")
	m := newLoopModeForServer(t, srv.base, provider)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := m.Run(ctx)
	if provider.CallCount() != 0 {
		t.Error("unavailable explicitly selected reviewer silently fell back to source/default provider")
	}
	if len(srv.results) > 0 {
		summary, _ := srv.results[0]["summary"].(string)
		if srv.results[0]["outcome"] != "failed" || !strings.Contains(strings.ToLower(summary), "provider") {
			t.Errorf("incompatibility result must explain unavailable provider: %#v", srv.results[0])
		}
	} else if err == nil || !strings.Contains(err.Error(), "not-installed") {
		t.Errorf("unavailable provider must produce actionable blocked/failed evidence or error: %v", err)
	}
}

func completionSourceRepo(t *testing.T) (repo, sourceSHA, advancedSHA string) {
	t.Helper()
	repo = t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		command := exec.Command("git", append([]string{"-C", repo}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
		return strings.TrimSpace(string(output))
	}
	git("init", "--initial-branch=main")
	for _, version := range []string{"accepted-source\n", "newer-main\n"} {
		if err := os.WriteFile(filepath.Join(repo, "version.txt"), []byte(version), 0o644); err != nil {
			t.Fatal(err)
		}
		git("add", "version.txt")
		git("-c", "user.name=Completion Fixture", "-c", "user.email=completion@example.invalid", "commit", "-m", strings.TrimSpace(version))
		if sourceSHA == "" {
			sourceSHA = git("rev-parse", "HEAD")
		} else {
			advancedSHA = git("rev-parse", "HEAD")
		}
	}
	return repo, sourceSHA, advancedSHA
}

func assertCompletionAcknowledgment(t *testing.T, srv *completionWorkServer, sourceSHA, outcome string) map[string]any {
	t.Helper()
	if len(srv.results) != 1 {
		t.Fatalf("expected one immutable candidate acknowledgment, got %d", len(srv.results))
	}
	result := srv.results[0]
	for key, expected := range map[string]string{
		"lease_token": "private-lease-do-not-inject", "candidate_id": "candidate-1",
		"policy_hash": "policy-hash-1", "contract_hash": "checks-hash-1",
		"source_sha": sourceSHA, "outcome": outcome,
	} {
		if result[key] != expected {
			t.Errorf("acknowledgment %s=%#v, want %q", key, result[key], expected)
		}
	}
	if srv.requestIndex("/completion/work/attempt-1/result") < 0 {
		t.Error("result was not scoped to its claimed attempt")
	}
	return result
}

func TestPostmergeAcceptance_ValidationChecksExactSHAAfterMainAdvancesAndUsesLiteralArgv(t *testing.T) {
	repo, sourceSHA, advancedSHA := completionSourceRepo(t)
	marker := filepath.Join(t.TempDir(), "must-not-exist")
	literal := "literal $(touch " + marker + "); not shell input"
	checks := []map[string]any{
		{"id": "exact-source", "argv": []string{"git", "show", "HEAD:version.txt"}, "timeout_seconds": 2},
		{"id": "literal-argv", "argv": []string{"printf", "%s", literal}, "timeout_seconds": 2},
	}
	srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sourceSHA, checks))
	provider := llm.NewMockProvider("passed")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"passed","summary":"checks passed"}`))
	m := newLoopModeForServer(t, srv.base, provider)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.Run(ctx); err != nil {
		t.Fatal(err)
	}
	result := assertCompletionAcknowledgment(t, srv, sourceSHA, "passed")
	encodedChecks, err := json.Marshal(result["checks"])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encodedChecks), "accepted-source") || strings.Contains(string(encodedChecks), "newer-main") {
		t.Errorf("validation checked advanced main instead of frozen accepted source: %s", encodedChecks)
	}
	if !strings.Contains(string(encodedChecks), literal) {
		t.Errorf("argv literal was interpolated or omitted from bounded check evidence: %s", encodedChecks)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("operator argv was shell-interpolated: marker stat error %v", err)
	}
	output, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil || strings.TrimSpace(string(output)) != advancedSHA {
		t.Fatal("validation altered the source repository instead of using an isolated checkout")
	}
}

func TestPostmergeAcceptance_FailedChecksAndChangedHEADCannotAcknowledgePassed(t *testing.T) {
	for _, scenario := range []string{"failed_check", "head_changed"} {
		t.Run(scenario, func(t *testing.T) {
			repo, sourceSHA, advancedSHA := completionSourceRepo(t)
			argv := []string{"git", "show", "HEAD:missing-file"}
			if scenario == "head_changed" {
				argv = []string{"git", "checkout", "--detach", advancedSHA}
			}
			checks := []map[string]any{{"id": scenario, "argv": argv, "timeout_seconds": 2}}
			srv := completionRunOnceServer(t, completionClaim(t, "validation", "mock", repo, sourceSHA, checks))
			provider := llm.NewMockProvider("claims passed anyway")
			provider.Caps = llm.Capabilities{StructuredOutput: true}
			provider.QueueStructured([]byte(`{"outcome":"passed","summary":"untrusted positive claim"}`))
			m := newLoopModeForServer(t, srv.base, provider)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = m.Run(ctx) // Failed work may return an error or record failure then resume.
			assertCompletionAcknowledgment(t, srv, sourceSHA, "failed")
			if srv.base.patchCount() != 0 {
				t.Error("failed validation disabled the board instead of preserving resumable work")
			}
		})
	}
}
