// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/service"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

type recordingRunner struct{ commands []string }

func (r *recordingRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	command := strings.Join(append([]string{name}, args...), " ")
	r.commands = append(r.commands, command)
	if strings.HasPrefix(command, "launchctl print") {
		return nil, errors.New("not loaded")
	}
	return nil, nil
}

func TestServiceCommandsDriveTheBackendThroughTheRunner(t *testing.T) {
	h := newHarness(t)
	h.app.goos = "darwin"
	h.app.uid = 501
	runner := &recordingRunner{}
	h.app.serviceRunner = runner
	h.env[envBeaconArtifact] = "/opt/backplane/beacon/artifact.json"
	if err := h.run(t, "service", "install"); err != nil {
		t.Fatal(err)
	}
	plist, err := os.ReadFile(filepath.Join(h.home, "Library", "LaunchAgents", "dev.backplane.companion.plist"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{h.app.executable, "<string>run</string>", h.data, "/opt/backplane/beacon/artifact.json", filepath.Join(h.data, "logs", "companion.log")} {
		if !strings.Contains(string(plist), want) {
			t.Errorf("plist missing %s", want)
		}
	}
	if !strings.Contains(strings.Join(runner.commands, "\n"), "launchctl bootstrap gui/501 "+filepath.Join(h.home, "Library", "LaunchAgents")) {
		t.Fatalf("install did not bootstrap through the runner: %v", runner.commands)
	}
	if err := h.run(t, "service", "status"); err != nil {
		t.Fatal(err)
	}
	var status struct {
		Service struct {
			Backend   string `json:"backend"`
			Installed bool   `json:"installed"`
			Current   bool   `json:"current"`
		} `json:"service"`
		DaemonRunning bool `json:"daemon_running"`
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &status); err != nil || status.Service.Backend != "launchd" || !status.Service.Installed || !status.Service.Current || status.DaemonRunning {
		t.Fatalf("service status: %s %v", h.stdout, err)
	}
	if err := h.run(t, "service", "uninstall"); err != nil {
		t.Fatal(err)
	}
	if err := h.run(t, "service", "restart"); !errors.Is(err, errUsage) {
		t.Fatalf("unknown service verb: %v", err)
	}
	h.app.goos = "plan9"
	if err := h.run(t, "service", "install"); !errors.Is(err, service.ErrUnsupportedPlatform) {
		t.Fatalf("unsupported platform: %v", err)
	}
}

func (h *harness) runDaemonAsync(t *testing.T, args ...string) (context.CancelFunc, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.app.run(ctx, append([]string{"run"}, args...)) }()
	return cancel, done
}

func waitForLog(t *testing.T, path, want string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, _ := os.ReadFile(path); strings.Contains(string(data), want) {
			return string(data)
		}
		time.Sleep(10 * time.Millisecond)
	}
	data, _ := os.ReadFile(path)
	t.Fatalf("log never contained %q:\n%s", want, data)
	return ""
}

func fakeBeaconManifest(t *testing.T, dir string) string {
	t.Helper()
	executable := filepath.Join(dir, "beacon-hooks")
	mustWrite(t, executable, "#!/bin/sh\nexit 0\n")
	os.Chmod(executable, 0o700)
	data, _ := os.ReadFile(executable)
	sum := sha256.Sum256(data)
	manifest := filepath.Join(dir, "artifact.json")
	encoded, _ := json.Marshal(beacon.Manifest{Path: executable, SHA256: hex.EncodeToString(sum[:]), SourceCommit: beacon.Commit})
	mustWrite(t, manifest, string(encoded))
	return manifest
}

func TestRunWaitsForAConnectionInsteadOfExiting(t *testing.T) {
	h := newHarness(t)
	delete(h.env, "BACKPLANE_COMPANION_HOME")
	h.app.connectPollInterval = 20 * time.Millisecond
	other := filepath.Join(h.root, "task-data")
	logPath := filepath.Join(other, "logs", "companion.log")
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	cancel, done := h.runDaemonAsync(t, "--data-dir", other, "--log", logPath)
	waitForLog(t, logPath, "not_connected")
	time.Sleep(100 * time.Millisecond)
	connectEnv := map[string]string{"BACKPLANE_COMPANION_HOME": other, envAPIKey: uplinktest.APIKey}
	connector := h.makeApp(func(key string) string { return connectEnv[key] }, &bytes.Buffer{})
	if err := connector.run(context.Background(), []string{"connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"}); err != nil {
		t.Fatal(err)
	}
	log := waitForLog(t, logPath, "started")
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run must not fail while waiting for a connection: %v", err)
	}
	if linesContaining(log, "not_connected") != 1 {
		t.Fatalf("waiting was logged more than once:\n%s", log)
	}
}

func TestRunExitsCleanlyWhenAnotherDaemonIsRunning(t *testing.T) {
	h := newHarness(t)
	layout, _ := store.Open(h.data)
	lock, acquired, err := store.TryLock(layout.DaemonLock())
	if err != nil || !acquired {
		t.Fatal("could not hold the daemon lock")
	}
	defer lock.Unlock()
	logPath := filepath.Join(h.data, "logs", "companion.log")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.app.run(ctx, []string{"run", "--log", logPath}); err != nil {
		t.Fatalf("a second run is not a failure: %v", err)
	}
	if data, _ := os.ReadFile(logPath); !strings.Contains(string(data), "daemon_already_running") {
		t.Fatalf("not logged: %s", data)
	}
}

func TestRunRetriesAMissingBeaconArtifactWithBackoff(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.app.artifactRetryBase = 10 * time.Millisecond
	h.app.artifactRetryMax = 40 * time.Millisecond
	artifactDir := filepath.Join(h.root, "upgrading")
	h.env[envBeaconArtifact] = filepath.Join(artifactDir, "artifact.json")
	logPath := filepath.Join(h.data, "logs", "companion.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	waitForLog(t, logPath, "beacon_artifact_unverified")
	time.Sleep(200 * time.Millisecond)
	os.MkdirAll(artifactDir, 0o700)
	fakeBeaconManifest(t, artifactDir)
	log := waitForLog(t, logPath, "started")
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if linesContaining(log, "beacon_artifact_unverified") != 1 {
		t.Fatalf("artifact failure logged on every retry:\n%s", log)
	}
}

func TestRotatingLogIsCapped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "companion.log")
	log, err := openRotatingLog(path, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	line := strings.Repeat("x", 39) + "\n"
	for i := 0; i < 20; i++ {
		if _, err := log.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	current, _ := os.Stat(path)
	previous, _ := os.Stat(path + ".1")
	if current == nil || previous == nil || current.Size() > 100 || previous.Size() > 100 {
		t.Fatalf("log not rotated within the cap: %v %v", current, previous)
	}
	if _, err := os.Stat(path + ".2"); !os.IsNotExist(err) {
		t.Fatal("more than one rotated file kept")
	}
}

func linesContaining(text, want string) int {
	count := 0
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, want) {
			count++
		}
	}
	return count
}
