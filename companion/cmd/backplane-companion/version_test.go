// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

type versionView struct {
	Version      string `json:"version"`
	Commit       string `json:"commit"`
	BeaconCommit string `json:"beacon_commit"`
	GoVersion    string `json:"go_version"`
	Platform     string `json:"platform"`
	Artifacts    map[string]struct {
		Manifest     string `json:"manifest"`
		Verified     bool   `json:"verified"`
		SHA256       string `json:"sha256"`
		SourceCommit string `json:"source_commit"`
		Error        string `json:"error"`
	} `json:"artifacts"`
}

func (h *harness) version(t *testing.T) versionView {
	t.Helper()
	if err := h.run(t, "version"); err != nil {
		t.Fatal(err)
	}
	var view versionView
	if err := json.Unmarshal(h.stdout.Bytes(), &view); err != nil {
		t.Fatalf("%v: %s", err, h.stdout)
	}
	return view
}

func TestVersionReportsTheBuildAndTheArtifactsNextToTheExecutable(t *testing.T) {
	h := newHarness(t)
	bundled := bundledBeacon(t, h)
	view := h.version(t)
	if view.Version != "dev" || view.BeaconCommit != beacon.Commit || view.GoVersion != runtime.Version() || view.Platform != "testos/testarch" {
		t.Fatalf("build identity: %+v", view)
	}
	hooks := view.Artifacts["beacon_hooks"]
	if hooks.Manifest != bundled || !hooks.Verified || hooks.SourceCommit != beacon.Commit || len(hooks.SHA256) != 64 {
		t.Fatalf("bundled beacon-hooks: %+v", hooks)
	}
	otelcol := view.Artifacts["beacon_otelcol"]
	if otelcol.Verified || otelcol.Error != "beacon_artifact_unverified" || otelcol.Manifest != filepath.Join(filepath.Dir(h.executable), "beacon", "otelcol.json") {
		t.Fatalf("missing collector: %+v", otelcol)
	}

	mustMkdir(t, filepath.Join(h.root, "elsewhere"))
	elsewhere := fakeBeaconManifest(t, filepath.Join(h.root, "elsewhere"))
	h.env[envBeaconArtifact] = elsewhere
	if hooks := h.version(t).Artifacts["beacon_hooks"]; hooks.Manifest != elsewhere || !hooks.Verified {
		t.Fatalf("environment override ignored: %+v", hooks)
	}
}

func TestStatusReportsTheCLIAndTheRunningDaemonVersions(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	bundledBeacon(t, h)
	logPath := filepath.Join(h.root, "daemon.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	waitForLog(t, logPath, "started")
	cancel()
	<-done
	var report struct {
		Companion struct {
			Version      string `json:"version"`
			BeaconCommit string `json:"beacon_commit"`
		} `json:"companion"`
		Health struct {
			Daemon *state.DaemonVersion `json:"daemon"`
		} `json:"health"`
	}
	if err := h.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Companion.Version != "dev" || report.Companion.BeaconCommit != beacon.Commit {
		t.Fatalf("cli version: %+v", report.Companion)
	}
	daemon := report.Health.Daemon
	if daemon == nil || daemon.Version != "dev" || daemon.BeaconCommit != beacon.Commit || len(daemon.BeaconHooksSHA256) != 64 || time.Since(daemon.StartedAt) > time.Minute {
		t.Fatalf("running daemon version: %+v", daemon)
	}
}

func TestWindowsTaskRunsTheWindowlessDaemonWhenBundled(t *testing.T) {
	h := newHarness(t)
	h.app.goos = "windows"
	h.app.serviceRunner = noTaskRunner{}
	h.env["USERNAME"] = "person"
	task := filepath.Join(h.data, "service", "companion-task.xml")
	taskCommand := func() string {
		t.Helper()
		if err := h.run(t, "service", "install"); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(task)
		if err != nil {
			t.Fatal(err)
		}
		text := decodeUTF16(data)
		start, end := strings.Index(text, "<Command>"), strings.Index(text, "</Command>")
		return text[start+len("<Command>") : end]
	}
	if got := taskCommand(); got != h.executable {
		t.Fatalf("without a windowless build the task runs %q", got)
	}
	windowless := filepath.Join(filepath.Dir(h.executable), windowlessDaemonName)
	mustWrite(t, windowless, "")
	if got := taskCommand(); got != windowless {
		t.Fatalf("task runs %q, want the windowless daemon", got)
	}
}

func bundledBeacon(t *testing.T, h *harness) string {
	t.Helper()
	dir := filepath.Join(filepath.Dir(h.executable), "beacon")
	mustMkdir(t, dir)
	return fakeBeaconManifest(t, dir)
}

// noTaskRunner answers as Task Scheduler does before any task exists.
type noTaskRunner struct{}

func (noTaskRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	if len(args) > 0 && args[0] == "/Query" {
		return nil, errors.New("task not found")
	}
	return nil, nil
}

func decodeUTF16(data []byte) string {
	var runes []rune
	for index := 2; index+1 < len(data); index += 2 {
		runes = append(runes, rune(uint16(data[index])|uint16(data[index+1])<<8))
	}
	return string(runes)
}

func TestRunReportsTheArtifactsItWillUseBeforeConnecting(t *testing.T) {
	h := newHarness(t)
	h.app.connectPollInterval = 20 * time.Millisecond
	bundled := bundledBeacon(t, h)
	logPath := filepath.Join(h.root, "daemon.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	logged := waitForLog(t, logPath, "not connected")
	cancel()
	<-done
	for _, want := range []string{"beacon_hooks verified " + bundled, "beacon_otelcol not verified " + filepath.Join(filepath.Dir(bundled), "otelcol.json")} {
		if !strings.Contains(logged, want) {
			t.Errorf("log lacks %q:\n%s", want, logged)
		}
	}
}

func TestStatusShowsTheServerRetention(t *testing.T) {
	h := newHarness(t)
	days := 30
	h.server.Policy.Installation.RetentionDays = &days
	h.connect(t)
	var report struct {
		Capture struct {
			RetentionDays *int `json:"retention_days"`
		} `json:"capture"`
	}
	if err := h.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &report); err != nil || report.Capture.RetentionDays == nil || *report.Capture.RetentionDays != 30 {
		t.Fatalf("retention: %s", h.stdout)
	}
	h.run(t, "status", "--human")
	if !strings.Contains(h.stdout.String(), "Retention:") || !strings.Contains(h.stdout.String(), "30 days") {
		t.Fatalf("human retention:\n%s", h.stdout)
	}
	layout, _ := h.app.layout()
	cached, _ := policy.Load(layout.Policy())
	cached.Policy.Installation.RetentionDays = nil
	policy.Save(layout.Policy(), cached)
	h.run(t, "status", "--human")
	if !strings.Contains(h.stdout.String(), "kept until deleted") {
		t.Fatalf("human retention without a limit:\n%s", h.stdout)
	}
}
