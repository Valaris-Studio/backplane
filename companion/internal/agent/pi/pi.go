// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package pi adapts Pi (pi.dev) to the companion through one managed
// extension that forwards Pi's events to `backplane-companion hook pi`.
package pi

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// ID matches the harness name beacon-hooks writes for Pi.
const ID = "pi_cli"

const (
	extensionFileName = "backplane-companion.ts"
	// ownershipMarker identifies the extension this companion wrote. Bump the
	// version when an older installed copy would behave wrongly.
	ownershipMarker = "backplane-companion-managed-pi-extension:v1"
	beaconExtension = "beacon.ts"
)

// SupportedEvents are the Pi events beacon-hooks' pi-event command maps.
var SupportedEvents = []string{"session_start", "session_shutdown", "input", "tool_call", "tool_result", "user_bash", "message_end"}

//go:embed extension.ts.tmpl
var extensionTemplate string

var nativeID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$`)

// toolCallID also admits Pi's OpenAI ids, `<call id>|<item id>`, which can run
// to hundreds of characters with base64 characters (+, /, =); same alphabet as
// the backend and MCP server, which hash ids over 200 characters.
var toolCallID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:@/+=|-]*$`)

const maxToolCallIDBytes = 4096

type Pi struct{}

func New() Pi { return Pi{} }

func (Pi) ID() string                                    { return ID }
func (Pi) Aliases() []string                             { return []string{"pi"} }
func (Pi) Ingress() agent.Ingress                        { return agent.IngressPlugin }
func (Pi) BeaconPlatform() string                        { return "pi" }
func (Pi) RewriteCwd(payload map[string]any, cwd string) { payload["cwd"] = cwd }

func (Pi) BeaconCommand(event string) (string, bool) {
	for _, supported := range SupportedEvents {
		if event == supported {
			return "pi-event", true
		}
	}
	return "", false
}

func (Pi) PrepareBeaconInput(_ string, payload map[string]any) map[string]any { return payload }

func (Pi) IdentityPreserved(observation agent.Observation, sanitized map[string]any) bool {
	if sanitized["sessionId"] != observation.NativeSessionID {
		return false
	}
	return observation.NativeToolCallID == "" || sanitized["toolCallId"] == observation.NativeToolCallID
}

// agentDir honors PI_CODING_AGENT_DIR, Pi's documented override of ~/.pi/agent.
func agentDir(env agent.Env) string {
	if dir := env.Lookup("PI_CODING_AGENT_DIR"); dir != "" && filepath.IsAbs(dir) {
		return filepath.Clean(dir)
	}
	return filepath.Join(env.Home, ".pi", "agent")
}

func extensionPath(env agent.Env) string {
	return filepath.Join(agentDir(env), "extensions", extensionFileName)
}

func (Pi) Discover(env agent.Env) agent.Presence {
	presence := agent.Presence{ConfigPath: extensionPath(env)}
	_, onPath := env.LookPath("pi")
	info, err := os.Stat(agentDir(env))
	presence.Installed = onPath || err == nil && info.IsDir()
	return presence
}

func (Pi) ParseHook(raw []byte) (agent.Observation, map[string]any, error) {
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil || decoder.Decode(new(any)) != io.EOF {
		return agent.Observation{}, nil, agent.ErrInvalidHook
	}
	if err := privacy.ValidateStructure(payload); err != nil {
		return agent.Observation{}, nil, errors.Join(agent.ErrInvalidHook, err)
	}
	event, _ := payload["type"].(string)
	if _, supported := (Pi{}).BeaconCommand(event); !supported {
		return agent.Observation{}, nil, agent.ErrUnsupportedEvent
	}
	// beacon-hooks maps only assistant messages; a user message is already
	// captured by its input event and is not retained twice.
	if event == "message_end" {
		message, _ := payload["message"].(map[string]any)
		if role, _ := message["role"].(string); role != "assistant" {
			return agent.Observation{}, nil, agent.ErrIgnoredEvent
		}
	}
	observation := agent.Observation{Event: event}
	observation.NativeSessionID, _ = payload["sessionId"].(string)
	observation.Cwd, _ = payload["cwd"].(string)
	if !nativeID.MatchString(observation.NativeSessionID) {
		return agent.Observation{}, nil, agent.ErrMissingIdentity
	}
	if event == "tool_call" || event == "tool_result" {
		callID, _ := payload["toolCallId"].(string)
		toolName, _ := payload["toolName"].(string)
		if len(callID) > maxToolCallIDBytes || !toolCallID.MatchString(callID) || strings.TrimSpace(toolName) == "" {
			return agent.Observation{}, nil, agent.ErrMissingIdentity
		}
		observation.NativeToolCallID = callID
	}
	return observation, payload, nil
}

func renderExtension(executable string) (string, error) {
	if !filepath.IsAbs(executable) {
		return "", agent.ErrConfigInvalid
	}
	var argv bytes.Buffer
	encoder := json.NewEncoder(&argv)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]string{executable, "hook", "pi"}); err != nil {
		return "", err
	}
	source := strings.Replace(extensionTemplate, "__OWNERSHIP_MARKER__", ownershipMarker, 1)
	return strings.Replace(source, "__COMPANION_ARGV__", strings.TrimSpace(argv.String()), 1), nil
}

// extensionState reads our extension file, refusing symlinks.
func extensionState(path string) (content []byte, exists, owned bool, err error) {
	for _, candidate := range []string{filepath.Dir(path), path} {
		if err := store.RejectSymlink(candidate); err != nil {
			return nil, false, false, errors.Join(agent.ErrConfigSymlink, err)
		}
	}
	content, err = os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, false, nil
	}
	if err != nil {
		return nil, false, false, err
	}
	return content, true, bytes.Contains(content, []byte(ownershipMarker)), nil
}

func (Pi) Install(env agent.Env) error {
	_, err := write(env, true)
	return err
}

// Repair rewrites an existing owned extension that is stale; it never
// recreates one the user removed.
func (Pi) Repair(env agent.Env) (bool, error) {
	return write(env, false)
}

func write(env agent.Env, create bool) (bool, error) {
	wanted, err := renderExtension(env.Executable)
	if err != nil {
		return false, err
	}
	path := extensionPath(env)
	content, exists, owned, err := extensionState(path)
	switch {
	case err != nil:
		return false, err
	case exists && !owned:
		return false, agent.ErrConfigForeign
	case !exists && !create, exists && string(content) == wanted:
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, err
	}
	mode := os.FileMode(0o600)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	// Never replace a version we did not read (e.g. a concurrent edit).
	err = store.WriteFileAtomicIf(path, []byte(wanted), mode, func() error {
		current, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if !bytes.Equal(current, content) {
			return agent.ErrConfigChanged
		}
		return nil
	})
	return err == nil, err
}

func (Pi) Uninstall(env agent.Env) error {
	path := extensionPath(env)
	_, exists, owned, err := extensionState(path)
	switch {
	case err != nil || !exists:
		return err
	case !owned:
		return agent.ErrConfigForeign
	}
	return os.Remove(path)
}

func (Pi) Status(env agent.Env) agent.IntegrationStatus {
	path := extensionPath(env)
	status := agent.IntegrationStatus{ConfigPath: path}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), beaconExtension)); err == nil {
		// Beacon's own extension reports to Beacon, not to Backplane; both
		// can run side by side.
		status.Notes = []string{"coexists_with_beacon_extension"}
	}
	content, exists, owned, err := extensionState(path)
	switch {
	case err != nil:
		status.State, status.Problems = agent.Broken, []string{agent.ProblemExtensionUnreadable}
		return status
	case !exists:
		status.State = agent.NotInstalled
		return status
	case !owned:
		status.State, status.Problems = agent.Broken, []string{agent.ProblemExtensionNotOwned}
		return status
	}
	if wanted, err := renderExtension(env.Executable); err != nil || string(content) != wanted {
		status.Problems = append(status.Problems, agent.ComponentProblem("extension", agent.ProblemStale))
	}
	if info, err := os.Stat(env.Executable); err != nil || !info.Mode().IsRegular() {
		status.Problems = append(status.Problems, agent.ProblemCompanionExecutableMissing)
	}
	status.State = agent.Installed
	if len(status.Problems) > 0 {
		status.State = agent.Broken
	}
	return status
}

func (Pi) ToolOutput(event string) []string {
	switch event {
	case "tool_result":
		return []string{"content", "details", "output", "result"}
	case "user_bash":
		return []string{"output", "result", "stdout", "stderr"}
	}
	return nil
}
