// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// meServer fronts the fake Backplane with GET /api/companion/me answering
// as respond says, and counts the calls.
func meServer(t *testing.T, h *harness, respond func(w http.ResponseWriter)) (string, *atomic.Int32) {
	t.Helper()
	upstream, _ := url.Parse(h.server.URL)
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	calls := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/api/companion/me" {
			calls.Add(1)
			respond(w)
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	return server.URL, calls
}

func answerMe(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"email": "jane@example.com", "display_name": "Jane"}, "installation": map[string]any{"id": "i", "name": "laptop"}, "web_origin": "https://app.example"})
}

func (h *harness) connectTo(t *testing.T, endpoint string) {
	t.Helper()
	if err := h.run(t, "connect", "--endpoint", endpoint, "--allow-insecure-loopback"); err != nil {
		t.Fatal(err)
	}
}

type accountView struct {
	Account *struct {
		Email       string  `json:"email"`
		DisplayName string  `json:"display_name"`
		WebOrigin   *string `json:"web_origin"`
	} `json:"account"`
}

func (c *apiClient) account(t *testing.T) accountView {
	t.Helper()
	status, body := c.call(t, "GET", "/v1/status", "")
	var view accountView
	if status != 200 || json.Unmarshal(body, &view) != nil || !strings.Contains(string(body), `"account":`) {
		t.Fatalf("status %d %s", status, body)
	}
	return view
}

func (c *apiClient) eventuallyAccount(t *testing.T) accountView {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if view := c.account(t); view.Account != nil {
			return view
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("account never appeared")
	return accountView{}
}

func TestAPIStatus_AccountAppearsAndIsCached(t *testing.T) {
	h := newHarness(t)
	endpoint, calls := meServer(t, h, answerMe)
	h.connectTo(t, endpoint)
	api := h.api(t)
	view := api.eventuallyAccount(t)
	if view.Account.Email != "jane@example.com" || view.Account.DisplayName != "Jane" || view.Account.WebOrigin == nil || *view.Account.WebOrigin != "https://app.example" {
		t.Fatalf("account %+v", *view.Account)
	}
	fetched := calls.Load()
	for range 3 {
		api.account(t)
	}
	if calls.Load() != fetched {
		t.Fatalf("the account must be cached: %d calls after %d", calls.Load(), fetched)
	}
	if err := h.run(t, "status"); err != nil || strings.Contains(h.stdout.String(), `"account"`) {
		t.Fatalf("CLI status keeps its recorded shape: %s", h.stdout)
	}
}

func TestAPIStatus_AccountIsNullWhenNotConnected(t *testing.T) {
	h := newHarness(t)
	if view := h.api(t).account(t); view.Account != nil {
		t.Fatalf("account while not connected: %+v", view.Account)
	}
}

func TestAPIStatus_AccountIsNullWhenTheCallFails(t *testing.T) {
	h := newHarness(t)
	endpoint, calls := meServer(t, h, func(w http.ResponseWriter) { w.WriteHeader(500) })
	h.connectTo(t, endpoint)
	api := h.api(t)
	api.account(t)
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if view := api.account(t); view.Account != nil || calls.Load() == 0 {
		t.Fatalf("failed fetch: account %+v after %d calls", view.Account, calls.Load())
	}
}

func TestAPIStatus_AccountNeverBlocksStatus(t *testing.T) {
	h := newHarness(t)
	release := make(chan struct{})
	endpoint, _ := meServer(t, h, func(w http.ResponseWriter) {
		<-release
		answerMe(w)
	})
	defer close(release)
	h.connectTo(t, endpoint)
	api := h.api(t)
	started := time.Now()
	view := api.account(t)
	if elapsed := time.Since(started); elapsed > time.Second || view.Account != nil {
		t.Fatalf("status waited %v for the account (%+v)", elapsed, view.Account)
	}
}

func TestAPIStatus_AccountRefreshesWithThePolicyRefresh(t *testing.T) {
	h := newHarness(t)
	endpoint, calls := meServer(t, h, answerMe)
	h.connectTo(t, endpoint)
	layout := store.Layout{Root: h.data}
	backend := h.app.controlConfig(layout, nil).Backend.(*controlBackend)
	backend.Status(context.Background())
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	before := calls.Load()
	if err := backend.RefreshPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for calls.Load() == before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() != before+1 {
		t.Fatalf("a policy refresh must refresh the account: %d → %d calls", before, calls.Load())
	}
}

func TestAPIProjects_CandidatesComeFromTheCatalog(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	layout := store.Layout{Root: h.data}
	shared := scope.Project{Root: filepath.Join(h.home, "code", "shared"), RepoURL: "github.com/acme/shared"}
	unbound := scope.Project{Root: filepath.Join(h.home, "code", "unbound"), RepoURL: "github.com/acme/unbound"}
	for _, project := range []scope.Project{shared, unbound} {
		mustMkdir(t, project.Root)
		state.RecordDiscovered(context.Background(), layout, project, time.Now())
	}
	cached, _ := policy.Load(layout.Policy())
	cached.Policy.Installation.AutoMatchRepos = true
	cached.Policy.RepoCatalog = []policy.CatalogRepo{
		{WorkspaceSlug: "acme", WorkspaceID: "w1", BoardID: "b1", BoardName: "App", RepoURLNormalized: "github.com/acme/shared"},
		{WorkspaceSlug: "beta", WorkspaceID: "w2", BoardID: "b2", BoardName: "Beta", RepoURLNormalized: "github.com/acme/shared"},
	}
	policy.Save(layout.Policy(), cached)
	api := h.api(t)
	type candidate struct {
		WorkspaceID   string  `json:"workspace_id"`
		WorkspaceName *string `json:"workspace_name"`
		WorkspaceSlug string  `json:"workspace_slug"`
		BoardID       string  `json:"board_id"`
		BoardName     string  `json:"board_name"`
	}
	listed := func() map[string][]candidate {
		_, body := api.call(t, "GET", "/v1/projects", "")
		var projects struct {
			Discovered []struct {
				Root       string       `json:"root"`
				Candidates *[]candidate `json:"candidates"`
			} `json:"discovered"`
		}
		json.Unmarshal(body, &projects)
		found := map[string][]candidate{}
		for _, project := range projects.Discovered {
			if project.Candidates == nil {
				t.Fatalf("every discovered item carries candidates: %s", body)
			}
			found[project.Root] = *project.Candidates
		}
		return found
	}
	found := listed()
	if got := found[shared.Root]; len(got) != 2 || got[0].BoardID != "b1" || got[0].BoardName != "App" || got[0].WorkspaceSlug != "acme" || got[0].WorkspaceName != nil || got[1].WorkspaceID != "w2" {
		t.Fatalf("ambiguous candidates %+v", got)
	}
	if got := found[unbound.Root]; len(got) != 0 {
		t.Fatalf("not_bound has no candidates: %+v", got)
	}
	cached.Policy.Installation.AutoMatchRepos = false
	cached.Policy.RepoCatalog = cached.Policy.RepoCatalog[:1]
	policy.Save(layout.Policy(), cached)
	if got := listed()[shared.Root]; len(got) != 1 || got[0].BoardID != "b1" {
		t.Fatalf("auto_match_off candidates %+v", got)
	}
	if err := h.run(t, "projects", "list"); err != nil || strings.Contains(h.stdout.String(), "candidates") {
		t.Fatalf("CLI list keeps its recorded shape: %s", h.stdout)
	}
}

func TestControlConfig_InsecureLoopbackFollowsTheEnvironment(t *testing.T) {
	h := newHarness(t)
	layout := store.Layout{Root: h.data}
	for value, want := range map[string]bool{"": false, "0": false, "true": false, "1": true} {
		h.env["BACKPLANE_COMPANION_ALLOW_INSECURE_LOOPBACK"] = value
		if got := h.app.controlConfig(layout, nil).AllowInsecureLoopback; got != want {
			t.Fatalf("%q: allow %v, want %v", value, got, want)
		}
	}
}

func TestControlConfig_HomeIsCaseInsensitiveOnDarwinAndWindows(t *testing.T) {
	h := newHarness(t)
	layout := store.Layout{Root: h.data}
	for goos, want := range map[string]bool{"darwin": true, "windows": true, "linux": false} {
		h.app.goos = goos
		if got := h.app.controlConfig(layout, nil).HomeCaseInsensitive; got != want {
			t.Fatalf("%s: case-insensitive %v", goos, got)
		}
	}
}

func TestAPIProjects_CandidatesCarryTheCatalogsWorkspaceName(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	layout := store.Layout{Root: h.data}
	shared := scope.Project{Root: filepath.Join(h.home, "code", "shared"), RepoURL: "github.com/acme/shared"}
	mustMkdir(t, shared.Root)
	state.RecordDiscovered(context.Background(), layout, shared, time.Now())
	cached, _ := policy.Load(layout.Policy())
	cached.Policy.Installation.AutoMatchRepos = true
	acme := "Acme Corp"
	cached.Policy.RepoCatalog = []policy.CatalogRepo{
		{WorkspaceSlug: "acme", WorkspaceName: &acme, WorkspaceID: "w1", BoardID: "b1", BoardName: "App", RepoURLNormalized: "github.com/acme/shared"},
		// An entry cached from a server that predates workspace_name.
		{WorkspaceSlug: "beta", WorkspaceID: "w2", BoardID: "b2", BoardName: "Beta", RepoURLNormalized: "github.com/acme/shared"},
	}
	policy.Save(layout.Policy(), cached)
	_, body := h.api(t).call(t, "GET", "/v1/projects", "")
	var projects struct {
		Discovered []struct {
			Candidates []map[string]any `json:"candidates"`
		} `json:"discovered"`
	}
	json.Unmarshal(body, &projects)
	if len(projects.Discovered) != 1 || len(projects.Discovered[0].Candidates) != 2 {
		t.Fatalf("projects %s", body)
	}
	named, unnamed := projects.Discovered[0].Candidates[0], projects.Discovered[0].Candidates[1]
	if named["workspace_name"] != "Acme Corp" {
		t.Fatalf("named candidate %v", named)
	}
	if value, present := unnamed["workspace_name"]; !present || value != nil {
		t.Fatalf("a catalog without the name answers workspace_name null: %v", unnamed)
	}
}
