// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

var completionMCPTools = []string{
	"get_completion_policy", "get_completion_status", "submit_completion_candidate",
	"request_landing", "retry_completion",
}

type MCPLaunchReport struct {
	ConfigPath string
	Executable string
	ServerName string
	Version    string
	Catalog    []ServedMCPTool
}

// PreflightCompletionMCP verifies the actual launch recipe, credentials and
// tool grant. It calls only the read-only board endpoint, never a model or a
// completion mutation. A version string alone cannot qualify a server build.
func PreflightCompletionMCP(ctx context.Context, template, workspace, board string, expected *valaris.BoardLoopConfig) (report MCPLaunchReport, err error) {
	report.ConfigPath, _ = filepath.Abs(template)
	report.Version = "unresolved"
	if template == "" {
		report.ConfigPath = "(not configured)"
	}
	defer func() {
		if err != nil {
			err = fmt.Errorf("MCP compatibility check failed before model invocation (config %s; executable %s; server %s %s): %w. Verify the MCP tool grants and credentials; select a compatible backplane-mcp 0.8.0 artifact/config or regenerate once that package is available", report.ConfigPath, report.Executable, report.ServerName, report.Version, err)
		}
	}()
	prepared, cleanup, err := llm.PrepareMCPConfig(template, expected.Tools)
	if err != nil {
		return report, err
	}
	defer cleanup()
	command, args, env, err := readMCPServerCommand(prepared)
	if err != nil {
		return report, err
	}
	report.Executable = command
	resolved, err := exec.LookPath(command)
	if err != nil {
		return report, fmt.Errorf("resolve MCP executable: %w", err)
	}
	report.Executable, _ = filepath.Abs(resolved)

	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, report.Executable, args...)
	cmd.Env = env
	stop := configureCompletionProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return report, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return report, err
	}
	if err = cmd.Start(); err != nil {
		return report, fmt.Errorf("start MCP package: %w", err)
	}
	defer func() { stop(); _ = cmd.Wait() }()
	reader := bufio.NewScanner(stdout)
	reader.Buffer(make([]byte, 64*1024), 8*1024*1024)
	requestID := 0
	call := func(method string, params any, out any) error {
		requestID++
		if err := json.NewEncoder(stdin).Encode(map[string]any{"jsonrpc": "2.0", "id": requestID, "method": method, "params": params}); err != nil {
			return fmt.Errorf("%s request: %w", method, err)
		}
		if err := readMCPReply(reader, requestID, out); err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("%s: %w", method, ctx.Err())
			}
			return fmt.Errorf("%s: %w", method, err)
		}
		return nil
	}
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
		ServerInfo      struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
	}
	if err = call("initialize", map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "backplane-runner-preflight", "version": "1"}}, &initialized); err != nil {
		return report, err
	}
	report.ServerName, report.Version = initialized.ServerInfo.Name, initialized.ServerInfo.Version
	if initialized.ProtocolVersion == "" || report.Version == "" {
		return report, fmt.Errorf("incomplete MCP initialize response")
	}
	if err = json.NewEncoder(stdin).Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		return report, err
	}
	served := map[string]bool{}
	cursor := ""
	seenCursors := map[string]bool{}
	for {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var page struct {
			Tools []struct {
				Name string `json:"name"`
				Meta struct {
					Deprecated *MCPDeprecation `json:"deprecated"`
				} `json:"_meta"`
			} `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err = call("tools/list", params, &page); err != nil {
			return report, err
		}
		if page.Tools == nil {
			return report, fmt.Errorf("tools/list did not return a catalog")
		}
		for _, tool := range page.Tools {
			served[tool.Name] = true
			report.Catalog = append(report.Catalog, ServedMCPTool{Name: tool.Name, Deprecated: tool.Meta.Deprecated})
		}
		cursor = page.NextCursor
		if cursor == "" {
			break
		}
		if seenCursors[cursor] {
			return report, fmt.Errorf("tools/list repeated pagination cursor")
		}
		seenCursors[cursor] = true
	}
	required := append([]string{"get_board_loop"}, completionMCPTools...)
	var missing []string
	for _, name := range required {
		if !served[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) != 0 {
		return report, fmt.Errorf("configured MCP catalog/grant is missing required tools: %s", strings.Join(missing, ", "))
	}
	var result struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err = call("tools/call", map[string]any{"name": "get_board_loop", "arguments": map[string]any{"workspace_slug": workspace, "board_id": board}}, &result); err != nil {
		return report, err
	}
	var payload string
	for _, content := range result.Content {
		if content.Type == "text" {
			payload += content.Text
		}
	}
	var failure struct {
		Error   bool   `json:"error"`
		Status  int    `json:"status"`
		Code    string `json:"error_code"`
		Message string `json:"message"`
	}
	decodeErr := json.Unmarshal([]byte(payload), &failure)
	if result.IsError || failure.Error {
		// The server wraps HTTP failures in successful MCP text replies.
		// Preserve the backend code/status, without dumping prompts or secrets.
		return report, fmt.Errorf("get_board_loop rejected the configured MCP identity/protocol (status %d, code %s); verify credentials and server compatibility", failure.Status, failure.Code)
	}
	if decodeErr != nil {
		return report, fmt.Errorf("get_board_loop did not return a JSON policy response")
	}
	var actual valaris.BoardLoopConfig
	if err = json.Unmarshal([]byte(payload), &actual); err != nil {
		return report, fmt.Errorf("decode MCP board policy: %w", err)
	}
	if err = actual.ValidateCompletionContract(); err != nil {
		return report, err
	}
	if actual.CompletionPolicy == nil || actual.CompletionPolicyHash != expected.CompletionPolicyHash {
		return report, fmt.Errorf("get_board_loop returned a missing or different completion policy; verify MCP host/credentials and retry setup")
	}
	return report, nil
}

func readMCPReply(reader *bufio.Scanner, id int, out any) error {
	for reader.Scan() {
		var msg struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(reader.Bytes(), &msg) != nil || msg.ID != id {
			continue
		}
		if msg.Error != nil {
			return fmt.Errorf("MCP JSON-RPC error %d", msg.Error.Code)
		}
		if len(msg.Result) == 0 || string(msg.Result) == "null" {
			return fmt.Errorf("MCP response has no result")
		}
		return json.Unmarshal(msg.Result, out)
	}
	if err := reader.Err(); err != nil {
		return err
	}
	return fmt.Errorf("MCP process closed before answering (package unavailable or server startup failed): %w", io.EOF)
}
