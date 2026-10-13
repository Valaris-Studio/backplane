// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pi

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
)

// Pi has no MCP of its own: the community pi-mcp-adapter package adds it,
// merging user-level server files. The companion writes only the adapter's
// own file, and only when the user installed the adapter; it never installs it.

// ErrMCPAdapterMissing means pi-mcp-adapter is not installed; nothing is written.
var ErrMCPAdapterMissing = errors.New("mcp_adapter_missing")

const mcpAdapterPackage = "pi-mcp-adapter"

func mcpAdapterPath(env agent.Env) string { return filepath.Join(agentDir(env), "mcp-adapter.json") }

// userMCPFiles are the user-level files the adapter merges, lowest
// precedence first; in-repo files are never read or written.
func userMCPFiles(env agent.Env) []string {
	return []string{
		filepath.Join(env.Home, ".config", "mcp", "mcp.json"),
		filepath.Join(env.Home, ".agents", "mcp.json"),
		filepath.Join(env.Home, ".agents", "mcp", "mcp.json"),
		mcpAdapterPath(env),
	}
}

// MCPAdapterInstalled reports whether Pi's settings list the adapter package
// (`pi install npm:pi-mcp-adapter`), as a source string or a package object.
func MCPAdapterInstalled(env agent.Env) bool {
	settings, err := mcpentry.ReadJSON(filepath.Join(agentDir(env), "settings.json"))
	if err != nil {
		return false
	}
	packages, _ := settings["packages"].([]any)
	for _, value := range packages {
		switch declared := value.(type) {
		case string:
			if strings.Contains(declared, mcpAdapterPackage) {
				return true
			}
		case map[string]any:
			for _, field := range []string{"source", "name"} {
				if text, _ := declared[field].(string); strings.Contains(text, mcpAdapterPackage) {
					return true
				}
			}
		}
	}
	return false
}

func mcpServer(executable string) (map[string]any, error) {
	if !filepath.IsAbs(executable) || strings.ContainsAny(executable, "\x00\r\n") {
		return nil, fmt.Errorf("%w: companion path must be absolute", agent.ErrConfigInvalid)
	}
	return map[string]any{"command": executable, "args": []any{"mcp"}}, nil
}

// WriteMCP adds the global entry to the adapter's file. It writes nothing
// when the adapter is missing or any user-level file has a foreign
// "backplane".
func WriteMCP(env agent.Env) (bool, error) {
	entry, err := mcpServer(env.Executable)
	if err != nil {
		return false, err
	}
	if !MCPAdapterInstalled(env) {
		return false, ErrMCPAdapterMissing
	}
	for _, path := range userMCPFiles(env) {
		config, err := mcpentry.ReadJSON(path)
		if err != nil {
			continue
		}
		servers, _ := config["mcpServers"].(map[string]any)
		if existing, present := servers[mcpentry.Name]; present && !mcpentry.IsOwned(existing) {
			return false, mcpentry.ErrNameTaken
		}
	}
	changed := false
	err = mcpentry.EditJSON(mcpAdapterPath(env), true, func(config map[string]any) (bool, error) {
		servers, err := mcpentry.Servers(config, "mcpServers")
		if err != nil {
			return false, err
		}
		changed, err = mcpentry.Put(servers, entry)
		return changed, err
	})
	return changed && err == nil, err
}

func RemoveMCP(env agent.Env) (bool, error) {
	changed := false
	err := mcpentry.EditJSON(mcpAdapterPath(env), false, func(config map[string]any) (bool, error) {
		servers, _ := config["mcpServers"].(map[string]any)
		changed = mcpentry.Remove(servers)
		return changed, nil
	})
	return changed && err == nil, err
}

// RepairMCP repoints our entry at the current executable; it never adds one.
func RepairMCP(env agent.Env) (bool, error) {
	if _, err := mcpServer(env.Executable); err != nil {
		return false, err
	}
	changed := false
	err := mcpentry.EditJSON(mcpAdapterPath(env), false, func(config map[string]any) (bool, error) {
		servers, _ := config["mcpServers"].(map[string]any)
		changed = mcpentry.Repoint(servers, env.Executable)
		return changed, nil
	})
	return changed && err == nil, err
}

// MCPFindings names the other Backplane servers across the user-level files.
func MCPFindings(env agent.Env, endpoint string) ([]mcpentry.Finding, error) {
	findings := []mcpentry.Finding{}
	seen := map[mcpentry.Finding]bool{}
	for _, path := range userMCPFiles(env) {
		config, err := mcpentry.ReadJSON(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return findings, err
		}
		servers, _ := config["mcpServers"].(map[string]any)
		for _, finding := range mcpentry.Scan(servers, endpoint) {
			if !seen[finding] {
				seen[finding] = true
				findings = append(findings, finding)
			}
		}
	}
	return findings, nil
}
