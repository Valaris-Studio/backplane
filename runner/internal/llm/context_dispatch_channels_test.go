// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func contextDispatchRecorder(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "recorder.go")
	source := `package main
import ("encoding/json"; "fmt"; "os")
func main() {
 payload, err := json.Marshal(os.Args[1:]); if err != nil { panic(err) }
 if err = os.WriteFile(os.Getenv("BACKPLANE_A2_ARGV_FILE"), payload, 0600); err != nil { panic(err) }
 fmt.Println("{\"type\":\"result\",\"result\":\"recorded\",\"session_id\":\"inert-session\"}")
 fmt.Println("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"recorded\"}}")
 fmt.Println("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}")
}
`
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "recorder")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-o", bin, path)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOWORK=off", "GO111MODULE=off")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build inert recorder: %v: %s", err, output)
	}
	return bin
}

func contextDispatchOptions(t *testing.T, version int, system string) Options {
	t.Helper()
	opts := Options{SystemPrompt: system, Model: "operator-model-47", WorkingDir: t.TempDir()}
	encoded, _ := json.Marshal(map[string]any{"ContextDispatchVersion": version})
	// Assert behavior at the actual launch seam before the new typed field
	// exists; baseline ignores this additive input instead of failing to build.
	if err := json.Unmarshal(encoded, &opts); err != nil {
		t.Fatal(err)
	}
	return opts
}

func contextDispatchProvider(kind, bin string) SessionProvider {
	if kind == "claude" {
		return &ClaudeCLI{ClaudeBin: bin}
	}
	return &CodexCLI{CodexBin: bin}
}

func contextDispatchLaunch(t *testing.T, p SessionProvider, resume bool, prompt string, opts Options) (*Result, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if resume {
		return p.ResumeSession(ctx, "operator-session-47", prompt, opts)
	}
	return p.Execute(ctx, prompt, opts)
}

func contextDispatchArgValue(args []string, flag string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag {
			return args[i+1]
		}
	}
	return ""
}

func TestContextDispatchAdapterChannelDeclarations(t *testing.T) {
	type channels struct {
		Version                                            int
		FreshInput, FreshSystem, ResumeInput, ResumeSystem bool
	}
	for _, kind := range []string{"claude", "codex"} {
		t.Run(kind, func(t *testing.T) {
			p := contextDispatchProvider(kind, "unused-inert-path")
			encoded, err := json.Marshal(p.(CapabilityProvider).Capabilities())
			if err != nil {
				t.Fatal(err)
			}
			var projection struct{ PromptChannels channels }
			if err := json.Unmarshal(encoded, &projection); err != nil {
				t.Fatal(err)
			}
			want := channels{Version: 1, FreshInput: true, ResumeInput: true,
				FreshSystem: kind == "claude", ResumeSystem: kind == "claude"}
			if projection.PromptChannels != want {
				t.Fatalf("actual adapter channel declaration = %+v, want %+v", projection.PromptChannels, want)
			}
		})
	}
}

func TestContextDispatchAdapterExactArgumentTransport(t *testing.T) {
	bin := contextDispatchRecorder(t)
	prompt := "--literal input é🧪\n```go\nfmt.Println(\"exact 'bytes'\")\n```\n"
	for _, kind := range []string{"claude", "codex"} {
		for _, resume := range []bool{false, true} {
			for _, system := range []string{"", "System é🧪\nKeep `code` and \"quotes\" exactly.\n"} {
				name := kind + "/fresh"
				if resume {
					name = kind + "/resume"
				}
				if system != "" {
					name += "/system"
				} else {
					name += "/empty_system"
				}
				t.Run(name, func(t *testing.T) {
					scratchCodexHome(t)
					capture := filepath.Join(t.TempDir(), "argv.json")
					t.Setenv("BACKPLANE_A2_ARGV_FILE", capture)
					opts := contextDispatchOptions(t, 1, system)
					result, err := contextDispatchLaunch(t, contextDispatchProvider(kind, bin), resume, prompt, opts)
					if kind == "codex" && system != "" {
						if err == nil {
							t.Error("required Codex system channel was silently dropped instead of refused")
						}
						if _, statErr := os.Stat(capture); !os.IsNotExist(statErr) {
							t.Errorf("unsupported required channel reached a subprocess: %v", statErr)
						}
						return
					}
					if err != nil || result == nil {
						t.Fatalf("supported inert launch: result=%+v err=%v", result, err)
					}
					data, err := os.ReadFile(capture)
					if err != nil {
						t.Fatal(err)
					}
					var args []string
					if err := json.Unmarshal(data, &args); err != nil {
						t.Fatal(err)
					}
					var actualPrompt, actualSystem string
					if kind == "claude" {
						actualSystem = contextDispatchArgValue(args, "--system-prompt")
						if len(args) >= 2 && args[len(args)-2] == "--" {
							actualPrompt = args[len(args)-1]
						} else {
							// Preserve the original baseline oracle while the separate
							// separator regression rejects its unsafe positional shape.
							actualPrompt = contextDispatchArgValue(args, "-p")
						}
						if resume && contextDispatchArgValue(args, "--resume") != "operator-session-47" {
							t.Fatal("Claude ResumeSession did not retain the exact session argument")
						}
					} else {
						actualPrompt = args[len(args)-1]
						if resume {
							if len(args) < 3 || args[0] != "exec" || args[1] != "resume" || !strings.Contains(string(data), "operator-session-47") {
								t.Fatalf("Codex ResumeSession did not use exec resume: %v", args)
							}
							if contextDispatchArgValue(args, "--cd") != "" || contextDispatchArgValue(args, "--add-dir") != "" {
								t.Fatal("Codex resume carried fresh-only CLI options")
							}
						}
					}
					if actualPrompt != prompt || actualSystem != system || sha256.Sum256([]byte(actualPrompt)) != sha256.Sum256([]byte(prompt)) {
						t.Fatalf("adapter mutated explicit prompt channels: input=%q system=%q", actualPrompt, actualSystem)
					}
					if opts.SystemPrompt != system || opts.ResumeSessionID != "" {
						t.Fatal("adapter mutated caller-owned options")
					}
				})
			}
		}
	}
}

func TestContextDispatchAdapterUnknownVersionNeverStarts(t *testing.T) {
	bin := contextDispatchRecorder(t)
	for _, kind := range []string{"claude", "codex"} {
		for _, resume := range []bool{false, true} {
			t.Run(kind+map[bool]string{false: "/fresh", true: "/resume"}[resume], func(t *testing.T) {
				scratchCodexHome(t)
				capture := filepath.Join(t.TempDir(), "argv.json")
				t.Setenv("BACKPLANE_A2_ARGV_FILE", capture)
				_, err := contextDispatchLaunch(t, contextDispatchProvider(kind, bin), resume, "inert", contextDispatchOptions(t, 2, ""))
				if err == nil {
					t.Error("unsupported nonzero channel protocol was accepted")
				}
				if _, statErr := os.Stat(capture); !os.IsNotExist(statErr) {
					t.Errorf("unsupported protocol reached recorder: %v", statErr)
				}
			})
		}
	}
}

func TestContextDispatchAdapterLegacyAndNULTransportControls(t *testing.T) {
	bin := contextDispatchRecorder(t)
	scratchCodexHome(t)
	capture := filepath.Join(t.TempDir(), "argv.json")
	t.Setenv("BACKPLANE_A2_ARGV_FILE", capture)
	if _, err := contextDispatchLaunch(t, contextDispatchProvider("codex", bin), false, "legacy input", contextDispatchOptions(t, 0, "legacy system")); err != nil {
		t.Fatalf("zero version changed the legacy adapter contract: %v", err)
	}
	if err := os.Remove(capture); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"claude", "codex"} {
		if _, err := contextDispatchLaunch(t, contextDispatchProvider(kind, bin), false, "cannot\x00pass argv", contextDispatchOptions(t, 1, "")); err == nil {
			t.Errorf("%s accepted NUL in an argv string", kind)
		}
		if _, err := os.Stat(capture); !os.IsNotExist(err) {
			t.Fatalf("invalid OS argument reached executable: %v", err)
		}
	}
}
