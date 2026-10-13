// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// CLI help confirms that print is a boolean flag and input is positional.
// A leading --help prompt must not turn into a CLI option. The recorder proves
// the actual launch arguments; it never runs the vendor CLI or a model.
func TestContextDispatchAdapterProtectsPositionalInput(t *testing.T) {
	bin := contextDispatchRecorder(t)
	for _, kind := range []string{"claude", "codex"} {
		for _, resume := range []bool{false, true} {
			for _, version := range []int{0, 1} {
				for _, prompt := range []string{"--help", "--model injected-model é🧪\nKeep these exact bytes.\n"} {
					name := fmt.Sprintf("%s/resume_%t/version_%d/%s", kind, resume, version, prompt[:6])
					t.Run(name, func(t *testing.T) {
						scratchCodexHome(t)
						capture := filepath.Join(t.TempDir(), "argv.json")
						t.Setenv("BACKPLANE_A2_ARGV_FILE", capture)
						system := ""
						if kind == "claude" {
							system = "Exact system é🧪\n"
						}
						opts := contextDispatchOptions(t, version, system)
						opts.OutputSchema = `{"type":"object","properties":{"answer":{"type":"string"}}}`
						result, err := contextDispatchLaunch(t, contextDispatchProvider(kind, bin), resume, prompt, opts)
						if err != nil || result == nil {
							t.Fatalf("inert launch: result=%+v err=%v", result, err)
						}
						encoded, err := os.ReadFile(capture)
						if err != nil {
							t.Fatal(err)
						}
						var args []string
						if err := json.Unmarshal(encoded, &args); err != nil {
							t.Fatal(err)
						}
						protected := len(args) >= 2 && args[len(args)-2] == "--" && args[len(args)-1] == prompt
						if !protected {
							t.Errorf("input is not the exact sole positional after --: %v", args)
						}
						flags := args
						if protected {
							flags = args[:len(args)-2]
						}
						if contextDispatchArgValue(flags, "--model") != opts.Model {
							t.Error("input replaced or displaced the configured model")
						}
						if kind == "claude" {
							if !slices.Contains(flags, "-p") || contextDispatchArgValue(flags, "--output-format") != "stream-json" {
								t.Error("print/stream options must remain options before the separator")
							}
							if contextDispatchArgValue(flags, "--system-prompt") != system || contextDispatchArgValue(flags, "--json-schema") != opts.OutputSchema {
								t.Error("system/schema options changed while protecting positional input")
							}
							if !slices.Contains(flags, "--disallowedTools") {
								t.Error("deny policy was displaced after the separator")
							}
							if resume && contextDispatchArgValue(flags, "--resume") != "operator-session-47" {
								t.Error("resume session changed")
							}
						} else {
							if !slices.Contains(flags, "--json") || contextDispatchArgValue(flags, "--output-schema") == "" {
								t.Error("Codex stream/schema options must remain before the separator")
							}
							if resume && (len(flags) < 3 || flags[0] != "exec" || flags[1] != "resume" || !slices.Contains(flags, "operator-session-47")) {
								t.Error("Codex resume command/session changed")
							}
							if resume && (slices.Contains(flags, "--cd") || slices.Contains(flags, "--add-dir")) {
								t.Error("unsupported fresh-only flags leaked into resume")
							}
						}
						if opts.ResumeSessionID != "" || opts.SystemPrompt != system || opts.Model != "operator-model-47" {
							t.Error("launch mutated caller options")
						}
					})
				}
			}
		}
	}
}
