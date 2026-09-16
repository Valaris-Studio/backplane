// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/workloop"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDoctorCompletionWorkflow(t *testing.T) {
	for _, scenario := range []string{"no_board", "missing_reviewer", "missing_source", "compatible", "server_readiness_failure"} {
		t.Run(scenario, func(t *testing.T) {
			readinessProbes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/loop"):
					_, _ = w.Write([]byte(`{"completion_policy":{"version":1,"source_review":"independent","review_role":"custom-auditor"},"completion_policy_hash":"policy-1","completion_context":"policy"}`))
				case strings.HasSuffix(r.URL.Path, "/completion/requirements"):
					_, _ = w.Write([]byte(`{"policy_hash":"policy-1","requirements":[{"kind":"review","role":"custom-auditor","provider":"codex-cli","model":"operator-review-model","checks":[]}]}`))
				case strings.HasSuffix(r.URL.Path, "/completion/readiness"):
					readinessProbes++
					if scenario == "server_readiness_failure" {
						_, _ = w.Write([]byte(`{"policy_hash":"policy-1","ready":false,"checks":[{"operation":"candidate_pr_read","repo_id":"repo-1","candidate_id":"candidate-1","required":true,"status":"failed","code":"forge_auth_failed","credential_source":"workspace_connection","connection_id":"connection-1"}]}`))
					} else {
						_, _ = w.Write([]byte(`{"policy_hash":"policy-1","ready":true,"checks":[{"operation":"repository_binding","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"repository_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"pull_requests_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"forge_write","repo_id":"repo-1","required":false,"status":"unverified","code":"write_unverified"}]}`))
					}
				default:
					t.Fatalf("unexpected %s", r.URL.Path)
				}
			}))
			defer server.Close()
			cfg := &config.Config{}
			cfg.Git.Forge = "gitea"
			cfg.LLM.Provider = "claude-cli"
			cfg.LLM.RunOverride = &config.ModelSelection{Provider: "claude-cli", Model: "fable"}
			if scenario != "no_board" {
				cfg.Valaris.BoardIDs = []string{"board-1"}
			}
			if scenario == "compatible" || scenario == "missing_source" || scenario == "server_readiness_failure" {
				cfg.LLM.ExtraProviders = []string{"codex-cli"}
			}
			mcpCalls := 0
			lookup := runtimeDoctorLookPath(t, "git", "claude", "codex")
			if scenario == "missing_source" {
				lookup = runtimeDoctorLookPath(t, "git", "codex")
			}
			row := checkCompletionWorkflow(context.Background(), cfg, Credentials{APIURL: server.URL, APIKey: "vlr_test", Workspace: "acme", MCPConfigPath: "/explicit/config.json"}, lookup, func(context.Context, string, string, string, *valaris.BoardLoopConfig) (workloop.MCPLaunchReport, error) {
				mcpCalls++
				return workloop.MCPLaunchReport{ConfigPath: "/explicit/config.json", Executable: "uvx", Version: "0.8.0"}, nil
			})
			if scenario == "server_readiness_failure" {
				if row.State != tui.StateFail || !strings.Contains(row.Detail, "credential") || readinessProbes != 1 {
					t.Fatalf("doctor failed to gate server credential: %+v probes=%d", row, readinessProbes)
				}
			} else if scenario == "missing_source" {
				if row.State != tui.StateFail || !strings.Contains(row.Detail, "claude") {
					t.Fatalf("missing source binary silently ready: %+v", row)
				}
			} else if scenario == "missing_reviewer" {
				if row.State != tui.StateFail || !strings.Contains(row.Detail, "custom-auditor") {
					t.Fatalf("missing reviewer silently ready: %+v", row)
				}
			} else if row.State != tui.StateWarn {
				t.Fatalf("unverified prerequisites must remain explicit: %+v", row)
			}
			if scenario == "compatible" && (readinessProbes != 1 || mcpCalls != 1 || !strings.Contains(row.Detail, "operator-review-model") || !strings.Contains(row.Detail, "/explicit/config.json")) {
				t.Fatalf("final composition not shown/checked: %+v calls=%d", row, mcpCalls)
			}
		})
	}
}

func TestDoctorSelectedProfilePinsSameCredentialsAsLaunch(t *testing.T) {
	root := t.TempDir()
	store := profile.NewStore(root)
	stored := profile.Credentials{APIKey: "vlr_profile_secret", APIURL: "https://profile.example", Workspace: "profile-workspace"}
	if err := store.Save("selected", stored, []byte("valaris: {}\n"), []byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VALARIS_API_KEY", "vlr_other_secret")
	t.Setenv("VALARIS_API_URL", "https://other.example")
	t.Setenv("VALARIS_WORKSPACE", "other-workspace")
	cfg := doctorConfigForReport(store.ConfigPath("selected"))
	warnings, err := pinProfileCredentials(cfg, root, "selected")
	if err != nil {
		t.Fatal(err)
	}
	got := doctorCredentials(cfg, store.ConfigPath("selected"), t.TempDir(), t.TempDir())
	if got.APIKey != stored.APIKey || got.APIURL != stored.APIURL || got.Workspace != stored.Workspace {
		t.Fatal("doctor profile credentials differ from selected profile")
	}
	if len(warnings) != 3 || strings.Contains(strings.Join(warnings, " "), "secret") {
		t.Fatal("profile warning count or secrecy violated")
	}
}
