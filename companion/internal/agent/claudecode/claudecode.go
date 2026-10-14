// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package claudecode adapts Claude Code's user-level hooks to the companion.
package claudecode

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

const ID = "claude_code"

// HookEvents are the Claude Code events the pinned beacon-hooks can normalize.
var HookEvents = []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"}

var beaconCommands = map[string]string{
	"SessionStart": "session-start", "SessionEnd": "session-end",
	"UserPromptSubmit": "prompt-submit", "PreToolUse": "pre-tool",
	"PostToolUse": "post-tool", "PostToolUseFailure": "post-tool", "Stop": "stop",
}

var nativeID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$`)

type ClaudeCode struct{}

func New() ClaudeCode { return ClaudeCode{} }

func (ClaudeCode) ID() string             { return ID }
func (ClaudeCode) Ingress() agent.Ingress { return agent.IngressHook }
func (ClaudeCode) BeaconPlatform() string { return "claude" }

func (ClaudeCode) BeaconCommand(event string) (string, bool) {
	command, ok := beaconCommands[event]
	return command, ok
}

func configDir(env agent.Env) string {
	if dir := env.Lookup("CLAUDE_CONFIG_DIR"); dir != "" && filepath.IsAbs(dir) {
		return filepath.Clean(dir)
	}
	return filepath.Join(env.Home, ".claude")
}

func settingsPath(env agent.Env) string { return filepath.Join(configDir(env), "settings.json") }

func (ClaudeCode) Discover(env agent.Env) agent.Presence {
	presence := agent.Presence{ConfigPath: settingsPath(env)}
	if info, err := os.Stat(configDir(env)); err == nil && info.IsDir() {
		presence.Installed = true
	}
	if _, found := env.LookPath("claude"); found {
		presence.Installed = true
	}
	return presence
}

func (ClaudeCode) ParseHook(raw []byte) (agent.Observation, map[string]any, error) {
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil || decoder.Decode(new(any)) != io.EOF {
		return agent.Observation{}, nil, agent.ErrInvalidHook
	}
	if err := privacy.ValidateStructure(payload); err != nil {
		return agent.Observation{}, nil, errors.Join(agent.ErrInvalidHook, err)
	}
	event, _ := payload["hook_event_name"].(string)
	if _, ok := beaconCommands[event]; !ok {
		return agent.Observation{}, nil, agent.ErrUnsupportedEvent
	}
	observation := agent.Observation{Event: event}
	observation.NativeSessionID, _ = payload["session_id"].(string)
	observation.Cwd, _ = payload["cwd"].(string)
	if !nativeID.MatchString(observation.NativeSessionID) {
		return agent.Observation{}, nil, agent.ErrMissingIdentity
	}
	if strings.Contains(event, "ToolUse") {
		callID, _ := payload["tool_use_id"].(string)
		toolName, _ := payload["tool_name"].(string)
		if !nativeID.MatchString(callID) || strings.TrimSpace(toolName) == "" {
			return agent.Observation{}, nil, agent.ErrMissingIdentity
		}
		observation.NativeToolCallID = callID
	}
	return observation, payload, nil
}

func (ClaudeCode) RewriteCwd(payload map[string]any, cwd string) { payload["cwd"] = cwd }

func (ClaudeCode) IdentityPreserved(observation agent.Observation, sanitized map[string]any) bool {
	if sanitized["session_id"] != observation.NativeSessionID {
		return false
	}
	return observation.NativeToolCallID == "" || sanitized["tool_use_id"] == observation.NativeToolCallID
}

// PrepareBeaconInput works around the pinned Claude mapper, which builds a
// file.modified event from tool_input before checking for failure.
func (ClaudeCode) PrepareBeaconInput(event string, payload map[string]any) map[string]any {
	if event != "PostToolUseFailure" {
		return payload
	}
	prepared := make(map[string]any, len(payload))
	for key, value := range payload {
		prepared[key] = value
	}
	delete(prepared, "tool_input")
	delete(prepared, "tool_response")
	return prepared
}

func (ClaudeCode) ToolOutput(event string) []string {
	if event == "PostToolUse" || event == "PostToolUseFailure" {
		return []string{"tool_response"}
	}
	return nil
}
