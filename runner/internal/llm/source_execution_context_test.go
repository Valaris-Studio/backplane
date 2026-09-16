// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSourceExecutionContextBoundPerProviderLaunchWithoutTemplateOrAmbientLeak(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture CLI uses POSIX shell")
	}
	for _, kind := range []string{"claude", "codex"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			capture := filepath.Join(dir, "capture")
			t.Setenv("BACKPLANE_ATTRIBUTION_CAPTURE", capture)
			t.Setenv("BACKPLANE_SOURCE_EXECUTION_ID", "ambient-stale-execution")
			t.Setenv("CODEX_HOME", scratchCodexHome(t))
			template := filepath.Join(dir, "mcp.json")
			original := `{"mcpServers":{"valaris":{"command":"fixture-mcp","env":{"VALARIS_API_KEY":"vlr_fixture","BACKPLANE_SOURCE_EXECUTION_ID":"template-stale-execution"}}}}`
			if err := os.WriteFile(template, []byte(original), 0600); err != nil {
				t.Fatal(err)
			}
			cli := filepath.Join(dir, "fixture-cli")
			script := `#!/bin/sh
printf '%s' "${BACKPLANE_SOURCE_EXECUTION_ID-unset}" > "$BACKPLANE_ATTRIBUTION_CAPTURE.ambient"
if [ -f "$CODEX_HOME/config.toml" ]; then cp "$CODEX_HOME/config.toml" "$BACKPLANE_ATTRIBUTION_CAPTURE.config"; fi
previous=''
for argument in "$@"; do
 if [ "$previous" = '--mcp-config' ]; then cp "$argument" "$BACKPLANE_ATTRIBUTION_CAPTURE.config"; fi
 previous="$argument"
done
printf '%s\n' '{"type":"result","result":"worked"}' '{"type":"item.completed","item":{"type":"agent_message","text":"worked"}}' '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}'
`
			if err := os.WriteFile(cli, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			var provider Provider
			if kind == "claude" {
				provider = &ClaudeCLI{ClaudeBin: cli}
			} else {
				provider = &CodexCLI{CodexBin: cli}
			}
			for _, id := range []string{"execution-current-1", "execution-current-2", ""} {
				t.Run(id, func(t *testing.T) {
					opts := Options{MCPConfigPath: template, AllowedTools: []string{"mcp__valaris__submit_completion"}, WorkingDir: dir}
					// Decode by exported name so the RED fails at the actual launch seam,
					// rather than failing to compile before the new Options field exists.
					encoded, _ := json.Marshal(map[string]string{"SourceExecutionID": id})
					if err := json.Unmarshal(encoded, &opts); err != nil {
						t.Fatal(err)
					}
					if _, err := provider.Execute(context.Background(), "work", opts); err != nil {
						t.Fatal(err)
					}
					data, err := os.ReadFile(capture + ".config")
					if err != nil {
						t.Fatal(err)
					}
					got := string(data)
					if strings.Contains(got, "stale-execution") {
						t.Error("launch retained stale template source identity")
					}
					if id != "" && !strings.Contains(got, id) {
						t.Errorf("MCP launch omitted code-owned source execution %q", id)
					}
					if id == "" && strings.Contains(got, "BACKPLANE_SOURCE_EXECUTION_ID") {
						t.Error("fresh non-source launch inherited a source identity")
					}
					ambient, err := os.ReadFile(capture + ".ambient")
					if err != nil {
						t.Fatal(err)
					}
					if string(ambient) != "unset" {
						t.Errorf("provider process inherited ambient source identity: %q", ambient)
					}
					unchanged, err := os.ReadFile(template)
					if err != nil || string(unchanged) != original {
						t.Fatal("per-launch context mutated the saved MCP template")
					}
				})
			}
		})
	}
}
