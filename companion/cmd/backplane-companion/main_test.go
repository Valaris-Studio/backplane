// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/service"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

type harness struct {
	app        *app
	executable string
	env        map[string]string
	stdout     *bytes.Buffer
	server     *uplinktest.Server
	root       string
	home       string
	data       string
	repo       string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	keyring.MockInit()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	h := &harness{root: root, home: filepath.Join(root, "home"), data: filepath.Join(root, "data"), stdout: &bytes.Buffer{}, server: uplinktest.New(t)}
	h.repo = filepath.Join(h.home, "code", "app")
	mustMkdir(t, filepath.Join(h.repo, ".git"))
	mustWrite(t, filepath.Join(h.repo, ".git", "config"), "[remote \"origin\"]\n\turl = git@github.com:acme/app.git\n")
	mustMkdir(t, filepath.Join(root, "tmp"))
	executable := filepath.Join(root, "bin", "backplane-companion")
	mustMkdir(t, filepath.Dir(executable))
	mustWrite(t, executable, "#!/bin/sh\n")
	os.Chmod(executable, 0o755)
	h.env = map[string]string{store.EnvHome: h.data, envAPIKey: uplinktest.APIKey, "LANG": "en_US.UTF-8"}
	h.server.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: h.repo, Enabled: true, ContentLevel: "standard"}}
	h.executable = executable
	h.app = h.makeApp(func(key string) string { return h.env[key] }, h.stdout)
	return h
}

// makeApp builds an independent app over the same HOME, server and keyring,
// e.g. to run connect while another app runs the daemon.
func (h *harness) makeApp(getenv func(string) string, stdout *bytes.Buffer) *app {
	return &app{
		getenv:     getenv,
		stdin:      strings.NewReader(""),
		stdout:     stdout,
		stderr:     &bytes.Buffer{},
		home:       h.home,
		executable: h.executable,
		goos:       "testos",
		goarch:     "testarch",
		now:        time.Now,
		tempDirs:   []string{filepath.Join(h.root, "tmp")},
		keyring:    credentials.Keyring{},
		readSecret: func(string) (string, error) { return "", errAPIKeyMissing },
		registry:   agent.NewRegistry(claudecode.New(), pi.New(), codex.New()),
	}
}

func (h *harness) run(t *testing.T, args ...string) error {
	t.Helper()
	h.stdout.Reset()
	return h.app.run(context.Background(), args)
}

func (h *harness) connect(t *testing.T) {
	t.Helper()
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) hook(t *testing.T, input string) string {
	t.Helper()
	h.stdout.Reset()
	h.app.stdin = strings.NewReader(input)
	h.app.runHook([]string{"claude-code"})
	return strings.TrimSpace(h.stdout.String())
}

func (h *harness) files(t *testing.T) []string {
	t.Helper()
	var found []string
	filepath.WalkDir(h.data, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			found = append(found, strings.TrimPrefix(path, h.data))
		}
		return nil
	})
	sort.Strings(found)
	return found
}

func TestConnectStoresDeviceTokenOnlyInKeyring(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	var output struct {
		Connected      bool   `json:"connected"`
		InstallationID string `json:"installation_id"`
		PolicyCached   bool   `json:"policy_cached"`
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &output); err != nil || !output.Connected || !output.PolicyCached {
		t.Fatalf("connect output: %s %v", h.stdout, err)
	}
	registration := h.server.Registrations[0]
	if registration["installation_id"] != output.InstallationID || registration["platform"] != "testos/testarch" {
		t.Fatalf("registration body: %+v", registration)
	}
	if token, err := (credentials.Keyring{}).Load(output.InstallationID); err != nil || token != uplinktest.DeviceToken {
		t.Fatalf("device token not in keyring: %v", err)
	}
	for _, path := range h.files(t) {
		data, _ := os.ReadFile(filepath.Join(h.data, path))
		if bytes.Contains(data, []byte(uplinktest.DeviceToken)) || bytes.Contains(data, []byte(uplinktest.APIKey)) {
			t.Fatalf("credential persisted in %s", path)
		}
	}
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); !errors.Is(err, errAlreadyConnected) {
		t.Fatalf("second connect: %v", err)
	}
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	if _, err := (credentials.Keyring{}).Load(output.InstallationID); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatal("disconnect left the device token")
	}
	h.server.Lock()
	revocations := h.server.Revocations
	h.server.Unlock()
	if revocations != 1 {
		t.Fatalf("disconnect did not revoke the installation on the server: %d", revocations)
	}
	if _, err := os.Stat(filepath.Join(h.data, "policy.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("disconnect left the policy, so capture would continue")
	}
}

func TestDisconnectClearsLocalStateWhenServerIsUnreachable(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.hook(t, hookPayload(h.repo, "SessionStart", ""))
	h.server.Close()
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatalf("revocation is best effort: %v", err)
	}
	if !strings.Contains(h.stdout.String(), `"server_revoked": false`) {
		t.Fatalf("disconnect must report the failed revocation: %s", h.stdout)
	}
	for _, leftover := range []string{"installation.json", "policy.json"} {
		if _, err := os.Stat(filepath.Join(h.data, leftover)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s left behind", leftover)
		}
	}
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != 0 {
		t.Fatal("inbox not purged")
	}
}

func TestConnectRequiresAPIKeyAndHTTPS(t *testing.T) {
	h := newHarness(t)
	delete(h.env, envAPIKey)
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); !errors.Is(err, errAPIKeyMissing) {
		t.Fatalf("missing key: %v", err)
	}
	h.env[envAPIKey] = uplinktest.APIKey
	if err := h.run(t, "connect", "--endpoint", h.server.URL); !errors.Is(err, uplink.ErrInsecureEndpoint) {
		t.Fatalf("plain HTTP accepted without the loopback flag: %v", err)
	}
	h.env[envAPIKey] = "vlr_rejected_by_server"
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); !errors.Is(err, uplink.ErrUnauthorized) {
		t.Fatalf("rejected key: %v", err)
	}
	if _, err := os.Stat(filepath.Join(h.data, "installation.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed connect persisted an installation")
	}
}

func TestHookAlwaysAnswersEmptyObject(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	for _, input := range []string{`{"cwd":`, strings.Repeat("x", 2<<20), `{"session_id":"s","hook_event_name":"Nope"}`} {
		if output := h.hook(t, input); output != "{}" {
			t.Fatalf("hook answered %q", output)
		}
	}
	h.stdout.Reset()
	h.app.runHook([]string{"unknown-agent"})
	if strings.TrimSpace(h.stdout.String()) != "{}" {
		t.Fatal("unknown agent did not answer {}")
	}
	health, _ := state.Load[state.Health](filepath.Join(h.data, "health.json"))
	if health.HookErrors != 4 {
		t.Fatalf("hook errors not counted: %+v", health)
	}
}

func TestHookNeverExecutesBeacon(t *testing.T) {
	h := newHarness(t)
	marker := filepath.Join(h.root, "beacon-was-run")
	fakeBeacon := filepath.Join(h.root, "fake-beacon")
	mustWrite(t, fakeBeacon, "#!/bin/sh\ntouch "+marker+"\n")
	os.Chmod(fakeBeacon, 0o755)
	manifest := filepath.Join(h.root, "artifact.json")
	encoded, _ := json.Marshal(beacon.Manifest{Path: fakeBeacon, SHA256: strings.Repeat("0", 64), SourceCommit: beacon.Commit})
	mustWrite(t, manifest, string(encoded))
	h.env[envBeaconArtifact] = manifest
	h.connect(t)
	if output := h.hook(t, hookPayload(h.repo, "UserPromptSubmit", `,"prompt":"hi"`)); output != "{}" {
		t.Fatalf("hook answered %q", output)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("hook executed Beacon")
	}
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != 1 {
		t.Fatal("in-scope hook did not reach the inbox")
	}
}

func TestPauseResumeAndProjectsCommands(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	if err := h.run(t, "pause"); err != nil {
		t.Fatal(err)
	}
	h.hook(t, hookPayload(h.repo, "SessionStart", ""))
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != 0 {
		t.Fatal("captured while locally paused")
	}
	if err := h.run(t, "resume"); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(h.home, "code", "other")
	mustMkdir(t, filepath.Join(other, ".git"))
	mustWrite(t, filepath.Join(other, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/other.git\n")
	h.hook(t, hookPayload(other, "SessionStart", ""))
	if err := h.run(t, "projects", "list"); err != nil || !strings.Contains(h.stdout.String(), "github.com/acme/other") {
		t.Fatalf("discovered project not listed: %s %v", h.stdout, err)
	}
	if err := h.run(t, "projects", "map", other); !errors.Is(err, errNoMatchingBoard) {
		t.Fatalf("unmatched map: %v", err)
	}
	h.server.Lock()
	h.server.Resolvable["github.com/acme/other"] = policy.Mapping{ID: "m2", WorkspaceID: "w", Enabled: true}
	h.server.Unlock()
	if err := h.run(t, "projects", "map", other); err != nil {
		t.Fatal(err)
	}
	h.hook(t, hookPayload(other, "SessionStart", ""))
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != 1 {
		t.Fatal("mapped project not captured")
	}
	if err := h.run(t, "projects", "ignore", other); err != nil {
		t.Fatal(err)
	}
	h.hook(t, hookPayload(other, "Stop", ""))
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != 1 {
		t.Fatal("ignored project captured")
	}
	if err := h.run(t, "projects", "map", filepath.Join(h.home)); !errors.Is(err, errNotARepository) {
		t.Fatalf("non-repo map: %v", err)
	}
}

func TestAgentsCommandsInstallIntoUserSettings(t *testing.T) {
	h := newHarness(t)
	if err := h.run(t, "agents", "install", "claude-code"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(h.stdout.String(), `"state": "installed"`) {
		t.Fatalf("install report: %s", h.stdout)
	}
	settings, err := os.ReadFile(filepath.Join(h.home, ".claude", "settings.json"))
	if err != nil || !bytes.Contains(settings, []byte(h.app.executable)) {
		t.Fatalf("user-level settings not written: %v", err)
	}
	if err := h.run(t, "agents", "uninstall"); err != nil || !strings.Contains(h.stdout.String(), `"state": "not_installed"`) {
		t.Fatalf("uninstall: %s %v", h.stdout, err)
	}
	mustMkdir(t, filepath.Join(h.home, ".pi", "agent"))
	if err := h.run(t, "agents", "install", "pi"); err != nil || !strings.Contains(h.stdout.String(), `"state": "installed"`) {
		t.Fatalf("pi install: %s %v", h.stdout, err)
	}
	extension, err := os.ReadFile(filepath.Join(h.home, ".pi", "agent", "extensions", "backplane-companion.ts"))
	if err != nil || !strings.Contains(string(extension), h.app.executable) {
		t.Fatalf("Pi extension not written for this companion: %v", err)
	}
	if err := h.run(t, "agents", "install", "cursor"); !errors.Is(err, agent.ErrUnknownAgent) {
		t.Fatalf("unknown agent: %v", err)
	}
}

type statusView struct {
	Connected     bool            `json:"connected"`
	DaemonRunning bool            `json:"daemon_running"`
	Service       json.RawMessage `json:"service"`
	Capture       struct {
		State        string `json:"state"`
		PolicyCached bool   `json:"policy_cached"`
		PolicyStale  bool   `json:"policy_stale"`
	} `json:"capture"`
	Agents []struct {
		ID                string     `json:"id"`
		State             string     `json:"state"`
		Configured        bool       `json:"configured"`
		Receiving         bool       `json:"receiving"`
		Uploading         bool       `json:"uploading"`
		Paused            bool       `json:"paused"`
		Broken            bool       `json:"broken"`
		LastObservationAt *time.Time `json:"last_observation_at"`
		LastUploadAt      *time.Time `json:"last_upload_at"`
	} `json:"agents"`
	Queue struct {
		Records         int  `json:"records"`
		InboxItems      int  `json:"inbox_items"`
		CapacityRecords int  `json:"capacity_records"`
		BackingOff      bool `json:"backing_off"`
	} `json:"queue"`
	PendingProjects []struct {
		Root    string `json:"root"`
		RepoURL string `json:"repo_url"`
	} `json:"pending_projects"`
}

func (h *harness) status(t *testing.T) statusView {
	t.Helper()
	if err := h.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	var report statusView
	if err := json.Unmarshal(h.stdout.Bytes(), &report); err != nil {
		t.Fatalf("%v: %s", err, h.stdout)
	}
	return report
}

func TestStatusReportsAgentStatesQueueAndPendingProjects(t *testing.T) {
	h := newHarness(t)
	report := h.status(t)
	if report.Connected || report.Capture.State != "not_connected" || len(report.Agents) != 3 || report.Agents[1].ID != "codex_cli" || report.Agents[2].ID != "pi_cli" || !allNotInstalled(report) {
		t.Fatalf("fresh status: %s", h.stdout)
	}
	h.connect(t)
	if err := h.run(t, "agents", "install"); err != nil || strings.TrimSpace(h.stdout.String()) != "[]" {
		t.Fatalf("install without names must skip agents not present on this machine: %s %v", h.stdout, err)
	}
	if _, err := os.Stat(filepath.Join(h.home, ".pi")); !os.IsNotExist(err) {
		t.Fatal("created ~/.pi for an agent that is not installed")
	}
	if err := h.run(t, "agents", "install", "claude-code"); err != nil {
		t.Fatal(err)
	}
	report = h.status(t)
	if report.Capture.State != "active" || !report.Agents[0].Configured || report.Agents[0].State != "idle" {
		t.Fatalf("configured agent: %s", h.stdout)
	}
	h.hook(t, hookPayload(h.repo, "SessionStart", ""))
	other := filepath.Join(h.home, "code", "undecided")
	mustMkdir(t, filepath.Join(other, ".git"))
	mustWrite(t, filepath.Join(other, ".git", "config"), "[remote \"origin\"]\n\turl = git@github.com:acme/undecided.git\n")
	h.hook(t, hookPayload(other, "SessionStart", ""))
	now := time.Now()
	layout := store.Layout{Root: h.data}
	state.Update(context.Background(), layout, layout.Health(), func(health *state.Health) bool {
		health.NoteActivity("claude_code", now.Add(-time.Minute), time.Time{})
		return true
	})
	report = h.status(t)
	agentReport := report.Agents[0]
	if agentReport.State != "receiving" || !agentReport.Receiving || agentReport.Uploading || agentReport.LastObservationAt == nil || agentReport.LastUploadAt != nil {
		t.Fatalf("receiving agent: %s", h.stdout)
	}
	if report.Queue.InboxItems != 1 || report.Queue.CapacityRecords != 1024 || len(report.PendingProjects) != 1 || report.PendingProjects[0].RepoURL != "github.com/acme/undecided" {
		t.Fatalf("queue or pending projects: %s", h.stdout)
	}
	state.Update(context.Background(), layout, layout.Health(), func(health *state.Health) bool {
		health.NoteActivity("claude_code", time.Time{}, now)
		return true
	})
	if report = h.status(t); report.Agents[0].State != "uploading" || !report.Agents[0].Uploading {
		t.Fatalf("uploading agent: %s", h.stdout)
	}
	h.run(t, "pause")
	if report = h.status(t); report.Agents[0].State != "paused" || report.Capture.State != "paused_locally" {
		t.Fatalf("paused agent: %s", h.stdout)
	}
	h.run(t, "resume")
	settings := filepath.Join(h.home, ".claude", "settings.json")
	mustWrite(t, settings, `{"hooks":{}}`+"\n")
	os.WriteFile(settings, []byte(`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'`+h.app.executable+`' hook claude-code"}]}]}}`), 0o600)
	if report = h.status(t); report.Agents[0].State != "broken" || !report.Agents[0].Broken {
		t.Fatalf("broken agent: %s", h.stdout)
	}
	if err := h.run(t, "projects", "ignore", other); err != nil {
		t.Fatal(err)
	}
	if report = h.status(t); len(report.PendingProjects) != 0 {
		t.Fatalf("ignored project still pending: %s", h.stdout)
	}
}

func TestStatusHumanView(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	if err := h.run(t, "status", "--human"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Backplane companion", "Connection:", h.server.URL, "Version:", "dev", "Capture:", "active", "claude_code", "Queue:"} {
		if !strings.Contains(h.stdout.String(), want) {
			t.Errorf("human status missing %q:\n%s", want, h.stdout)
		}
	}
	h.env["LANG"] = "es_ES.UTF-8"
	h.run(t, "status", "--human")
	if !strings.Contains(h.stdout.String(), "Conexión:") {
		t.Fatalf("human status not localized:\n%s", h.stdout)
	}
}

func TestConnectDropsInboxItemsFromBeforeTheConnection(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	// A shim that read the old policy just before disconnect can still land
	// an item after the purge.
	late := inbox.Item{Agent: "claude_code", ReceivedAt: time.Now().Add(-time.Second), Payload: map[string]any{"cwd": h.repo}}
	if err := inbox.Write(filepath.Join(h.data, "inbox"), late); err != nil {
		t.Fatal(err)
	}
	h.connect(t)
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != 0 {
		t.Fatal("an item captured under the previous connection survived reconnect")
	}
	h.hook(t, hookPayload(h.repo, "SessionStart", ""))
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != 1 {
		t.Fatal("capture after reconnect broken")
	}
}

func TestErrorsAreLocalizedByTypedCode(t *testing.T) {
	wrapped := fmt.Errorf("refresh: %w", uplink.ErrUnauthorized)
	english := localizedError(wrapped, "en_US.UTF-8")
	spanish := localizedError(wrapped, "es_AR.UTF-8")
	portuguese := localizedError(wrapped, "pt-BR")
	if !strings.HasPrefix(english, "unauthorized: ") || !strings.HasPrefix(spanish, "unauthorized: Backplane rechazó") || !strings.HasPrefix(portuguese, "unauthorized: O Backplane rejeitou") {
		t.Fatalf("localization: %q %q %q", english, spanish, portuguese)
	}
	if errorCode(errors.New("something else")) != "internal_error" {
		t.Fatal("unknown errors must map to internal_error")
	}
	for _, known := range errorCodes {
		if _, ok := messages[known.code]; !ok {
			t.Errorf("no message for %s", known.code)
		}
	}
}

func hookPayload(cwd, event, extra string) string {
	return `{"cwd":` + quoted(cwd) + `,"session_id":"session_fixture_1","hook_event_name":` + quoted(event) + extra + `}`
}

func quoted(value string) string { data, _ := json.Marshal(value); return string(data) }

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func allNotInstalled(report statusView) bool {
	for _, agent := range report.Agents {
		if agent.State != "not_installed" {
			return false
		}
	}
	return true
}

func installationID(t *testing.T, h *harness) string {
	t.Helper()
	installation, _ := state.Load[state.Installation](filepath.Join(h.data, "installation.json"))
	return installation.ID
}

func TestReconnectAfterKeyringLossReusesTheInstallationAndRotates(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	(credentials.Keyring{}).Delete(first)
	h.connect(t)
	if installationID(t, h) != first || h.server.Rotations != 1 {
		t.Fatalf("expected the same installation with a rotated token: %s rotations=%d", installationID(t, h), h.server.Rotations)
	}
	if token, err := (credentials.Keyring{}).Load(first); err != nil || token != uplinktest.DeviceToken {
		t.Fatalf("rotated token not stored: %v", err)
	}
}

func TestReconnectOfARevokedInstallationRegistersANewOne(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	h.server.Lock()
	h.server.Revoked[first] = true
	h.server.Unlock()
	(credentials.Keyring{}).Delete(first)
	h.connect(t)
	second := installationID(t, h)
	if second == first || second == "" {
		t.Fatal("a revoked installation must be replaced by a new one")
	}
	if token, err := (credentials.Keyring{}).Load(second); err != nil || token == "" {
		t.Fatalf("new installation has no token: %v", err)
	}
}

func TestProjectsMapExplainsServerRefusals(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	cases := map[int]error{409: errAmbiguousRepo, 403: errAutoMatchDisabled, 422: errNoMatchingBoard, 404: errNoMatchingBoard}
	for status, want := range cases {
		h.server.Lock()
		h.server.MappingRefusals["github.com/acme/app"] = status
		if status == 404 {
			delete(h.server.MappingRefusals, "github.com/acme/app")
		}
		h.server.Policy.Mappings = nil
		h.server.Unlock()
		if err := h.run(t, "projects", "map", h.repo); !errors.Is(err, want) {
			t.Errorf("%d: got %v want %v", status, err, want)
		}
	}
}

func TestInsecureDevKeyringIsRefusedByReleaseBuilds(t *testing.T) {
	t.Setenv(credentials.EnvStore, credentials.DevStoreValue)
	t.Setenv(store.EnvHome, filepath.Join(t.TempDir(), "data"))
	app := newApp()
	if _, err := app.keyring.Load("any"); !errors.Is(err, credentials.ErrDevStoreUnavailable) && !devKeyringBuilt() {
		t.Fatalf("a release build selected the insecure dev keyring: %v", err)
	}
	if errorCode(credentials.ErrDevStoreUnavailable) != "dev_credential_store_not_built" {
		t.Fatal("refusal has no stable error code")
	}
}

func TestErrorCode_ServiceDaemonStillRunningIsDaemonRunning(t *testing.T) {
	err := fmt.Errorf("service uninstall: %w", service.ErrDaemonStillRunning)
	if code := errorCode(err); code != "daemon_running" {
		t.Fatalf("code %s", code)
	}
	if message := localizedError(err, "es"); !strings.HasPrefix(message, "daemon_running: El companion en ejecución") {
		t.Fatalf("message %s", message)
	}
}
