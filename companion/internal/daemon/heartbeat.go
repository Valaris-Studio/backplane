// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/buildinfo"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	HeartbeatInterval = 5 * time.Minute
	// The server stores at most one report a minute; sending faster is waste.
	heartbeatMinInterval = time.Minute
	// How often the agent states are re-read to notice a change.
	heartbeatCheckInterval = 30 * time.Second
	maxAgentDetail         = 200
)

type heartbeatState struct {
	sentAt    time.Time
	checkedAt time.Time
	// agents is the last sent agent states; a change is worth a heartbeat.
	agents string
}

// sendHeartbeat reports at start, when the agent states change and every
// five minutes, never more than once a minute. A failure waits for the
// next check; only a revoked-token 401 means anything beyond that.
func (d *Daemon) sendHeartbeat(ctx context.Context) {
	now := d.config.Now()
	beat := &d.heartbeat
	if !beat.checkedAt.IsZero() && now.Sub(beat.checkedAt) < heartbeatCheckInterval && now.Sub(beat.sentAt) < HeartbeatInterval {
		return
	}
	beat.checkedAt = now
	// A policy refresh clears this once the credential works again.
	if admission, err := state.Load[state.Admission](d.config.Layout.Admission()); err != nil || admission.RevokedFor(d.config.InstallationID) {
		return
	}
	report := d.statusReport()
	agents, _ := json.Marshal(report.Agents)
	due := beat.sentAt.IsZero() || now.Sub(beat.sentAt) >= HeartbeatInterval
	changed := string(agents) != beat.agents && now.Sub(beat.sentAt) >= heartbeatMinInterval
	if !due && !changed {
		return
	}
	if _, err := d.config.Client.ReportStatus(ctx, report); err != nil {
		if errors.Is(err, uplink.ErrDeviceRevoked) {
			d.markRevoked(ctx)
		}
		return
	}
	beat.sentAt, beat.agents = now, string(agents)
}

func (d *Daemon) statusReport() uplink.StatusReport {
	report := uplink.StatusReport{CompanionVersion: buildinfo.Version, BeaconCommit: beacon.Commit, Agents: d.agentStates(), RichCapture: d.richCaptureStatus()}
	stats, _ := d.queue.Stats()
	health, _ := state.Load[state.Health](d.config.Layout.Health())
	items, _ := inbox.List(d.config.Layout.InboxDir())
	report.Queue = uplink.QueueStatus{
		Pending: stats.Records + len(items),
		// Everything that will never be stored: rejected, dropped by the
		// server or locally, and suppressed deleted sessions.
		DroppedTotal:    stats.Rejected + stats.Dropped + health.DroppedItems + health.SuppressedDeleted,
		OldestPendingAt: stats.OldestPendingAt,
	}
	return report
}

// agentStates maps each agent's integration onto the capture state the
// server shows; details are problem codes, placed so no local path leaks.
func (d *Daemon) agentStates() []uplink.AgentStatus {
	cached, policyErr := policy.Load(d.config.Layout.Policy())
	preferences, _ := state.Load[state.Preferences](d.config.Layout.Preferences())
	paused := preferences.Paused || policyErr == nil && cached.Policy.Installation.Paused
	var states []uplink.AgentStatus
	for _, adapter := range d.config.Registry.All() {
		status := adapter.Status(d.config.AgentEnv)
		reported := uplink.AgentStatus{Harness: adapter.ID()}
		switch {
		case status.State == agent.NotInstalled:
			reported.State = "not_installed"
		case status.State == agent.Broken || status.State == agent.NeedsTrust || status.State == agent.InvalidConfig:
			reported.State = "error"
			reported.Detail = d.agentDetail(append([]string{string(status.State)}, status.Problems...))
		case paused || policyErr != nil || !cached.Policy.AgentEnabled(adapter.ID()):
			reported.State = "disabled"
		default:
			reported.State = "capturing"
		}
		states = append(states, reported)
	}
	return states
}

func (d *Daemon) agentDetail(problems []string) string {
	placed := privacy.PlaceEvent(map[string]any{"detail": strings.Join(problems, ", ")}, privacy.Place{Homes: []string{d.config.Home}})
	detail, _ := placed["detail"].(string)
	if len(detail) > maxAgentDetail {
		detail = detail[:maxAgentDetail]
	}
	return detail
}
