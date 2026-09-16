// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// The defect (card d3857c4c, third recurrence): doctor passed with a DEAD
// agent key. checkMCPConfig only judges the file's shape, and checkBackend
// authenticates with the RUNNER's credentials — the key inside mcp-config,
// the one actually handed to the coding agent, was never sent anywhere.
// Loop #6 iteration 1 burned a paid run and exited blocked_on_human on a
// rotated-stale agent key that a green doctor had just blessed.
//
// These tests pin the missing checks:
//  1. a REST probe with the mcp-config's own key against the mcp-config's
//     own URL, reported as its own row, distinct from "backend";
//  2. drift between the resolved mcp-config and the copy sitting beside the
//     runner config (profiles keep both, and they rot apart silently);
//  3. a WARN when the config launches the MCP server `--from` a live git
//     working tree (the uvx stale-build trap — a snapshot cannot drift).

// runnerOwnKey and agentConfigKey are deliberately DISTINCT: the runner's own
// credentials and the agent key inside mcp-config are two identities, and a
// probe that carries the wrong one has reintroduced the blind spot wholesale.
const (
	runnerOwnKey   = "vlr_runner_own_key"
	agentConfigKey = "vlr_agent_config_key"
)

// recordingBackend is a fake platform that answers every authenticated GET
// and remembers each Authorization header it saw, so a test can prove WHICH
// key a probe carried — not just that some request happened.
type recordingBackend struct {
	mu    sync.Mutex
	auths []string
	// reject, when non-empty, is the bearer token the backend refuses with 403.
	reject string
}

func (b *recordingBackend) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		b.auths = append(b.auths, r.Header.Get("Authorization"))
		b.mu.Unlock()
		if b.reject != "" && r.Header.Get("Authorization") == "Bearer "+b.reject {
			http.Error(w, `{"detail":"invalid API key"}`, http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"u-agent","email":"agent@valaris.dev"}`)
	})
}

func (b *recordingBackend) seen() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.auths...)
}

// writeMCPConfigFile writes a resolved (non-template) mcp-config with the
// hard-required "valaris" server key — the exact file the runner hands to the
// coding agent by path.
func writeMCPConfigFile(t *testing.T, path string, server map[string]any) string {
	t.Helper()
	data, err := json.Marshal(map[string]any{"mcpServers": map[string]any{"valaris": server}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// agentServerEntry builds a valaris server block whose env carries the
// AGENT's key and URL, mirroring what the wizard's MarshalMCPConfig writes.
func agentServerEntry(apiKey, apiURL string, args ...string) map[string]any {
	if len(args) == 0 {
		args = []string{"backplane-mcp"}
	}
	return map[string]any{
		"command": "uvx",
		"args":    args,
		"env":     map[string]string{"VALARIS_API_KEY": apiKey, "VALARIS_API_URL": apiURL},
	}
}

// mcpProbeDeps is a machine that passes every PRE-EXISTING check, so the only
// signal in these tests is the new agent-key/drift/--from rows. The runner's
// own API URL is a dead host on purpose: any probe that resolves the backend
// from the runner's credentials instead of the mcp-config cannot go green.
func mcpProbeDeps(t *testing.T, mcpConfigPath string) doctorDeps {
	t.Helper()
	return doctorDeps{
		LookPath: fakeLookPath("claude", "codex", "git", "gh"),
		Run:      func(string, ...string) ([]byte, error) { return []byte("git version 2.44.0"), nil },
		Creds: Credentials{
			APIKey: runnerOwnKey, APIKeySource: credSourceEnv,
			APIURL: "http://runner-own-backend.invalid", APIURLSource: credSourceEnv,
			Workspace: "valaris", WorkspaceSource: credSourceEnv,
			MCPConfigPath: mcpConfigPath,
		},
		BaseDir:  filepath.Join(t.TempDir(), "repos"),
		Identity: backendIdentity{UserID: "u1", AgentName: "runner-1", IsAgent: true, IsActive: true},
	}
}

// agentKeyCheck finds the row that judges the mcp-config's OWN key. The label
// must make "agent … key" legible on its own — folding the verdict into
// "backend" or "mcp config" is exactly how the stale key stayed invisible
// through three recurrences.
func agentKeyCheck(t *testing.T, results []checkResult) checkResult {
	t.Helper()
	for _, r := range results {
		label := strings.ToLower(r.Label)
		if strings.Contains(label, "agent") && strings.Contains(label, "key") {
			return r
		}
	}
	t.Fatalf("no check row judges the agent's MCP key — labels: %v", checkLabels(results))
	return checkResult{}
}

func checkLabels(results []checkResult) []string {
	labels := make([]string, 0, len(results))
	for _, r := range results {
		labels = append(labels, r.Label)
	}
	return labels
}

// ------------------------------------------------- agent-key REST probe --

// A 403 for the agent's key must FAIL and name the file carrying it, while
// the runner's own "backend" row stays OK — telling the two identities apart
// is the entire point of the row.
func TestRunChecks_AgentMCPKeyRejectedFailsNamingTheConfigFile(t *testing.T) {
	backend := &recordingBackend{reject: agentConfigKey}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	path := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		agentServerEntry(agentConfigKey, srv.URL))

	results := runChecks(mcpProbeDeps(t, path))

	row := agentKeyCheck(t, results)
	if row.State != tui.StateFail {
		t.Fatalf("a rejected agent key must FAIL, got %v (%s)", row.State, row.Detail)
	}
	if !strings.Contains(row.Detail, path) {
		t.Errorf("detail must name the mcp-config carrying the dead key: %q", row.Detail)
	}
	if row.Fix == "" {
		t.Error("a failing agent-key check must carry a fix hint")
	}
	if backendRow := detailFor(t, results, "backend"); backendRow.State != tui.StateOK {
		t.Errorf("the runner's own backend row must stay OK — the agent key is the broken identity: %v (%s)",
			backendRow.State, backendRow.Detail)
	}
}

func TestRunChecks_AgentMCPKeyAcceptedPasses(t *testing.T) {
	backend := &recordingBackend{}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	path := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		agentServerEntry(agentConfigKey, srv.URL))

	results := runChecks(mcpProbeDeps(t, path))

	row := agentKeyCheck(t, results)
	if row.State != tui.StateOK {
		t.Fatalf("an accepted agent key must be OK, got %v (%s)", row.State, row.Detail)
	}
	// A verdict with no request behind it is the original false green.
	if len(backend.seen()) == 0 {
		t.Fatal("the check went green without ever probing the backend named in the mcp-config")
	}
}

// A config with no VALARIS_API_KEY has nothing to hand the coding agent —
// that is a FAIL in its own right, never a silent skip.
func TestRunChecks_AgentMCPKeyMissingFromConfigFailsLoudly(t *testing.T) {
	path := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		map[string]any{"command": "uvx", "args": []string{"backplane-mcp"}})

	results := runChecks(mcpProbeDeps(t, path))

	row := agentKeyCheck(t, results)
	if row.State != tui.StateFail {
		t.Fatalf("a key-less mcp-config must FAIL, got %v (%s)", row.State, row.Detail)
	}
	if !strings.Contains(row.Detail+row.Fix, "VALARIS_API_KEY") {
		t.Errorf("the row should name the missing env var: %q / %q", row.Detail, row.Fix)
	}
}

// The probe must authenticate as the CODING AGENT — with the key from the
// mcp-config env block — never with the runner's own credentials. Probing
// with runner creds would pass on every machine where the stale-key defect
// is present.
func TestRunChecks_AgentKeyProbeCarriesTheConfigKeyNotRunnerCreds(t *testing.T) {
	backend := &recordingBackend{}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	path := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		agentServerEntry(agentConfigKey, srv.URL))

	runChecks(mcpProbeDeps(t, path))

	auths := backend.seen()
	if len(auths) == 0 {
		t.Fatal("no probe reached the backend named in the mcp-config — the agent key was never verified")
	}
	for _, auth := range auths {
		if auth == "Bearer "+runnerOwnKey {
			t.Fatalf("the probe authenticated with the RUNNER's key, not the agent's: %q", auth)
		}
		if auth != "Bearer "+agentConfigKey {
			t.Errorf("probe carried an unexpected identity: %q", auth)
		}
	}
}

// ------------------------------------------------------ config-copy drift --

// Profiles keep TWO copies of the mcp-config: the yaml-target file the run
// actually uses (llm.mcp_config_path) and a copy beside the profile's
// runner.yaml. A save refreshes one and not the other, and the operator edits
// whichever they find first — when the two disagree doctor must say so,
// naming BOTH paths, so "which file is live?" stops being archaeology.
func TestRunChecks_MCPConfigCopyDriftFailsNamingBothPaths(t *testing.T) {
	backend := &recordingBackend{}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	profileDir := t.TempDir()
	configPath := filepath.Join(profileDir, "runner.yaml")
	if err := os.WriteFile(configPath, []byte("llm:\n  provider: claude\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	profileCopy := writeMCPConfigFile(t, filepath.Join(profileDir, "mcp-config.json"),
		agentServerEntry("vlr_agent_key_ROTATED", srv.URL))
	target := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		agentServerEntry(agentConfigKey, srv.URL))

	deps := mcpProbeDeps(t, target)
	deps.Creds.ConfigPath = configPath

	results := runChecks(deps)

	var drift checkResult
	found := false
	for _, r := range results {
		if r.State == tui.StateFail && strings.Contains(r.Detail, profileCopy) && strings.Contains(r.Detail, target) {
			drift, found = r, true
		}
	}
	if !found {
		t.Fatalf("differing mcp-config copies produced no failure naming both %s and %s — rows: %+v",
			target, profileCopy, results)
	}
	if drift.Fix == "" {
		t.Error("a drift failure must say how to reconcile the copies")
	}
}

// Identical copies are the healthy state a profile save leaves behind — they
// must produce no drift finding at all.
func TestRunChecks_MCPConfigIdenticalCopiesProduceNoDriftFinding(t *testing.T) {
	backend := &recordingBackend{}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	entry := agentServerEntry(agentConfigKey, srv.URL)
	profileDir := t.TempDir()
	configPath := filepath.Join(profileDir, "runner.yaml")
	if err := os.WriteFile(configPath, []byte("llm:\n  provider: claude\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	profileCopy := writeMCPConfigFile(t, filepath.Join(profileDir, "mcp-config.json"), entry)
	target := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"), entry)

	deps := mcpProbeDeps(t, target)
	deps.Creds.ConfigPath = configPath

	results := runChecks(deps)

	for _, r := range results {
		if r.State != tui.StateOK && strings.Contains(r.Detail, profileCopy) && strings.Contains(r.Detail, target) {
			t.Errorf("identical copies flagged as drift: %q — %s", r.Label, r.Detail)
		}
	}
}

// --------------------------------------------- working-tree --from launch --

// `uvx --from <checkout>` against a LIVE working tree serves whatever state
// the tree is in mid-edit — and uvx caches a stale wheel besides (Loop #6's
// stop-the-line). Doctor must WARN and steer at a git-archive snapshot. A
// warning, not a failure: the setup does run, it just rots.
func TestRunChecks_WorkingTreeFromPathWarnsWithoutFlippingTheVerdict(t *testing.T) {
	backend := &recordingBackend{}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	// An empty .git DIRECTORY is all an ancestor walk needs. Never a real
	// repo: live git inside a doctor fixture is the hazard this whole suite
	// exists to prevent.
	checkout := filepath.Join(t.TempDir(), "backplane-checkout")
	if err := os.MkdirAll(filepath.Join(checkout, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	mcpServerDir := filepath.Join(checkout, "mcp-server")
	if err := os.MkdirAll(mcpServerDir, 0o700); err != nil {
		t.Fatal(err)
	}

	path := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		agentServerEntry(agentConfigKey, srv.URL, "--from", mcpServerDir, "backplane-mcp"))

	results := runChecks(mcpProbeDeps(t, path))

	var warn checkResult
	found := false
	for _, r := range results {
		if r.State == tui.StateWarn && strings.Contains(r.Detail+r.Fix, mcpServerDir) {
			warn, found = r, true
		}
	}
	if !found {
		t.Fatalf("a --from inside a git working tree produced no warning naming %s — rows: %+v",
			mcpServerDir, results)
	}
	low := strings.ToLower(warn.Detail + warn.Fix)
	if !strings.Contains(low, "archive") && !strings.Contains(low, "snapshot") {
		t.Errorf("the warning should recommend a snapshot (git archive): %q / %q", warn.Detail, warn.Fix)
	}
	if code := doctorExitCode(results); code != 0 {
		t.Errorf("the working-tree warning alone must not flip the verdict, exit = %d", code)
	}
}

// A --from pointing at a plain directory — a snapshot, exactly what the
// warning recommends — must not warn.
func TestRunChecks_PlainDirFromPathDoesNotWarn(t *testing.T) {
	backend := &recordingBackend{}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	snapshotDir := filepath.Join(t.TempDir(), "backplane-snapshot", "mcp-server")
	if err := os.MkdirAll(snapshotDir, 0o700); err != nil {
		t.Fatal(err)
	}

	path := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		agentServerEntry(agentConfigKey, srv.URL, "--from", snapshotDir, "backplane-mcp"))

	results := runChecks(mcpProbeDeps(t, path))

	for _, r := range results {
		if r.State == tui.StateWarn && strings.Contains(r.Detail+r.Fix, snapshotDir) {
			t.Errorf("a --from outside any working tree must not warn: %q — %s", r.Label, r.Detail)
		}
	}
}

// ---------------------------------------------- drift with env-only creds --

// The documented setup exports VALARIS_API_KEY/VALARIS_WORKSPACE and names
// the config with -config. Credential DISCOVERY then never attributes a file
// — resolveCredentials sets ConfigPath only when a yaml supplied a credential
// — so the drift check loses the one path it keys off and two genuinely
// differing mcp-configs produce NO finding. The operator's -config yaml is
// known the whole time; doctor must carry it to the checks regardless of
// where the credentials came from.
func TestDoctorCredentials_EnvCredsStillSurfaceMCPConfigCopyDrift(t *testing.T) {
	backend := &recordingBackend{}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	t.Setenv("VALARIS_API_KEY", runnerOwnKey)
	t.Setenv("VALARIS_WORKSPACE", "valaris")
	t.Setenv("VALARIS_API_URL", "http://runner-own-backend.invalid")
	// Keep discovery away from any real config on the machine running this.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	target := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		agentServerEntry(agentConfigKey, srv.URL))

	yamlDir := t.TempDir()
	yamlPath := filepath.Join(yamlDir, "runner.yaml")
	yaml := fmt.Sprintf("llm:\n  mcp_config_path: %q\ngit:\n  base_dir: %q\n",
		target, filepath.Join(t.TempDir(), "repos"))
	if err := os.WriteFile(yamlPath, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	profileCopy := writeMCPConfigFile(t, filepath.Join(yamlDir, "mcp-config.json"),
		agentServerEntry("vlr_agent_key_ROTATED", srv.URL))

	cfg := doctorConfigForReport(yamlPath)
	if cfg == nil {
		t.Fatal("the operator's yaml did not load — fixture bug, not the defect under test")
	}
	creds := doctorCredentials(cfg, yamlPath, t.TempDir(), t.TempDir())

	if creds.ConfigPath != yamlPath {
		t.Errorf("Creds.ConfigPath = %q, want the operator's -config yaml %q — env-supplied credentials must not cost doctor the config it was pointed at",
			creds.ConfigPath, yamlPath)
	}

	deps := mcpProbeDeps(t, creds.MCPConfigPath)
	deps.Creds = creds

	results := runChecks(deps)

	found := false
	for _, r := range results {
		if r.State == tui.StateFail && strings.Contains(r.Detail, profileCopy) && strings.Contains(r.Detail, target) {
			found = true
		}
	}
	if !found {
		t.Fatalf("with env creds and -config %s, differing mcp-config copies produced no failure naming both %s and %s — rows: %+v",
			yamlPath, target, profileCopy, results)
	}
}

// uvx accepts both `--from PATH` and `--from=PATH`; a warning that only
// understands the space form goes silent on the equals form of the exact same
// hazard.
func TestRunChecks_WorkingTreeFromEqualsFormWarnsToo(t *testing.T) {
	backend := &recordingBackend{}
	srv := httptest.NewServer(backend.handler())
	defer srv.Close()

	checkout := filepath.Join(t.TempDir(), "backplane-checkout")
	if err := os.MkdirAll(filepath.Join(checkout, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	mcpServerDir := filepath.Join(checkout, "mcp-server")
	if err := os.MkdirAll(mcpServerDir, 0o700); err != nil {
		t.Fatal(err)
	}

	path := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
		agentServerEntry(agentConfigKey, srv.URL, "--from="+mcpServerDir, "backplane-mcp"))

	results := runChecks(mcpProbeDeps(t, path))

	found := false
	for _, r := range results {
		if r.State == tui.StateWarn && strings.Contains(r.Detail+r.Fix, mcpServerDir) {
			found = true
		}
	}
	if !found {
		t.Fatalf("--from=%s (equals form) inside a git working tree produced no warning — rows: %+v",
			mcpServerDir, results)
	}
}

// A 3xx from the probe means the URL is fronted by a redirector — an SSO/IAP
// login, a proxy to somewhere else — so the platform never judged the key and
// OK here is the same false green with extra steps. CheckRedirect already
// stops the follow; the verdict must then treat the raw 3xx as a FAIL that
// points at VALARIS_API_URL, not the key.
func TestRunChecks_AgentKeyProbeRedirectFails(t *testing.T) {
	for _, status := range []int{http.StatusMovedPermanently, http.StatusFound, http.StatusTemporaryRedirect} {
		t.Run(fmt.Sprintf("%d", status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "https://sso.example.com/login")
				w.WriteHeader(status)
			}))
			defer srv.Close()

			path := writeMCPConfigFile(t, filepath.Join(t.TempDir(), "mcp-config.json"),
				agentServerEntry(agentConfigKey, srv.URL))

			row := agentKeyCheck(t, runChecks(mcpProbeDeps(t, path)))

			if row.State != tui.StateFail {
				t.Fatalf("HTTP %d to the agent-key probe must FAIL — the platform never judged the key, got %v (%s)",
					status, row.State, row.Detail)
			}
			low := strings.ToLower(row.Detail + row.Fix)
			if !strings.Contains(low, "redirect") && !strings.Contains(low, "valaris_api_url") {
				t.Errorf("the failure should say the URL answers with redirects, not the API: %q / %q", row.Detail, row.Fix)
			}
		})
	}
}
