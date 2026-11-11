// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package hermes adapts Hermes Agent to the companion through an observer
// plugin that forwards four lifecycle hooks to `backplane-companion hook
// hermes`. Only metadata is kept: every member outside an allowlist is
// dropped, never digested.
package hermes

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

// ID is the harness the backend records; Beacon's own events name it "hermes".
const ID = "hermes_agent"

const (
	pluginName = "backplane-companion"
	// noteManualPluginSetup: the companion does not install the plugin; the
	// user copies it into Hermes' plugins directory and enables it.
	noteManualPluginSetup = "manual_plugin_setup"
)

// commandForEvent maps each forwarded hook to its pinned beacon-hooks
// --platform hermes command; permission-request is the only one that emits
// approval.denied. Hermes fires on_session_end after every turn, so it is
// never forwarded: only on_session_finalize ends a session. stop is not
// forwarded either, because Beacon maps it to a completion that reads as
// success.
var commandForEvent = map[string]string{
	"on_session_start":       "session-start",
	"post_tool_call":         "post-tool",
	"post_approval_response": "permission-request",
	"on_session_finalize":    "session-end",
}

type Hermes struct{}

func New() Hermes { return Hermes{} }

func (Hermes) ID() string                                    { return ID }
func (Hermes) Aliases() []string                             { return []string{"hermes"} }
func (Hermes) Ingress() agent.Ingress                        { return agent.IngressPlugin }
func (Hermes) BeaconPlatform() string                        { return "hermes" }
func (Hermes) RewriteCwd(payload map[string]any, cwd string) { payload["cwd"] = cwd }
func (Hermes) ToolOutput(string) []string                    { return nil }

func (Hermes) BeaconCommand(event string) (string, bool) {
	command, supported := commandForEvent[event]
	return command, supported
}

// PrepareBeaconInput passes the projection as is: tool_call_id is already top
// level, where Beacon reads it, and approval choices already collapsed.
func (Hermes) PrepareBeaconInput(_ string, payload map[string]any) map[string]any { return payload }

func (Hermes) IdentityPreserved(observation agent.Observation, sanitized map[string]any) bool {
	if sanitized["session_id"] != observation.NativeSessionID {
		return false
	}
	return observation.NativeToolCallID == "" || sanitized["tool_call_id"] == observation.NativeToolCallID
}

func (Hermes) ParseHook(raw []byte) (agent.Observation, map[string]any, error) {
	var hook map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&hook); err != nil || hook == nil || decoder.Decode(new(any)) != io.EOF {
		return agent.Observation{}, nil, agent.ErrInvalidHook
	}
	if err := privacy.ValidateStructure(hook); err != nil {
		return agent.Observation{}, nil, errors.Join(agent.ErrInvalidHook, err)
	}
	event, _ := hook["hook_event_name"].(string)
	if _, supported := commandForEvent[event]; !supported {
		return agent.Observation{}, nil, agent.ErrUnsupportedEvent
	}
	extra, _ := hook["extra"].(map[string]any)
	// On a messaging surface Hermes' session cwd is the profile's terminal
	// directory, not a workspace, so the session cannot be scoped.
	if platform, _ := extra["platform"].(string); !localSurfaces[platform] {
		return agent.Observation{}, nil, agent.ErrIgnoredEvent
	}
	if choice, _ := extra["choice"].(string); event == "post_approval_response" && !denyingChoices[choice] {
		return agent.Observation{}, nil, agent.ErrIgnoredEvent
	}
	observation := agent.Observation{Event: event}
	observation.NativeSessionID, _ = hook["session_id"].(string)
	observation.Cwd, _ = hook["cwd"].(string)
	if !nativeID.MatchString(observation.NativeSessionID) || !filepath.IsAbs(observation.Cwd) {
		return agent.Observation{}, nil, agent.ErrMissingIdentity
	}
	callID, _ := hook["tool_call_id"].(string)
	if isHermesMintedCallID(callID) || validNativeRef(callID) && len(callID) > maxUploadedCallIDBytes {
		turnID, _ := extra["turn_id"].(string)
		observedAt, _ := extra["observed_at"].(string)
		callID = callIDOfFiring(observation.NativeSessionID, turnID, observedAt)
	}
	switch {
	case event == "post_tool_call" && !validNativeRef(callID):
		return agent.Observation{}, nil, agent.ErrMissingIdentity
	case event == "post_tool_call", event == "post_approval_response" && validNativeRef(callID):
		observation.NativeToolCallID = callID
	}
	return observation, projectHook(observation, hook, extra), nil
}

func hermesHome(env agent.Env) string {
	if home := env.Lookup("HERMES_HOME"); home != "" && filepath.IsAbs(home) {
		return filepath.Clean(home)
	}
	return filepath.Join(env.Home, ".hermes")
}

func manifestPath(env agent.Env) string {
	return filepath.Join(hermesHome(env), "plugins", pluginName, "plugin.yaml")
}

func (Hermes) Discover(env agent.Env) agent.Presence {
	presence := agent.Presence{ConfigPath: manifestPath(env)}
	_, onPath := env.LookPath("hermes")
	info, err := os.Stat(hermesHome(env))
	presence.Installed = onPath || err == nil && info.IsDir()
	return presence
}

// Install, Uninstall and Repair change nothing: the plugin is set up by hand,
// and an error here would abort `agents install` for every agent.
func (Hermes) Install(agent.Env) error        { return nil }
func (Hermes) Uninstall(agent.Env) error      { return nil }
func (Hermes) Repair(agent.Env) (bool, error) { return false, nil }
func (Hermes) Status(env agent.Env) agent.IntegrationStatus {
	path := manifestPath(env)
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		return agent.IntegrationStatus{State: agent.Installed, ConfigPath: path}
	}
	return agent.IntegrationStatus{State: agent.NotInstalled, ConfigPath: path, Notes: []string{noteManualPluginSetup}}
}
