// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/shim"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// In a headless session (Config.VerifyPolicyInstallation) a refreshed
// policy is cached only for the installation the daemon runs for: a policy
// (and API base) of another installation must never become this one's
// capture scope. Desktop sessions keep today's behavior.

const (
	refreshInstallation      = "7a1c0de5-0000-4000-8000-0000000000d1"
	refreshOtherInstallation = "7a1c0de5-0000-4000-8000-0000000000e2"
)

type installationFixture struct {
	daemon *Daemon
	server *uplinktest.Server
	layout store.Layout
	shim   shim.Shim
	repo   string
	clock  *time.Time
}

// newInstallationFixture runs a headless session for refreshInstallation
// against a server whose policy names answered; nothing has ticked yet.
func newInstallationFixture(t *testing.T, answered string) *installationFixture {
	t.Helper()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(root, "home")
	repo := filepath.Join(home, "code", "app")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o700)
	os.WriteFile(filepath.Join(repo, ".git", "config"), []byte("[remote \"origin\"]\n\turl = git@github.com:acme/app.git\n"), 0o600)
	os.MkdirAll(filepath.Join(root, "tmp"), 0o700)
	layout, err := store.Open(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	store.WriteJSON(layout.Installation(), state.Installation{ID: refreshInstallation})
	server := uplinktest.New(t)
	server.Policy.Installation.ID = answered
	server.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: repo, Enabled: true, ContentLevel: "standard"}}
	client, _ := uplink.New(uplink.Options{Endpoint: server.URL, AllowLoopbackHTTP: true})
	device, _ := client.WithDeviceToken(uplinktest.DeviceToken)
	registry := agent.NewRegistry(claudecode.New())
	current := now
	clock := func() time.Time { return current }
	temp := []string{filepath.Join(root, "tmp")}
	return &installationFixture{
		daemon: New(Config{InstallationID: refreshInstallation, VerifyPolicyInstallation: true, Layout: layout, Client: device, Normalizer: &fakeNormalizer{}, Registry: registry, Home: home, TempDirs: temp, Now: clock}),
		server: server,
		layout: layout,
		shim:   shim.Shim{Layout: layout, Registry: registry, Home: home, TempDirs: temp, Now: clock},
		repo:   repo,
		clock:  &current,
	}
}

func (f *installationFixture) tick() error { return f.daemon.Tick(context.Background()) }

func (f *installationFixture) answer(installationID string) {
	f.server.Lock()
	f.server.Policy.Installation.ID = installationID
	f.server.Unlock()
}

func (f *installationFixture) lastPolicyError(t *testing.T) string {
	t.Helper()
	health, err := state.Load[state.Health](f.layout.Health())
	if err != nil {
		t.Fatal(err)
	}
	return health.LastPolicyError
}

func (f *installationFixture) hookCaptures(t *testing.T) bool {
	t.Helper()
	input := `{"cwd":` + quotedJSON(f.repo) + `,"session_id":"sess-1","hook_event_name":"SessionStart"}`
	f.shim.Handle("claude_code", strings.NewReader(input))
	names, err := inbox.List(f.layout.InboxDir())
	if err != nil {
		t.Fatal(err)
	}
	return len(names) > 0
}

func quotedJSON(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}

func TestRefreshPolicy_RefusesAPolicyForAnotherInstallation(t *testing.T) {
	f := newInstallationFixture(t, refreshOtherInstallation)
	if err := f.tick(); errors.Is(err, ErrRevoked) {
		t.Fatalf("a mismatched policy is not a revocation: %v", err)
	}
	if _, err := os.Stat(f.layout.Policy()); !errors.Is(err, os.ErrNotExist) {
		cached, _ := policy.Load(f.layout.Policy())
		t.Fatalf("another installation's policy was cached: %+v", cached.Policy.Installation)
	}
	if got := f.lastPolicyError(t); got != "policy_installation_mismatch" {
		t.Fatalf("health.last_policy_error = %q, want policy_installation_mismatch", got)
	}
	if f.hookCaptures(t) {
		t.Fatal("captured under another installation's policy")
	}
	if admission, _ := state.Load[state.Admission](f.layout.Admission()); admission.Unauthorized {
		t.Fatalf("a mismatched policy recorded a revocation: %+v", admission)
	}

	// The refresh retries; the installation's own policy is then cached.
	f.answer(refreshInstallation)
	*f.clock = f.clock.Add(policyRetryInterval)
	f.tick()
	cached, err := policy.Load(f.layout.Policy())
	if err != nil || cached.Policy.Installation.ID != refreshInstallation {
		t.Fatalf("the installation's own policy was not cached on retry: %+v %v", cached.Policy.Installation, err)
	}
	if got := f.lastPolicyError(t); got != "" {
		t.Fatalf("a good refresh must clear the mismatch, got %q", got)
	}
}

func TestRefreshPolicy_KeepsTheCachedPolicyWhenAnotherInstallationAnswers(t *testing.T) {
	f := newInstallationFixture(t, refreshInstallation)
	f.tick()
	cachedBefore, err := os.ReadFile(f.layout.Policy())
	if err != nil {
		t.Fatalf("the installation's own policy was not cached: %v", err)
	}

	f.answer(refreshOtherInstallation)
	*f.clock = f.clock.Add(PolicyInterval)
	f.tick()
	if cachedAfter, _ := os.ReadFile(f.layout.Policy()); !bytes.Equal(cachedBefore, cachedAfter) {
		cached, _ := policy.Load(f.layout.Policy())
		t.Fatalf("another installation's policy replaced the cached one: %+v", cached.Policy.Installation)
	}
	if got := f.lastPolicyError(t); got != "policy_installation_mismatch" {
		t.Fatalf("health.last_policy_error = %q, want policy_installation_mismatch", got)
	}
}
