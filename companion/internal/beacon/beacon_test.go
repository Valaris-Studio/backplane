// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package beacon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestModuleAndSourcePinsAgree(t *testing.T) {
	data, err := os.ReadFile("../../beacon-source.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Commit string `json:"commit"`
	}
	if err := json.Unmarshal(data, &spec); err != nil || spec.Commit != Commit {
		t.Fatal("beacon-source.json and runtime pin disagree")
	}
	module, err := os.ReadFile("../../go.mod")
	if err != nil || !bytes.Contains(module, []byte(Commit[:12])) {
		t.Fatal("asymptoteobserve module and executable pins disagree")
	}
}

func TestLoadVerifiesManifestOnce(t *testing.T) {
	dir := t.TempDir()
	manifest := fakeArtifact(t, dir, "exit 0")
	if _, err := Load(manifest, dir); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Manifest){
		"commit":   func(m *Manifest) { m.SourceCommit = strings.Repeat("0", 40) },
		"checksum": func(m *Manifest) { m.SHA256 = strings.Repeat("0", 64) },
		"platform": func(m *Manifest) { m.GOOS = "plan9" },
		"missing":  func(m *Manifest) { m.Path = filepath.Join(dir, "absent") },
	} {
		t.Run(name, func(t *testing.T) {
			var m Manifest
			data, _ := os.ReadFile(manifest)
			json.Unmarshal(data, &m)
			mutate(&m)
			path := filepath.Join(t.TempDir(), "artifact.json")
			encoded, _ := json.Marshal(m)
			os.WriteFile(path, encoded, 0o600)
			if _, err := Load(path, dir); !errors.Is(err, ErrUnverified) {
				t.Fatalf("accepted %s mismatch: %v", name, err)
			}
		})
	}
}

func TestNormalizeRejectsDiagnosticsFailuresAndIdentityLoss(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake executable is a shell script")
	}
	cases := map[string]string{
		"stderr":         `echo '{"event":{"action":"x"},"session":{"id":"s1"}}' > "$5"; echo warn >&2`,
		"exit status":    `exit 3`,
		"lost session":   `echo '{"event":{"action":"x"},"session":{"id":"other"}}' > "$5"`,
		"partial record": `printf '{"event":{"action":"x"}' > "$5"`,
		"missing action": `echo '{"event":{},"session":{"id":"s1"}}' > "$5"`,
		"mixed versions": `printf '%s\n%s\n' '{"schema_version":"1.0","event":{"action":"x"},"session":{"id":"s1"}}' '{"schema_version":"2.0","event":{"action":"y"},"session":{"id":"s1"}}' > "$5"`,
	}
	for name, script := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			runner, err := Load(fakeArtifact(t, dir, script), dir)
			if err != nil {
				t.Fatal(err)
			}
			_, err = runner.Normalize(context.Background(), Request{Platform: "claude", Command: "stop", Event: "Stop", SessionID: "s1", Cwd: dir, Payload: map[string]any{}})
			if !errors.Is(err, ErrNormalize) {
				t.Fatalf("accepted %s: %v", name, err)
			}
		})
	}
}

func TestNormalizeUsesPrivateHomeAndRestrictedEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake executable is a shell script")
	}
	t.Setenv("BEACON_CLOUD_DEVICE_KEY", "must-not-inherit")
	dir := t.TempDir()
	script := `input=$(cat); printf '{"schema_version":"1.0","event":{"action":"seen"},"session":{"id":"s1"},"home":"%s","leak":"%s","input":%s}\n' "$HOME" "$BEACON_CLOUD_DEVICE_KEY" "$input" > "$5"`
	runner, err := Load(fakeArtifact(t, dir, script), dir)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"session_id": "s1", "tool_input": map[string]any{"file_path": "x"}, "tool_response": "r"}
	result, err := runner.Normalize(context.Background(), Request{Platform: "claude", Command: "post-tool", Event: "PostToolUseFailure", SessionID: "s1", Cwd: dir, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	var event struct {
		Home, Leak string
		Input      map[string]any
	}
	json.Unmarshal(result.Events[0], &event)
	if event.Leak != "" || !strings.HasPrefix(event.Home, dir) || event.Home == os.Getenv("HOME") {
		t.Fatalf("environment not restricted: %+v", event)
	}
	if _, passed := event.Input["tool_input"]; !passed || result.SchemaVersion != "1.0" {
		t.Fatalf("payload must reach Beacon unchanged; adapters own input shaping: %s", result.Events[0])
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "beacon-") {
			t.Fatal("scratch home not removed")
		}
	}
}

func fakeArtifact(t *testing.T, dir, body string) string {
	t.Helper()
	executable := filepath.Join(dir, "beacon-hooks")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	sum, err := fileSHA256(executable)
	if err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "artifact.json")
	encoded, _ := json.Marshal(Manifest{Path: "beacon-hooks", SHA256: sum, SourceCommit: Commit})
	if err := os.WriteFile(manifest, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func TestNormalizeStripsDeviceIdentityAndKeepsNumbers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake executable is a shell script")
	}
	dir := t.TempDir()
	script := `echo '{"schema_version":"1.0","event":{"action":"x"},"session":{"id":"s1"},"user":{"name":"ada","uid":"501"},"endpoint":{"hostname":"laptop.local","os":"darwin"},"n":9007199254740993,"text":"<a&b>"}' > "$5"`
	runner, err := Load(fakeArtifact(t, dir, script), dir)
	if err != nil {
		t.Fatal(err)
	}
	result, err := runner.Normalize(context.Background(), Request{Platform: "claude", Command: "stop", Event: "Stop", SessionID: "s1", Cwd: dir, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	event := string(result.Events[0])
	for _, identity := range []string{`"user"`, "ada", `"hostname"`, "laptop.local"} {
		if strings.Contains(event, identity) {
			t.Fatalf("device identity %s kept: %s", identity, event)
		}
	}
	for _, kept := range []string{`"os":"darwin"`, `9007199254740993`, `"<a&b>"`, `"action":"x"`} {
		if !strings.Contains(event, kept) {
			t.Fatalf("lost %s: %s", kept, event)
		}
	}
}

func TestNormalizeInterruptionIsTransient(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake executable is a shell script")
	}
	dir := t.TempDir()
	runner, err := Load(fakeArtifact(t, dir, "sleep 5"), dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = runner.Normalize(ctx, Request{Platform: "claude", Command: "stop", Event: "Stop", SessionID: "s1", Cwd: dir, Payload: map[string]any{}})
	if !errors.Is(err, ErrInterrupted) || errors.Is(err, ErrNormalize) {
		t.Fatalf("interruption must be transient, not a normalize failure: %v", err)
	}
}

func TestEventTypesBeaconDoesNotMapYieldNoEventsNotAFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake executable is a shell script")
	}
	for name, script := range map[string]string{"empty log": `: > "$5"`, "no log": `exit 0`} {
		dir := t.TempDir()
		runner, err := Load(fakeArtifact(t, dir, script), dir)
		if err != nil {
			t.Fatal(err)
		}
		_, err = runner.Normalize(context.Background(), Request{Platform: "pi", Command: "pi-event", Event: "message_end", SessionID: "s1", Cwd: dir, Payload: map[string]any{}})
		if !errors.Is(err, ErrNoEvents) || errors.Is(err, ErrNormalize) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestVerifyExecutableChecksAnyPinnedManifest(t *testing.T) {
	dir := t.TempDir()
	manifest := fakeArtifact(t, dir, "exit 0")
	path, err := VerifyExecutable(manifest)
	if err != nil || path != filepath.Join(dir, "beacon-hooks") {
		t.Fatalf("verify: %q %v", path, err)
	}
	os.WriteFile(filepath.Join(dir, "beacon-hooks"), []byte("tampered"), 0o700)
	if _, err := VerifyExecutable(manifest); !errors.Is(err, ErrUnverified) {
		t.Fatal("tampered executable accepted")
	}
}
