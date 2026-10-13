// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/hookfile"
)

// trustHash reproduces Codex's hook trust identity (rust-v0.144.1,
// hooks/src/engine/discovery.rs command_hook_hash + config fingerprint
// version_for_toml): sha256 over the key-sorted compact JSON of the
// normalized hook. Our hooks have no matcher, statusMessage or
// commandWindows, so those members are absent, as Codex omits unset
// options. The companion only compares this with Codex's recorded
// trusted_hash; it never writes it.
func trustHash(label, command string, timeout int) string {
	identity := map[string]any{
		"event_name": label,
		"hooks":      []any{map[string]any{"async": false, "command": command, "timeout": timeout, "type": "command"}},
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.Encode(identity)
	// serde_json writes U+2028 and U+2029 raw; encoding/json escapes them.
	serialized := strings.NewReplacer(`\u2028`, "\u2028", `\u2029`, "\u2029").Replace(strings.TrimSuffix(buffer.String(), "\n"))
	sum := sha256.Sum256([]byte(serialized))
	return "sha256:" + hex.EncodeToString(sum[:])
}

const (
	trustTrusted    = "trusted"
	trustNeedsTrust = "needs_trust"
	trustModified   = "modified"
	trustUnknown    = "trust_unknown"
)

type trustResult struct {
	trust    string
	problems []string
}

// hookTrust reads [hooks.state] from config.toml. Codex keys each hook as
// "<hooks.json path>:<event label>:<group>:<handler>"; both the literal and
// the symlink-resolved path are accepted because Codex may canonicalize
// CODEX_HOME.
func hookTrust(env agent.Env) trustResult {
	hooks, err := hookfile.ReadHooks(hooksPath(env))
	if err != nil {
		return trustResult{trust: trustUnknown}
	}
	file, err := readConfig(configPath(env))
	if err != nil {
		return trustResult{trust: trustUnknown}
	}
	parsed, err := parseTOML(file.text)
	if err != nil {
		return trustResult{trust: trustUnknown}
	}
	hooksTable, _ := parsed["hooks"].(map[string]any)
	states, _ := hooksTable["state"].(map[string]any)
	prefixes := []string{hooksPath(env)}
	if resolved, err := filepath.EvalSymlinks(hooksPath(env)); err == nil && resolved != prefixes[0] {
		prefixes = append(prefixes, resolved)
	}
	counts := map[string]int{}
	result := trustResult{}
	for _, event := range HookEvents {
		entries, _ := hookfile.EventEntries(hooks, event)
		for _, position := range hookfile.OwnedHooks(entries, isOwned) {
			state, found := hookState(states, prefixes, eventLabels[event], position)
			switch {
			case !found:
				counts[trustNeedsTrust]++
			case state["enabled"] == false:
				result.problems = append(result.problems, agent.ProblemHookDisabledInCodex)
			case state["trusted_hash"] == trustHash(eventLabels[event], position.Command, hookTimeoutSeconds):
				counts[trustTrusted]++
			case state["trusted_hash"] == nil:
				counts[trustNeedsTrust]++
			default:
				counts[trustModified]++
			}
		}
	}
	switch {
	case counts[trustModified] > 0:
		result.trust = trustModified
	case counts[trustNeedsTrust] > 0:
		result.trust = trustNeedsTrust
	case counts[trustTrusted] > 0:
		result.trust = trustTrusted
	default:
		result.trust = trustUnknown
	}
	return result
}

func hookState(states map[string]any, prefixes []string, label string, position hookfile.OwnedPosition) (map[string]any, bool) {
	suffix := fmt.Sprintf(":%s:%d:%d", label, position.Group, position.Handler)
	for _, prefix := range prefixes {
		if state, ok := states[prefix+suffix].(map[string]any); ok {
			return state, true
		}
	}
	return nil, false
}

// Status combines hook ownership, Codex's trust in those hooks and the
// telemetry configuration.
func (Codex) Status(env agent.Env) agent.IntegrationStatus {
	status := agent.IntegrationStatus{ConfigPath: hooksPath(env)}
	hooks, err := hookfile.ReadValidatedHooks(hooksPath(env), validateHooksFile)
	switch {
	case errors.Is(err, os.ErrNotExist):
		hooks = map[string]any{}
	case errors.Is(err, agent.ErrConfigInvalid):
		status.State, status.Problems = agent.InvalidConfig, []string{agent.ProblemHooksInvalid}
		return withProblemPaths(status, env)
	case err != nil:
		status.State, status.Problems = agent.Broken, []string{agent.ProblemHooksInvalid}
		return withProblemPaths(status, env)
	}
	expected, _ := hookCommand(env.Executable)
	owned, missing := 0, 0
	for _, event := range HookEvents {
		entries, err := hookfile.EventEntries(hooks, event)
		if err != nil {
			status.Problems = append(status.Problems, agent.ComponentProblem(event, agent.ProblemInvalid))
			continue
		}
		commands := hookfile.OwnedCommands(entries, isOwned)
		owned += len(commands)
		switch {
		case len(commands) == 0:
			missing++
			status.Problems = append(status.Problems, agent.ComponentProblem(event, agent.ProblemMissing))
		case len(commands) > 1 || commands[0] != expected:
			status.Problems = append(status.Problems, agent.ComponentProblem(event, agent.ProblemStale))
		}
	}
	telemetry := telemetryState(configPath(env), env.Telemetry)
	status.Notes = telemetry.notes
	if owned == 0 && contains(telemetry.problems, agent.ComponentProblem("otel", agent.ProblemMissing)) && missing == len(HookEvents) {
		status.State, status.Problems = agent.NotInstalled, nil
		return status
	}
	status.Problems = append(status.Problems, telemetry.problems...)
	if owned > 0 {
		if info, err := os.Stat(env.Executable); err != nil || !info.Mode().IsRegular() {
			status.Problems = append(status.Problems, agent.ProblemCompanionExecutableMissing)
		}
		trust := hookTrust(env)
		status.Trust = trust.trust
		status.Problems = append(status.Problems, trust.problems...)
	}
	switch {
	case len(status.Problems) > 0:
		status.State = agent.Broken
	case status.Trust == trustNeedsTrust || status.Trust == trustModified:
		status.State = agent.NeedsTrust
	default:
		status.State = agent.Installed
	}
	// Added after the state: a restart is the user's step, not a repair.
	if owned > 0 {
		status.Problems = append(status.Problems, restartProblems(env)...)
	}
	return withProblemPaths(status, env)
}

// withProblemPaths maps each problem to the file it concerns: hook entries
// live in hooks.json; telemetry, trust and hook enablement in config.toml.
func withProblemPaths(status agent.IntegrationStatus, env agent.Env) agent.IntegrationStatus {
	for _, problem := range status.Problems {
		var path string
		switch {
		case problem == agent.ProblemCompanionExecutableMissing || problem == agent.ProblemRestartRequired || problem == agent.ProblemDaemonRestartRequired:
			continue
		case problem == agent.ProblemHooksInvalid || isHookEventProblem(problem):
			path = hooksPath(env)
		default:
			path = configPath(env)
		}
		if status.ProblemConfigPaths == nil {
			status.ProblemConfigPaths = map[string]string{}
		}
		status.ProblemConfigPaths[problem] = path
	}
	return status
}

func isHookEventProblem(problem string) bool {
	for _, event := range HookEvents {
		if strings.HasPrefix(problem, event+":") {
			return true
		}
	}
	return false
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
