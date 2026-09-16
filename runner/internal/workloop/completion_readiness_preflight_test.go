// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

const readinessVerifiedFixture = `{"policy_hash":"policy-hash-1","ready":true,"checks":[{"operation":"repository_binding","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"repository_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"pull_requests_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"forge_write","repo_id":"repo-1","required":false,"status":"unverified","code":"write_unverified"}]}`

func incompleteReadinessProof(change string) string {
	var report valaris.CompletionReadiness
	if err := json.Unmarshal([]byte(readinessVerifiedFixture), &report); err != nil {
		panic(err)
	}
	switch change {
	case "binding_only":
		report.Checks = report.Checks[:1]
	case "metadata_only":
		report.Checks = report.Checks[1:2]
	case "missing_binding":
		report.Checks = report.Checks[1:]
	case "optional_pr":
		report.Checks[2].Required = false
	case "different_credential":
		report.Checks[2].ConnectionID = "other-connection"
	case "different_source":
		report.Checks[2].CredentialSource = "platform"
		report.Checks[2].ConnectionID = ""
	case "binding_without_repo":
		report.Checks[0].RepoID = ""
	case "additional_incomplete_repo":
		check := report.Checks[0]
		check.RepoID = "repo-2"
		report.Checks = append(report.Checks, check)
	case "optional_candidate":
		check := report.Checks[2]
		check.Operation = "candidate_pr_read"
		check.CandidateID = "candidate-1"
		check.Required = false
		report.Checks = append(report.Checks, check)
	case "candidate_different_credential":
		check := report.Checks[2]
		check.Operation = "candidate_pr_read"
		check.CandidateID = "candidate-1"
		check.ConnectionID = "other-connection"
		report.Checks = append(report.Checks, check)
	}
	body, err := json.Marshal(report)
	if err != nil {
		panic(err)
	}
	return string(body)
}

func TestCompletionReadinessRejectsBeforeSourceOrClaim(t *testing.T) {
	for _, claim := range []bool{false, true} {
		for _, scenario := range []struct {
			name, body, want string
			status           int
			timeout          bool
		}{
			{name: "binding_only", body: incompleteReadinessProof("binding_only"), want: "readiness"},
			{name: "metadata_only", body: incompleteReadinessProof("metadata_only"), want: "readiness"},
			{name: "missing_binding", body: incompleteReadinessProof("missing_binding"), want: "readiness"},
			{name: "optional_pr", body: incompleteReadinessProof("optional_pr"), want: "readiness"},
			{name: "different_credential", body: incompleteReadinessProof("different_credential"), want: "readiness"},
			{name: "different_source", body: incompleteReadinessProof("different_source"), want: "readiness"},
			{name: "binding_without_repo", body: incompleteReadinessProof("binding_without_repo"), want: "readiness"},
			{name: "additional_incomplete_repo", body: incompleteReadinessProof("additional_incomplete_repo"), want: "readiness"},
			{name: "optional_candidate", body: incompleteReadinessProof("optional_candidate"), want: "readiness"},
			{name: "candidate_different_credential", body: incompleteReadinessProof("candidate_different_credential"), want: "readiness"},
			{name: "missing_endpoint", status: 404, body: `{"detail":"upstream-private-token"}`, want: "404"},
			{name: "auth_failure", body: `{"policy_hash":"policy-hash-1","ready":false,"checks":[{"operation":"candidate_pr_read","repo_id":"repo-1","candidate_id":"candidate-1","required":true,"status":"failed","code":"forge_auth_failed","credential_source":"workspace_connection","connection_id":"connection-1"}]}`, want: "credential"},
			{name: "unsafe_metadata", body: `{"policy_hash":"policy-hash-1","ready":false,"checks":[{"operation":"candidate_pr_read","repo_id":"upstream-private-token","candidate_id":"upstream-private-token","required":true,"status":"failed","code":"forge_auth_failed","credential_source":"workspace_connection","connection_id":"upstream-private-token"}]}`, want: "credential"},
			{name: "missing_repo", body: `{"policy_hash":"policy-hash-1","ready":false,"checks":[{"operation":"repository_binding","required":true,"status":"failed","code":"repository_required"}]}`, want: "repository"},
			{name: "unverified_required", body: `{"policy_hash":"policy-hash-1","ready":true,"checks":[{"operation":"pull_requests_read","repo_id":"repo-1","required":true,"status":"unverified","code":"forge_unavailable"}]}`, want: "readiness"},
			{name: "changed_policy", body: strings.Replace(readinessVerifiedFixture, "policy-hash-1", "changed", 1), want: "changed"},
			{name: "missing_required_flag", body: `{"policy_hash":"policy-hash-1","ready":true,"checks":[{"operation":"repository_read","status":"verified","code":"verified"}]}`, want: "readiness"},
			{name: "empty_checks", body: `{"policy_hash":"policy-hash-1","ready":true,"checks":[]}`, want: "readiness"},
			{name: "only_optional", body: `{"policy_hash":"policy-hash-1","ready":true,"checks":[{"operation":"forge_write","required":false,"status":"unverified","code":"write_unverified"}]}`, want: "readiness"},
			{name: "missing_checks", body: `{"policy_hash":"policy-hash-1","ready":true}`, want: "readiness"},
			{name: "null", body: `null`, want: "readiness"},
			{name: "timeout", timeout: true, want: "readiness"},
		} {
			t.Run(fmt.Sprintf("claim=%v/%s", claim, scenario.name), func(t *testing.T) {
				cfg := baseLoopConfig()
				cfg.MaxIterations = 1
				srv := newCompletionWorkServer(t, completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory policy."))
				if claim {
					srv.workBody = `{"pending_count":1,"actionable_count":1,"failed_count":0}`
				}
				probes := 0
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if strings.HasSuffix(r.URL.Path, "/completion/readiness") {
						probes++
						if scenario.timeout {
							cancel()
							<-r.Context().Done()
							return
						}
						if scenario.status != 0 {
							w.WriteHeader(scenario.status)
						}
						_, _ = w.Write([]byte(scenario.body))
						return
					}
					srv.handle(w, r)
				}))
				defer wrapper.Close()
				provider := llm.NewMockProvider("must not execute")
				mode := newLoopModeForServer(t, srv.base, provider)
				mode.client = valaris.NewClient(wrapper.URL, "vlr_fixture")
				err := mode.Run(ctx)
				if err == nil || !strings.Contains(strings.ToLower(err.Error()), scenario.want) {
					t.Fatalf("expected %s readiness failure, got %v", scenario.want, err)
				}
				if strings.Contains(err.Error(), "upstream-private-token") {
					t.Fatal("raw upstream body leaked")
				}
				if probes != 1 || provider.CallCount() != 0 || len(srv.claims) != 0 || srv.base.executionStartCount() != 0 || srv.base.patchCount() != 0 {
					t.Fatalf("prerequisite failure reached work: probes=%d models=%d claims=%d starts=%d patches=%d", probes, provider.CallCount(), len(srv.claims), srv.base.executionStartCount(), srv.base.patchCount())
				}
			})
		}
	}
}

func TestCompletionReadinessIsFreshEachEnabledCycle(t *testing.T) {
	cfg := baseLoopConfig()
	disabled := cfg
	disabled.Enabled = false
	srv := newCompletionWorkServer(t, completionPolicyConfigJSON(t, cfg, completionPolicyV1, "policy"), completionPolicyConfigJSON(t, cfg, completionPolicyV1, "policy"), completionPolicyConfigJSON(t, disabled, completionPolicyV1, "paused"))
	probes := 0
	wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/completion/readiness") {
			probes++
			if probes == 1 {
				_, _ = w.Write([]byte(readinessVerifiedFixture))
			} else {
				w.WriteHeader(503)
				_, _ = w.Write([]byte(`{"detail":"private-upstream-body"}`))
			}
			return
		}
		srv.handle(w, r)
	}))
	defer wrapper.Close()
	provider := llm.NewMockProvider("first source", "must not run next source")
	mode := newLoopModeForServer(t, srv.base, provider)
	mode.client = valaris.NewClient(wrapper.URL, "vlr_fixture")
	if err := mode.Run(context.Background()); err == nil {
		t.Fatal("cached readiness allowed second source")
	}
	if probes != 2 || provider.CallCount() != 1 || srv.base.executionStartCount() != 1 || srv.base.patchCount() != 0 {
		t.Fatalf("wrong fresh-cycle boundary: probes=%d models=%d starts=%d patches=%d", probes, provider.CallCount(), srv.base.executionStartCount(), srv.base.patchCount())
	}
}

func TestCompletionReadinessReviewProbesOnceDespiteRepeatedRoleChecks(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	srv := completionRunOnceServer(t, completionClaim(t, "review", "mock", repo, sha, nil))
	probes := 0
	wrapper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/completion/readiness") {
			probes++
			_, _ = w.Write([]byte(readinessVerifiedFixture))
			return
		}
		srv.handle(w, r)
	}))
	defer wrapper.Close()
	provider := llm.NewMockProvider("reviewed")
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"passed","summary":"independent review completed"}`))
	mode := newLoopModeForServer(t, srv.base, provider)
	mode.client = valaris.NewClient(wrapper.URL, "vlr_fixture")
	if err := mode.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if probes != 1 || provider.CallCount() != 1 || len(srv.claims) != 1 {
		t.Fatalf("readiness repeated per role check or missing: probes=%d calls=%d claims=%d", probes, provider.CallCount(), len(srv.claims))
	}
	assertCompletionAcknowledgment(t, srv, sha, "passed")
}
