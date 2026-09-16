// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// valarisMCPToolPrefix is what the coding agent prepends when it surfaces an
// MCP tool to the model. Board allowlists and loop prompts speak the prefixed
// form; the MCP server's own catalog is unprefixed, because the prefix is the
// client's namespacing, not the server's. Both spellings have to be accepted
// when reading a catalog — see offSwitchInCatalog.
const valarisMCPToolPrefix = "mcp__valaris__"

// offSwitchUnservedWarning covers the third and last way the off-switch can be
// missing, and the only one that actually happened: the board granted it, the
// API accepts it, and the MCP server the session talks to does not serve it.
// Loops #1–#3 all ended on a safety rail because a stale PyPI wheel resolved
// behind the configured template. The other two warnings send the operator to
// the board's tool list and to the agent's identity respectively — both would
// be wrong here, so this message names the server instead.
const offSwitchUnservedWarning = "loop mode: " + offSwitchTool +
	" is allowlisted and callable but the configured MCP server does NOT serve it — the session will have no off-switch, " +
	"so a safety rail (max_iterations or budget_usd) will be the only stop; the MCP server build is stale or misconfigured"

// mcpSurfaceProbeTimeout bounds the whole spawn + handshake. The probe is a
// diagnostic that runs before the first session, so a server that hangs must
// cost a few seconds and then be treated as inconclusive — never delay the run.
const mcpSurfaceProbeTimeout = 10 * time.Second

// MCPDeprecation is the `_meta.deprecated` block the MCP server stamps on a
// tool it retired behind an alias: the alias still answers until RemovedIn.
type MCPDeprecation struct {
	Replacement string `json:"replacement"`
	RemovedIn   string `json:"removed_in"`
}

// ServedMCPTool is one tools/list entry, reduced to what the pre-flights read.
type ServedMCPTool struct {
	Name       string
	Deprecated *MCPDeprecation
}

// DeprecatedGrant pairs a granted tool (in the grant's own spelling) with the
// server's deprecation for it.
type DeprecatedGrant struct {
	Tool        string
	Replacement string
	RemovedIn   string
}

// deprecatedGrantsWarning fires when a stored grant names a tool the server
// serves only as a deprecated alias. The alias works today; it disappears on
// the next minor of backplane-mcp, so the grant must move before that upgrade.
const deprecatedGrantsWarning = "loop mode: the board's tool grant names deprecated MCP tools — they still work on this server " +
	"but are removed in the next backplane-mcp minor; update the board's loop config (or its template) to the replacements"

// DeprecatedGrants lists, in grant order and without repeats, every granted
// tool the served catalog marks deprecated. Both spellings of a name are
// matched (see valarisMCPToolPrefix).
func DeprecatedGrants(granted []string, served []ServedMCPTool) []DeprecatedGrant {
	deprecatedByName := make(map[string]*MCPDeprecation, len(served))
	for _, tool := range served {
		if tool.Deprecated != nil {
			deprecatedByName[strings.TrimPrefix(tool.Name, valarisMCPToolPrefix)] = tool.Deprecated
		}
	}
	var findings []DeprecatedGrant
	seen := make(map[string]bool, len(granted))
	for _, tool := range granted {
		if seen[tool] {
			continue
		}
		seen[tool] = true
		if dep := deprecatedByName[strings.TrimPrefix(tool, valarisMCPToolPrefix)]; dep != nil {
			findings = append(findings, DeprecatedGrant{Tool: tool, Replacement: dep.Replacement, RemovedIn: dep.RemovedIn})
		}
	}
	return findings
}

// mcpSurfaceProbe memoizes one spawn of the configured server per run: both
// surface pre-flights read the same catalog, and a second uvx launch would
// double the start-up cost for no new information.
type mcpSurfaceProbe struct {
	done   bool
	served []ServedMCPTool
	err    error
}

// servedMCPCatalog probes the configured template once per run. An empty
// template path is reported as an error so callers treat it as inconclusive.
func (m *LoopMode) servedMCPCatalog(ctx context.Context) ([]ServedMCPTool, error) {
	if m.mcpSurface == nil {
		m.mcpSurface = &mcpSurfaceProbe{}
	}
	probe := m.mcpSurface
	if !probe.done {
		probe.done = true
		templatePath := m.cfg.LLM.MCPConfigPath
		if templatePath == "" {
			probe.err = fmt.Errorf("no MCP template configured")
		} else {
			probe.served, probe.err = ServedMCPCatalog(ctx, templatePath)
		}
	}
	return probe.served, probe.err
}

// warnDeprecatedGrants warns once per run when the board's grant names a tool
// the server serves as a deprecated alias. Same fail-open contract as the
// off-switch pre-flight: an unprobeable server says nothing, so it stays silent.
func (m *LoopMode) warnDeprecatedGrants(ctx context.Context, granted []string) {
	served, err := m.servedMCPCatalog(ctx)
	if err != nil {
		slog.Debug("loop mode: MCP tool-surface probe inconclusive",
			"board_id", m.boardID, "mcp_config", m.cfg.LLM.MCPConfigPath, "error", err)
		return
	}
	findings := DeprecatedGrants(granted, served)
	if len(findings) == 0 {
		return
	}
	details := make([]string, 0, len(findings))
	for _, f := range findings {
		details = append(details, fmt.Sprintf("%s → %s (removed in %s)", f.Tool, f.Replacement, f.RemovedIn))
	}
	slog.Warn(deprecatedGrantsWarning,
		"board_id", m.boardID, "mcp_config", m.cfg.LLM.MCPConfigPath, "deprecated_grants", strings.Join(details, "; "))
}

// offSwitchInCatalog reports whether a served tool catalog contains the loop's
// off-switch, tolerating either spelling (see valarisMCPToolPrefix).
func offSwitchInCatalog(served []string) bool {
	want := strings.TrimPrefix(offSwitchTool, valarisMCPToolPrefix)
	for _, name := range served {
		if strings.TrimPrefix(name, valarisMCPToolPrefix) == want {
			return true
		}
	}
	return false
}

// warnUnservedOffSwitch runs the surface pre-flight and warns only on a
// CONCLUSIVE negative: the server answered with a catalog and the off-switch
// was not in it. Anything else — no template configured, a server that will
// not spawn, a handshake that does not complete — is inconclusive and stays
// silent. An unprobeable server says nothing about the off-switch, and a
// warning that fires on unrelated misconfiguration is one operators learn to
// scroll past, which would cost us the signal this exists to send.
func (m *LoopMode) warnUnservedOffSwitch(ctx context.Context) {
	templatePath := m.cfg.LLM.MCPConfigPath
	if templatePath == "" {
		return
	}

	catalog, err := m.servedMCPCatalog(ctx)
	if err != nil {
		slog.Debug("loop mode: MCP tool-surface probe inconclusive",
			"board_id", m.boardID, "mcp_config", templatePath, "error", err)
		return
	}
	served := servedNames(catalog)
	if offSwitchInCatalog(served) {
		return
	}
	slog.Warn(offSwitchUnservedWarning,
		"board_id", m.boardID, "mcp_config", templatePath, "served_tools", len(served))
}

func servedNames(catalog []ServedMCPTool) []string {
	names := make([]string, 0, len(catalog))
	for _, tool := range catalog {
		names = append(names, tool.Name)
	}
	return names
}

// mcpServedTools is ServedMCPCatalog reduced to names.
func mcpServedTools(ctx context.Context, templatePath string) ([]string, error) {
	catalog, err := ServedMCPCatalog(ctx, templatePath)
	if err != nil {
		return nil, err
	}
	return servedNames(catalog), nil
}

// ServedMCPCatalog spawns the valaris MCP server described by the template and
// returns the tools it lists. It speaks the minimum of the MCP stdio protocol
// needed to ask one question — initialize, initialized, tools/list — rather
// than pulling in a client library for a once-per-run diagnostic.
func ServedMCPCatalog(ctx context.Context, templatePath string) ([]ServedMCPTool, error) {
	command, args, env, err := readMCPServerCommand(templatePath)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, mcpSurfaceProbeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("mcp stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("mcp stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("spawn mcp server: %w", err)
	}
	// The probe owns the process: Kill unblocks a server that never answers,
	// and Wait reaps it so a per-run diagnostic cannot leak a child.
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	requests := []string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"backplane-runner-preflight","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
	}
	for _, req := range requests {
		if _, err := fmt.Fprintln(stdin, req); err != nil {
			return nil, fmt.Errorf("write mcp request: %w", err)
		}
	}

	return readToolsListResult(stdout)
}

// readToolsListResult scans server output for the tools/list reply. Servers
// interleave notifications and log lines with responses, so we match on the
// response carrying a tools array rather than assuming reply ordering.
func readToolsListResult(stdout io.Reader) ([]ServedMCPTool, error) {
	scanner := bufio.NewScanner(stdout)
	// Real catalogs are ~50 tools with full JSON schemas; the default 64KB
	// token limit truncates them into unparseable fragments.
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	for scanner.Scan() {
		var msg struct {
			Result *struct {
				Tools []struct {
					Name string `json:"name"`
					Meta *struct {
						Deprecated *MCPDeprecation `json:"deprecated"`
					} `json:"_meta"`
				} `json:"tools"`
			} `json:"result"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue // not JSON, or not a shape we model — keep reading
		}
		if msg.Result == nil || msg.Result.Tools == nil {
			continue
		}
		served := make([]ServedMCPTool, 0, len(msg.Result.Tools))
		for _, tool := range msg.Result.Tools {
			entry := ServedMCPTool{Name: tool.Name}
			if tool.Meta != nil {
				entry.Deprecated = tool.Meta.Deprecated
			}
			served = append(served, entry)
		}
		return served, nil
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read mcp response: %w", err)
	}
	return nil, fmt.Errorf("mcp server closed without answering tools/list")
}

// readMCPServerCommand extracts the spawn recipe from the same template the
// coding agent is handed, so the probe measures the server the SESSION would
// get. Env is expressed as the template's own overrides applied on top of the
// runner's environment — the server inherits PATH and credentials exactly as
// it does under the coding agent.
func readMCPServerCommand(templatePath string) (command string, args []string, env []string, err error) {
	_, valarisServer, err := llm.ReadValarisMCPServerTemplate(templatePath)
	if err != nil {
		return "", nil, nil, err
	}

	command, _ = valarisServer["command"].(string)
	if command == "" {
		return "", nil, nil, fmt.Errorf("mcp template has no command for mcpServers.valaris")
	}

	rawArgs, _ := valarisServer["args"].([]any)
	for _, a := range rawArgs {
		if s, ok := a.(string); ok {
			args = append(args, s)
		}
	}

	env = os.Environ()
	if rawEnv, ok := valarisServer["env"].(map[string]any); ok {
		for k, v := range rawEnv {
			if s, ok := v.(string); ok {
				env = append(env, k+"="+s)
			}
		}
	}
	return command, args, env, nil
}
