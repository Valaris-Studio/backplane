// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sessionCursor is the cursor a first poll leaves for a session of
// originator, held back by the settle before its first response.
func sessionCursor(t *testing.T, env testEnv, originator string) json.RawMessage {
	t.Helper()
	path := filepath.Join(env.codexHome, "sessions", "2026", "09", "29", "rollout-2026-09-29T11-00-00-"+rolloutThread+".jsonl")
	write(t, path, encodeRollout(t, sessionMeta(originator), turnContext("gpt-5.4"),
		usageRecord(10*time.Second, rolloutThread, "resp_01", codexTokens(1000, 0, 0, 50, 0))))
	f := &rolloutFixture{env: env, path: path}
	f.readUntil(t, rolloutNow.Add(-time.Hour+5*time.Second))
	return f.cursor
}

func countTraceConfigReads(t *testing.T) *int {
	t.Helper()
	reads := 0
	original := readTraceConfig
	readTraceConfig = func(path string) ([]byte, error) {
		reads++
		return original(path)
	}
	t.Cleanup(func() { readTraceConfig = original })
	return &reads
}

func TestExportsTraces_OnlyARecognisedDesktopOrAnUnwiredConfigRulesTracesOut(t *testing.T) {
	wired := func(t *testing.T, env testEnv) {
		if err := New().Install(env.Env); err != nil {
			t.Fatal(err)
		}
	}
	for name, c := range map[string]struct {
		originator string
		setup      func(*testing.T, testEnv)
		want       bool
	}{
		"CLI wired to the gate":            {"codex_cli_rs", wired, true},
		"Desktop even with the gate wired": {"Codex Desktop", wired, false},
		"unknown client wired to the gate": {"codex_future_client", wired, true},
		"CLI without a config":             {"codex_exec", func(*testing.T, testEnv) {}, false},
		"CLI exporting to another collector": {"codex_cli_rs", func(t *testing.T, env testEnv) {
			write(t, env.configFile(), "[otel.trace_exporter.otlp-http]\nendpoint = \"http://collector:4318/v1/traces\"\nprotocol = \"json\"\n")
		}, false},
		"CLI wired to an earlier gate port": {"codex_cli_rs", func(t *testing.T, env testEnv) {
			env.Telemetry.Endpoint = "http://127.0.0.1:1"
			wired(t, env)
		}, false},
		"CLI with an unparsable config": {"codex_cli_rs", func(t *testing.T, env testEnv) { write(t, env.configFile(), "[otel\n") }, true},
		"CLI with an oversize config": {"codex_cli_rs", func(t *testing.T, env testEnv) {
			write(t, env.configFile(), "# "+strings.Repeat("x", maxTraceConfigBytes)+"\n")
		}, true},
	} {
		t.Run(name, func(t *testing.T) {
			env := newEnv(t)
			c.setup(t, env)
			if got := New().ExportsTraces(env.Env, sessionCursor(t, env, c.originator)); got != c.want {
				t.Fatalf("ExportsTraces(%s) = %v, want %v", c.originator, got, c.want)
			}
		})
	}
}

func TestExportsTraces_UnknownGateEndpointKeepsWaitingForTraces(t *testing.T) {
	env := newEnv(t)
	cursor := sessionCursor(t, env, "codex_cli_rs")
	env.Telemetry.Endpoint = ""
	if !New().ExportsTraces(env.Env, cursor) {
		t.Fatal("without the gate's endpoint the CLI's traces may still arrive")
	}
}

func TestExportsTraces_RereadsTheConfigOnlyWhenItChanges(t *testing.T) {
	env := newEnv(t)
	if err := New().Install(env.Env); err != nil {
		t.Fatal(err)
	}
	cursor := sessionCursor(t, env, "codex_cli_rs")
	reads := countTraceConfigReads(t)
	for range 3 {
		if !New().ExportsTraces(env.Env, cursor) {
			t.Fatal("wired CLI")
		}
	}
	if *reads != 1 {
		t.Fatalf("an unchanged config.toml was read %d times", *reads)
	}
	write(t, env.configFile(), "model = \"gpt-5.4\"\n")
	later := time.Now().Add(time.Minute)
	os.Chtimes(env.configFile(), later, later)
	if New().ExportsTraces(env.Env, cursor) {
		t.Fatal("the rewritten config no longer exports traces to the gate")
	}
	if *reads != 2 {
		t.Fatalf("a changed config.toml must be read again; reads = %d", *reads)
	}
}
