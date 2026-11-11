// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/hermes"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/binding"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// Headless mode is selected only by `run --headless-config /abs/path.json`;
// the token is an operator-provisioned file and no keyring is ever used.

const (
	headlessInstallationID      = "7a1c0de5-0000-4000-8000-0000000000a1"
	headlessOtherInstallationID = "7a1c0de5-0000-4000-8000-0000000000b2"
	headlessOwnerEmail          = "owner@example.test"
	headlessOtherOwnerEmail     = "someone-else@example.test"

	headlessMePath     = "/api/companion/me"
	headlessPolicyPath = "/api/companion/policy"
	headlessIngestPath = "/api/companion/ingest"
	headlessStatusPath = "/api/companion/status"

	// headlessPoll is the injected wait-for-connection interval; the hold
	// backoff (30 s to 5 min in production) starts from it.
	headlessPoll = 20 * time.Millisecond
	// sessionEndBound is the contract's ~2.2 s for a token change to end a
	// session, with room for the race detector.
	sessionEndBound = 3 * time.Second
	// drainBound is the contract's 8 s stop drain, with room to exit.
	drainBound = 8 * time.Second
)

// Device tokens are built at runtime in the server's exact format, so no
// token literal is ever in source and every trace of one is findable.
func headlessSentinelToken() string { return "bpc_" + strings.Repeat("Sn7", 14) + "q" }
func headlessRotatedToken() string  { return "bpc_" + strings.Repeat("Rt4", 14) + "w" }
func headlessForeignToken() string  { return "bpc_" + strings.Repeat("Fx2", 14) + "k" }

var errKeyringTouched = errors.New("keyring_touched_in_headless_mode")

// failingKeyring fails the test on any call: headless mode never reads,
// writes, probes or deletes a keyring entry.
type failingKeyring struct {
	t     *testing.T
	calls *atomic.Int32
}

func (k failingKeyring) touched(method, account string) error {
	k.calls.Add(1)
	k.t.Errorf("headless mode touched the keyring: %s(%q)", method, account)
	return errKeyringTouched
}

func (k failingKeyring) Save(account, _ string) error { return k.touched("Save", account) }
func (k failingKeyring) Load(account string) (string, error) {
	return "", k.touched("Load", account)
}
func (k failingKeyring) Delete(account string) error { return k.touched("Delete", account) }

type headlessHarness struct {
	*harness
	keyring    failingKeyring
	tokenDir   string
	tokenPath  string
	tokenGID   int
	configDir  string
	configPath string
	logPath    string
	// config is what writeConfig last wrote.
	config map[string]any
	// hookPeerUID replaces the kernel's peer credentials on the hook socket.
	hookPeerUID func(net.Conn) (int, error)
}

// newHeadlessHarness binds nothing yet: the fake issues the sentinel token
// for the configured installation and owner, the token file holds it, and
// the config names both. BACKPLANE_API_KEY stays set, to be ignored.
func newHeadlessHarness(t *testing.T) *headlessHarness {
	t.Helper()
	// The out-of-tree runner exports a keyring selection; headless reads its
	// environment through app.getenv only, and must not be confused by it.
	t.Setenv(credentials.EnvStore, "")
	os.Unsetenv(credentials.EnvStore)
	h := newHarness(t)
	h.data = shortDataDir(t)
	h.env[store.EnvHome] = h.data
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	hh := &headlessHarness{harness: h, keyring: failingKeyring{t: t, calls: &atomic.Int32{}}}
	hh.tokenDir = headlessPrivateDir(t)
	hh.tokenPath = filepath.Join(hh.tokenDir, "device-token")
	hh.configDir = headlessPrivateDir(t)
	hh.configPath = filepath.Join(hh.configDir, "companion.json")
	hh.logPath = filepath.Join(h.data, "logs", "companion.log")
	h.app = hh.process()
	h.server.IssueDeviceToken(headlessSentinelToken(), headlessInstallationID, headlessOwnerEmail)
	hh.writeToken(t, headlessSentinelToken())
	hh.writeConfig(t, hh.configFor(h.server.URL, headlessInstallationID))
	return hh
}

// process is a fresh app, as a new process of the companion would be.
func (hh *headlessHarness) process() *app {
	process := hh.makeApp(func(key string) string { return hh.env[key] }, &bytes.Buffer{})
	process.keyring = hh.keyring
	process.connectPollInterval = headlessPoll
	process.hookPeerUID = hh.hookPeerUID
	// The hook socket serves Hermes, which the shared test registry leaves
	// out so the status goldens stay as they are.
	process.registry = agent.NewRegistry(claudecode.New(), pi.New(), codex.New(), hermes.New())
	return process
}

// headlessPrivateDir is a temp directory named without symlinks whose
// ancestors pass the token-file rules (owned by root or this user, writable
// by no one else unless sticky); a host where they do not is skipped.
func headlessPrivateDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for current := dir; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			t.Fatal(err)
		}
		owner := info.Sys().(*syscall.Stat_t).Uid
		othersWrite := info.Mode().Perm()&0o022 != 0 && info.Mode()&os.ModeSticky == 0
		if !info.IsDir() || owner != 0 && int(owner) != os.Getuid() || othersWrite {
			t.Skipf("the temp directory fails the token-file ancestor rules on this host: %s", current)
		}
		if current == filepath.Dir(current) {
			return dir
		}
	}
}

// writeToken replaces the token file the way the operator policy says: a
// temp file in the same directory, renamed over the path.
func (hh *headlessHarness) writeToken(t *testing.T, token string) {
	t.Helper()
	incoming := filepath.Join(hh.tokenDir, ".incoming")
	if err := os.WriteFile(incoming, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(incoming, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(incoming, hh.tokenPath); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(hh.tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	hh.tokenGID = int(info.Sys().(*syscall.Stat_t).Gid)
}

func (hh *headlessHarness) configFor(endpoint, installationID string) map[string]any {
	return map[string]any{
		"endpoint":            endpoint,
		"token_file":          hh.tokenPath,
		"installation_id":     installationID,
		"owner_email":         headlessOwnerEmail,
		"token_gid":           hh.tokenGID,
		"allow_loopback_http": true,
	}
}

// writeConfig replaces the config atomically, as an operator edit would.
func (hh *headlessHarness) writeConfig(t *testing.T, config map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	incoming := filepath.Join(hh.configDir, ".incoming")
	if err := os.WriteFile(incoming, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(incoming, hh.configPath); err != nil {
		t.Fatal(err)
	}
	hh.config = config
}

// headlessRun is one headless daemon process.
type headlessRun struct {
	cancel  context.CancelFunc
	done    chan error
	once    sync.Once
	err     error
	elapsed time.Duration
}

// stop delivers SIGTERM (the context main cancels on it) and waits.
func (r *headlessRun) stop() (time.Duration, error) {
	r.once.Do(func() {
		started := time.Now()
		r.cancel()
		r.err = <-r.done
		r.elapsed = time.Since(started)
	})
	return r.elapsed, r.err
}

// start runs `run --headless-config` in a fresh process app. A run that
// returns at once (an unknown flag, a refused config) fails the test.
func (hh *headlessHarness) start(t *testing.T) *headlessRun {
	t.Helper()
	process := hh.process()
	ctx, cancel := context.WithCancel(context.Background())
	run := &headlessRun{cancel: cancel, done: make(chan error, 1)}
	go func() {
		run.done <- process.run(ctx, []string{"run", "--headless-config", hh.configPath, "--log", hh.logPath})
	}()
	t.Cleanup(func() {
		if _, err := run.stop(); err != nil && !t.Failed() {
			t.Errorf("headless run: %v", err)
		}
	})
	select {
	case err := <-run.done:
		run.done <- err
		t.Fatalf("headless run exited at once: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	return run
}

// runRefused runs a headless start that must be refused, and returns why.
func (hh *headlessHarness) runRefused(t *testing.T, args ...string) error {
	t.Helper()
	process := hh.process()
	done := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { done <- process.run(ctx, append([]string{"run"}, args...)) }()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		cancel()
		<-done
		t.Fatalf("run %v kept running instead of refusing to start", args)
		return nil
	}
}

// bindAndStop starts a headless run, waits for its capture session and stops
// it, leaving a bound data root.
func (hh *headlessHarness) bindAndStop(t *testing.T) binding.Record {
	t.Helper()
	run := hh.start(t)
	hh.waitForSessions(t, 1)
	hh.waitForPolicy(t)
	if _, err := run.stop(); err != nil {
		t.Fatalf("stopping the first run: %v", err)
	}
	return hh.boundRecord(t)
}

// waitForPolicy waits for the session's first refresh to cache the policy
// hooks capture under.
func (hh *headlessHarness) waitForPolicy(t *testing.T) {
	t.Helper()
	waitForWithin(t, "the session to cache its policy", 10*time.Second, func() bool {
		_, err := os.Stat(store.Layout{Root: hh.data}.Policy())
		return err == nil
	}, func() string { return logText(hh.logPath) })
}

// waitForSessions waits for the count-th capture session to start.
func (hh *headlessHarness) waitForSessions(t *testing.T, count int) {
	t.Helper()
	waitForWithin(t, fmt.Sprintf("capture session %d to start", count), 10*time.Second, func() bool {
		return linesContaining(logText(hh.logPath), "started") >= count
	}, func() string { return logText(hh.logPath) })
}

func (hh *headlessHarness) boundRecord(t *testing.T) binding.Record {
	t.Helper()
	record, err := binding.Load(hh.data)
	if err != nil || record == nil {
		t.Fatalf("no binding.json in the data root: %v", err)
	}
	return *record
}

func (hh *headlessHarness) identity(endpoint, installationID string) binding.Identity {
	origin, err := binding.NormalizeOrigin(endpoint, true)
	if err != nil {
		panic(err)
	}
	return binding.Identity{Origin: origin, InstallationID: installationID, OwnerEmail: headlessOwnerEmail}
}

// cli runs a command as a separate process would.
func (hh *headlessHarness) cli(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var output bytes.Buffer
	process := hh.makeApp(func(key string) string { return hh.env[key] }, &output)
	process.keyring = hh.keyring
	done := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { done <- process.run(ctx, args) }()
	select {
	case err := <-done:
		return output.String(), err
	case <-time.After(10 * time.Second):
		cancel()
		<-done
		t.Fatalf("%v did not return", args)
		return "", nil
	}
}

// hookIn runs the agent hook in cwd as its own process.
func (hh *headlessHarness) hookIn(t *testing.T, cwd, event string) {
	t.Helper()
	process := hh.makeApp(func(key string) string { return hh.env[key] }, &bytes.Buffer{})
	process.stdin = strings.NewReader(hookPayload(cwd, event, ""))
	process.runHook([]string{"claude-code"})
}

// control calls the running daemon's control API over its socket.
func (hh *headlessHarness) control(t *testing.T, method, path, body string) (int, []byte) {
	t.Helper()
	waitForFile(t, filepath.Join(hh.data, "control.json"))
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, _ := http.NewRequest(method, "http://companion"+path, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	reply, err := socketHTTPClient(hh.data).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	data, _ := io.ReadAll(reply.Body)
	return reply.StatusCode, data
}

// headlessBlock is the status's headless report: the members at the top
// level, or a "headless" object carrying them.
func headlessBlock(raw []byte) (map[string]any, bool) {
	var document map[string]any
	if json.Unmarshal(raw, &document) != nil {
		return nil, false
	}
	if document["mode"] == "headless" {
		return document, true
	}
	if nested, ok := document["headless"].(map[string]any); ok && nested["mode"] == "headless" {
		return nested, true
	}
	return nil, false
}

// controlHeadless waits for the control API status to report want as the
// headless reason ("" for none).
func (hh *headlessHarness) controlHeadlessReason(t *testing.T, want string) map[string]any {
	t.Helper()
	var block map[string]any
	var last []byte
	waitForWithin(t, "control API status reason "+quoted(want), 10*time.Second, func() bool {
		_, body := hh.control(t, "GET", "/v1/status", "")
		last = body
		found, ok := headlessBlock(body)
		if !ok {
			return false
		}
		block = found
		reason, _ := found["reason"].(string)
		return reason == want
	}, func() string { return string(last) })
	return block
}

// waitForWithin is waitFor with a bound and a report of what was seen.
func waitForWithin(t *testing.T, what string, bound time.Duration, condition func() bool, seen func() string) {
	t.Helper()
	for deadline := time.Now().Add(bound); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if condition() {
			return
		}
	}
	report := ""
	if seen != nil {
		report = seen()
	}
	t.Fatalf("timed out after %v waiting for %s; saw:\n%s", bound, what, report)
}

func (hh *headlessHarness) waitForLogReason(t *testing.T, reason string, bound time.Duration) {
	t.Helper()
	waitForWithin(t, "the log to say "+reason, bound, func() bool {
		return strings.Contains(logText(hh.logPath), reason)
	}, func() string { return logText(hh.logPath) })
}

// requestsTo counts the requests server received for path ("" for any).
func requestsTo(server *uplinktest.Server, path string) int {
	count := 0
	for _, request := range server.Requests() {
		if path == "" || request.Path == path {
			count++
		}
	}
	return count
}

func requestsBesides(server *uplinktest.Server, path string) []string {
	var others []string
	for _, request := range server.Requests() {
		if request.Path != path {
			others = append(others, request.Method+" "+request.Path)
		}
	}
	return others
}

func waitForRequests(t *testing.T, server *uplinktest.Server, path string, count int) {
	t.Helper()
	waitForWithin(t, fmt.Sprintf("%d requests to %s", count, path), 10*time.Second, func() bool {
		return requestsTo(server, path) >= count
	}, func() string { return fmt.Sprint(server.Requests()) })
}

func describeRequests(requests []uplinktest.Request) string {
	var lines []string
	for _, request := range requests {
		lines = append(lines, request.Method+" "+request.Host+request.Path)
	}
	return strings.Join(lines, "\n")
}

// headlessAllowedPaths are the only device routes a headless client may call.
func headlessAllowedPath(method, path string) bool {
	switch {
	case method == http.MethodGet && (path == headlessMePath || path == headlessPolicyPath):
		return true
	case method == http.MethodPost && (path == headlessStatusPath || path == headlessIngestPath):
		return true
	}
	return strings.HasPrefix(path, "/api/companion/contents/")
}

// digestEntries hashes every file under each named entry of root, by path
// relative to root; an absent entry contributes nothing.
func digestEntries(t *testing.T, root string, names ...string) map[string]string {
	t.Helper()
	digests := map[string]string{}
	for _, name := range names {
		filepath.WalkDir(filepath.Join(root, name), func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatalf("reading %s: %v", path, readErr)
			}
			sum := sha256.Sum256(data)
			relative, _ := filepath.Rel(root, path)
			digests[relative] = hex.EncodeToString(sum[:])
			return nil
		})
	}
	return digests
}

// connectionScopedDigest covers what one binding owns and a hold or switch
// must never change.
func connectionScopedDigest(t *testing.T, root string) map[string]string {
	t.Helper()
	return digestEntries(t, root, "queue", "inbox", "ledger.json", "threads.json", "capture-windows.json", "usage", "rich", "installation.json", "binding.json")
}

func assertSameDigest(t *testing.T, what string, before, after map[string]string) {
	t.Helper()
	if !jsonEqual(before, after) {
		t.Fatalf("%s changed:\nbefore %v\nafter  %v", what, sortedKeys(before), sortedKeys(after))
	}
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key, value := range values {
		keys = append(keys, key+"="+value[:8])
	}
	sort.Strings(keys)
	return keys
}

// headlessCaptureID is a valid capture id whose index sorts in order.
func headlessCaptureID(index int) string { return fmt.Sprintf("%032x", 0xc0de0000+index) }

func headlessRecord(captureID string) []byte {
	return []byte(`{"capture_id":"` + captureID + `","harness":"claude_code","n":1}`)
}

func (hh *headlessHarness) enqueue(t *testing.T, captureIDs ...string) {
	t.Helper()
	layout := store.Layout{Root: hh.data}
	for _, id := range captureIDs {
		if err := queue.Open(layout).Enqueue(id, headlessRecord(id)); err != nil {
			t.Fatalf("enqueue %s: %v", id, err)
		}
	}
}

// receivedCaptureIDs are the capture ids server was sent, in order.
func receivedCaptureIDs(server *uplinktest.Server) []string {
	var ids []string
	for _, record := range server.Records() {
		if id, ok := record["capture_id"].(string); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// receivedRaw is each record server was sent, by capture id, as sent.
func receivedRaw(server *uplinktest.Server) map[string][][]byte {
	server.Lock()
	defer server.Unlock()
	raw := map[string][][]byte{}
	for _, batch := range server.Batches {
		for _, record := range batch {
			var head struct {
				CaptureID string `json:"capture_id"`
			}
			json.Unmarshal(record, &head)
			raw[head.CaptureID] = append(raw[head.CaptureID], append([]byte(nil), record...))
		}
	}
	return raw
}

func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// tokenTraces are the forms a leaked token could take: the token, its body,
// its digest (with or without the file's newline) and its base64.
func tokenTraces(token string) map[string][]byte {
	plain := sha256.Sum256([]byte(token))
	withNewline := sha256.Sum256([]byte(token + "\n"))
	return map[string][]byte{
		"token":          []byte(token),
		"token body":     []byte(strings.TrimPrefix(token, "bpc_")),
		"sha256":         []byte(hex.EncodeToString(plain[:])),
		"sha256 prefix":  []byte(hex.EncodeToString(plain[:])[:16]),
		"sha256 of file": []byte(hex.EncodeToString(withNewline[:])),
		"base64":         []byte(base64.StdEncoding.EncodeToString([]byte(token))),
		"base64 url":     []byte(base64.RawURLEncoding.EncodeToString([]byte(token))),
	}
}

func assertNoTokenTrace(t *testing.T, where string, data []byte, tokens ...string) {
	t.Helper()
	for _, token := range tokens {
		for form, trace := range tokenTraces(token) {
			if bytes.Contains(data, trace) {
				t.Errorf("%s carries the device token (%s)", where, form)
			}
		}
	}
}
