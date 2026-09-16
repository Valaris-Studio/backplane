// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"encoding/json"
	"os"
	"testing"
)

// mcpToolCatalog loads the checked-in snapshot of the mcp-server's registered
// tool names (testdata/mcp_tool_catalog.json, regenerated via
// mcp-server/scripts/export-tool-catalog.py). mcp-server/tests/test_tool_catalog_fixture.py
// is the other half of this contract: it fails if the fixture drifts from the
// live server, so a rename or removal on either side surfaces here too.
func mcpToolCatalog(t *testing.T) map[string]bool {
	t.Helper()
	data, err := os.ReadFile("testdata/mcp_tool_catalog.json")
	if err != nil {
		t.Fatalf("reading mcp tool catalog fixture: %v", err)
	}
	var names []string
	if err := json.Unmarshal(data, &names); err != nil {
		t.Fatalf("parsing mcp tool catalog fixture: %v", err)
	}
	catalog := make(map[string]bool, len(names))
	for _, n := range names {
		catalog[n] = true
	}
	return catalog
}

// TestMCPToolDispatch_NoPhantomTools guards against runner code referencing an
// MCP tool name that doesn't exist on the server — a silent no-op at best
// (unknown tool → runtime error at mcp_call time) and a maintenance trap at
// worst (renamed real tools leaving stale entries behind). Every key in
// mcpToolDispatch must resolve to a tool the mcp-server actually registers.
func TestMCPToolDispatch_NoPhantomTools(t *testing.T) {
	catalog := mcpToolCatalog(t)

	var phantoms []string
	for tool := range mcpToolDispatch {
		if !catalog[tool] {
			phantoms = append(phantoms, tool)
		}
	}
	if len(phantoms) > 0 {
		t.Errorf("mcpToolDispatch references tool names not in the mcp-server catalog: %v", phantoms)
	}
}

// discoverWriteTools are the mcp__valaris__* write tools discoverOpts strips
// from the allowlist during read-only discover calls (internal/workloop/loop.go).
// Kept here rather than exported from loop.go so this test can assert the
// bare tool names (post mcp__valaris__ prefix) against the same catalog
// without loop.go needing to know about the fixture.
var discoverWriteTools = []string{
	"log_execution_start",
	"log_execution_update",
	"claim_card",
	"update_card",
	"move_card",
	"add_card_participant",
	"remove_card_participant",
	"request_approval",
}

// TestDiscoverWriteTools_NoPhantomTools guards discoverOpts's write-tool strip
// list the same way: every name it filters on must be a real registered tool,
// or the filter silently protects against nothing.
func TestDiscoverWriteTools_NoPhantomTools(t *testing.T) {
	catalog := mcpToolCatalog(t)

	for _, tool := range discoverWriteTools {
		if !catalog[tool] {
			t.Errorf("discoverOpts strips %q but it is not in the mcp-server catalog", tool)
		}
	}
}
