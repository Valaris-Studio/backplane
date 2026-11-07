// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/hook"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// The hook socket is how a Hermes worker running as another uid hands the
// headless Companion a record. It exists only while a verified binding
// captures, serves only the configured peer uid, and is handled by the same
// shim as `hook hermes`.

// hookCodingUID is the worker uid the socket is configured for; this test
// process is the Companion's uid, which the socket never serves.
func hookCodingUID() int { return os.Getuid() + 1 }

// asHookCodingUID makes the daemon read every peer as the coding uid, so
// this process can play the worker.
func asHookCodingUID(net.Conn) (int, error) { return hookCodingUID(), nil }

// hookSocketDir is a 0711 directory this user owns, short enough for
// sun_path, as the operator creates on the host.
func hookSocketDir(t *testing.T) string {
	t.Helper()
	dir := shortDataDir(t)
	if err := os.Chmod(dir, 0o711); err != nil {
		t.Fatal(err)
	}
	return dir
}

// configWithHook names the hook socket and, since the fake policy enables
// only Claude Code, lets the installation capture Hermes too.
func (hh *headlessHarness) configWithHook(socket string, peerUID int) map[string]any {
	hh.server.Lock()
	hh.server.Policy.Installation.EnabledAgents = []string{"claude_code", "hermes_agent"}
	hh.server.Unlock()
	config := hh.configFor(hh.server.URL, headlessInstallationID)
	config["hook_socket"] = socket
	config["hook_peer_uid"] = peerUID
	return config
}

// hermesHookPayload is the plugin's projection of on_session_start, with a
// fixed observed_at so two routes of the same record compare byte for byte.
func hermesHookPayload(cwd string) string {
	return `{"hook_event_name":"on_session_start","session_id":"20261025_101500_a1b2c3","cwd":` + quoted(cwd) +
		`,"tool_name":null,"tool_input":null,"extra":{"model":"synthetic-model-1","platform":"cli",` +
		`"observed_at":"2026-10-25T10:15:00.000000Z","plugin_schema":"backplane.hermes.v1"}}`
}

// sendHookFrame plays the plugin: one frame, half-close, read the reply.
func sendHookFrame(t *testing.T, socket, agent, payload string) (string, error) {
	t.Helper()
	conn, err := net.DialTimeout("unix", socket, time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err := io.WriteString(conn, agent+"\n"+payload); err != nil {
		return "", err
	}
	if err := conn.(*net.UnixConn).CloseWrite(); err != nil {
		return "", err
	}
	reply, err := io.ReadAll(conn)
	return string(reply), err
}

// copyingBeaconManifest pins a Beacon stand-in that copies each call's
// input to its own file, so the test sees exactly what each inbox item
// became.
func copyingBeaconManifest(t *testing.T, dir, dumps string) string {
	t.Helper()
	mustMkdir(t, dumps)
	executable := filepath.Join(dir, "beacon-copy")
	// Written whole, then renamed: the test reads only complete inputs.
	script := "#!/bin/sh\n/bin/cat > '" + dumps + "/'$$'.part' && /bin/mv '" + dumps + "/'$$'.part' '" + dumps + "/'$$'.json'\nexit 0\n"
	mustWrite(t, executable, script)
	os.Chmod(executable, 0o700)
	return beaconManifestFor(t, dir, executable, script)
}

func dumpedBeaconInputs(t *testing.T, dumps string) [][]byte {
	t.Helper()
	entries, _ := os.ReadDir(dumps)
	var inputs [][]byte
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dumps, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		inputs = append(inputs, data)
	}
	return inputs
}

func socketAbsent(socket string) bool {
	_, err := os.Lstat(socket)
	return errors.Is(err, os.ErrNotExist)
}

func hookHealth(t *testing.T, data string) state.Health {
	t.Helper()
	health, err := state.Load[state.Health](store.Layout{Root: data}.Health())
	if err != nil {
		t.Fatal(err)
	}
	return health
}

func TestHeadlessRun_HookSocketDeliversTheRecordTheSubprocessRouteWould(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.hookPeerUID = asHookCodingUID
	dumps := filepath.Join(hh.root, "beacon-inputs")
	hh.env[envBeaconArtifact] = copyingBeaconManifest(t, hh.root, dumps)
	socket := filepath.Join(hookSocketDir(t), "hook.sock")
	hh.writeConfig(t, hh.configWithHook(socket, hookCodingUID()))
	run := hh.start(t)
	hh.waitForSessions(t, 1)
	hh.waitForPolicy(t)
	waitForFile(t, socket)
	info, err := os.Lstat(socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o666 {
		t.Fatalf("hook socket %v: %v; want a 0666 socket the worker uid can connect to", info, err)
	}

	payload := hermesHookPayload(hh.repo)
	reply, err := sendHookFrame(t, socket, "hermes", payload)
	if err != nil || reply != "{}\n" {
		t.Fatalf("socket reply %q, err %v; want {} once the record is consumed", reply, err)
	}
	waitForWithin(t, "the socket record to reach Beacon", 10*time.Second, func() bool {
		return len(dumpedBeaconInputs(t, dumps)) == 1
	}, func() string {
		health, _ := os.ReadFile(filepath.Join(hh.data, "health.json"))
		names, _ := inbox.List(filepath.Join(hh.data, "inbox"))
		return logText(hh.logPath) + "\nhealth: " + string(health) + "\ninbox: " + strings.Join(names, ",")
	})

	// The same record through `hook hermes`, as the same-uid plugin sends it.
	process := hh.process()
	process.stdin = strings.NewReader(payload)
	process.runHook([]string{"hermes"})
	waitForWithin(t, "the subprocess record to reach Beacon", 10*time.Second, func() bool {
		return len(dumpedBeaconInputs(t, dumps)) == 2
	}, func() string { return logText(hh.logPath) })
	inputs := dumpedBeaconInputs(t, dumps)
	if !bytes.Equal(inputs[0], inputs[1]) {
		t.Fatalf("the socket route produced a different record than the subprocess route:\nsocket     %s\nsubprocess %s", inputs[0], inputs[1])
	}
	if !bytes.Contains(inputs[0], []byte(`"session_id":"20261025_101500_a1b2c3"`)) {
		t.Fatalf("the record lost its identity: %s", inputs[0])
	}
	if health := hookHealth(t, hh.data); health.HookErrors != 0 {
		t.Fatalf("a consumed record was counted as a hook error: %+v", health)
	}

	if _, err := run.stop(); err != nil {
		t.Fatal(err)
	}
	if !socketAbsent(socket) {
		t.Fatal("the hook socket outlived the daemon")
	}
}

// Uses the kernel's peer credentials: this process is not the coding uid.
func TestHeadlessRun_HookSocketRefusesAnotherPeerWithoutAWrite(t *testing.T) {
	hh := newHeadlessHarness(t)
	socket := filepath.Join(hookSocketDir(t), "hook.sock")
	hh.writeConfig(t, hh.configWithHook(socket, hookCodingUID()))
	hh.start(t)
	hh.waitForSessions(t, 1)
	hh.waitForPolicy(t)
	waitForFile(t, socket)
	ingests := requestsTo(hh.server, headlessIngestPath)

	reply, _ := sendHookFrame(t, socket, "hermes", hermesHookPayload(hh.repo))
	if reply != "" {
		t.Fatalf("another uid got a reply %q", reply)
	}
	time.Sleep(500 * time.Millisecond)
	if names, _ := inbox.List(filepath.Join(hh.data, "inbox")); len(names) != 0 {
		t.Fatalf("another uid's record was written to the inbox: %v", names)
	}
	if health := hookHealth(t, hh.data); health.HookErrors != 0 {
		t.Fatalf("a refused peer was counted as a hook error: %+v", health)
	}
	if got := requestsTo(hh.server, headlessIngestPath); got != ingests {
		t.Fatalf("another uid's record was uploaded (%d ingests, was %d)", got, ingests)
	}
}

func TestHeadlessRun_HookSocketCountsRefusedFramesContentFree(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.hookPeerUID = asHookCodingUID
	socket := filepath.Join(hookSocketDir(t), "hook.sock")
	hh.writeConfig(t, hh.configWithHook(socket, hookCodingUID()))
	hh.start(t)
	hh.waitForSessions(t, 1)
	hh.waitForPolicy(t)
	waitForFile(t, socket)
	secret := "sk-live-" + strings.Repeat("Q", 24)
	cases := []struct {
		name    string
		agent   string
		payload string
		code    string
	}{
		{"oversized", "hermes", `{"pad":"` + strings.Repeat("a", hook.MaxPayloadBytes) + `"}`, "hook_payload_too_large"},
		{"unknown agent", "nobody", hermesHookPayload(hh.repo), "hook_agent_not_served"},
		{"agent without plugin ingress", "claude-code", hookPayload(hh.repo, "SessionStart", ""), "hook_agent_not_served"},
		{"invalid payload", "hermes", `{"hook_event_name":"on_session_start","note":"` + secret + `"`, "invalid_hook_payload"},
	}
	for index, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reply, _ := sendHookFrame(t, socket, tc.agent, tc.payload)
			if tc.code != "invalid_hook_payload" && reply != "" {
				t.Fatalf("a frame the socket refused got a reply %q", reply)
			}
			waitForWithin(t, "the refusal to be counted", 10*time.Second, func() bool {
				return hookHealth(t, hh.data).HookErrors == uint64(index+1)
			}, func() string { return logText(hh.logPath) })
			if health := hookHealth(t, hh.data); health.HookLastError != tc.code {
				t.Fatalf("health says %q, want %q", health.HookLastError, tc.code)
			}
		})
	}
	if names, _ := inbox.List(filepath.Join(hh.data, "inbox")); len(names) != 0 {
		t.Fatalf("a refused frame was written to the inbox: %v", names)
	}
	for _, path := range []string{hh.logPath, filepath.Join(hh.data, "health.json")} {
		if data, _ := os.ReadFile(path); bytes.Contains(data, []byte(secret)) {
			t.Fatalf("a refused payload's content reached %s", path)
		}
	}
}

func TestHeadlessRun_HookSocketExistsOnlyInsideTheVerifiedSession(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.hookPeerUID = asHookCodingUID
	socket := filepath.Join(hookSocketDir(t), "hook.sock")
	hh.writeConfig(t, hh.configWithHook(socket, hookCodingUID()))

	// Held before verification: the server rejects the token file.
	hh.server.RevokeDeviceToken(headlessSentinelToken())
	run := hh.start(t)
	hh.waitForLogReason(t, "credential_rejected", 10*time.Second)
	time.Sleep(200 * time.Millisecond)
	if !socketAbsent(socket) {
		t.Fatal("the hook socket exists before the binding is verified")
	}
	if _, err := sendHookFrame(t, socket, "hermes", hermesHookPayload(hh.repo)); err == nil {
		t.Fatal("a record was accepted during a hold")
	}

	// The operator replaces the token: the session starts and the socket appears.
	hh.server.IssueDeviceToken(headlessRotatedToken(), headlessInstallationID, headlessOwnerEmail)
	hh.writeToken(t, headlessRotatedToken())
	hh.waitForSessions(t, 1)
	hh.waitForPolicy(t)
	waitForFile(t, socket)

	// The server rejects the new token: the session ends and the socket
	// is gone before the next hold, so nothing is retained for a later binding.
	hh.server.RevokeDeviceToken(headlessRotatedToken())
	hh.enqueue(t, headlessCaptureID(61))
	waitForWithin(t, "the socket to close with the rejected session", 10*time.Second, func() bool {
		return socketAbsent(socket)
	}, func() string { return logText(hh.logPath) })
	if _, err := sendHookFrame(t, socket, "hermes", hermesHookPayload(hh.repo)); err == nil {
		t.Fatal("a record was accepted while the binding was held")
	}
	if names, _ := inbox.List(filepath.Join(hh.data, "inbox")); len(names) != 0 {
		t.Fatalf("records were retained across the hold: %v", names)
	}
	if _, err := run.stop(); err != nil {
		t.Fatal(err)
	}
}

func TestHeadlessRun_HookSocketIsAbsentWithoutTheConfigFields(t *testing.T) {
	hh := newHeadlessHarness(t)
	dir := hookSocketDir(t)
	hh.start(t)
	hh.waitForSessions(t, 1)
	hh.waitForPolicy(t)
	time.Sleep(200 * time.Millisecond)
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("a listener appeared without hook_socket: %v", entries)
	}
	filepath.WalkDir(hh.data, func(path string, entry os.DirEntry, err error) error {
		if err == nil && entry.Type()&os.ModeSocket != 0 && filepath.Base(path) != "control.sock" {
			t.Errorf("unexpected socket %s", path)
		}
		return nil
	})
}

func TestHeadlessRun_RefusesAHookConfigItCannotTrust(t *testing.T) {
	cases := []struct {
		name    string
		prepare func(t *testing.T, hh *headlessHarness, config map[string]any)
		code    string
	}{
		{"hook_socket without hook_peer_uid", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			delete(config, "hook_peer_uid")
		}, "headless_config_invalid"},
		{"hook_peer_uid without hook_socket", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			delete(config, "hook_socket")
		}, "headless_config_invalid"},
		{"relative hook_socket", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			config["hook_socket"] = "run/hook.sock"
		}, "headless_config_invalid"},
		{"unclean hook_socket", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			config["hook_socket"] = config["hook_socket"].(string) + "/."
		}, "headless_config_invalid"},
		{"peer uid 0", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			config["hook_peer_uid"] = 0
		}, "headless_config_invalid"},
		{"peer uid of the companion itself", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			config["hook_peer_uid"] = os.Getuid()
		}, "headless_config_invalid"},
		{"negative peer uid", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			config["hook_peer_uid"] = -1
		}, "headless_config_invalid"},
		{"peer uid that is not an integer", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			config["hook_peer_uid"] = "10000"
		}, "headless_config_invalid"},
		{"world-writable socket directory", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			os.Chmod(filepath.Dir(config["hook_socket"].(string)), 0o777)
		}, "unsafe_hook_directory"},
		{"group-writable socket directory", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			os.Chmod(filepath.Dir(config["hook_socket"].(string)), 0o771)
		}, "unsafe_hook_directory"},
		{"symlinked socket directory", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			link := filepath.Join(hookSocketDir(t), "d")
			os.Symlink(filepath.Dir(config["hook_socket"].(string)), link)
			config["hook_socket"] = filepath.Join(link, "hook.sock")
		}, "unsafe_hook_directory"},
		{"regular file at the socket path", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			mustWrite(t, config["hook_socket"].(string), "not a socket")
		}, "unsafe_hook_directory"},
		{"symlink at the socket path", func(t *testing.T, hh *headlessHarness, config map[string]any) {
			os.Symlink(filepath.Join(hookSocketDir(t), "elsewhere.sock"), config["hook_socket"].(string))
		}, "unsafe_hook_directory"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHeadlessHarness(t)
			socket := filepath.Join(hookSocketDir(t), "hook.sock")
			config := hh.configWithHook(socket, hookCodingUID())
			tc.prepare(t, hh, config)
			hh.writeConfig(t, config)
			err := hh.runRefused(t, "--headless-config", hh.configPath, "--log", hh.logPath)
			if code := errorCode(err); code != tc.code {
				t.Fatalf("code %s (%v), want %s", code, err, tc.code)
			}
			assertLocalized(t, tc.code)
			if requests := hh.server.Requests(); len(requests) != 0 {
				t.Fatalf("a refused start reached the server:\n%s", describeRequests(requests))
			}
			if _, err := os.Lstat(filepath.Join(hh.data, "binding.json")); err == nil {
				t.Fatal("a refused start bound the data root")
			}
		})
	}
}
