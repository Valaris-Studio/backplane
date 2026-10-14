// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"errors"
	"os"
	"runtime"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/hookfile"
)

const hookTimeoutSeconds = 15

func (ClaudeCode) Install(env agent.Env) error {
	command, err := hookCommand(env.Executable)
	if err != nil {
		return err
	}
	return hookfile.Edit(settingsPath(env), true, func(hooks map[string]any) (bool, error) {
		changed := false
		for _, event := range HookEvents {
			entries, err := hookfile.EventEntries(hooks, event)
			if err != nil {
				return false, err
			}
			if owned := hookfile.OwnedCommands(entries, isOwned); len(owned) == 1 && owned[0] == command {
				continue
			}
			entries, _ = hookfile.WithoutOwned(entries, isOwned)
			hooks[event] = append(entries, ownedBlock(command))
			changed = true
		}
		return changed, nil
	})
}

func (ClaudeCode) Repair(env agent.Env) (bool, error) {
	command, err := hookCommand(env.Executable)
	if err != nil {
		return false, err
	}
	changed := false
	err = hookfile.Edit(settingsPath(env), false, func(hooks map[string]any) (bool, error) {
		for _, event := range HookEvents {
			entries, err := hookfile.EventEntries(hooks, event)
			if err != nil {
				return false, err
			}
			owned := hookfile.OwnedCommands(entries, isOwned)
			if len(owned) == 0 || len(owned) == 1 && owned[0] == command {
				continue
			}
			remaining, _ := hookfile.WithoutOwned(entries, isOwned)
			hooks[event] = append(remaining, ownedBlock(command))
			changed = true
		}
		return changed, nil
	})
	return changed, err
}

func ownedBlock(command string) map[string]any {
	return map[string]any{
		"matcher": "",
		"hooks":   []any{map[string]any{"type": "command", "command": command, "timeout": hookTimeoutSeconds}},
	}
}

func (ClaudeCode) Uninstall(env agent.Env) error {
	return hookfile.Edit(settingsPath(env), false, func(hooks map[string]any) (bool, error) {
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

func (ClaudeCode) Status(env agent.Env) agent.IntegrationStatus {
	path := settingsPath(env)
	status := agent.IntegrationStatus{ConfigPath: path}
	hooks, err := hookfile.ReadHooks(path)
	if errors.Is(err, os.ErrNotExist) {
		status.State = agent.NotInstalled
		return status
	}
	if err != nil {
		status.State = agent.Broken
		status.Problems = []string{agent.ProblemSettingsInvalid}
		return status
	}
	expected, _ := hookCommand(env.Executable)
	ownedTotal, missing := 0, 0
	for _, event := range HookEvents {
		entries, err := hookfile.EventEntries(hooks, event)
		if err != nil {
			status.Problems = append(status.Problems, agent.ComponentProblem(event, agent.ProblemInvalid))
			continue
		}
		owned := hookfile.OwnedCommands(entries, isOwned)
		ownedTotal += len(owned)
		switch {
		case len(owned) == 0:
			missing++
			status.Problems = append(status.Problems, agent.ComponentProblem(event, agent.ProblemMissing))
		case len(owned) > 1 || owned[0] != expected:
			status.Problems = append(status.Problems, agent.ComponentProblem(event, agent.ProblemStale))
		}
	}
	if ownedTotal > 0 && !isExecutable(env.Executable) {
		status.Problems = append(status.Problems, agent.ProblemCompanionExecutableMissing)
	}
	switch {
	case missing == len(HookEvents) && len(status.Problems) == missing:
		status.State, status.Problems = agent.NotInstalled, nil
	case len(status.Problems) == 0:
		status.State = agent.Installed
	default:
		status.State = agent.Broken
	}
	return status
}

func isOwned(command string) bool { return agent.IsOwnedHookCommand(command, "claude-code") }

func hookCommand(executable string) (string, error) {
	return agent.HookCommand(executable, "claude-code", agent.GitBash)
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}
