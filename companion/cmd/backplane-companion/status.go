// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/buildinfo"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/service"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// activityWindow is how recent an observation or upload must be for an agent
// to count as receiving or uploading.
const activityWindow = 24 * time.Hour

// Agent states in status.agents[].state, in the order they win: an
// integration problem first, then setup, then the device's connection,
// then activity. not_configured is an agent present on this machine whose
// hooks are not set up (enabled_agents may leave it off on purpose).
const (
	AgentStateBroken        = "broken"
	AgentStateNeedsTrust    = "needs_trust"
	AgentStateInvalidConfig = "invalid_config"
	AgentStateNotInstalled  = "not_installed"
	AgentStateNotConfigured = "not_configured"
	AgentStatePaused        = "paused"
	AgentStateUploading     = "uploading"
	AgentStateReceiving     = "receiving"
	AgentStateIdle          = "idle"
)

// AgentStates is every state an agent reports; revoked and not_connected
// are the capture states a device that cannot upload shows instead.
var AgentStates = []string{AgentStateBroken, AgentStateNeedsTrust, AgentStateInvalidConfig, AgentStateNotInstalled, AgentStateNotConfigured, "revoked", "not_connected", AgentStatePaused, AgentStateUploading, AgentStateReceiving, AgentStateIdle}

type agentReport struct {
	ID                string                  `json:"id"`
	State             string                  `json:"state"`
	Installed         bool                    `json:"installed"`
	Configured        bool                    `json:"configured"`
	Receiving         bool                    `json:"receiving"`
	Uploading         bool                    `json:"uploading"`
	Paused            bool                    `json:"paused"`
	Broken            bool                    `json:"broken"`
	LastObservationAt *time.Time              `json:"last_observation_at"`
	LastUploadAt      *time.Time              `json:"last_upload_at"`
	Integration       agent.IntegrationStatus `json:"integration"`
}

type queueReport struct {
	queue.Stats
	InboxItems      int   `json:"inbox_items"`
	CapacityRecords int   `json:"capacity_records"`
	CapacityBytes   int64 `json:"capacity_bytes"`
	BackingOff      bool  `json:"backing_off"`
}

type captureReport struct {
	// State is one of: revoked, not_connected, paused_locally,
	// paused_by_server, policy_stale, active.
	State             string     `json:"state"`
	LocalPaused       bool       `json:"local_paused"`
	Unauthorized      bool       `json:"unauthorized"`
	PolicyCached      bool       `json:"policy_cached"`
	PolicyRefreshedAt *time.Time `json:"policy_refreshed_at"`
	PolicyAgeSeconds  int64      `json:"policy_age_seconds"`
	PolicyStale       bool       `json:"policy_stale"`
	ServerPaused      bool       `json:"server_paused"`
	// EnabledAgents is null when every harness is enabled.
	EnabledAgents []string `json:"enabled_agents"`
	// RetentionDays is the server's retention; null keeps sessions until
	// their owner deletes them.
	RetentionDays *int `json:"retention_days"`
	Mappings      int  `json:"mappings"`
	// Reported by the control API only; the CLI JSON keeps its shape.
	autoMatchRepos bool
	excludeGlobs   []string
}

type statusReport struct {
	// Companion is this CLI's build; health.daemon is the running daemon's.
	Companion buildinfo.Info `json:"companion"`
	Connected bool           `json:"connected"`
	// Revoked: the server refused the device credential; connect again.
	Revoked        bool   `json:"revoked"`
	InstallationID string `json:"installation_id"`
	Endpoint       string `json:"endpoint"`
	// Connections lists every Backplane this device is connected to: at most
	// one today, mirrored by the top-level fields above.
	Connections []connectionReport `json:"connections"`
	// AgentAPI is what agents' backplane-mcp calls; absent with no installation.
	AgentAPI        *agentAPIReport           `json:"agent_api,omitempty"`
	DataDir         string                    `json:"data_dir"`
	DaemonRunning   bool                      `json:"daemon_running"`
	Service         *service.Status           `json:"service"`
	Capture         captureReport             `json:"capture"`
	Agents          []agentReport             `json:"agents"`
	Queue           queueReport               `json:"queue"`
	PendingProjects []state.DiscoveredProject `json:"pending_projects"`
	Health          state.Health              `json:"health"`
}

type connectionReport struct {
	InstallationID string `json:"installation_id"`
	Endpoint       string `json:"endpoint"`
	Connected      bool   `json:"connected"`
	Revoked        bool   `json:"revoked"`
	// CaptureState is capture.state for this connection.
	CaptureState string                `json:"capture_state"`
	RichCapture  connectionRichCapture `json:"rich_capture"`
}

// connectionRichCapture is what the connection's latest cached policy said
// of rich capture.
type connectionRichCapture struct {
	// Offer is offered, not_offered (an explicit null) or unknown (no policy
	// cached, or a server from before rich capture).
	Offer string `json:"offer"`
}

func richCaptureOffer(cached *policy.Cached) connectionRichCapture {
	switch {
	case cached == nil || !cached.Policy.RichCapture.Present:
		return connectionRichCapture{Offer: "unknown"}
	case cached.Policy.RichCapture.Offer == nil:
		return connectionRichCapture{Offer: "not_offered"}
	}
	return connectionRichCapture{Offer: "offered"}
}

// agentAPIReport: Source "absent" or "rejected" means URL is the paired
// endpoint because the server advertised no usable API base.
type agentAPIReport struct {
	URL    string               `json:"url"`
	Source policy.APIBaseSource `json:"source"`
}

func (a *app) status(ctx context.Context, args []string) error {
	flags := newFlags("status")
	human := flags.Bool("human", false, "short human-readable view")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return fmt.Errorf("%w: status [--human]", errUsage)
	}
	layout, err := a.layout()
	if err != nil {
		return err
	}
	report, err := a.buildStatus(ctx, layout, nil)
	if err != nil {
		return err
	}
	if *human {
		writeHumanStatus(a.stdout, report, a.now(), locale(a.getenv))
		return nil
	}
	return a.printJSON(report)
}

// statusProbeTTL is how long the control API reuses the service-manager and
// keyring probes, which may spawn a process or ask the OS keychain. Any
// change through the API or to the connection files invalidates them.
const statusProbeTTL = 30 * time.Second

// probed is what the slow probes found: the connection (the keyring holds
// the token) and the service manager's view.
type probed struct {
	installation state.Installation
	connectErr   error
	service      *service.Status
	// device is the client the keyring probe built, reused by the control
	// API's own calls so they add no keyring reads.
	device *uplink.Client
}

type statusProbes struct {
	mu       sync.Mutex
	cached   *probed
	cachedAt time.Time
}

func (p *statusProbes) invalidate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cached = nil
}

// probe returns the probes, from the cache when probes is set and fresh.
func (a *app) probe(ctx context.Context, layout store.Layout, probes *statusProbes) probed {
	if probes != nil {
		probes.mu.Lock()
		defer probes.mu.Unlock()
		if probes.cached != nil && a.now().Sub(probes.cachedAt) < statusProbeTTL {
			return *probes.cached
		}
	}
	var result probed
	result.installation, result.device, result.connectErr = a.connectedClient(layout)
	if manager, _, err := a.serviceManager(); err == nil {
		if status, err := manager.Status(ctx); err == nil {
			result.service = &status
		}
	}
	if probes != nil {
		probes.cached, probes.cachedAt = &result, a.now()
	}
	return result
}

// buildStatus is the status report of CLI status and the control API;
// probes, when set, caches the slow probes.
func (a *app) buildStatus(ctx context.Context, layout store.Layout, probes *statusProbes) (statusReport, error) {
	probe := a.probe(ctx, layout, probes)
	installation, connectErr := probe.installation, probe.connectErr
	report := statusReport{Companion: buildinfo.Current(a.goos, a.goarch), InstallationID: installation.ID, Endpoint: installation.Endpoint, DataDir: layout.Root, DaemonRunning: daemonRunning(layout), Service: probe.service}
	if installation.ID != "" && installation.Endpoint != "" {
		url, source := agentAPI(layout, installation)
		report.AgentAPI = &agentAPIReport{URL: url, Source: source}
	}
	preferences, err := state.Load[state.Preferences](layout.Preferences())
	if err != nil {
		return report, err
	}
	admission, err := state.Load[state.Admission](layout.Admission())
	if err != nil {
		return report, err
	}
	report.Revoked = admission.RevokedFor(installation.ID)
	// A flag another installation left is cleared by the daemon's next
	// policy refresh; it is not this installation's revocation.
	admission.Unauthorized = report.Revoked
	report.Connected = connectErr == nil && !report.Revoked
	cached, policyErr := policy.Load(layout.Policy())
	var cachedPolicy *policy.Cached
	if policyErr == nil {
		cachedPolicy = &cached
	}
	report.Capture = captureStatus(report.Connected, preferences, admission, cachedPolicy, a.now())
	report.Connections = []connectionReport{}
	if installation.ID != "" {
		report.Connections = append(report.Connections, connectionReport{InstallationID: installation.ID, Endpoint: installation.Endpoint, Connected: report.Connected, Revoked: report.Revoked, CaptureState: report.Capture.State, RichCapture: richCaptureOffer(cachedPolicy)})
	}
	connection := ""
	if !report.Connected {
		connection = report.Capture.State
	}
	if report.Health, err = state.Load[state.Health](layout.Health()); err != nil {
		return report, err
	}
	if report.Queue, err = queueStatus(layout, a.now()); err != nil {
		return report, err
	}
	discovered, err := state.Load[state.Discovered](layout.Discovered())
	if err != nil {
		return report, err
	}
	report.PendingProjects = pendingProjects(discovered, preferences)
	env := a.agentEnv()
	report.Agents = []agentReport{}
	for _, adapter := range a.registry.All() {
		paused := preferences.Paused || cachedPolicy != nil && (cachedPolicy.Policy.Installation.Paused || !cachedPolicy.Policy.AgentEnabled(adapter.ID()))
		report.Agents = append(report.Agents, agentStatus(adapter, env, report.Health.Agents[adapter.ID()], paused, connection, a.now()))
	}
	return report, nil
}

func captureStatus(connected bool, preferences state.Preferences, admission state.Admission, cached *policy.Cached, now time.Time) captureReport {
	report := captureReport{LocalPaused: preferences.Paused, Unauthorized: admission.Unauthorized}
	if cached != nil {
		refreshed := cached.RefreshedAt
		report.PolicyCached, report.PolicyRefreshedAt = true, &refreshed
		report.PolicyAgeSeconds = int64(now.Sub(refreshed) / time.Second)
		report.PolicyStale = cached.Stale(now)
		report.ServerPaused = cached.Policy.Installation.Paused
		report.EnabledAgents = cached.Policy.Installation.EnabledAgents
		report.RetentionDays = cached.Policy.Installation.RetentionDays
		report.autoMatchRepos = cached.Policy.Installation.AutoMatchRepos
		report.excludeGlobs = cached.Policy.Installation.ExcludeGlobs
		report.Mappings = len(cached.Policy.Mappings)
	}
	switch {
	case admission.Unauthorized:
		report.State = "revoked"
	case !connected || cached == nil:
		report.State = "not_connected"
	case preferences.Paused:
		report.State = "paused_locally"
	case report.ServerPaused:
		report.State = "paused_by_server"
	case report.PolicyStale:
		report.State = "policy_stale"
	default:
		report.State = "active"
	}
	return report
}

// agentStatus reports a configured agent of a device that cannot upload by
// its connection state (revoked, not_connected) rather than past activity.
func agentStatus(adapter agent.Agent, env agent.Env, activity state.AgentActivity, paused bool, connection string, now time.Time) agentReport {
	integration := adapter.Status(env)
	report := agentReport{
		ID:          adapter.ID(),
		Installed:   adapter.Discover(env).Installed,
		Configured:  integration.State == agent.Installed,
		Broken:      integration.State == agent.Broken,
		Paused:      paused,
		Integration: integration,
	}
	if !activity.LastObservationAt.IsZero() {
		observed := activity.LastObservationAt
		report.LastObservationAt = &observed
		report.Receiving = now.Sub(observed) < activityWindow
	}
	if !activity.LastUploadAt.IsZero() {
		uploaded := activity.LastUploadAt
		report.LastUploadAt = &uploaded
		report.Uploading = connection == "" && now.Sub(uploaded) < activityWindow
	}
	switch {
	case report.Broken:
		report.State = AgentStateBroken
	case integration.State == agent.NeedsTrust:
		report.State = AgentStateNeedsTrust
	case integration.State == agent.InvalidConfig:
		report.State = AgentStateInvalidConfig
	case !report.Configured && !report.Installed:
		report.State = AgentStateNotInstalled
	case !report.Configured:
		report.State = AgentStateNotConfigured
	case connection != "":
		report.State = connection
	case report.Paused:
		report.State = AgentStatePaused
	case report.Uploading:
		report.State = AgentStateUploading
	case report.Receiving:
		report.State = AgentStateReceiving
	default:
		report.State = AgentStateIdle
	}
	return report
}

func queueStatus(layout store.Layout, now time.Time) (queueReport, error) {
	stats, err := queue.Open(layout).Stats()
	if err != nil {
		return queueReport{}, err
	}
	items, err := inbox.List(layout.InboxDir())
	if err != nil {
		return queueReport{}, err
	}
	return queueReport{Stats: stats, InboxItems: len(items), CapacityRecords: queue.MaxRecords, CapacityBytes: queue.MaxBytes, BackingOff: now.Before(stats.NextAttempt)}, nil
}

// pendingProjects are discovered repositories still waiting for the user to
// map or ignore them.
func pendingProjects(discovered state.Discovered, preferences state.Preferences) []state.DiscoveredProject {
	ignored := map[string]bool{}
	for _, path := range preferences.IgnoredPaths {
		ignored[path] = true
	}
	pending := []state.DiscoveredProject{}
	for _, project := range discovered.Projects {
		if !ignored[project.Root] {
			pending = append(pending, project)
		}
	}
	return pending
}

func writeHumanStatus(output io.Writer, report statusReport, now time.Time, locale string) {
	label := func(key string) string { return message(key, locale) }
	line := func(key, value string) { fmt.Fprintf(output, "%-12s %s\n", label(key), value) }
	fmt.Fprintln(output, label("status_title"))
	switch {
	case report.Revoked:
		line("status_connection", label("status_revoked"))
	case report.Connected:
		line("status_connection", label("status_connected")+" — "+report.Endpoint)
	default:
		line("status_connection", label("status_not_connected"))
	}
	serviceState := label("status_service_not_installed")
	switch {
	case report.DaemonRunning:
		serviceState = label("status_service_running")
	case report.Service != nil && report.Service.Installed:
		serviceState = label("status_service_stopped")
	}
	line("status_service", serviceState)
	version := report.Companion.Version
	if daemon := report.Health.Daemon; daemon != nil && report.DaemonRunning && daemon.Version != version {
		version += " (" + label("status_daemon_version") + " " + daemon.Version + ")"
	}
	line("status_version", version)
	line("status_capture", report.Capture.State)
	retention := label("status_retention_forever")
	if days := report.Capture.RetentionDays; days != nil {
		retention = fmt.Sprintf(label("status_retention_days"), *days)
	}
	line("status_retention", retention)
	fmt.Fprintln(output, label("status_agents"))
	for _, agentReport := range report.Agents {
		details := []string{agentReport.State}
		if agentReport.LastObservationAt != nil {
			details = append(details, label("status_last_observation")+" "+agentReport.LastObservationAt.Format(time.RFC3339))
		}
		if agentReport.LastUploadAt != nil {
			details = append(details, label("status_last_upload")+" "+agentReport.LastUploadAt.Format(time.RFC3339))
		}
		fmt.Fprintf(output, "  %-12s %s\n", agentReport.ID, strings.Join(details, " · "))
	}
	queueLine := fmt.Sprintf(label("status_queue_summary"), report.Queue.Records, report.Queue.InboxItems, report.Queue.Rejected)
	if report.Queue.BackingOff {
		queueLine += " · " + label("status_retrying_after") + " " + report.Queue.NextAttempt.Format(time.RFC3339)
	}
	if report.Queue.LastError != "" {
		queueLine += " · " + report.Queue.LastError
	}
	line("status_queue", queueLine)
	if count := len(report.PendingProjects); count > 0 {
		fmt.Fprintf(output, label("status_pending_projects")+"\n", count)
	}
}
