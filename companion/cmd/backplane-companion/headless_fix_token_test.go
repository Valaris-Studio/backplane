// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestHeadlessFixRun_ARestartNeverResendsATokenFileTheServerRejected(t *testing.T) {
	hh := newHeadlessHarness(t)
	bound := hh.bindAndStop(t)
	id := headlessCaptureID(50)
	hh.enqueue(t, id)
	hh.server.RevokeDeviceToken(headlessSentinelToken())
	run := hh.start(t)
	hh.waitForLogReason(t, "credential_rejected", 10*time.Second)
	hh.controlHeadlessReason(t, "credential_rejected")
	if _, err := run.stop(); err != nil {
		t.Fatalf("stopping the rejected run: %v", err)
	}
	rejected := len(hh.server.Requests())

	// A restart (restart: unless-stopped, a reboot, a crash loop) with the
	// very file the server rejected sends nothing at all.
	hh.start(t)
	hh.controlHeadlessReason(t, "credential_rejected")
	time.Sleep(50*headlessPoll + 500*time.Millisecond)
	if sent := requestsAfter(hh.server, rejected); len(sent) != 0 {
		t.Fatalf("the restarted daemon sent the rejected token file again:\n%s", describeRequests(sent))
	}
	// What is remembered of the rejected file is its metadata, never its
	// bytes or a digest of them.
	filepath.WalkDir(hh.data, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Type()&os.ModeSocket != 0 {
			return nil
		}
		data, _ := os.ReadFile(path)
		assertNoTokenTrace(t, path, data, headlessSentinelToken())
		return nil
	})

	// The operator replaces the file: the restarted daemon uses it at once.
	hh.server.IssueDeviceToken(headlessRotatedToken(), headlessInstallationID, headlessOwnerEmail)
	hh.writeToken(t, headlessRotatedToken())
	waitForWithin(t, "the queued record to upload with the replaced token", 10*time.Second, func() bool {
		return containsID(receivedCaptureIDs(hh.server), id)
	}, func() string { return logText(hh.logPath) })
	if stale := withToken(requestsAfter(hh.server, rejected), headlessSentinelToken()); stale != 0 {
		t.Fatalf("the rejected token was sent %d times after the restart", stale)
	}
	if record := hh.boundRecord(t); record.BindingID != bound.BindingID || !record.BoundAt.Equal(bound.BoundAt) {
		t.Fatalf("the replaced token changed the binding: %+v, was %+v", record, bound)
	}
}

// fixPlaceToken writes token to path as an operator would provision it and
// returns the file's group, which the config must name.
func fixPlaceToken(t *testing.T, path, token string) int {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	incoming := filepath.Join(filepath.Dir(path), ".incoming-token")
	if err := os.WriteFile(incoming, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(incoming, path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return int(info.Sys().(*syscall.Stat_t).Gid)
}

func TestHeadlessFixRun_RefusesATokenFileInsideTheDataRoot(t *testing.T) {
	sentinel := headlessSentinelToken()
	for _, tc := range []struct{ name, relative string }{
		{"at the data root", "device-token"},
		// A switch renames rich/ into quarantine, taking the credential along.
		{"under rich, which a switch quarantines", filepath.Join("rich", "device-token")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hh := newHeadlessHarness(t)
			inside := filepath.Join(hh.data, tc.relative)
			config := hh.configFor(hh.server.URL, headlessInstallationID)
			config["token_gid"] = fixPlaceToken(t, inside, sentinel)
			config["token_file"] = inside
			hh.writeConfig(t, config)

			err := hh.runRefused(t, "--headless-config", hh.configPath, "--log", hh.logPath)
			if err == nil {
				t.Fatal("a token file inside the data root started the daemon")
			}
			code := errorCode(err)
			if code == "usage" || code == "internal_error" {
				t.Fatalf("the refusal has no stable code of its own: %s (%v)", code, err)
			}
			assertLocalized(t, code)
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
	// Only containment counts: a directory beside the root whose name merely
	// starts with the root's is outside it.
	t.Run("beside the data root, sharing its name as a prefix", func(t *testing.T) {
		hh := newHeadlessHarness(t)
		beside := hh.data + "-token"
		t.Cleanup(func() { os.RemoveAll(beside) })
		path := filepath.Join(beside, "device-token")
		config := hh.configFor(hh.server.URL, headlessInstallationID)
		config["token_gid"] = fixPlaceToken(t, path, sentinel)
		config["token_file"] = path
		hh.writeConfig(t, config)
		hh.start(t)
		hh.waitForSessions(t, 1)
	})
}
