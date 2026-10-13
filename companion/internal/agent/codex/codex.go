// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package codex adapts Codex (CLI and Desktop) to the companion. Codex hooks
// carry the working directory, so they decide each thread's capture scope;
// the telemetry itself arrives over OTLP through the companion's gate.
package codex

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/hookfile"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

// ID and DesktopID match the harness names Beacon writes for Codex.
const (
	ID        = "codex_cli"
	DesktopID = "codex_desktop"
	hookName  = "codex"
	// hookTimeoutSeconds is part of each hook's trust hash in Codex; changing
	// it asks the user to trust the hooks again.
	hookTimeoutSeconds = 10
	desktopService     = "codex-app-server"
)

// HookEvents give every thread (root or subagent) a scope decision before
// its telemetry arrives, and re-check it when cwd may have changed.
var HookEvents = []string{"SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse"}

// eventLabels are Codex's hook_event_key_label values, used in trust keys.
var eventLabels = map[string]string{
	"SessionStart":     "session_start",
	"SubagentStart":    "subagent_start",
	"UserPromptSubmit": "user_prompt_submit",
	"PreToolUse":       "pre_tool_use",
}

var nativeID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$`)

type Codex struct{}

func New() Codex { return Codex{} }

func (Codex) ID() string                                                         { return ID }
func (Codex) Aliases() []string                                                  { return []string{hookName, DesktopID} }
func (Codex) Ingress() agent.Ingress                                             { return agent.IngressOTLP }
func (Codex) BeaconPlatform() string                                             { return "codex" }
func (Codex) PrepareBeaconInput(_ string, payload map[string]any) map[string]any { return payload }
func (Codex) RewriteCwd(payload map[string]any, cwd string)                      { payload["cwd"] = cwd }

// Harnesses: Codex Desktop's sessions are captured under their own harness,
// with their own capture windows and generations.
func (Codex) Harnesses() []string { return []string{DesktopID} }

// BeaconCommand is always false: Codex hook payloads carry scope, not the
// telemetry, which arrives over OTLP.
func (Codex) BeaconCommand(string) (string, bool) { return "", false }

// HarnessForService maps an OTLP service.name to the Codex harness.
func HarnessForService(serviceName string) string {
	if serviceName == desktopService {
		return DesktopID
	}
	return ID
}

func (Codex) IdentityPreserved(observation agent.Observation, sanitized map[string]any) bool {
	if sanitized["session_id"] != observation.NativeSessionID {
		return false
	}
	return observation.NativeToolCallID == "" || sanitized["tool_use_id"] == observation.NativeToolCallID
}

// codexHome honors CODEX_HOME, Codex's documented override of ~/.codex.
func codexHome(env agent.Env) string {
	if dir := env.Lookup("CODEX_HOME"); dir != "" && filepath.IsAbs(dir) {
		return filepath.Clean(dir)
	}
	return filepath.Join(env.Home, ".codex")
}

func hooksPath(env agent.Env) string  { return filepath.Join(codexHome(env), "hooks.json") }
func configPath(env agent.Env) string { return filepath.Join(codexHome(env), "config.toml") }

func (Codex) Discover(env agent.Env) agent.Presence {
	presence := agent.Presence{ConfigPath: hooksPath(env)}
	_, onPath := env.LookPath("codex")
	info, err := os.Stat(codexHome(env))
	presence.Installed = onPath || err == nil && info.IsDir()
	return presence
}

func (Codex) ParseHook(raw []byte) (agent.Observation, map[string]any, error) {
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
	if _, supported := eventLabels[event]; !supported {
		return agent.Observation{}, nil, agent.ErrUnsupportedEvent
	}
	observation := agent.Observation{Event: event}
	observation.NativeSessionID, _ = payload["session_id"].(string)
	observation.Cwd, _ = payload["cwd"].(string)
	if !nativeID.MatchString(observation.NativeSessionID) {
		return agent.Observation{}, nil, agent.ErrMissingIdentity
	}
	// A subagent runs as its own thread; its telemetry carries that id.
	observation.ThreadID = observation.NativeSessionID
	if agentID, _ := payload["agent_id"].(string); agentID != "" {
		if !nativeID.MatchString(agentID) {
			return agent.Observation{}, nil, agent.ErrMissingIdentity
		}
		observation.ThreadID = agentID
	} else if event == "SubagentStart" {
		return agent.Observation{}, nil, agent.ErrMissingIdentity
	}
	if event == "PreToolUse" {
		callID, _ := payload["tool_use_id"].(string)
		toolName, _ := payload["tool_name"].(string)
		if !nativeID.MatchString(callID) || strings.TrimSpace(toolName) == "" {
			return agent.Observation{}, nil, agent.ErrMissingIdentity
		}
		observation.NativeToolCallID = callID
	}
	return observation, payload, nil
}

func hookCommand(executable string) (string, error) {
	return agent.HookCommand(executable, hookName, agent.PowerShell)
}

func isOwned(command string) bool { return agent.IsOwnedHookCommand(command, hookName) }

// codexHandlerTypes are the hook handler types codex-cli 0.144.1 accepts.
var codexHandlerTypes = map[string]bool{"command": true, "prompt": true, "agent": true}

// validateHooksFile mirrors the checks Codex applies to hooks.json. Codex drops
// the whole file, and so our hooks with it, when any of them fails; unknown
// events and extra members of groups and handlers are accepted.
func validateHooksFile(root map[string]any) error {
	for field := range root {
		if field != "description" && field != "hooks" {
			return fmt.Errorf("hooks.json: unknown field %q", field)
		}
	}
	value, present := root["hooks"]
	if !present {
		return nil
	}
	events, ok := value.(map[string]any)
	if !ok {
		return errors.New("hooks.json: hooks is not an object")
	}
	for event, value := range events {
		groups, ok := value.([]any)
		if !ok {
			return fmt.Errorf("hooks.json: %s is not a list", event)
		}
		for _, value := range groups {
			group, ok := value.(map[string]any)
			if !ok {
				return fmt.Errorf("hooks.json: %s has a group that is not an object", event)
			}
			if handlers, present := group["hooks"]; present {
				if err := validateHandlers(event, handlers); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func validateHandlers(event string, value any) error {
	handlers, ok := value.([]any)
	if !ok {
		return fmt.Errorf("hooks.json: %s hooks is not a list", event)
	}
	for _, value := range handlers {
		handler, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("hooks.json: %s has a hook that is not an object", event)
		}
		handlerType, _ := handler["type"].(string)
		if !codexHandlerTypes[handlerType] {
			return fmt.Errorf("hooks.json: %s has a hook of unknown type", event)
		}
		if _, ok := handler["command"].(string); handlerType == "command" && !ok {
			return fmt.Errorf("hooks.json: %s has a command hook without a command", event)
		}
		// timeout is an Option<u64> in Codex, so null means unset.
		if timeout := handler["timeout"]; timeout != nil {
			if number, ok := timeout.(json.Number); !ok || !unsignedInteger.MatchString(number.String()) {
				return fmt.Errorf("hooks.json: %s has a hook whose timeout is not a whole number of seconds", event)
			}
		}
	}
	return nil
}

var unsignedInteger = regexp.MustCompile(`^[0-9]+$`)

func ownedGroup(command string) map[string]any {
	// No matcher: the hook runs for every source and tool, and the absent
	// matcher is part of its trust hash.
	return map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": hookTimeoutSeconds}}}
}

func installHooks(env agent.Env, create, readdMissing bool) (bool, error) {
	command, err := hookCommand(env.Executable)
	if err != nil {
		return false, err
	}
	changed := false
	err = hookfile.EditValidated(hooksPath(env), create, validateHooksFile, func(hooks map[string]any) (bool, error) {
		for _, event := range HookEvents {
			entries, err := hookfile.EventEntries(hooks, event)
			if err != nil {
				return false, err
			}
			owned := hookfile.OwnedCommands(entries, isOwned)
			if len(owned) == 1 && owned[0] == command || len(owned) == 0 && !readdMissing {
				continue
			}
			remaining, _ := hookfile.WithoutOwned(entries, isOwned)
			hooks[event] = append(remaining, ownedGroup(command))
			changed = true
		}
		return changed, nil
	})
	return changed, err
}

func removeHooks(env agent.Env) error {
	return hookfile.EditValidated(hooksPath(env), false, validateHooksFile, func(hooks map[string]any) (bool, error) {
		changed := false
		for event := range hooks {
			entries, err := hookfile.EventEntries(hooks, event)
			if err != nil {
				return false, err
			}
			remaining, removed := hookfile.WithoutOwned(entries, isOwned)
			if !removed {
				continue
			}
			changed = true
			if len(remaining) == 0 {
				delete(hooks, event)
			} else {
				hooks[event] = remaining
			}
		}
		return changed, nil
	})
}

// Install writes owned hooks and, unless another exporter is configured,
// points Codex's OTLP exporters at the companion gate.
func (Codex) Install(env agent.Env) error {
	hooksChanged, err := installHooks(env, true, true)
	if hooksChanged {
		recordIntegrationChange(env)
	}
	if err != nil {
		return err
	}
	configChanged, err := configureTelemetry(configPath(env), env.Telemetry, true)
	if configChanged {
		recordIntegrationChange(env)
	}
	if errors.Is(err, errConflictingExporter) {
		return nil
	}
	return err
}

// Repair repoints existing owned hooks and refreshes the managed telemetry
// block; it never re-adds hooks or telemetry the user removed.
func (Codex) Repair(env agent.Env) (bool, error) {
	hooksChanged, err := installHooks(env, false, false)
	if err != nil {
		return false, err
	}
	configChanged, err := configureTelemetry(configPath(env), env.Telemetry, false)
	if errors.Is(err, errConflictingExporter) {
		err = nil
	}
	if hooksChanged || configChanged {
		recordIntegrationChange(env)
	}
	return hooksChanged || configChanged, err
}

func (Codex) Uninstall(env agent.Env) error {
	if err := removeHooks(env); err != nil {
		return err
	}
	return removeTelemetry(configPath(env))
}

// ToolOutput is empty: Codex hook payloads are not retained; the OTLP gate
// applies the tool-output rule to Codex telemetry.
func (Codex) ToolOutput(string) []string { return nil }
