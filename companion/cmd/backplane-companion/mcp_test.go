// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agentaccess"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

const agentKeyFixture = "vlr_fixture_secret_key_do_not_leak_0001"

const mcpInitialize = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}` + "\n"

func (h *harness) runMCP(t *testing.T, args ...string) (stdout, stderr string) {
	t.Helper()
	h.stdout.Reset()
	errOut := &bytes.Buffer{}
	h.app.stderr = errOut
	h.app.stdin = strings.NewReader(mcpInitialize)
	if err := h.run(t, append([]string{"mcp"}, args...)...); err != nil {
		t.Fatalf("mcp: %v (stderr %q)", err, errOut.String())
	}
	return h.stdout.String(), errOut.String()
}

func (h *harness) grantAgentAccess(t *testing.T) {
	t.Helper()
	layout := store.Layout{Root: h.data}
	file := agentaccess.File{
		Endpoint: h.server.URL,
		Mappings: map[string]agentaccess.MappingAccess{"m1": {Enabled: true, Root: h.repo, WorkspaceSlug: "acme", WorkspaceName: "Acme", BoardID: "4ad6b3a4-3c3d-49e2-ae2a-2a6cddc53480", BoardName: "App"}},
	}
	if err := agentaccess.Save(layout, file); err != nil {
		t.Fatal(err)
	}
	if err := h.app.keyring.Save(credentials.AgentKeyAccount(installationID(t, h)), agentKeyFixture); err != nil {
		t.Fatal(err)
	}
}

func TestMCPCommand_NotConnectedServesStub(t *testing.T) {
	h := newHarness(t)
	stdout, _ := h.runMCP(t)
	if !strings.Contains(stdout, "not connected") || !strings.Contains(stdout, `"tools":{}`) {
		t.Fatalf("stub answer %s", stdout)
	}
	if _, err := os.Stat(h.data); err == nil {
		t.Fatal("the launcher created the data directory")
	}
}

func TestMCPCommand_RevokedDeviceServesStub(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.grantAgentAccess(t)
	layout := store.Layout{Root: h.data}
	store.WriteJSON(layout.Admission(), state.Admission{Unauthorized: true, Since: time.Now(), InstallationID: installationID(t, h)})
	t.Chdir(h.repo)
	if stdout, _ := h.runMCP(t); !strings.Contains(stdout, "not connected") {
		t.Fatalf("a revoked device must serve the stub: %s", stdout)
	}
}

func TestMCPCommand_UnboundFolderServesStub(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.grantAgentAccess(t)
	t.Chdir(h.home)
	if stdout, _ := h.runMCP(t); !strings.Contains(stdout, "not set up for this folder") {
		t.Fatalf("stub answer %s", stdout)
	}
}

func TestMCPCommand_RunsServerWithKeyFromKeychainOnlyInEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fake")
	}
	h := newHarness(t)
	h.connect(t)
	h.grantAgentAccess(t)
	bin := filepath.Join(h.root, "uvbin")
	out := filepath.Join(h.root, "uvout")
	mustMkdir(t, bin)
	mustMkdir(t, out)
	mustWrite(t, filepath.Join(bin, "uvx"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAKE_OUT/argv\"\nenv > \"$FAKE_OUT/env\"\nexec cat\n")
	os.Chmod(filepath.Join(bin, "uvx"), 0o755)
	h.env["PATH"] = bin
	t.Setenv("FAKE_OUT", out)
	t.Chdir(h.home)
	stdout, stderr := h.runMCP(t, "--mapping", "m1")
	if stdout != mcpInitialize {
		t.Fatalf("proxied output %q", stdout)
	}
	env, _ := os.ReadFile(filepath.Join(out, "env"))
	if !strings.Contains(string(env), "VALARIS_API_KEY="+agentKeyFixture+"\n") || !strings.Contains(string(env), "VALARIS_API_URL="+h.server.URL+"\n") || !strings.Contains(string(env), "VALARIS_DEFAULT_BOARD_ID=4ad6b3a4-3c3d-49e2-ae2a-2a6cddc53480\n") {
		t.Fatalf("child env lacks the board or key")
	}
	argv, _ := os.ReadFile(filepath.Join(out, "argv"))
	for name, text := range map[string]string{"argv": string(argv), "stdout": stdout, "stderr": stderr} {
		if strings.Contains(text, agentKeyFixture) {
			t.Errorf("the key leaked into %s", name)
		}
	}
	for _, file := range h.files(t) {
		data, _ := os.ReadFile(filepath.Join(h.data, file))
		if strings.Contains(string(data), agentKeyFixture) {
			t.Errorf("the key was written to %s", file)
		}
	}
}

func (h *harness) launchedAPIURL(t *testing.T) string {
	t.Helper()
	apiURL, _ := h.launchThroughFakeUvx(t)
	return apiURL
}

// launchThroughFakeUvx runs one MCP launch through a fake uvx and returns
// the VALARIS_API_URL backplane-mcp was started with and the launcher's stderr.
func (h *harness) launchThroughFakeUvx(t *testing.T) (apiURL, stderr string) {
	t.Helper()
	bin := filepath.Join(h.root, "uvbin")
	out := filepath.Join(h.root, "uvout")
	mustMkdir(t, bin)
	mustMkdir(t, out)
	mustWrite(t, filepath.Join(bin, "uvx"), "#!/bin/sh\nenv > \"$FAKE_OUT/env\"\nexec cat\n")
	os.Chmod(filepath.Join(bin, "uvx"), 0o755)
	h.env["PATH"] = bin
	t.Setenv("FAKE_OUT", out)
	t.Chdir(h.home)
	_, stderr = h.runMCP(t, "--mapping", "m1")
	env, _ := os.ReadFile(filepath.Join(out, "env"))
	for _, line := range strings.Split(string(env), "\n") {
		if value, ok := strings.CutPrefix(line, "VALARIS_API_URL="); ok {
			return value, stderr
		}
	}
	t.Fatal("backplane-mcp started without VALARIS_API_URL")
	return "", ""
}

func TestMCPCommand_AgentsCallTheAPIBaseTheServerAdvertises(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fake")
	}
	h := newHarness(t)
	h.server.Policy.APIBaseURL = "https://api.example.test/"
	h.connect(t)
	h.grantAgentAccess(t)
	if got := h.launchedAPIURL(t); got != "https://api.example.test" {
		t.Fatalf("VALARIS_API_URL = %q", got)
	}
}

func TestMCPCommand_EachLaunchReadsTheLatestRefreshedAPIBase(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fake")
	}
	h := newHarness(t)
	h.server.Policy.APIBaseURL = "https://api.example.test"
	h.connect(t)
	h.grantAgentAccess(t)
	h.launchedAPIURL(t)
	layout := store.Layout{Root: h.data}
	cached, err := policy.Load(layout.Policy())
	if err != nil {
		t.Fatal(err)
	}
	cached.Policy.APIBaseURL = "https://moved.example.test"
	if err := policy.Save(layout.Policy(), cached); err != nil {
		t.Fatal(err)
	}
	if got := h.launchedAPIURL(t); got != "https://moved.example.test" {
		t.Fatalf("a launch after the refresh used %q", got)
	}
}

func TestMCPCommand_FallsBackToTheEndpointWithoutAUsableAPIBase(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fake")
	}
	for name, c := range map[string]struct{ advertised, logged string }{
		"older backend": {"", "api_base_absent"},
		"plain http":    {"http://api.example.test", "api_base_rejected"},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.server.Policy.APIBaseURL = c.advertised
			h.connect(t)
			h.grantAgentAccess(t)
			got, stderr := h.launchThroughFakeUvx(t)
			if got != h.server.URL {
				t.Fatalf("VALARIS_API_URL = %q, want the endpoint", got)
			}
			if strings.Count(stderr, c.logged) != 1 || strings.Contains(stderr, "api.example.test") {
				t.Fatalf("the fallback must be logged once, as a code: %q", stderr)
			}
		})
	}
}

func TestMCPCommand_AnAdvertisedAPIBaseIsNotLogged(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fake")
	}
	h := newHarness(t)
	h.server.Policy.APIBaseURL = "https://api.example.test"
	h.connect(t)
	h.grantAgentAccess(t)
	if _, stderr := h.launchThroughFakeUvx(t); strings.Contains(stderr, "api_base") {
		t.Fatalf("stderr %q", stderr)
	}
}

// A policy cached for another installation (a refresh that landed after a
// re-pair) must never steer this installation's agent key to that server.
func TestMCPCommand_IgnoresAnAPIBaseCachedForAnotherInstallation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fake")
	}
	h := newHarness(t)
	h.server.Policy.APIBaseURL = "https://api.example.test"
	h.connect(t)
	h.grantAgentAccess(t)
	layout := store.Layout{Root: h.data}
	cached, err := policy.Load(layout.Policy())
	if err != nil {
		t.Fatal(err)
	}
	cached.Policy.Installation.ID = "previous-installation"
	cached.Policy.APIBaseURL = "https://previous-server.example.test"
	if err := policy.Save(layout.Policy(), cached); err != nil {
		t.Fatal(err)
	}
	if got := h.launchedAPIURL(t); got != h.server.URL {
		t.Fatalf("VALARIS_API_URL = %q, want the paired endpoint", got)
	}
}

func TestCachePolicy_RefusesAPolicyForAnotherInstallation(t *testing.T) {
	h := newHarness(t)
	h.server.Policy.APIBaseURL = "https://api.example.test"
	h.connect(t)
	layout := store.Layout{Root: h.data}
	before, err := os.ReadFile(layout.Policy())
	if err != nil {
		t.Fatal(err)
	}
	// A re-pair landed while this refresh's request was in flight: the
	// server still answers for the installation the request was made as.
	repaired, _ := state.Load[state.Installation](layout.Installation())
	repaired.ID = "repaired-installation"
	if err := store.WriteJSON(layout.Installation(), repaired); err != nil {
		t.Fatal(err)
	}
	client, err := uplink.New(uplink.Options{Endpoint: h.server.URL, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	device, err := client.WithDeviceToken(uplinktest.DeviceToken)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.app.cachePolicy(context.Background(), layout, device); err == nil {
		t.Fatal("a policy for another installation was accepted")
	}
	if after, _ := os.ReadFile(layout.Policy()); string(after) != string(before) {
		t.Fatal("a policy for another installation replaced the cache")
	}
}

func TestStatus_ReportsWhichAPIAgentsCall(t *testing.T) {
	cases := map[string]struct{ advertised, source string }{
		"advertised":    {"https://api.example.test", "advertised"},
		"older backend": {"", "absent"},
		"plain http":    {"http://api.example.test", "rejected"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.server.Policy.APIBaseURL = c.advertised
			h.connect(t)
			h.stdout.Reset()
			if err := h.run(t, "status"); err != nil {
				t.Fatal(err)
			}
			var report struct {
				AgentAPI struct {
					URL    string `json:"url"`
					Source string `json:"source"`
				} `json:"agent_api"`
			}
			if err := json.Unmarshal(h.stdout.Bytes(), &report); err != nil {
				t.Fatal(err)
			}
			want := h.server.URL
			if c.source == "advertised" {
				want = c.advertised
			}
			if report.AgentAPI.URL != want || report.AgentAPI.Source != c.source {
				t.Fatalf("agent_api %+v, want %s (%s)", report.AgentAPI, want, c.source)
			}
		})
	}
}

func TestMCPCommand_FallsBackToTheEndpointWithoutACachedPolicy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fake")
	}
	h := newHarness(t)
	h.server.Policy.APIBaseURL = "https://api.example.test"
	h.connect(t)
	h.grantAgentAccess(t)
	if err := os.Remove(store.Layout{Root: h.data}.Policy()); err != nil {
		t.Fatal(err)
	}
	if got := h.launchedAPIURL(t); got != h.server.URL {
		t.Fatalf("VALARIS_API_URL = %q, want the endpoint", got)
	}
}

func TestMCPCommand_CorruptAgentAccessStateServesTheUnreadableStub(t *testing.T) {
	for name, content := range map[string]string{"corrupt": `{"version":1,"mappings":`, "oversized": `{"version":1,"x":"` + strings.Repeat("x", 2<<20) + `"}`} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.connect(t)
			mustWrite(t, agentaccess.Path(store.Layout{Root: h.data}), content)
			os.Chmod(agentaccess.Path(store.Layout{Root: h.data}), 0o600)
			t.Chdir(h.repo)
			stdout, stderr := h.runMCP(t)
			if !strings.Contains(stdout, "unreadable") || strings.Contains(stdout, "not connected") {
				t.Fatalf("stub %s", stdout)
			}
			if strings.Contains(stderr, h.data) || !strings.Contains(stderr, "agent_access_state_unreadable") {
				t.Fatalf("stderr %q", stderr)
			}
		})
	}
}
