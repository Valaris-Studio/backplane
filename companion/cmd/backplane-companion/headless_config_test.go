// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/binding"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// assertLocalized checks a stable code has its own message in every
// language the companion speaks.
func assertLocalized(t *testing.T, code string) {
	t.Helper()
	translations, ok := messages[code]
	if !ok {
		t.Fatalf("no localized message for %s", code)
	}
	for index, text := range translations {
		if strings.TrimSpace(text) == "" || text == code {
			t.Fatalf("%s has no message in language %d: %q", code, index, text)
		}
	}
	if translations[0] == translations[1] || translations[0] == translations[2] {
		t.Fatalf("%s is not translated: %q", code, translations)
	}
}

func TestHeadlessRun_RefusesToStartWithAKeyringSelected(t *testing.T) {
	for _, selection := range []string{credentials.DevStoreValue, "keyring"} {
		t.Run(selection, func(t *testing.T) {
			hh := newHeadlessHarness(t)
			hh.env[credentials.EnvStore] = selection
			err := hh.runRefused(t, "--headless-config", hh.configPath, "--log", hh.logPath)
			if code := errorCode(err); code != "credential_source_conflict" {
				t.Fatalf("headless config with %s=%s: code %s (%v)", credentials.EnvStore, selection, code, err)
			}
			assertLocalized(t, "credential_source_conflict")
			if requests := hh.server.Requests(); len(requests) != 0 {
				t.Fatalf("a refused start reached the server:\n%s", describeRequests(requests))
			}
			if _, err := os.Stat(filepath.Join(hh.data, "binding.json")); err == nil {
				t.Fatal("a refused start bound the data root")
			}
		})
	}
}

func TestHeadlessRun_RefusesAConfigItCannotTrust(t *testing.T) {
	sentinel := headlessSentinelToken()
	cases := []struct {
		name string
		// prepare edits the config document or the files; it returns the
		// --headless-config argument.
		prepare func(t *testing.T, hh *headlessHarness, config map[string]any) string
	}{
		{"unknown key", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			config["api_key"] = "vlr_" + strings.Repeat("k", 20)
			hh.writeConfig(t, config)
			return hh.configPath
		}},
		{"path-prefixed endpoint", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			config["endpoint"] = hh.server.URL + "/backplane"
			hh.writeConfig(t, config)
			return hh.configPath
		}},
		{"plain http without the loopback flag", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			delete(config, "allow_loopback_http")
			hh.writeConfig(t, config)
			return hh.configPath
		}},
		{"token pasted as the token file", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			config["token_file"] = filepath.Join(hh.tokenDir, sentinel)
			hh.writeConfig(t, config)
			return hh.configPath
		}},
		{"installation id not a uuid", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			config["installation_id"] = "installation-one"
			hh.writeConfig(t, config)
			return hh.configPath
		}},
		{"owner email without an address", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			config["owner_email"] = "owner"
			hh.writeConfig(t, config)
			return hh.configPath
		}},
		{"group-writable config", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			if err := os.Chmod(hh.configPath, 0o620); err != nil {
				t.Fatal(err)
			}
			return hh.configPath
		}},
		{"other-writable config", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			if err := os.Chmod(hh.configPath, 0o602); err != nil {
				t.Fatal(err)
			}
			return hh.configPath
		}},
		{"symlinked config", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			link := filepath.Join(hh.configDir, "linked.json")
			if err := os.Symlink(hh.configPath, link); err != nil {
				t.Fatal(err)
			}
			return link
		}},
		{"config in an other-writable directory", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			if err := os.Chmod(hh.configDir, 0o777); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.Chmod(hh.configDir, 0o700) })
			return hh.configPath
		}},
		{"relative config path", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			return "companion.json"
		}},
		{"missing config", func(t *testing.T, hh *headlessHarness, config map[string]any) string {
			return filepath.Join(hh.configDir, "absent.json")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHeadlessHarness(t)
			config := hh.configFor(hh.server.URL, headlessInstallationID)
			argument := tc.prepare(t, hh, config)
			err := hh.runRefused(t, "--headless-config", argument, "--log", hh.logPath)
			if err == nil {
				t.Fatal("an untrusted config started the daemon")
			}
			if code := errorCode(err); code == "usage" || code == "internal_error" {
				t.Fatalf("the refusal has no stable code of its own: %s (%v)", code, err)
			}
			assertNoTokenTrace(t, "the refusal", []byte(err.Error()+localizedError(err, "en")), sentinel)
			assertNoTokenTrace(t, "the log", []byte(logText(hh.logPath)), sentinel)
			if requests := hh.server.Requests(); len(requests) != 0 {
				t.Fatalf("a refused config reached the server:\n%s", describeRequests(requests))
			}
			if _, err := os.Stat(filepath.Join(hh.data, "binding.json")); err == nil {
				t.Fatal("a refused config bound the data root")
			}
		})
	}
}

func TestHeadlessRun_BindsTheNormalizedIdentityAfterMeVerifies(t *testing.T) {
	hh := newHeadlessHarness(t)
	// The server spells the owner's email its own way; both sides compare
	// trimmed and lowercased.
	hh.server.Lock()
	hh.server.DeviceTokens[headlessSentinelToken()].OwnerEmail = "Owner@Example.Test"
	hh.server.Unlock()
	config := hh.configFor(strings.Replace(hh.server.URL, "http://", "HTTP://", 1)+"/", strings.ToUpper(headlessInstallationID))
	config["owner_email"] = "  OWNER@example.TEST "
	hh.writeConfig(t, config)

	run := hh.start(t)
	hh.waitForSessions(t, 1)
	want := hh.identity(hh.server.URL, headlessInstallationID)
	record := hh.boundRecord(t)
	if record.BindingID != want.ID() || record.Origin != want.Origin || record.InstallationID != headlessInstallationID || record.OwnerEmail != headlessOwnerEmail {
		t.Fatalf("binding.json %+v, want the normalized identity %+v (%s)", record, want, want.ID())
	}
	installation, err := state.Load[state.Installation](store.Layout{Root: hh.data}.Installation())
	if err != nil || installation.ID != headlessInstallationID || installation.Endpoint != want.Origin || !installation.ConnectedAt.Equal(record.BoundAt) {
		t.Fatalf("installation.json %+v (%v): want id %s, endpoint %s, connected_at = bound_at %v", installation, err, headlessInstallationID, want.Origin, record.BoundAt)
	}

	hh.enqueue(t, headlessCaptureID(1))
	waitForWithin(t, "the queued record to upload", 10*time.Second, func() bool {
		return containsID(receivedCaptureIDs(hh.server), headlessCaptureID(1))
	}, func() string { return describeRequests(hh.server.Requests()) })
	if _, err := run.stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}

	requests := hh.server.Requests()
	if len(requests) == 0 || requests[0].Method != "GET" || requests[0].Path != headlessMePath {
		t.Fatalf("the first request must verify the token with GET /me:\n%s", describeRequests(requests))
	}
	for _, request := range requests {
		if !headlessAllowedPath(request.Method, request.Path) {
			t.Errorf("headless sent %s %s, outside the allowlist", request.Method, request.Path)
		}
		if request.Token != headlessSentinelToken() {
			t.Errorf("%s %s carried another credential (BACKPLANE_API_KEY must be ignored)", request.Method, request.Path)
		}
	}
	if calls := hh.keyring.calls.Load(); calls != 0 {
		t.Fatalf("the keyring was called %d times", calls)
	}
}

func TestHeadlessRun_NeverAdoptsADesktopDataRoot(t *testing.T) {
	hh := newHeadlessHarness(t)
	// A desktop connection's state, with no binding.json.
	layout, err := store.Open(hh.data)
	if err != nil {
		t.Fatal(err)
	}
	store.WriteJSON(layout.Installation(), state.Installation{ID: headlessInstallationID, Endpoint: hh.server.URL, AllowLoopbackHTTP: true, ConnectedAt: time.Now().UTC()})
	hh.enqueue(t, headlessCaptureID(7))
	before := connectionScopedDigest(t, hh.data)

	hh.start(t)
	var last []byte
	waitForWithin(t, "the daemon to report the unbound state as a hold", 10*time.Second, func() bool {
		_, body := hh.control(t, "GET", "/v1/status", "")
		last = body
		block, ok := headlessBlock(body)
		reason, _ := block["reason"].(string)
		return ok && reason != ""
	}, func() string { return string(last) })
	time.Sleep(300 * time.Millisecond)
	if others := requestsBesides(hh.server, headlessMePath); len(others) != 0 {
		t.Fatalf("an unbound desktop root was captured for: %v", others)
	}
	if record, _ := binding.Load(hh.data); record != nil {
		t.Fatalf("a desktop data root was silently bound: %+v", record)
	}
	assertSameDigest(t, "the desktop connection's state", before, connectionScopedDigest(t, hh.data))
	if ids := receivedCaptureIDs(hh.server); len(ids) != 0 {
		t.Fatalf("desktop records were uploaded under the configured identity: %v", ids)
	}
}
