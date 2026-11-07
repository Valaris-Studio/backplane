// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// operatorManagedWrites are the server routes a headless companion must
// never call: credential minting, capture-scope writes, enrollment, pairing,
// self-revocation, renames and session reads.
func operatorManagedWrites(server *uplinktest.Server) []string {
	var found []string
	for _, request := range server.Requests() {
		path := request.Path
		switch {
		case request.Token == uplinktest.APIKey,
			strings.HasPrefix(path, "/api/me/"),
			strings.HasPrefix(path, "/api/companion/pairing"),
			path == "/api/companion/agent-key",
			path == "/api/companion/settings",
			path == "/api/companion/installation",
			strings.HasPrefix(path, "/api/companion/sessions"),
			strings.HasPrefix(path, "/api/companion/mappings") && request.Method != http.MethodGet:
			found = append(found, request.Method+" "+path)
		}
	}
	return found
}

func (hh *headlessHarness) assertBindingAndTokenIntact(t *testing.T, bound []byte, token []byte) {
	t.Helper()
	if now, err := os.ReadFile(filepath.Join(hh.data, "binding.json")); err != nil || !bytes.Equal(now, bound) {
		t.Fatalf("binding.json changed or went away: %v", err)
	}
	if now, err := os.ReadFile(hh.tokenPath); err != nil || !bytes.Equal(now, token) {
		t.Fatalf("the operator's token file changed or went away: %v", err)
	}
}

func TestHeadlessCLI_RefusesEveryOperatorManagedCommand(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.start(t)
	hh.waitForSessions(t, 1)
	bound, _ := os.ReadFile(filepath.Join(hh.data, "binding.json"))
	token, _ := os.ReadFile(hh.tokenPath)
	commands := [][]string{
		{"connect", "--endpoint", hh.server.URL, "--allow-insecure-loopback"},
		{"connect", "--endpoint", hh.server.URL, "--allow-insecure-loopback", "--replace"},
		{"connect", "--browser", "--endpoint", hh.server.URL, "--allow-insecure-loopback"},
		{"connect", "--browser", "--replace", "--endpoint", hh.server.URL, "--allow-insecure-loopback"},
		{"mcp"},
		{"disconnect"},
		{"uninstall", "--purge"},
	}
	for _, command := range commands {
		_, err := hh.cli(t, command...)
		if code := errorCode(err); code != "headless_operator_managed" {
			t.Errorf("%s: code %s (%v), want headless_operator_managed", strings.Join(command, " "), code, err)
		}
	}
	assertLocalized(t, "headless_operator_managed")
	if writes := operatorManagedWrites(hh.server); len(writes) != 0 {
		t.Fatalf("refused commands reached the server: %v", writes)
	}
	hh.assertBindingAndTokenIntact(t, bound, token)
}

func TestHeadlessControlAPI_RefusesEveryOperatorManagedWrite(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.env[envAllowInsecureLoopback] = "1"
	hh.start(t)
	hh.waitForSessions(t, 1)
	bound, _ := os.ReadFile(filepath.Join(hh.data, "binding.json"))
	token, _ := os.ReadFile(hh.tokenPath)
	calls := []struct{ method, path, body string }{
		{"POST", "/v1/pair/start", `{"endpoint":"` + hh.server.URL + `","replace":true}`},
		{"POST", "/v1/disconnect", ""},
		{"PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`},
		{"POST", "/v1/mappings", `{"workspace_id":"w","board_id":"b2","root_path":` + quoted(hh.repo) + `,"content_level":"metadata"}`},
		{"PATCH", "/v1/mappings/m1", `{"enabled":false,"content_level":"full"}`},
		{"DELETE", "/v1/mappings/m1", ""},
		{"PATCH", "/v1/settings", `{"exclude_globs":["**/secret/**"]}`},
		{"POST", "/v1/rename", `{"name":"desk"}`},
		{"GET", "/v1/sessions", ""},
	}
	for _, call := range calls {
		status, body := hh.control(t, call.method, call.path, call.body)
		if status < 400 {
			t.Errorf("%s %s answered %d: %s", call.method, call.path, status, body)
			continue
		}
		if code := envelopeCode(t, body); code != "headless_operator_managed" {
			t.Errorf("%s %s: code %s, want headless_operator_managed", call.method, call.path, code)
		}
	}
	// Without replace the connected device may also answer already_connected;
	// either way nothing pairs.
	if status, body := hh.control(t, "POST", "/v1/pair/start", `{"endpoint":"`+hh.server.URL+`"}`); status < 400 {
		t.Errorf("pair/start answered %d: %s", status, body)
	}
	if writes := operatorManagedWrites(hh.server); len(writes) != 0 {
		t.Fatalf("refused control calls reached the server: %v", writes)
	}
	hh.assertBindingAndTokenIntact(t, bound, token)
}

func TestHeadlessRun_NeverAutoMatchesARepository(t *testing.T) {
	hh := newHeadlessHarness(t)
	unmapped := gitRepo(t, filepath.Join(hh.home, "code", "unmapped"), "git@github.com:acme/unmapped.git")
	hh.server.Lock()
	hh.server.Policy.Installation.AutoMatchRepos = true
	hh.server.Policy.RepoCatalog = []policy.CatalogRepo{{WorkspaceID: "w", WorkspaceSlug: "w", BoardID: "b2", BoardName: "Unmapped", RepoURLNormalized: "github.com/acme/unmapped"}}
	hh.server.Resolvable["github.com/acme/unmapped"] = policy.Mapping{ID: "m2", WorkspaceID: "w", Enabled: true, ContentLevel: "standard"}
	hh.server.Unlock()
	hh.start(t)
	hh.waitForSessions(t, 1)
	hh.waitForPolicy(t)
	hh.hookIn(t, unmapped, "SessionStart")
	time.Sleep(2500 * time.Millisecond)
	if writes := operatorManagedWrites(hh.server); len(writes) != 0 {
		t.Fatalf("headless asked the server to map a repository: %v", writes)
	}
}

// dumpingBeaconManifest pins a Beacon stand-in that appends its
// environment, arguments and input to dump, so the test sees exactly what
// a child process received.
func dumpingBeaconManifest(t *testing.T, dir, dump string) string {
	t.Helper()
	executable := filepath.Join(dir, "beacon-dump")
	script := "#!/bin/sh\n/usr/bin/env >> '" + dump + "'\necho \"argv: $0 $*\" >> '" + dump + "'\n/bin/cat >> '" + dump + "'\nexit 0\n"
	mustWrite(t, executable, script)
	os.Chmod(executable, 0o700)
	return beaconManifestFor(t, dir, executable, script)
}

// beaconManifestFor pins executable, whose content is script, as the
// Beacon artifact.
func beaconManifestFor(t *testing.T, dir, executable, script string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(script))
	manifest := filepath.Join(dir, filepath.Base(executable)+".json")
	encoded, _ := json.Marshal(beacon.Manifest{Path: executable, SHA256: hex.EncodeToString(sum[:]), SourceCommit: beacon.Commit})
	mustWrite(t, manifest, string(encoded))
	return manifest
}

func TestHeadlessRun_TheTokenNeverLeavesMemory(t *testing.T) {
	hh := newHeadlessHarness(t)
	dump := filepath.Join(hh.root, "child-dump")
	hh.env[envBeaconArtifact] = dumpingBeaconManifest(t, hh.root, dump)
	run := hh.start(t)
	hh.waitForSessions(t, 1)
	hh.waitForPolicy(t)
	hh.hookIn(t, hh.repo, "SessionStart")
	waitForWithin(t, "the daemon to run a child process", 10*time.Second, func() bool {
		data, _ := os.ReadFile(dump)
		return bytes.Contains(data, []byte("argv:"))
	}, func() string { return logText(hh.logPath) })
	hh.enqueue(t, headlessCaptureID(14))
	waitForWithin(t, "an upload", 10*time.Second, func() bool {
		return containsID(receivedCaptureIDs(hh.server), headlessCaptureID(14))
	}, nil)

	outputs := map[string][]byte{}
	for _, command := range [][]string{{"status"}, {"status", "--human"}, {"version"}, {"projects", "list"}} {
		output, _ := hh.cli(t, command...)
		outputs["cli "+strings.Join(command, " ")] = []byte(output)
	}
	for _, path := range []string{"/v1/status", "/v1/version", "/v1/agents", "/v1/projects", "/v1/agent-access", "/v1/boards", "/v1/diagnostics"} {
		_, body := hh.control(t, "GET", path, "")
		outputs["control "+path] = body
		if path != "/v1/diagnostics" {
			continue
		}
		archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		if err != nil {
			t.Fatalf("diagnostics is not a zip archive: %v", err)
		}
		for _, file := range archive.File {
			reader, _ := file.Open()
			content, _ := io.ReadAll(reader)
			reader.Close()
			outputs["diagnostics "+file.Name] = content
		}
	}
	if _, err := run.stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}

	token := headlessSentinelToken()
	for name, output := range outputs {
		assertNoTokenTrace(t, name, output, token)
	}
	child, _ := os.ReadFile(dump)
	assertNoTokenTrace(t, "a child process's environment, arguments or input", child, token)
	for _, tree := range []string{hh.data, hh.home} {
		filepath.WalkDir(tree, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() || entry.Type()&fs.ModeSocket != 0 {
				return nil
			}
			data, _ := os.ReadFile(path)
			assertNoTokenTrace(t, path, data, token)
			return nil
		})
	}
	if calls := hh.keyring.calls.Load(); calls != 0 {
		t.Fatalf("the keyring was called %d times", calls)
	}
}

func TestHeadlessStatus_ReportsTheBindingAndItsHoldWithoutTheToken(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.start(t)
	hh.waitForSessions(t, 1)
	want := hh.identity(hh.server.URL, headlessInstallationID)
	members := func(source string, raw []byte) map[string]any {
		t.Helper()
		block, ok := headlessBlock(raw)
		if !ok {
			t.Fatalf("%s reports no headless mode:\n%s", source, raw)
		}
		if block["binding_id"] != want.ID() || block["origin"] != want.Origin || block["installation_id"] != headlessInstallationID || block["owner_email"] != headlessOwnerEmail {
			t.Fatalf("%s binding members: %v", source, block)
		}
		if state, _ := block["state"].(string); state == "" {
			t.Fatalf("%s reports no state: %v", source, block)
		}
		if quarantined, ok := block["quarantined"].([]any); !ok || len(quarantined) != 0 {
			t.Fatalf("%s quarantined must be an empty list: %v", source, block["quarantined"])
		}
		assertNoTokenTrace(t, source, raw, headlessSentinelToken())
		return block
	}
	output, err := hh.cli(t, "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	active := members("CLI status", []byte(output))
	if reason, _ := active["reason"].(string); reason != "" {
		t.Fatalf("a capturing binding reports a hold reason: %v", active)
	}
	_, body := hh.control(t, "GET", "/v1/status", "")
	members("control API status", body)

	if err := os.Remove(hh.tokenPath); err != nil {
		t.Fatal(err)
	}
	held := hh.controlHeadlessReason(t, "credential_missing")
	if held["state"] == active["state"] {
		t.Fatalf("a held binding reports the capturing state %v", held["state"])
	}
	since, _ := held["since"].(string)
	if _, err := time.Parse(time.RFC3339, since); err != nil {
		t.Fatalf("hold since %q is not a time: %v", since, err)
	}
	output, _ = hh.cli(t, "status")
	if block := members("CLI status while held", []byte(output)); block["reason"] != "credential_missing" {
		t.Fatalf("CLI status does not show the daemon's hold: %v", block)
	}
}
