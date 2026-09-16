// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"gopkg.in/yaml.v3"
)

func absoluteMCPPath(path, base string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			if path == "~" {
				path = home
			} else {
				path = filepath.Join(home, path[2:])
			}
		}
	}
	if !filepath.IsAbs(path) && base != "" {
		path = filepath.Join(base, path)
	}
	resolved, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return resolved
}

func declaredMCPPath(configPath string) string {
	info, err := os.Stat(configPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return ""
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return ""
	}
	var doc struct {
		LLM struct {
			MCPConfigPath string `yaml:"mcp_config_path"`
		} `yaml:"llm"`
	}
	if yaml.Unmarshal(data, &doc) != nil || strings.TrimSpace(doc.LLM.MCPConfigPath) == "" {
		return ""
	}
	return absoluteMCPPath(doc.LLM.MCPConfigPath, filepath.Dir(configPath))
}

// Discovery reads only named locations; missing explicit paths remain visible.
func discoverMCPConfigs(candidatePaths []string, store *profile.Store) []tui.MCPConfigCandidate {
	candidates := []tui.MCPConfigCandidate{}
	seen := map[string]bool{}
	add := func(path, origin string, explicit bool) {
		if path == "" {
			return
		}
		path = absoluteMCPPath(path, "")
		if seen[path] {
			return
		}
		if _, err := os.Lstat(path); os.IsNotExist(err) && !explicit {
			return
		}
		seen[path] = true
		item := tui.MCPConfigCandidate{Path: path, Origin: origin, IsTemplate: isMCPConfigTemplate(path)}
		if err := validateMCPConfig(path); err != nil {
			item.Issue = err.Error()
		}
		candidates = append(candidates, item)
	}
	for _, candidate := range candidatePaths {
		add(declaredMCPPath(candidate), "runner config "+absoluteMCPPath(candidate, ""), true)
	}
	for _, candidate := range candidatePaths {
		for _, name := range mcpConfigFilenames {
			add(filepath.Join(filepath.Dir(candidate), name), "discovered beside "+absoluteMCPPath(candidate, ""), false)
		}
	}
	if store != nil {
		if profiles, err := store.ListExisting(); err == nil {
			for _, saved := range profiles {
				origin := fmt.Sprintf("profile %q", saved.Name)
				declared := declaredMCPPath(store.ConfigPath(saved.Name))
				add(declared, origin, true)
				add(store.MCPConfigPath(saved.Name), origin, false)
			}
		}
	}
	return candidates
}

// Validate structure without launching any candidate or returning file contents.
func validateMCPConfig(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("MCP config is missing or unreadable; choose an existing readable file")
	}
	if !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return fmt.Errorf("MCP config must be a regular JSON file smaller than 1 MiB")
	}
	if isMCPConfigTemplate(path) {
		return fmt.Errorf("This is the shipped template; choose a configured MCP file or generate one")
	}
	_, server, err := llm.ReadValarisMCPServerTemplate(path)
	if err != nil {
		return fmt.Errorf("MCP config must contain valid JSON with mcpServers.valaris")
	}
	command, ok := server["command"].(string)
	if !ok || strings.TrimSpace(command) == "" || strings.ContainsRune(command, 0) {
		return fmt.Errorf("MCP config requires a nonempty server command")
	}
	if raw, exists := server["args"]; exists {
		args, ok := raw.([]any)
		if !ok {
			return fmt.Errorf("MCP config server args must be a list of strings")
		}
		for _, arg := range args {
			value, ok := arg.(string)
			if !ok || strings.ContainsRune(value, 0) {
				return fmt.Errorf("MCP config server args must be NUL-free strings")
			}
		}
	}
	if raw, exists := server["env"]; exists {
		env, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("MCP config server env must map names to strings")
		}
		for name, value := range env {
			v, ok := value.(string)
			if !ok || name == "" || strings.ContainsAny(name, "=\x00") || strings.ContainsRune(v, 0) {
				return fmt.Errorf("MCP config server env must contain valid names and NUL-free string values")
			}
		}
	}
	return nil
}

func validateMCPWritePath(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("Choose a destination for the generated MCP config")
	}
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("%w; choose the existing config explicitly or enter a different generation destination", tui.ErrMCPConfigExists)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("MCP config destination cannot be inspected; choose a writable destination")
	}
	return nil
}

func mcpConfigIssue(path string) string {
	if path == "" {
		return ""
	}
	if err := validateMCPConfig(path); err != nil {
		return err.Error()
	}
	return ""
}
