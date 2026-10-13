// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"fmt"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
)

// Codex has no per-folder user-level MCP servers, so the companion keeps one
// global [mcp_servers.backplane] whose launcher resolves the board from the
// working directory. It lives in its own marker block, edited as text like
// the telemetry block and independent of it: either can be added or removed
// without touching the other.
const (
	mcpBlockBegin = "# BEGIN backplane-companion: Backplane MCP for agents (managed; do not edit)"
	mcpBlockEnd   = "# END backplane-companion-mcp"
	// mcpStartupTimeoutSeconds covers uvx fetching backplane-mcp on a cold
	// cache; Codex's default is 10.
	mcpStartupTimeoutSeconds = 30
)

// mcpManagedLine matches what mcpBlockBody writes, and nothing a user or
// Codex would add after it.
var mcpManagedLine = regexp.MustCompile(`^(\[mcp_servers\.backplane\]|command = "(?:[^"\\]|\\.)*"|args = \["mcp"\]|startup_timeout_sec = 30)$`)

var mcpKey = []string{"mcp_servers", mcpentry.Name}

func mcpServer(executable string) map[string]any {
	return map[string]any{"command": executable, "args": []any{"mcp"}, "startup_timeout_sec": int64(mcpStartupTimeoutSeconds)}
}

func mcpBlockBody(executable string) string {
	return fmt.Sprintf("[mcp_servers.backplane]\ncommand = %s\nargs = [\"mcp\"]\nstartup_timeout_sec = %d\n", tomlString(executable), mcpStartupTimeoutSeconds)
}

// tomlString is a TOML basic string; Go's %q escapes are not all TOML.
func tomlString(value string) string {
	var quoted strings.Builder
	quoted.WriteByte('"')
	for _, char := range value {
		switch {
		case char == '"' || char == '\\':
			quoted.WriteByte('\\')
			quoted.WriteRune(char)
		case char < 0x20 || char == 0x7f:
			fmt.Fprintf(&quoted, `\u%04X`, char)
		default:
			quoted.WriteRune(char)
		}
	}
	quoted.WriteByte('"')
	return quoted.String()
}

func isMCPBegin(line string) bool {
	return line == mcpBlockBegin || line == mcpBlockBegin+noFinalNewline
}

// mcpManagedLines marks our lines the way managedLines does for telemetry:
// BEGIN, then our own lines until END or a table Codex appended, and our END
// marker wherever Codex's rewrite left it. Any other line inside the block,
// or a second BEGIN, makes the block corrupt: that line would silently move
// to another table once our lines go.
func mcpManagedLines(lines []string) (managed []bool, found, corrupt bool) {
	managed = make([]bool, len(lines))
	inBlock := false
	pendingBlanks := []int{}
	claimPendingBlanks := func() {
		for _, blank := range pendingBlanks {
			managed[blank] = true
		}
		pendingBlanks = pendingBlanks[:0]
	}
	for index, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		switch {
		case isMCPBegin(trimmed):
			corrupt = corrupt || found
			managed[index], inBlock, found = true, true, true
			pendingBlanks = pendingBlanks[:0]
		case trimmed == mcpBlockEnd:
			managed[index], inBlock = true, false
			claimPendingBlanks()
		case inBlock && strings.TrimSpace(trimmed) == "":
			pendingBlanks = append(pendingBlanks, index)
		case inBlock && mcpManagedLine.MatchString(trimmed):
			managed[index] = true
			claimPendingBlanks()
		case inBlock && tableHeader.MatchString(trimmed):
			inBlock = false
			pendingBlanks = pendingBlanks[:0]
		case inBlock:
			corrupt = true
		}
	}
	return managed, found, corrupt
}

// withoutMCP removes our lines and the blank line we add before the block,
// restoring a missing final newline.
func withoutMCP(text string) (string, bool) {
	lines := strings.SplitAfter(text, "\n")
	managed, found, _ := mcpManagedLines(lines)
	kept := make([]string, 0, len(lines))
	restoreNoNewline := false
	for index, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		if isMCPBegin(trimmed) {
			restoreNoNewline = trimmed != mcpBlockBegin
			if count := len(kept); count > 0 && strings.TrimSpace(kept[count-1]) == "" {
				kept = kept[:count-1]
			}
		}
		if !managed[index] {
			kept = append(kept, line)
			if strings.TrimSpace(line) != "" {
				restoreNoNewline = false
			}
		}
	}
	text = strings.Join(kept, "")
	if restoreNoNewline {
		text = strings.TrimSuffix(text, "\n")
	}
	return text, found
}

func appendMCP(base, executable string) string {
	separator, begin := "", mcpBlockBegin
	if base != "" {
		if !strings.HasSuffix(base, "\n") {
			base += "\n"
			begin += noFinalNewline
		}
		separator = "\n"
	}
	return base + separator + begin + "\n" + mcpBlockBody(executable) + mcpBlockEnd + "\n"
}

// refreshMCP rewrites an existing block in place, so tables Codex appended
// after it keep their position.
func refreshMCP(text, executable string) string {
	lines := strings.SplitAfter(text, "\n")
	managed, _, _ := mcpManagedLines(lines)
	var out strings.Builder
	for index, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n")
		switch {
		case isMCPBegin(trimmed):
			out.WriteString(trimmed + "\n" + mcpBlockBody(executable) + mcpBlockEnd + "\n")
		case !managed[index]:
			out.WriteString(line)
		}
	}
	return out.String()
}

// errForeignLineInBlock refuses every edit of a block holding a line we did
// not write; the user fixes config.toml, or removes the block by hand.
var errForeignLineInBlock = fmt.Errorf("%w: config.toml has a foreign line inside the Backplane MCP block", agent.ErrConfigInvalid)

func blockCorrupt(text string) bool {
	_, _, corrupt := mcpManagedLines(strings.SplitAfter(text, "\n"))
	return corrupt
}

func ourServerIn(parsed map[string]any) (any, bool) {
	servers, _ := parsed["mcp_servers"].(map[string]any)
	entry, present := servers[mcpentry.Name]
	return entry, present
}

func validExecutable(executable string) error {
	if !filepath.IsAbs(executable) || !utf8.ValidString(executable) || strings.ContainsAny(executable, "\x00\r\n") {
		return fmt.Errorf("%w: companion path must be absolute", agent.ErrConfigInvalid)
	}
	return nil
}

// WriteMCP adds the global entry, or refreshes ours. A foreign
// [mcp_servers.backplane] is never touched: ErrNameTaken.
func WriteMCP(env agent.Env) (bool, error) {
	return editMCP(env, true)
}

// RepairMCP repoints an existing entry at the current executable; it never
// adds one.
func RepairMCP(env agent.Env) (bool, error) {
	return editMCP(env, false)
}

func editMCP(env agent.Env, create bool) (bool, error) {
	if err := validExecutable(env.Executable); err != nil {
		return false, err
	}
	path := configPath(env)
	file, err := readConfig(path)
	if err != nil {
		return false, err
	}
	parsed, err := parseTOML(file.text)
	if err != nil {
		return false, err
	}
	if blockCorrupt(file.text) {
		return false, errForeignLineInBlock
	}
	base, managed := withoutMCP(file.text)
	if !managed && !create {
		return false, nil
	}
	expected, err := parseTOML(base)
	if err != nil {
		return false, err
	}
	if _, foreign := ourServerIn(expected); foreign {
		return false, mcpentry.ErrNameTaken
	}
	want := mcpServer(env.Executable)
	if current, _ := ourServerIn(parsed); managed && reflect.DeepEqual(current, want) {
		return false, nil
	}
	desired := appendMCP(base, env.Executable)
	if managed {
		desired = refreshMCP(file.text, env.Executable)
	}
	servers, _ := expected["mcp_servers"].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
		expected["mcp_servers"] = servers
	}
	servers[mcpentry.Name] = want
	if err := verify(desired, expected); err != nil {
		return false, err
	}
	if err := writeConfig(path, file, desired); err != nil {
		return false, err
	}
	recordIntegrationChange(env)
	return true, nil
}

// RemoveMCP removes our block byte for byte, leaving telemetry and every
// foreign setting as they were.
func RemoveMCP(env agent.Env) (bool, error) {
	path := configPath(env)
	file, err := readConfig(path)
	if err != nil || !file.exists {
		return false, err
	}
	if blockCorrupt(file.text) {
		return false, errForeignLineInBlock
	}
	base, managed := withoutMCP(file.text)
	if !managed {
		return false, nil
	}
	before, err := parseTOML(file.text)
	if err != nil {
		return false, err
	}
	after, err := parseTOML(base)
	if err != nil {
		return false, err
	}
	withoutKey(before, mcpKey)
	if !reflect.DeepEqual(before, after) {
		return false, fmt.Errorf("%w: config.toml edit would change unrelated settings", agent.ErrConfigInvalid)
	}
	if err := writeConfig(path, file, base); err != nil {
		return false, err
	}
	recordIntegrationChange(env)
	return true, nil
}

// MCPFindings names the other Backplane servers in config.toml.
func MCPFindings(env agent.Env, endpoint string) ([]mcpentry.Finding, error) {
	file, err := readConfig(configPath(env))
	if err != nil {
		return []mcpentry.Finding{}, err
	}
	parsed, err := parseTOML(file.text)
	if err != nil {
		return []mcpentry.Finding{}, err
	}
	servers, _ := parsed["mcp_servers"].(map[string]any)
	return mcpentry.Scan(servers, endpoint), nil
}

// MCPConfigured reports whether config.toml holds our current entry.
func MCPConfigured(env agent.Env) (bool, error) {
	file, err := readConfig(configPath(env))
	if err != nil {
		return false, err
	}
	parsed, err := parseTOML(file.text)
	if err != nil {
		return false, err
	}
	current, _ := ourServerIn(parsed)
	return reflect.DeepEqual(current, mcpServer(env.Executable)), nil
}
