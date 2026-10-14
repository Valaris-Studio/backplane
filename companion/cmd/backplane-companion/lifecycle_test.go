// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// lockedKeyring behaves like a credential store that refuses writes, as the
// macOS Keychain and Windows Credential Manager do from an SSH session.
// Saves numbered below allowedSaves succeed.
type lockedKeyring struct {
	credentialStore
	mu           sync.Mutex
	allowedSaves int
	saves        int
}

func (k *lockedKeyring) Save(installationID, token string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.saves++
	if k.saves > k.allowedSaves {
		return fmt.Errorf("%w: A specified logon session does not exist", credentials.ErrUnavailable)
	}
	return k.credentialStore.Save(installationID, token)
}

func TestConnectNamesTheDeviceWithoutItsHostname(t *testing.T) {
	h := newHarness(t)
	hostname, _ := os.Hostname()
	h.connect(t)
	id := installationID(t, h)
	name := h.server.Registrations[0]["name"]
	if name != "testos-testarch-"+id[:8] || hostname != "" && strings.Contains(name, hostname) {
		t.Fatalf("default device name %q must be neutral, not the hostname", name)
	}
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback", "--name", "work laptop"); err != nil {
		t.Fatal(err)
	}
	if name := h.server.Registrations[len(h.server.Registrations)-1]["name"]; name != "work laptop" {
		t.Fatalf("--name not honored: %q", name)
	}
}

func TestConnectWithALockedKeyringEnrollsNothing(t *testing.T) {
	h := newHarness(t)
	h.app.keyring = &lockedKeyring{credentialStore: credentials.Keyring{}}
	err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback")
	if !errors.Is(err, credentials.ErrUnavailable) {
		t.Fatalf("connect with a locked keyring: %v", err)
	}
	if len(h.server.Registrations) != 0 {
		t.Fatal("the server enrolled an installation whose token could not be kept")
	}
	if message := localizedError(err, "en_US.UTF-8"); !strings.Contains(message, "desktop session") {
		t.Fatalf("the error must say why and what to do: %s", message)
	}
	if _, err := os.Stat(filepath.Join(h.data, "installation.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed connect persisted an installation")
	}
}

func TestConnectRevokesTheNewInstallationWhenTheTokenCannotBeSaved(t *testing.T) {
	h := newHarness(t)
	// The probe's write succeeds; the store then fails the real one.
	h.app.keyring = &lockedKeyring{credentialStore: credentials.Keyring{}, allowedSaves: 1}
	err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback")
	if !errors.Is(err, credentials.ErrUnavailable) {
		t.Fatalf("connect: %v", err)
	}
	h.server.Lock()
	defer h.server.Unlock()
	enrolled := h.server.Registrations[0]["installation_id"]
	if h.server.Revocations != 1 || !h.server.Revoked[enrolled] {
		t.Fatalf("the orphan installation %s was left active on the server", enrolled)
	}
	if _, err := os.Stat(filepath.Join(h.data, "installation.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed connect persisted an installation")
	}
}

// serialKeyring serializes the go-keyring mock, which is not safe for the
// concurrent daemon and CLI calls these tests make.
type serialKeyring struct {
	mu *sync.Mutex
	credentials.Keyring
}

var sharedKeyringMu sync.Mutex

func sharedKeyring() serialKeyring { return serialKeyring{mu: &sharedKeyringMu} }

func (k serialKeyring) Save(id, token string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.Keyring.Save(id, token)
}

func (k serialKeyring) Load(id string) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.Keyring.Load(id)
}

func (k serialKeyring) Delete(id string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.Keyring.Delete(id)
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if condition() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func logText(path string) string {
	data, _ := os.ReadFile(path)
	return string(data)
}

// startDaemon runs the daemon in the background against the harness data
// directory, as the service would.
func (h *harness) startDaemon(t *testing.T) (logPath string, stop func()) {
	t.Helper()
	h.app.connectPollInterval = 20 * time.Millisecond
	h.app.keyring = sharedKeyring()
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	logPath = filepath.Join(h.data, "logs", "companion.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	stopped := false
	stop = func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		if err := <-done; err != nil {
			t.Errorf("daemon: %v", err)
		}
	}
	t.Cleanup(stop)
	return logPath, stop
}

// cli runs a command as a separate process would while the daemon runs.
func (h *harness) cli(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var output bytes.Buffer
	app := h.makeApp(func(key string) string { return h.env[key] }, &output)
	app.keyring = sharedKeyring()
	err := app.run(t.Context(), args)
	return output.String(), err
}

type lifecycleStatus struct {
	Connected bool `json:"connected"`
	Revoked   bool `json:"revoked"`
	Capture   struct {
		State string `json:"state"`
	} `json:"capture"`
}

func (h *harness) lifecycleStatus(t *testing.T) lifecycleStatus {
	t.Helper()
	output, err := h.cli(t, "status")
	if err != nil {
		t.Fatal(err)
	}
	var report lifecycleStatus
	if err := json.Unmarshal([]byte(output), &report); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	return report
}

func TestDaemonNoticesAServerRevokeAndConnectRecovers(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	// Which call meets the 401 first (policy, ingest, heartbeat) is pinned
	// by the daemon package; here the session's first policy refresh does.
	h.server.RevokeAll()
	logPath, _ := h.startDaemon(t)
	waitForLog(t, logPath, "device_revoked")
	waitFor(t, "the revoked token to leave the keyring", func() bool {
		_, err := sharedKeyring().Load(first)
		return errors.Is(err, credentials.ErrNotFound)
	})
	report := h.lifecycleStatus(t)
	if report.Connected || !report.Revoked || report.Capture.State != "revoked" {
		t.Fatalf("status after a server revoke: %+v", report)
	}
	human, _ := h.cli(t, "status", "--human")
	if !strings.Contains(human, "revoked") {
		t.Fatalf("human status does not say revoked:\n%s", human)
	}
	if _, err := h.cli(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); err != nil {
		t.Fatalf("connect after a server revoke: %v", err)
	}
	if second := installationID(t, h); second == first {
		t.Fatal("a revoked installation must be replaced")
	}
	waitFor(t, "the daemon to start a new session", func() bool { return linesContaining(logText(logPath), "started") == 2 })
	if report := h.lifecycleStatus(t); !report.Connected || report.Revoked {
		t.Fatalf("status after reconnecting: %+v", report)
	}
}

func TestConnectReplacesAnInstallationRevokedWhileNoDaemonRan(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	h.server.RevokeAll()
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); err != nil {
		t.Fatalf("connect must accept a revoked installation: %v", err)
	}
	if installationID(t, h) == first {
		t.Fatal("the revoked installation was kept")
	}
	if _, err := (credentials.Keyring{}).Load(first); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatal("the revoked installation's token stayed in the keyring")
	}
}

func TestDisconnectWhileTheDaemonRunsEndsItsSession(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	logPath, stop := h.startDaemon(t)
	waitForLog(t, logPath, "started")
	output, err := h.cli(t, "disconnect")
	if err != nil {
		t.Fatalf("disconnect with the daemon running: %v", err)
	}
	if !strings.Contains(output, `"server_revoked": true`) {
		t.Fatalf("disconnect output: %s", output)
	}
	// The daemon logged "disconnected" before disconnect emptied the log.
	if strings.Contains(logText(logPath), h.root) {
		t.Fatalf("the log a running daemon keeps open still holds local paths:\n%s", logText(logPath))
	}
	h.server.Lock()
	uploads := len(h.server.Batches)
	h.server.Unlock()
	h.hook(t, hookPayload(h.repo, "SessionStart", ""))
	time.Sleep(300 * time.Millisecond)
	if len(h.server.Records()) != uploads {
		t.Fatal("the daemon kept uploading after disconnect")
	}
	if _, err := h.cli(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); err != nil {
		t.Fatal(err)
	}
	waitForLog(t, logPath, "started")
	stop()
}

func TestDisconnectReportsAnInstallationTheServerAlreadyRevoked(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.server.RevokeAll()
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(h.stdout.String(), `"server_revoked": true`) {
		t.Fatalf("an installation the server already revoked is revoked: %s", h.stdout)
	}
}

func TestDaemonRunningIsNotFooledByALockWithoutALiveDaemon(t *testing.T) {
	h := newHarness(t)
	layout, _ := store.Open(h.data)
	lock, acquired, err := store.TryLock(layout.DaemonLock())
	if err != nil || !acquired {
		t.Fatal("could not hold the daemon lock")
	}
	defer lock.Unlock()
	if !daemonRunning(layout) {
		t.Fatal("a held lock without a pid file is a running daemon")
	}
	exited := exec.Command(os.Args[0], "-test.run=^$")
	if err := exited.Run(); err != nil {
		t.Fatal(err)
	}
	store.WriteJSON(layout.DaemonPID(), daemonProcess{PID: exited.Process.Pid})
	if daemonRunning(layout) {
		t.Fatal("a lock whose daemon exited (e.g. held by an orphan) is not a running daemon")
	}
	store.WriteJSON(layout.DaemonPID(), daemonProcess{PID: os.Getpid()})
	if !daemonRunning(layout) {
		t.Fatal("a live daemon holding the lock is running")
	}
}

func TestRunRecordsItsPidWhileRunning(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	logPath, stop := h.startDaemon(t)
	waitForLog(t, logPath, "started")
	var recorded daemonProcess
	if err := store.ReadJSON(filepath.Join(h.data, "daemon.pid"), 4096, &recorded); err != nil || recorded.PID != os.Getpid() {
		t.Fatalf("daemon pid not recorded: %+v %v", recorded, err)
	}
	stop()
	if _, err := os.Stat(filepath.Join(h.data, "daemon.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("pid file left after the daemon exited")
	}
}

// seedEveryDataFile fills each file and directory the companion writes with
// content that holds a local path.
func seedEveryDataFile(t *testing.T, h *harness) (localPath string) {
	t.Helper()
	localPath = h.repo
	layout, _ := store.Open(h.data)
	withPath := `{"path":` + quoted(localPath) + `}` + "\n"
	for _, file := range []string{layout.Policy(), layout.Admission(), layout.Health(), layout.Discovered(), layout.Threads(), layout.Suppressions(), layout.Ledger()} {
		mustWrite(t, file, withPath)
	}
	store.WriteJSON(layout.Preferences(), state.Preferences{Paused: true, IgnoredPaths: []string{localPath}})
	store.WriteJSON(layout.OTelSettings(), state.OTelSettings{GatePort: 14327})
	for _, file := range []string{
		filepath.Join(layout.InboxDir(), "item"), filepath.Join(layout.QueueDir(), "record"), filepath.Join(layout.WorkDir(), "beacon", "log"),
		filepath.Join(layout.OTelDir(), "runtime.jsonl"), filepath.Join(layout.OTelDir(), "collector.yaml"), filepath.Join(layout.OTelDir(), "collector.log"),
		filepath.Join(h.data, "logs", "companion.log"), filepath.Join(h.data, "logs", "companion.log.1"), filepath.Join(h.data, "logs", "stderr.log"),
		filepath.Join(h.data, ".pending-123"), filepath.Join(h.data, "written-by-a-future-version.json"),
	} {
		mustMkdir(t, filepath.Dir(file))
		mustWrite(t, file, withPath)
	}
	return localPath
}

func (h *harness) filesContaining(t *testing.T, text string) []string {
	t.Helper()
	var found []string
	for _, path := range h.files(t) {
		if data, _ := os.ReadFile(filepath.Join(h.data, path)); strings.Contains(string(data), text) {
			found = append(found, path)
		}
	}
	return found
}

func TestDisconnectRemovesEveryCapturedDerivedAndLogFile(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	localPath := seedEveryDataFile(t, h)
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	want := []string{"/daemon.lock", "/otel.json", "/preferences.json", "/session.lock", "/state.lock"}
	if got := h.files(t); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("after disconnect:\n got %v\nwant %v", got, want)
	}
	if leaking := h.filesContaining(t, localPath); len(leaking) != 0 {
		t.Fatalf("files still holding a local path: %v", leaking)
	}
	preferences, _ := state.Load[state.Preferences](filepath.Join(h.data, "preferences.json"))
	if !preferences.Paused || len(preferences.IgnoredPaths) != 0 {
		t.Fatalf("only the pause choice survives: %+v", preferences)
	}
}

func TestFullUninstallLeavesNothingWithPathsOrContent(t *testing.T) {
	for _, order := range [][]string{{"disconnect", "agents", "service"}, {"service", "disconnect", "agents"}} {
		t.Run(strings.Join(order, "-"), func(t *testing.T) {
			h := newHarness(t)
			h.app.goos, h.app.uid, h.app.serviceRunner = "darwin", 501, &recordingRunner{}
			h.connect(t)
			if err := h.run(t, "agents", "install", "claude-code"); err != nil {
				t.Fatal(err)
			}
			if err := h.run(t, "service", "install"); err != nil {
				t.Fatal(err)
			}
			localPath := seedEveryDataFile(t, h)
			steps := map[string][]string{"disconnect": {"disconnect"}, "agents": {"agents", "uninstall"}, "service": {"service", "uninstall"}}
			for _, step := range order {
				if err := h.run(t, steps[step]...); err != nil {
					t.Fatalf("%s: %v", step, err)
				}
			}
			want := []string{"/daemon.lock", "/otel.json", "/preferences.json", "/session.lock", "/state.lock"}
			if got := h.files(t); strings.Join(got, " ") != strings.Join(want, " ") {
				t.Fatalf("after uninstall:\n got %v\nwant %v", got, want)
			}
			if leaking := h.filesContaining(t, localPath); len(leaking) != 0 {
				t.Fatalf("files still holding a local path: %v", leaking)
			}
		})
	}
}

func TestConnectClearsADisconnectRequestLeftByAnInterruptedDisconnect(t *testing.T) {
	h := newHarness(t)
	layout, _ := store.Open(h.data)
	mustWrite(t, layout.DisconnectRequest(), "")
	h.connect(t)
	logPath, _ := h.startDaemon(t)
	waitForLog(t, logPath, "started")
}

func TestABare401IsNotTakenForARevocation(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	h.server.Lock()
	h.server.Status["/api/companion/policy"] = 401
	h.server.Status["/api/companion/installation"] = 401
	h.server.Unlock()
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); !errors.Is(err, errAlreadyConnected) {
		t.Fatalf("a proxy's 401 must not replace the connection: %v", err)
	}
	if token, err := (credentials.Keyring{}).Load(first); err != nil || token == "" {
		t.Fatalf("a proxy's 401 deleted the token: %v", err)
	}
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(h.stdout.String(), `"server_revoked": false`) {
		t.Fatalf("a bare 401 on revoke does not prove revocation: %s", h.stdout)
	}
}

// seedCapturedState leaves captured and derived data as a revoked session
// would: a queued record, Beacon work files, the upload ledger, threads,
// transcript read positions and capture windows.
func seedCapturedState(t *testing.T, h *harness) store.Layout {
	t.Helper()
	layout, _ := store.Open(h.data)
	for _, file := range []string{filepath.Join(layout.QueueDir(), "record"), filepath.Join(layout.WorkDir(), "beacon", "log"), layout.Ledger(), layout.Threads(), filepath.Join(layout.UsageDir(), "session.json"), layout.CaptureWindows()} {
		mustMkdir(t, filepath.Dir(file))
		mustWrite(t, file, "{}\n")
	}
	return layout
}

func capturedStateLeft(layout store.Layout) []string {
	var left []string
	for _, dir := range []string{layout.QueueDir(), layout.WorkDir(), layout.UsageDir()} {
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			left = append(left, dir)
		}
	}
	for _, file := range []string{layout.Ledger(), layout.Threads(), layout.CaptureWindows()} {
		if _, err := os.Stat(file); err == nil {
			left = append(left, file)
		}
	}
	return left
}

func TestConnectToANewInstallationDropsWhatTheOldOneCaptured(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	layout := seedCapturedState(t, h)
	h.server.RevokeAll()
	h.connect(t)
	if installationID(t, h) == first {
		t.Fatal("expected a new installation")
	}
	if left := capturedStateLeft(layout); len(left) != 0 {
		t.Fatalf("content captured under the revoked installation would upload under the new one: %v", left)
	}
}

func TestReconnectingTheSameInstallationKeepsItsQueue(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	layout := seedCapturedState(t, h)
	(credentials.Keyring{}).Delete(first)
	h.connect(t)
	if installationID(t, h) != first {
		t.Fatal("expected the same installation with a rotated token")
	}
	if left := capturedStateLeft(layout); len(left) != 6 {
		t.Fatalf("a rotated installation keeps its queue and state: %v", left)
	}
}

func TestAFailedReconnectKeepsTheOldTokenAndState(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	layout := seedCapturedState(t, h)
	h.server.RevokeAll()
	h.app.keyring = &lockedKeyring{credentialStore: credentials.Keyring{}, allowedSaves: 1}
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); !errors.Is(err, credentials.ErrUnavailable) {
		t.Fatalf("connect: %v", err)
	}
	if _, err := (credentials.Keyring{}).Load(first); err != nil {
		t.Fatalf("the old token must go only once a new one is saved: %v", err)
	}
	if installationID(t, h) != first || len(capturedStateLeft(layout)) != 6 {
		t.Fatal("a failed connect changed the installation or dropped its state")
	}
}

func TestARevocationRecordedForAnotherInstallationDoesNotApply(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	// As if a session of the replaced installation met its 401 late.
	store.WriteJSON(filepath.Join(h.data, "admission.json"), state.Admission{Unauthorized: true, InstallationID: "replaced-installation"})
	if report := h.lifecycleStatus(t); !report.Connected || report.Revoked {
		t.Fatalf("a stale revocation applied to the new installation: %+v", report)
	}
	logPath, _ := h.startDaemon(t)
	waitForLog(t, logPath, "started")
}

func TestAStaleDisconnectRequestDoesNotIdleTheDaemonForever(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	// A disconnect killed mid-way leaves its request behind.
	request := filepath.Join(h.data, "disconnect.request")
	mustWrite(t, request, "")
	longAgo := time.Now().Add(-time.Hour)
	os.Chtimes(request, longAgo, longAgo)
	logPath, _ := h.startDaemon(t)
	waitForLog(t, logPath, "started")
}

func TestLogCleanupNeverFollowsASymlinkOutOfTheDataDirectory(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	outside := filepath.Join(h.root, "elsewhere")
	mustMkdir(t, outside)
	mustWrite(t, filepath.Join(outside, "companion.log"), "not the companion's\n")
	os.Symlink(outside, filepath.Join(h.data, "logs"))
	// With a daemon running, disconnect empties logs instead of removing them.
	layout, _ := store.Open(h.data)
	lock, _, _ := store.TryLock(layout.DaemonLock())
	defer lock.Unlock()
	store.WriteJSON(layout.DaemonPID(), daemonProcess{PID: os.Getpid()})
	if err := h.run(t, "disconnect"); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(outside, "companion.log")); string(data) != "not the companion's\n" {
		t.Fatal("disconnect truncated a file outside the data directory")
	}
	if _, err := os.Lstat(filepath.Join(h.data, "logs")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the symlinked logs entry was kept")
	}
}

func TestTheDaemonLogRefusesASymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	mustWrite(t, target, "")
	os.MkdirAll(filepath.Join(dir, "logs"), 0o700)
	os.Symlink(target, filepath.Join(dir, "logs", "companion.log"))
	if _, err := openRotatingLog(filepath.Join(dir, "logs", "companion.log"), 100); !errors.Is(err, store.ErrUnsafePath) {
		t.Fatalf("a symlinked log was opened: %v", err)
	}
}

func TestALegacyRevocationFlagIsVerifiedNotObeyed(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	// A daemon predating installation ids wrote this on any 401.
	store.WriteJSON(filepath.Join(h.data, "admission.json"), state.Admission{Unauthorized: true})
	if report := h.lifecycleStatus(t); !report.Connected || report.Revoked {
		t.Fatalf("an unverified flag read as revoked: %+v", report)
	}
	logPath, _ := h.startDaemon(t)
	waitForLog(t, logPath, "started")
	waitFor(t, "the policy refresh to clear the flag", func() bool {
		admission, _ := state.Load[state.Admission](filepath.Join(h.data, "admission.json"))
		return !admission.Unauthorized
	})
}

func TestConnectToANewInstallationDropsTheOTelBacklog(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	layout, _ := store.Open(h.data)
	for _, file := range []string{"runtime.jsonl", "runtime.jsonl.1", "tail.json"} {
		mustMkdir(t, layout.OTelDir())
		mustWrite(t, filepath.Join(layout.OTelDir(), file), "{}\n")
	}
	h.server.RevokeAll()
	h.connect(t)
	if entries, _ := os.ReadDir(layout.OTelDir()); len(entries) != 0 {
		t.Fatalf("OTel lines captured before the reconnect would upload under the new installation: %v", entries)
	}
}

// undeletableKeyring refuses to delete one entry, as a locked store might.
type undeletableKeyring struct {
	credentials.Keyring
	kept string
}

func (k undeletableKeyring) Delete(id string) error {
	if id == k.kept {
		return fmt.Errorf("%w: locked", credentials.ErrUnavailable)
	}
	return k.Keyring.Delete(id)
}

func TestConnectSucceedsWhenTheRevokedTokenCannotBeDeleted(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	first := installationID(t, h)
	h.server.RevokeAll()
	h.app.keyring = undeletableKeyring{kept: first}
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); err != nil {
		t.Fatalf("a leftover revoked token must not fail a connect that registered: %v", err)
	}
	if second := installationID(t, h); second == first || second == "" {
		t.Fatal("the new installation was not recorded")
	}
	if !strings.Contains(h.app.stderr.(*bytes.Buffer).String(), "secure_credential_store_unavailable") {
		t.Fatalf("the failed deletion was not reported: %q", h.app.stderr)
	}
}
