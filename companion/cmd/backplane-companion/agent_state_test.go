// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

type stubAgent struct {
	agent.Agent
	installed   bool
	integration agent.IntegrationState
}

func (s stubAgent) ID() string                        { return "stub" }
func (s stubAgent) Discover(agent.Env) agent.Presence { return agent.Presence{Installed: s.installed} }
func (s stubAgent) Status(agent.Env) agent.IntegrationStatus {
	return agent.IntegrationStatus{State: s.integration}
}

func TestAgentStatus_PresentButUnconfiguredIsNotConfigured(t *testing.T) {
	report := agentStatus(stubAgent{installed: true, integration: agent.NotInstalled}, agent.Env{}, state.AgentActivity{}, false, "", time.Now())
	if report.State != AgentStateNotConfigured || AgentStateNotConfigured != "not_configured" {
		t.Fatalf("state %q", report.State)
	}
}

func TestAgentStatus_AbsentAndUnconfiguredIsNotInstalled(t *testing.T) {
	report := agentStatus(stubAgent{installed: false, integration: agent.NotInstalled}, agent.Env{}, state.AgentActivity{}, false, "", time.Now())
	if report.State != AgentStateNotInstalled {
		t.Fatalf("state %q", report.State)
	}
}

func TestAgentStates_AreTheDocumentedSet(t *testing.T) {
	want := []string{"broken", "needs_trust", "invalid_config", "not_installed", "not_configured", "revoked", "not_connected", "paused", "uploading", "receiving", "idle"}
	if len(AgentStates) != len(want) {
		t.Fatalf("AgentStates = %v", AgentStates)
	}
	for index, state := range want {
		if AgentStates[index] != state {
			t.Fatalf("AgentStates[%d] = %q, want %q", index, AgentStates[index], state)
		}
	}
}
