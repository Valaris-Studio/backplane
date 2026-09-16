// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestValidateLoopAgentID_NilAgent_FatalActionableError proves runLoopMode's
// -loop must refuse to start (before any iteration, before any spend) when
// the API key has no linked agent at all — the pre-existing "no agent"
// resolution path that already leaves agentID empty.
func TestValidateLoopAgentID_NilAgent_FatalActionableError(t *testing.T) {
	err := validateLoopAgentID(nil)
	if err == nil {
		t.Fatal("expected an error when no agent is linked to the API key")
	}
	if !strings.Contains(err.Error(), "agent key") && !strings.Contains(err.Error(), "AGENT key") {
		t.Errorf("error not actionable — must name the fix (use an agent key): %q", err.Error())
	}
	if strings.Contains(err.Error(), "user") == false && strings.Contains(err.Error(), "personal") == false {
		t.Errorf("error should call out that a user/personal key is the wrong kind of key: %q", err.Error())
	}
}

// TestValidateLoopAgentID_AgentWithEmptyID_FatalActionableError proves the
// exact root-cause shape from card 41506640: client.Agent is non-nil but its
// ID is empty (e.g. a malformed/partial agent record), which today produces
// agentID == "" fed straight into workloop.NewLoopMode -> POST
// /api/agents//executions (405, zero execution records, real spend). This
// must fail fast instead.
func TestValidateLoopAgentID_AgentWithEmptyID_FatalActionableError(t *testing.T) {
	agent := &valaris.AgentConfig{Name: "ghost-agent", IsActive: true, ID: ""}

	err := validateLoopAgentID(agent)
	if err == nil {
		t.Fatal("expected an error when the resolved agent ID is empty")
	}
	if !strings.Contains(err.Error(), "agent key") && !strings.Contains(err.Error(), "AGENT key") {
		t.Errorf("error not actionable — must name the fix (use an agent key): %q", err.Error())
	}
}

// TestValidateLoopAgentID_ValidAgent_Passes proves a normal agent-key
// resolution (non-nil Agent, non-empty ID) is allowed through unchanged.
func TestValidateLoopAgentID_ValidAgent_Passes(t *testing.T) {
	agent := &valaris.AgentConfig{Name: "real-agent", IsActive: true, ID: "agent-123"}

	if err := validateLoopAgentID(agent); err != nil {
		t.Errorf("valid agent with non-empty ID should pass: %v", err)
	}
}
