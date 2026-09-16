// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestValidateAgentConfig_NilAgent(t *testing.T) {
	if err := validateAgentConfig(nil, "any-workspace"); err != nil {
		t.Errorf("nil agent should pass: %v", err)
	}
}

func TestValidateAgentConfig_ActiveMatchingWorkspace(t *testing.T) {
	agent := &valaris.AgentConfig{
		Name: "test", IsActive: true,
		AllowedWorkspaces: []string{"internal", "staging"},
	}
	if err := validateAgentConfig(agent, "internal"); err != nil {
		t.Errorf("matching workspace should pass: %v", err)
	}
}

func TestValidateAgentConfig_Inactive(t *testing.T) {
	agent := &valaris.AgentConfig{Name: "test", IsActive: false}
	if err := validateAgentConfig(agent, "any"); err == nil {
		t.Error("inactive agent should fail")
	}
}

func TestValidateAgentConfig_WorkspaceNotAllowed(t *testing.T) {
	agent := &valaris.AgentConfig{
		Name: "test", IsActive: true,
		AllowedWorkspaces: []string{"staging"},
	}
	if err := validateAgentConfig(agent, "production"); err == nil {
		t.Error("disallowed workspace should fail")
	}
}

func TestValidateAgentConfig_EmptyAllowedWorkspaces(t *testing.T) {
	agent := &valaris.AgentConfig{
		Name: "test", IsActive: true,
		AllowedWorkspaces: nil,
	}
	if err := validateAgentConfig(agent, "anything"); err != nil {
		t.Errorf("empty allowed_workspaces means all allowed: %v", err)
	}
}
