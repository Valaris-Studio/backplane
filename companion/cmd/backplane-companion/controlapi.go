// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// controlBackend serves the control API with the same implementations the
// CLI commands print, so both always agree.
type controlBackend struct {
	app     *app
	layout  store.Layout
	probes  *statusProbes
	account accountCache
	// suggestion is read at most once: reading it may run scutil.
	suggestion deviceNameSuggestion
	// changed schedules a status event once a background fetch lands.
	changed func()
}

// newControlServer builds the control API over layout. A nil pairer makes
// the pairing endpoints answer "pairing unavailable".
func (a *app) newControlServer(layout store.Layout, pairer control.Pairer) *control.Server {
	config := a.controlConfig(layout, pairer)
	server := control.New(config)
	config.Backend.(*controlBackend).changed = server.StatusChanged
	return server
}

// envAllowInsecureLoopback=1 lets pairing use plain HTTP to a loopback IP,
// as connect --allow-insecure-loopback does (local development).
const envAllowInsecureLoopback = "BACKPLANE_COMPANION_ALLOW_INSECURE_LOOPBACK"

func (a *app) controlConfig(layout store.Layout, pairer control.Pairer) control.Config {
	backend := &controlBackend{app: a, layout: layout, probes: &statusProbes{}}
	return control.Config{
		DataDir:     layout.Root,
		Backend:     backend,
		Pairer:      pairer,
		AgentAccess: agentAccessService{app: a, layout: layout},
		Home:        a.home,
		// Both filesystems resolve paths case-insensitively by default.
		HomeCaseInsensitive:   a.goos == "darwin" || a.goos == "windows",
		AllowInsecureLoopback: a.getenv(envAllowInsecureLoopback) == "1",
		Locale:                locale(a.getenv),
		// What status is built from, including files other processes write:
		// the CLI (preferences, installation), hooks (inbox, discovered) and
		// the daemon's session (policy, admission, health, queue).
		WatchPaths:   []string{layout.Installation(), layout.Admission(), layout.Preferences(), layout.Policy(), layout.Health(), layout.Discovered(), layout.InboxDir(), layout.QueueDir(), layout.DaemonPID()},
		ProbePaths:   []string{layout.Installation(), layout.Admission(), layout.Preferences(), layout.Policy()},
		ProjectPaths: []string{layout.Discovered(), layout.Preferences(), layout.Policy()},
		PolicyPath:   layout.Policy(),
		Now:          a.now,
		Logf:         func(format string, args ...any) { a.logLine(fmt.Sprintf(format, args...)) },
	}
}

// startControlAPI serves the control API for the daemon's lifetime, ctx;
// the caller holds the daemon lock. Without it the daemon still captures.
func (a *app) startControlAPI(ctx context.Context, layout store.Layout) *control.Server {
	pairer := a.newDaemonPairer(ctx, layout)
	a.daemonPairing = pairer
	server := a.newControlServer(layout, pairer)
	pairer.settled = server.PairingSettled
	a.publishAgentAccess = func(access any) { server.Publish("agent_access", access) }
	if err := server.Start(); err != nil {
		a.logError(err)
		server.Close()
		return nil
	}
	return server
}

// sessionPublisher forwards the daemon's session events to subscribers.
func sessionPublisher(server *control.Server) func(daemon.SessionEvent) {
	if server == nil {
		return nil
	}
	return func(event daemon.SessionEvent) { server.Publish("session", event) }
}

// StatusReport is exported only so apiStatus embeds an exported field,
// which control's array normalization can rewrite.
type StatusReport = statusReport

// CaptureReport is exported only so apiCapture embeds an exported field.
type CaptureReport = captureReport

// apiCapture is the CLI capture report plus the cached installation
// settings the desktop edits (contract v1.8); a PATCH replaces the whole
// glob list, so the app must read the current one first.
type apiCapture struct {
	CaptureReport
	AutoMatchRepos bool     `json:"auto_match_repos"`
	ExcludeGlobs   []string `json:"exclude_globs"`
}

// apiStatus is the CLI status plus what only the API reports. Its capture
// shadows the embedded report's, being the shallower field.
type apiStatus struct {
	StatusReport
	Capture apiCapture    `json:"capture"`
	Account *ownerAccount `json:"account"`
	// SuggestedDeviceName prefills pairing's name field; null once connected.
	SuggestedDeviceName *string `json:"suggested_device_name"`
}

func (b *controlBackend) Status(ctx context.Context) (control.Snapshot, error) {
	report, err := b.app.buildStatus(ctx, b.layout, b.probes)
	if err != nil {
		return control.Snapshot{}, err
	}
	if report.Capture.PolicyCached && report.Capture.EnabledAgents == nil {
		// The policy's null means every agent; the API has no null arrays
		// (contract v1.3), so it names them. The CLI keeps the null.
		for _, adapter := range b.app.registry.All() {
			report.Capture.EnabledAgents = append(report.Capture.EnabledAgents, adapter.ID())
		}
	}
	capture := apiCapture{CaptureReport: report.Capture, AutoMatchRepos: report.Capture.autoMatchRepos, ExcludeGlobs: report.Capture.excludeGlobs}
	status := apiStatus{StatusReport: report, Capture: capture, Account: b.currentAccount(report)}
	if !report.Connected {
		status.SuggestedDeviceName = b.suggestedDeviceName()
	}
	return control.Snapshot{Status: status, Attention: b.app.attention(report)}, nil
}

func (b *controlBackend) InvalidateProbes() {
	b.probes.invalidate()
	b.account.markStale()
}

func (b *controlBackend) SetPaused(ctx context.Context, paused bool) error {
	return b.app.writePaused(ctx, paused)
}

func (b *controlBackend) Projects(context.Context) (any, error) {
	return b.app.listProjects(b.layout, true)
}

func (b *controlBackend) IgnoreProject(ctx context.Context, path string) (string, error) {
	return b.app.ignorePath(ctx, b.layout, path)
}

func (b *controlBackend) DiscoverProject(ctx context.Context, path string) (any, error) {
	return b.app.discoverPath(ctx, b.layout, path)
}

func (b *controlBackend) UnignoreProject(ctx context.Context, path string) (string, error) {
	return b.app.unignorePath(ctx, b.layout, path)
}

func (b *controlBackend) Agents(context.Context) (any, error) {
	return b.app.agentReports("status", nil, true)
}

func (b *controlBackend) InstallAgent(_ context.Context, id string) (any, error) {
	return b.agentAction("install", id)
}

func (b *controlBackend) UninstallAgent(_ context.Context, id string) (any, error) {
	return b.agentAction("uninstall", id)
}

func (b *controlBackend) agentAction(action, id string) (any, error) {
	reports, err := b.app.agentReports(action, []string{id}, true)
	if err != nil {
		return nil, err
	}
	return reports[0], nil
}

func (b *controlBackend) Disconnect(ctx context.Context) (any, error) {
	return b.app.disconnectDevice(ctx, "")
}

func (b *controlBackend) Version(context.Context) (any, error) {
	return b.app.versionReport(), nil
}

func (b *controlBackend) Rename(ctx context.Context, name string) (string, error) {
	return b.app.renameDevice(ctx, name)
}

func (b *controlBackend) Device(context.Context) (control.Device, error) {
	_, device, err := b.app.connectedClient(b.layout)
	if err != nil {
		return nil, err
	}
	return device, nil
}

func (b *controlBackend) RefreshPolicy(ctx context.Context) error {
	if err := b.app.refreshPolicyCache(ctx, b.layout); err != nil {
		return err
	}
	// Detached from the request: a slow /me must never delay the mapping or
	// settings write that refreshed the policy.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), accountRefreshTimeout)
		defer cancel()
		b.fetchAccount(ctx)
	}()
	return nil
}

func (b *controlBackend) ApplyPolicyWrite(ctx context.Context, write control.PolicyWrite) error {
	return applyPolicyWrite(ctx, b.layout, write)
}

func (b *controlBackend) Connected(ctx context.Context) bool {
	report, err := b.app.buildStatus(ctx, b.layout, b.probes)
	return err == nil && report.Connected
}

// FlushQueue wakes the daemon's uploader only when a retry could send
// something; otherwise it says why nothing was scheduled.
func (b *controlBackend) FlushQueue(ctx context.Context) (control.QueueFlush, error) {
	report, err := b.app.buildStatus(ctx, b.layout, b.probes)
	if err != nil {
		return control.QueueFlush{}, err
	}
	reason := ""
	switch {
	case report.Revoked:
		reason = control.FlushReasonRevoked
	case !report.Connected:
		reason = control.FlushReasonNotConnected
	case report.Queue.Records == 0:
		reason = control.FlushReasonQueueEmpty
	case !b.app.uploadFlush.Attached():
		// Also while the supervisor waits for a connection or an artifact.
		reason = control.FlushReasonDaemonNotRunning
	}
	if reason != "" {
		return control.QueueFlush{Reason: reason}, nil
	}
	b.app.uploadFlush.Request()
	return control.QueueFlush{Scheduled: true}, nil
}

// maxDiagnosticLogBytes is the tail of each log a diagnostics archive keeps.
const maxDiagnosticLogBytes = 256 << 10

// Diagnostics holds reports the companion builds and the tail of its own
// logs, never the captured inbox, queue or policy; control scrubs it.
func (b *controlBackend) Diagnostics(ctx context.Context) ([]control.DiagnosticFile, error) {
	report, err := b.app.buildStatus(ctx, b.layout, b.probes)
	if err != nil {
		return nil, err
	}
	files := []control.DiagnosticFile{}
	// The agent access summary names states and entry names, never the key.
	access, _ := agentAccessService{app: b.app, layout: b.layout}.AgentAccess(ctx)
	for name, value := range map[string]any{"status.json": report, "version.json": b.app.versionReport(), "agent_access.json": access} {
		encoded, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return nil, err
		}
		files = append(files, control.DiagnosticFile{Name: name, Data: encoded})
	}
	entries, _ := os.ReadDir(b.layout.LogsDir())
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".log") {
			continue
		}
		if tail, err := readTail(filepath.Join(b.layout.LogsDir(), entry.Name()), maxDiagnosticLogBytes); err == nil {
			files = append(files, control.DiagnosticFile{Name: "logs/" + entry.Name(), Data: tail})
		}
	}
	return files, nil
}

func readTail(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > limit {
		if _, err := file.Seek(-limit, io.SeekEnd); err != nil {
			return nil, err
		}
	}
	return io.ReadAll(io.LimitReader(file, limit))
}

// controlStatuses are the HTTP statuses of the CLI's codes in the control
// API; any other code the companion knows answers 500 with its code.
var controlStatuses = map[string]int{
	"not_connected":                       http.StatusConflict,
	"already_connected":                   http.StatusConflict,
	"daemon_running":                      http.StatusConflict,
	"daemon_already_running":              http.StatusConflict,
	"not_a_repository":                    http.StatusBadRequest,
	"not_a_directory":                     http.StatusBadRequest,
	"home_or_root":                        http.StatusBadRequest,
	"temp_dir":                            http.StatusBadRequest,
	"ignored_path":                        http.StatusConflict,
	"excluded_path":                       http.StatusConflict,
	"already_mapped":                      http.StatusConflict,
	"too_many_projects":                   http.StatusConflict,
	"no_matching_board":                   http.StatusNotFound,
	"ambiguous_repo":                      http.StatusConflict,
	"auto_match_disabled":                 http.StatusForbidden,
	"unknown_agent":                       http.StatusNotFound,
	"agent_config_symlink":                http.StatusConflict,
	"agent_config_invalid":                http.StatusConflict,
	"agent_config_changed":                http.StatusConflict,
	"agent_config_not_owned":              http.StatusConflict,
	"secure_credential_store_unavailable": http.StatusServiceUnavailable,
}

func (b *controlBackend) DescribeError(err error, language string) *control.Error {
	code := errorCode(err)
	switch code {
	case "internal_error":
		return nil
	case "usage":
		return &control.Error{Status: http.StatusBadRequest, Code: control.CodeInvalidRequest, Message: message(code, language)}
	case "device_revoked":
		return &control.Error{Status: http.StatusUnauthorized, Code: control.CodeUnauthorizedDevice, Message: message(code, language)}
	}
	status, known := controlStatuses[code]
	if !known {
		status = http.StatusInternalServerError
	}
	described := &control.Error{Status: status, Code: code, Message: message(code, language)}
	if reason := credentials.UnavailableReason(err); reason != "" {
		described.Detail = map[string]any{"reason": reason}
	}
	return described
}

// attention lists what only the user can fix, from a status report.
func (a *app) attention(report statusReport) []control.AttentionItem {
	language := locale(a.getenv)
	items := []control.AttentionItem{}
	if report.Revoked {
		items = append(items, control.AttentionItem{Code: "device_revoked", Severity: "error", Message: message("device_revoked", language)})
	}
	if report.Capture.State == "policy_stale" {
		items = append(items, control.AttentionItem{Code: "policy_stale", Severity: "warning", Message: message("policy_stale", language)})
	}
	for _, entry := range report.Agents {
		id := entry.ID
		switch {
		case entry.Integration.State == agent.NeedsTrust || entry.Integration.State == agent.InvalidConfig:
			items = append(items, control.AttentionItem{Code: string(entry.Integration.State), Severity: "warning", Agent: &id, Message: a.requiredAction(entry.Integration)})
		case entry.Broken:
			items = append(items, control.AttentionItem{Code: "agent_broken", Severity: "error", Agent: &id, Message: message("agent_broken", language)})
		case containsString(entry.Integration.Problems, agent.ProblemConflictExistingOTel):
			items = append(items, control.AttentionItem{Code: agent.ProblemConflictExistingOTel, Severity: "warning", Agent: &id, Message: message(agent.ProblemConflictExistingOTel, language)})
		case containsString(entry.Integration.Problems, agent.ProblemRestartRequired):
			items = append(items, control.AttentionItem{Code: agent.ProblemRestartRequired, Severity: "warning", Agent: &id, Message: message(agent.ProblemRestartRequired, language)})
		case containsString(entry.Integration.Problems, agent.ProblemDaemonRestartRequired):
			items = append(items, control.AttentionItem{Code: agent.ProblemDaemonRestartRequired, Severity: "warning", Agent: &id, Message: message(agent.ProblemDaemonRestartRequired, language)})
		}
	}
	return items
}

// accountTTL refreshes the owner's account as often as the daemon refreshes
// the policy; a policy change refreshes it at once.
const accountTTL = daemon.PolicyInterval

// accountFetchTimeout bounds a background account fetch.
const accountFetchTimeout = 15 * time.Second

// accountRefreshTimeout bounds the account fetch a policy write starts.
const accountRefreshTimeout = 5 * time.Second

// ownerAccount is who owns this installation, from GET /api/companion/me.
type ownerAccount struct {
	Email       string  `json:"email"`
	DisplayName string  `json:"display_name"`
	WebOrigin   *string `json:"web_origin"`
	DeviceName  string  `json:"device_name"`
}

// accountCache keeps the owner's account for status, which must never wait
// for the server: a missing or stale entry is fetched in the background.
type accountCache struct {
	mu             sync.Mutex
	installationID string
	value          *ownerAccount
	fetchedAt      time.Time
	stale          bool
	fetching       bool
}

func (c *accountCache) markStale() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stale = true
}

// currentAccount answers the cached account at once, null while not
// connected or before a fetch succeeded, and starts a fetch when due.
func (b *controlBackend) currentAccount(report statusReport) *ownerAccount {
	b.account.mu.Lock()
	defer b.account.mu.Unlock()
	if !report.Connected {
		b.account.installationID, b.account.value = "", nil
		return nil
	}
	if b.account.installationID != report.InstallationID {
		b.account.installationID, b.account.value, b.account.fetchedAt = report.InstallationID, nil, time.Time{}
	}
	due := b.account.stale || b.account.fetchedAt.IsZero() || b.app.now().Sub(b.account.fetchedAt) >= accountTTL
	if due && !b.account.fetching {
		b.account.fetching = true
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), accountFetchTimeout)
			defer cancel()
			b.fetchAccount(ctx)
		}()
	}
	return b.account.value
}

// fetchAccount asks the server for the owner; a failed call clears the
// account rather than showing one that may no longer be right.
func (b *controlBackend) fetchAccount(ctx context.Context) {
	probe := b.app.probe(ctx, b.layout, b.probes)
	installation := probe.installation
	var fetched *ownerAccount
	if probe.connectErr == nil && probe.device != nil {
		if me, err := probe.device.Me(ctx); err == nil {
			fetched = &ownerAccount{Email: me.User.Email, DisplayName: me.User.DisplayName, WebOrigin: me.WebOrigin, DeviceName: me.Installation.Name}
		}
	}
	b.account.mu.Lock()
	changed := !reflect.DeepEqual(fetched, b.account.value)
	b.account.installationID, b.account.value = installation.ID, fetched
	b.account.fetchedAt, b.account.stale, b.account.fetching = b.app.now(), false, false
	b.account.mu.Unlock()
	if changed && b.changed != nil {
		b.changed()
	}
}
