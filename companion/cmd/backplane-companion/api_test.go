// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

type apiClient struct {
	server *httptest.Server
	*control.Server
}

// api serves the control API of h's app over loopback TCP; the socket
// transport is covered by the control package and the run tests below.
func (h *harness) api(t *testing.T) *apiClient {
	t.Helper()
	layout, err := h.app.layout()
	if err != nil {
		t.Fatal(err)
	}
	server := h.app.newControlServer(layout, nil)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(func() {
		httpServer.CloseClientConnections()
		httpServer.Close()
		server.Close()
	})
	return &apiClient{server: httpServer, Server: server}
}

func (c *apiClient) call(t *testing.T, method, path, body string, header ...string) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, _ := http.NewRequest(method, c.server.URL+path, reader)
	for index := 0; index+1 < len(header); index += 2 {
		request.Header.Set(header[index], header[index+1])
	}
	reply, err := c.server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	data, _ := io.ReadAll(reply.Body)
	return reply.StatusCode, data
}

func decodeJSON(t *testing.T, data []byte) any {
	t.Helper()
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("not JSON: %s", data)
	}
	return decoded
}

func envelopeCode(t *testing.T, data []byte) string {
	t.Helper()
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.Error.Code == "" || envelope.Error.Message == "" {
		t.Fatalf("not an error envelope: %s", data)
	}
	return envelope.Error.Code
}

func TestAPIStatus_MatchesTheCLIStatus(t *testing.T) {
	h := newHarness(t)
	h.app.now = func() time.Time { return goldenClock }
	h.connect(t)
	api := h.api(t)
	status, apiBody := api.call(t, "GET", "/v1/status", "")
	if err := h.run(t, "status"); err != nil || status != 200 {
		t.Fatalf("status %d %v", status, err)
	}
	got := decodeJSON(t, apiBody).(map[string]any)
	if _, present := got["account"]; !present {
		t.Fatalf("the API status carries account: %s", apiBody)
	}
	delete(got, "account")
	if _, present := got["suggested_device_name"]; !present {
		t.Fatalf("the API status carries suggested_device_name: %s", apiBody)
	}
	delete(got, "suggested_device_name")
	capture := got["capture"].(map[string]any)
	for _, apiOnly := range []string{"auto_match_repos", "exclude_globs"} {
		if _, present := capture[apiOnly]; !present {
			t.Fatalf("the API capture carries %s: %s", apiOnly, apiBody)
		}
		delete(capture, apiOnly)
	}
	if want := decodeJSON(t, h.stdout.Bytes()); !jsonEqual(got, want) {
		t.Fatalf("API status differs from the CLI:\n%s\n%s", apiBody, h.stdout)
	}
}

func jsonEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}

// countingKeyring counts token loads: the status probe of the keyring.
type countingKeyring struct {
	credentialStore
	loads atomic.Int32
}

func (k *countingKeyring) Load(installationID string) (string, error) {
	k.loads.Add(1)
	return k.credentialStore.Load(installationID)
}

type countingRunner struct {
	mu     sync.Mutex
	prints int
}

func (r *countingRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if name == "launchctl" && len(args) > 0 && args[0] == "print" {
		r.prints++
	}
	return nil, errors.New("not loaded")
}

func (r *countingRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.prints
}

func TestAPIStatus_CachesProbesUntilAMutation(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	keyring := &countingKeyring{credentialStore: credentials.Keyring{}}
	runner := &countingRunner{}
	h.app.keyring, h.app.goos, h.app.uid, h.app.serviceRunner = keyring, "darwin", 501, runner
	api := h.api(t)
	for range 3 {
		if status, body := api.call(t, "GET", "/v1/status", ""); status != 200 {
			t.Fatalf("status %d %s", status, body)
		}
	}
	if keyring.loads.Load() != 1 || runner.count() != 1 {
		t.Fatalf("three reads probed the keyring %d and the service manager %d times, want 1 each", keyring.loads.Load(), runner.count())
	}
	api.call(t, "POST", "/v1/pause", "")
	api.call(t, "GET", "/v1/status", "")
	if keyring.loads.Load() != 2 || runner.count() != 2 {
		t.Fatalf("pause must invalidate the probes: keyring %d, service %d", keyring.loads.Load(), runner.count())
	}
}

func TestAPIStatus_ProbesExpireAfterTheTTL(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	// Read by the background account fetch too, so it is atomic.
	var current atomic.Int64
	current.Store(time.Now().UnixNano())
	h.app.now = func() time.Time { return time.Unix(0, current.Load()) }
	keyring := &countingKeyring{credentialStore: credentials.Keyring{}}
	h.app.keyring = keyring
	api := h.api(t)
	api.call(t, "GET", "/v1/status", "")
	current.Add(int64(29 * time.Second))
	api.call(t, "GET", "/v1/status", "")
	if keyring.loads.Load() != 1 {
		t.Fatalf("probed %d times within the TTL", keyring.loads.Load())
	}
	current.Add(int64(2 * time.Second))
	api.call(t, "GET", "/v1/status", "")
	if keyring.loads.Load() != 2 {
		t.Fatalf("probed %d times after the TTL", keyring.loads.Load())
	}
}

func TestAPIAndCLIPauseConcurrently_KeepPreferencesConsistent(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	other := filepath.Join(h.home, "code", "app")
	if err := h.run(t, "projects", "ignore", other); err != nil {
		t.Fatal(err)
	}
	api := h.api(t)
	var wait sync.WaitGroup
	for index := range 20 {
		wait.Add(2)
		go func() {
			defer wait.Done()
			path := map[bool]string{true: "/v1/pause", false: "/v1/resume"}[index%2 == 0]
			if status, body := api.call(t, "POST", path, ""); status != 200 {
				t.Errorf("%s: %d %s", path, status, body)
			}
		}()
		go func() {
			defer wait.Done()
			command := map[bool]string{true: "resume", false: "pause"}[index%2 == 0]
			// Each CLI invocation is its own process: its own app, same data.
			cli := h.makeApp(func(key string) string { return h.env[key] }, &bytes.Buffer{})
			if err := cli.run(context.Background(), []string{command}); err != nil {
				t.Errorf("%s: %v", command, err)
			}
		}()
	}
	wait.Wait()
	preferences, err := state.Load[state.Preferences](filepath.Join(h.data, "preferences.json"))
	if err != nil {
		t.Fatalf("preferences.json unreadable after concurrent writes: %v", err)
	}
	if len(preferences.IgnoredPaths) != 1 || preferences.IgnoredPaths[0] != other {
		t.Fatalf("a concurrent pause lost the ignored paths: %+v", preferences)
	}
	_, body := api.call(t, "POST", "/v1/pause", "")
	if string(bytes.TrimSpace(body)) != `{"paused":true}` {
		t.Fatalf("pause: %s", body)
	}
	if err := h.run(t, "status"); err != nil || !strings.Contains(h.stdout.String(), `"local_paused": true`) {
		t.Fatalf("the CLI must see the API's pause: %s", h.stdout)
	}
}

func TestAPIProjects_DiscoveredCarryAReason(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	layout := store.Layout{Root: h.data}
	projects := map[string]scope.Project{
		"no_origin": {Root: filepath.Join(h.home, "code", "local")},
		"not_bound": {Root: filepath.Join(h.home, "code", "unbound"), RepoURL: "github.com/acme/unbound"},
		"ambiguous": {Root: filepath.Join(h.home, "code", "shared"), RepoURL: "github.com/acme/shared"},
		"excluded":  {Root: filepath.Join(h.home, "code", "secret"), RepoURL: "github.com/acme/secret"},
	}
	for _, project := range projects {
		mustMkdir(t, project.Root)
		state.RecordDiscovered(context.Background(), layout, project, time.Now())
	}
	cached, _ := policy.Load(layout.Policy())
	cached.Policy.Installation.AutoMatchRepos = true
	cached.Policy.Installation.ExcludeGlobs = []string{"**/secret"}
	cached.Policy.RepoCatalog = []policy.CatalogRepo{
		{WorkspaceID: "w1", BoardID: "b1", RepoURLNormalized: "github.com/acme/shared"},
		{WorkspaceID: "w2", BoardID: "b2", RepoURLNormalized: "github.com/acme/shared"},
	}
	policy.Save(layout.Policy(), cached)
	api := h.api(t)
	reasons := func() map[string]string {
		_, body := api.call(t, "GET", "/v1/projects", "")
		var listed struct {
			Discovered []struct {
				Root   string `json:"root"`
				Reason string `json:"reason"`
			} `json:"discovered"`
		}
		json.Unmarshal(body, &listed)
		found := map[string]string{}
		for _, project := range listed.Discovered {
			found[project.Root] = project.Reason
		}
		return found
	}
	found := reasons()
	for want, project := range projects {
		if found[project.Root] != want {
			t.Errorf("%s: reason %q, want %q", project.Root, found[project.Root], want)
		}
	}
	cached.Policy.Installation.AutoMatchRepos = false
	policy.Save(layout.Policy(), cached)
	if reason := reasons()[projects["not_bound"].Root]; reason != "auto_match_off" {
		t.Fatalf("with auto-match off: %q", reason)
	}
	if err := h.run(t, "projects", "list"); err != nil || strings.Contains(h.stdout.String(), `"reason"`) {
		t.Fatalf("the CLI list keeps its recorded shape: %s %v", h.stdout, err)
	}
}

func TestAPIProjects_ARemoteAddedAfterDiscoveryReachesTheFoundRow(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	repo := filepath.Join(h.home, "code", "skate")
	mustMkdir(t, filepath.Join(repo, ".git"))
	api := h.api(t)
	api.StartWatching()
	events := h.collectEvents(t, api)
	events.next(t, "status")
	found := func() (reason, repoURL string) {
		_, body := api.call(t, "GET", "/v1/projects", "")
		var listed struct {
			Discovered []struct {
				Root    string `json:"root"`
				RepoURL string `json:"repo_url"`
				Reason  string `json:"reason"`
			} `json:"discovered"`
		}
		json.Unmarshal(body, &listed)
		for _, project := range listed.Discovered {
			if project.Root == repo {
				return project.Reason, project.RepoURL
			}
		}
		t.Fatalf("%s not listed: %s", repo, body)
		return "", ""
	}
	session := `{"cwd":` + quoted(repo) + `,"session_id":"s","hook_event_name":"UserPromptSubmit","prompt":"x"}`
	h.hook(t, session)
	if reason, _ := found(); reason != "no_origin" {
		t.Fatalf("before the remote: %q", reason)
	}
	mustWrite(t, filepath.Join(repo, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/Acme-Labs/skate.git\n")
	h.hook(t, session)
	if reason, repoURL := found(); reason != "not_bound" || repoURL != "github.com/acme-labs/skate" {
		t.Fatalf("after the remote: %q %q", reason, repoURL)
	}
	for {
		if strings.Contains(events.next(t, "projects"), "github.com/acme-labs/skate") {
			break
		}
	}
}

func TestProjectsUnignore_RemovesTheIgnoredPathIdempotently(t *testing.T) {
	h := newHarness(t)
	if err := h.run(t, "projects", "ignore", h.repo); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := h.run(t, "projects", "unignore", h.repo); err != nil {
			t.Fatal(err)
		}
		if got := strings.TrimSpace(h.stdout.String()); got != "{\n  \"unignored\": "+quoted(h.repo)+"\n}" {
			t.Fatalf("unignore output %s", got)
		}
	}
	preferences, _ := state.Load[state.Preferences](filepath.Join(h.data, "preferences.json"))
	if len(preferences.IgnoredPaths) != 0 {
		t.Fatalf("still ignored: %v", preferences.IgnoredPaths)
	}
}

func TestProjectsUnignore_AcceptsAPathThatNoLongerExists(t *testing.T) {
	h := newHarness(t)
	gone := filepath.Join(h.home, "code", "gone")
	mustMkdir(t, gone)
	if err := h.run(t, "projects", "ignore", gone); err != nil {
		t.Fatal(err)
	}
	os.Remove(gone)
	if err := h.run(t, "projects", "unignore", gone); err != nil {
		t.Fatal(err)
	}
	preferences, _ := state.Load[state.Preferences](filepath.Join(h.data, "preferences.json"))
	if len(preferences.IgnoredPaths) != 0 {
		t.Fatalf("a deleted directory must be un-ignorable: %v", preferences.IgnoredPaths)
	}
	if err := h.run(t, "projects", "unignore"); !errors.Is(err, errUsage) {
		t.Fatalf("unignore without a path: %v", err)
	}
}

func TestAPIUnignore_UndoesACLIIgnore(t *testing.T) {
	h := newHarness(t)
	if err := h.run(t, "projects", "ignore", h.repo); err != nil {
		t.Fatal(err)
	}
	api := h.api(t)
	status, body := api.call(t, "DELETE", "/v1/projects/ignore", `{"path":`+quoted(h.repo)+`}`)
	if status != 200 || !strings.Contains(string(body), `"unignored"`) {
		t.Fatalf("unignore: %d %s", status, body)
	}
	status, body = api.call(t, "POST", "/v1/projects/ignore", `{"path":`+quoted(filepath.Join(h.home, "missing"))+`}`)
	if status != http.StatusBadRequest || envelopeCode(t, body) != "not_a_directory" {
		t.Fatalf("ignore a missing directory: %d %s", status, body)
	}
}

// renamingServer fronts the fake Backplane with the installation rename
// endpoint the companion calls.
func renamingServer(t *testing.T, h *harness) (string, *[]string) {
	t.Helper()
	upstream, _ := url.Parse(h.server.URL)
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	var names []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PATCH" && r.URL.Path == "/api/companion/installation" {
			if r.Header.Get("Authorization") != "Bearer "+uplinktest.DeviceToken {
				w.WriteHeader(401)
				return
			}
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			names = append(names, body["name"])
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"installation_id": "x", "name": body["name"]})
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	return server.URL, &names
}

func TestRename_RenamesOnTheServerAndLocally(t *testing.T) {
	h := newHarness(t)
	endpoint, names := renamingServer(t, h)
	if err := h.run(t, "connect", "--endpoint", endpoint, "--allow-insecure-loopback"); err != nil {
		t.Fatal(err)
	}
	if err := h.run(t, "rename", "work laptop"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(h.stdout.String()); got != "{\n  \"name\": \"work laptop\"\n}" {
		t.Fatalf("rename output %s", got)
	}
	installation, _ := state.Load[state.Installation](filepath.Join(h.data, "installation.json"))
	if len(*names) != 1 || (*names)[0] != "work laptop" || installation.Name != "work laptop" {
		t.Fatalf("server saw %v, local name %q", *names, installation.Name)
	}
	api := h.api(t)
	status, body := api.call(t, "POST", "/v1/rename", `{"name":"desk"}`)
	if status != 200 || string(bytes.TrimSpace(body)) != `{"name":"desk"}` || (*names)[1] != "desk" {
		t.Fatalf("API rename: %d %s", status, body)
	}
}

func TestRename_RefusesWhenNotConnectedOrInvalid(t *testing.T) {
	h := newHarness(t)
	if err := h.run(t, "rename", "laptop"); !errors.Is(err, errNotConnected) {
		t.Fatalf("rename while not connected: %v", err)
	}
	h.connect(t)
	for _, args := range [][]string{{"rename"}, {"rename", ""}, {"rename", strings.Repeat("a", 81)}, {"rename", "a", "b"}} {
		if err := h.run(t, args...); !errors.Is(err, errUsage) {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

func TestAPIAgents_MergesPresenceIntoTheStatusShape(t *testing.T) {
	h := newHarness(t)
	mustMkdir(t, filepath.Join(h.home, ".claude"))
	api := h.api(t)
	status, body := api.call(t, "GET", "/v1/agents", "")
	var agents []map[string]any
	if status != 200 || json.Unmarshal(body, &agents) != nil || len(agents) != 3 {
		t.Fatalf("agents: %d %s", status, body)
	}
	for _, entry := range agents {
		if entry["presence"] == nil || entry["integration"] == nil {
			t.Fatalf("each agent needs presence and integration: %v", entry)
		}
	}
}

func TestAPIInstallAgent_AnswersThatAgentsStatus(t *testing.T) {
	h := newHarness(t)
	api := h.api(t)
	status, body := api.call(t, "POST", "/v1/agents/claude_code/install", "")
	var entry map[string]any
	if status != 200 || json.Unmarshal(body, &entry) != nil || entry["id"] != "claude_code" || !strings.Contains(string(body), `"installed"`) {
		t.Fatalf("install: %d %s", status, body)
	}
	if _, err := os.Stat(filepath.Join(h.home, ".claude", "settings.json")); err != nil {
		t.Fatal("install did not write the agent settings")
	}
	status, body = api.call(t, "POST", "/v1/agents/cursor/install", "")
	if status != http.StatusNotFound || envelopeCode(t, body) != "unknown_agent" {
		t.Fatalf("unknown agent: %d %s", status, body)
	}
}

func TestAPIDisconnect_AnswersLikeTheCLI(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	api := h.api(t)
	status, body := api.call(t, "POST", "/v1/disconnect", "")
	if status != 200 || string(bytes.TrimSpace(body)) != `{"connected":false,"server_revoked":true}` {
		t.Fatalf("disconnect: %d %s", status, body)
	}
	status, body = api.call(t, "GET", "/v1/boards", "")
	if status != http.StatusConflict || envelopeCode(t, body) != "not_connected" {
		t.Fatalf("proxy after disconnect: %d %s", status, body)
	}
}

func TestAPIErrors_AreLocalizedByAcceptLanguage(t *testing.T) {
	h := newHarness(t)
	api := h.api(t)
	_, body := api.call(t, "GET", "/v1/boards", "", "Accept-Language", "es-AR,es;q=0.9")
	if !strings.Contains(string(body), "no está conectado") {
		t.Fatalf("message not localized: %s", body)
	}
}

func TestAPIPair_IsUnavailableUntilPairingShips(t *testing.T) {
	h := newHarness(t)
	api := h.api(t)
	status, body := api.call(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	if status != http.StatusNotImplemented || envelopeCode(t, body) != "invalid_request" {
		t.Fatalf("pair start: %d %s", status, body)
	}
}

func TestRefreshPolicy_CachesTheServerPolicy(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.server.Lock()
	h.server.Policy.Mappings = append(h.server.Policy.Mappings, policy.Mapping{ID: "m2", WorkspaceID: "w", RootPath: "/src/other", Enabled: true})
	h.server.Unlock()
	layout := store.Layout{Root: h.data}
	if err := h.app.refreshPolicyCache(context.Background(), layout); err != nil {
		t.Fatal(err)
	}
	cached, err := policy.Load(layout.Policy())
	if err != nil || len(cached.Policy.Mappings) != 2 {
		t.Fatalf("policy after refresh: %+v %v", cached.Policy.Mappings, err)
	}
}

func TestAPIDiagnostics_ContainNoPromptHomePathOrToken(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	const sentinel = "SENTINEL_PROMPT_7f3a"
	h.hook(t, hookPayload(h.repo, "UserPromptSubmit", `,"prompt":"`+sentinel+`"`))
	logs := filepath.Join(h.data, "logs")
	mustMkdir(t, logs)
	mustWrite(t, filepath.Join(logs, "companion.log"), "2026-09-28T10:00:00Z started in "+h.home+"/code/app with "+uplinktest.DeviceToken+" and "+uplinktest.APIKey+"\n")
	os.Chmod(filepath.Join(logs, "companion.log"), 0o600)
	api := h.api(t)
	status, body := api.call(t, "GET", "/v1/diagnostics", "")
	if status != 200 {
		t.Fatalf("diagnostics: %d %s", status, body)
	}
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	var all strings.Builder
	for _, file := range archive.File {
		names = append(names, file.Name)
		contents, _ := file.Open()
		data, _ := io.ReadAll(contents)
		all.Write(data)
	}
	text := all.String()
	for _, forbidden := range []string{sentinel, h.home, uplinktest.DeviceToken, uplinktest.APIKey} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("diagnostics contain %q", forbidden)
		}
	}
	for _, want := range []string{"status.json", "version.json", "logs/companion.log"} {
		if !strings.Contains(strings.Join(names, ","), want) {
			t.Fatalf("diagnostics lack %s: %v", want, names)
		}
	}
	if !strings.Contains(text, "~/code/app") {
		t.Fatalf("home must be shown as ~:\n%s", text)
	}
}

func TestDisconnect_KeepsTheControlSocketAndDiscovery(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	for _, name := range []string{"control.sock", "control.json"} {
		mustWrite(t, filepath.Join(h.data, name), "x")
	}
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"control.sock", "control.json"} {
		if _, err := os.Stat(filepath.Join(h.data, name)); err != nil {
			t.Fatalf("disconnect removed the running daemon's %s", name)
		}
	}
}

// shortDataDir keeps the socket path under the Unix limit of about 104 bytes.
func shortDataDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "bpd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	resolved, _ := filepath.EvalSymlinks(dir)
	return resolved
}

func socketHTTPClient(dataDir string) *http.Client {
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return control.Dial(ctx, dataDir) },
	}}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s never appeared", path)
}

func TestRun_ServesTheControlAPIBeforeAConnection(t *testing.T) {
	h := newHarness(t)
	data := shortDataDir(t)
	h.env[store.EnvHome] = data
	h.app.connectPollInterval = 20 * time.Millisecond
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	h.env[envAllowInsecureLoopback] = "1"
	cancel, done := h.runDaemonAsync(t, "--log", filepath.Join(h.root, "companion.log"))
	waitForFile(t, filepath.Join(data, "control.json"))
	reply, err := socketHTTPClient(data).Get("http://companion/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Connected     bool `json:"connected"`
		DaemonRunning bool `json:"daemon_running"`
	}
	json.NewDecoder(reply.Body).Decode(&status)
	reply.Body.Close()
	if reply.StatusCode != 200 || status.Connected || !status.DaemonRunning {
		t.Fatalf("status before connecting: %d %+v", reply.StatusCode, status)
	}
	reply, err = socketHTTPClient(data).Post("http://companion/v1/pair/start", "application/json", strings.NewReader(`{"endpoint":"`+h.server.URL+`"}`))
	if err != nil || reply.StatusCode != http.StatusOK {
		t.Fatalf("pairing must work before a connection: %v %v", reply, err)
	}
	reply.Body.Close()
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"control.sock", "control.json"} {
		if _, err := os.Lstat(filepath.Join(data, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s left after the daemon exited", name)
		}
	}
}

func TestRun_ReplacesAStaleControlSocket(t *testing.T) {
	h := newHarness(t)
	data := shortDataDir(t)
	h.env[store.EnvHome] = data
	h.app.connectPollInterval = 20 * time.Millisecond
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	store.Open(data)
	stale, err := net.Listen("unix", filepath.Join(data, "control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()
	cancel, done := h.runDaemonAsync(t, "--log", filepath.Join(h.root, "companion.log"))
	waitForFile(t, filepath.Join(data, "control.json"))
	reply, err := socketHTTPClient(data).Get("http://companion/v1/version")
	if err != nil || reply.StatusCode != 200 {
		t.Fatalf("version after replacing a stale socket: %v %v", reply, err)
	}
	reply.Body.Close()
	cancel()
	<-done
}

func TestRun_LeavesTheSocketAloneWithoutTheDaemonLock(t *testing.T) {
	h := newHarness(t)
	data := shortDataDir(t)
	h.env[store.EnvHome] = data
	layout, _ := store.Open(data)
	lock, acquired, err := store.TryLock(layout.DaemonLock())
	if err != nil || !acquired {
		t.Fatal("could not take the daemon lock")
	}
	defer lock.Unlock()
	stale, _ := net.Listen("unix", filepath.Join(data, "control.sock"))
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()
	if err := h.run(t, "run"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(data, "control.sock")); err != nil {
		t.Fatal("a daemon without the lock removed the socket")
	}
	if _, err := os.Lstat(filepath.Join(data, "control.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a daemon without the lock wrote discovery")
	}
}

// The API's disconnect runs inside the daemon whose capture session it ends:
// it must wait that session out, not deadlock on it.
func TestRun_APIDisconnectEndsTheDaemonsOwnSession(t *testing.T) {
	h := newHarness(t)
	data := shortDataDir(t)
	h.env[store.EnvHome] = data
	h.app.connectPollInterval = 20 * time.Millisecond
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	h.connect(t)
	logPath := filepath.Join(h.root, "companion.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	defer func() {
		cancel()
		<-done
	}()
	waitForLog(t, logPath, "started")
	client := socketHTTPClient(data)
	reply, err := client.Post("http://companion/v1/disconnect", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(reply.Body)
	reply.Body.Close()
	if reply.StatusCode != 200 || string(bytes.TrimSpace(body)) != `{"connected":false,"server_revoked":true}` {
		t.Fatalf("disconnect through the daemon: %d %s", reply.StatusCode, body)
	}
	waitForLog(t, logPath, "disconnected")
	reply, err = client.Get("http://companion/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Connected bool `json:"connected"`
	}
	json.NewDecoder(reply.Body).Decode(&status)
	reply.Body.Close()
	if status.Connected {
		t.Fatal("status still connected after the API disconnect")
	}
}
