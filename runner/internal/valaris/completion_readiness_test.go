// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCompletionReadinessClientRejectsMalformedContractWithoutLeaking(t *testing.T) {
	for _, body := range []string{
		`null`, `{}`, `{"policy_hash":"hash","checks":[]}`, `{"policy_hash":"hash","ready":true,"checks":null}`,
		`{"policy_hash":"hash","ready":true,"checks":[{"operation":"repository_read","status":"verified","code":"verified"}]}`,
		`{"policy_hash":"hash","ready":true,"checks":[{"operation":"unknown","required":true,"status":"verified","code":"verified"}]}`,
		`{"policy_hash":"hash","ready":true,"checks":[{"operation":"repository_read","required":true,"status":"unknown","code":"verified"}]}`,
		`{"policy_hash":"hash","ready":true,"checks":[{"operation":"repository_read","required":true,"status":"verified","code":"verified","credential_source":"upstream-private-token"}]}`,
		`{"policy_hash":"hash","ready":true,"checks":[{"operation":"repository_read","required":true,"status":"verified","code":"verified"}]}`,
		`{"policy_hash":"hash","ready":true,"checks":[{"operation":"repository_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified"}]}`,
		`{"policy_hash":"hash","ready":true,"checks":[{"operation":"repository_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection"}]}`,
		`{"policy_hash":"hash","ready":true,"checks":[{"operation":"candidate_pr_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"platform"}]}`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
			defer server.Close()
			_, err := NewClient(server.URL, "vlr_fixture").GetCompletionReadiness(context.Background(), "acme", "board-1")
			if err == nil || strings.Contains(err.Error(), "upstream-private-token") {
				t.Fatalf("unsafe malformed response handling: %v", err)
			}
		})
	}
}

func TestCompletionReadinessClientPreservesCredentialProvenance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/api/workspaces/acme/boards/board-1/completion/readiness" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"policy_hash":"hash","ready":true,"checks":[{"operation":"repository_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"forge_write","repo_id":"repo-1","required":false,"status":"unverified","code":"write_unverified","credential_source":"workspace_connection","connection_id":"connection-1"}]}`))
	}))
	defer server.Close()
	got, err := NewClient(server.URL, "vlr_fixture").GetCompletionReadiness(context.Background(), "acme", "board-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.PolicyHash != "hash" || !got.Ready || len(got.Checks) != 2 || got.Checks[0].CredentialSource != "workspace_connection" || got.Checks[0].ConnectionID != "connection-1" || got.Checks[1].Required || got.Checks[1].Status != "unverified" {
		t.Fatalf("readiness contract changed: %+v", got)
	}
}
