// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"gopkg.in/yaml.v3"
)

func TestRunOverrideCLIProcess(t *testing.T) {
	if os.Getenv("BACKPLANE_TEST_RUN_OVERRIDE") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{os.Args[0]}, os.Args[i+1:]...)
			break
		}
	}
	flag.CommandLine = flag.NewFlagSet(os.Args[0], flag.ExitOnError)
	main()
	os.Exit(0)
}

func TestRunOverrideCLIRejectsInvalidBeforeConfig(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"provider only", []string{"-loop", "-run-provider=codex-cli"}, "requires both"},
		{"model only", []string{"-loop", "-run-model=custom-model"}, "requires both"},
		{"empty explicit pair", []string{"-loop", "-run-provider=", "-run-model="}, "requires both"},
		{"pipeline", []string{"-run-provider=codex-cli", "-run-model=custom-model"}, "requires -loop"},
		{"discovery", []string{"-loop", "-discover", "-run-provider=codex-cli", "-run-model=custom-model"}, "requires -loop"},
		{"interactive", []string{"-loop", "-interactive", "-run-provider=codex-cli", "-run-model=custom-model"}, "cannot be combined with -interactive"},
		{"edge newline", []string{"-loop", "-run-provider=codex-cli", "-run-model=custom\n"}, "model"},
		{"edge space", []string{"-loop", "-run-provider=codex-cli", "-run-model= custom"}, "model"},
		{"long model", []string{"-loop", "-run-provider=codex-cli", "-run-model=" + strings.Repeat("x", 101)}, "model"},
		{"unknown provider", []string{"-loop", "-run-provider=unknown", "-run-model=custom-model"}, "provider"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := append([]string{"-test.run=^TestRunOverrideCLIProcess$", "--", "-config=/missing/run-override-test.yaml"}, tc.args...)
			cmd := exec.Command(os.Args[0], args...)
			cmd.Env = append(os.Environ(), "BACKPLANE_TEST_RUN_OVERRIDE=1")
			out, err := cmd.CombinedOutput()
			exit, ok := err.(*exec.ExitError)
			if !ok || exit.ExitCode() != exitCodeUsage || !strings.Contains(string(out), tc.want) || strings.Contains(string(out), "flag provided but not defined") {
				t.Fatalf("want usage error %q before config/network; got %v: %s", tc.want, err, out)
			}
		})
	}
}

func TestRunOverrideDoctorValidatesTheSameExplicitSourceSelection(t *testing.T) {
	for _, loop := range []bool{false, true} {
		selection, err := parseRunOverride("claude-cli", "fable", true, loop, true, false, false)
		if err != nil || selection == nil || selection.Provider != "claude-cli" || selection.Model != "fable" {
			t.Fatalf("doctor loop=%v must accept the actual launch override without invoking it: selection=%+v err=%v", loop, selection, err)
		}
	}
	if _, err := parseRunOverride("claude-cli", "fable", true, false, true, true, false); err == nil {
		t.Fatal("doctor flag incorrectly permitted a discovery override")
	}
	if _, err := parseRunOverride("claude-cli", "fable", true, false, true, false, true); err == nil {
		t.Fatal("doctor flag incorrectly permitted interactive source flags")
	}
}

func TestRunOverrideLaunchDoesNotRequireReplacedUnconfiguredDefault(t *testing.T) {
	cfg := config.Defaults()
	cfg.LLM.Provider = "claude-cli"
	cfg.LLM.Model = "saved-model"
	cfg.LLM.ExtraProviders = nil
	cfg.Git.Forge = "gitea"
	cfg.LLM.RunOverride = &config.ModelSelection{Provider: "codex-cli", Model: "custom-exact-model"}
	var checked []string
	err := preflightTools(cfg, func(name string) (string, error) {
		checked = append(checked, name)
		if name != "codex" {
			return "", fmt.Errorf("not installed")
		}
		return "/fake/codex", nil
	})
	if err != nil || strings.Join(checked, ",") != "codex" {
		t.Fatalf("preflight: %v %v", checked, err)
	}
	providers, selected := buildProviders(cfg)
	if selected.Name() != "codex-cli" || providers["codex-cli"] == nil {
		t.Fatalf("wrong registry: %v %v", providers, selected)
	}
	if launchModel(cfg) != "custom-exact-model" || cfg.LLM.Provider != "claude-cli" || cfg.LLM.Model != "saved-model" {
		t.Fatal("override lost or persistent defaults changed")
	}
	err = preflightTools(cfg, func(string) (string, error) { return "", fmt.Errorf("missing") })
	if err == nil || !strings.Contains(err.Error(), "codex") {
		t.Fatalf("selected CLI missing: %v", err)
	}
}

func TestRunOverrideLaunchPreservesConfiguredCompletionProviders(t *testing.T) {
	for _, configured := range []string{"extra", "tier"} {
		t.Run(configured, func(t *testing.T) {
			cfg := config.Defaults()
			cfg.LLM.Provider = "claude-cli"
			cfg.LLM.Model = "saved-source-model"
			cfg.LLM.RunOverride = &config.ModelSelection{Provider: "claude-cli", Model: "fable"}
			cfg.Git.Forge = "gitea"
			if configured == "extra" {
				cfg.LLM.ExtraProviders = []string{"codex-cli", "codex-cli", "claude-cli"}
			} else {
				cfg.LLM.TierProviders = map[string][]string{"premium": {"codex-cli"}}
			}
			var checked []string
			if err := preflightTools(cfg, func(name string) (string, error) {
				checked = append(checked, name)
				return "/fake/" + name, nil
			}); err != nil {
				t.Fatal(err)
			}
			if strings.Join(checked, ",") != "claude,codex" {
				t.Errorf("source override removed a configured completion capability from preflight: %v", checked)
			}
			providers, source := buildProviders(cfg)
			if len(providers) != 2 || providers["codex-cli"] == nil || source.Name() != "claude-cli" || launchModel(cfg) != "fable" {
				t.Errorf("source override must preserve Codex registry independently of Claude/Fable selection: registry=%v source=%s model=%s", providers, source.Name(), launchModel(cfg))
			}
			if cfg.LLM.Model != "saved-source-model" {
				t.Fatal("source selection modified persistent model")
			}
			err := preflightTools(cfg, func(name string) (string, error) {
				if name == "codex" {
					return "", fmt.Errorf("not installed")
				}
				return "/fake/" + name, nil
			})
			if err == nil || !strings.Contains(err.Error(), "codex") || !strings.Contains(err.Error(), "install") {
				t.Errorf("missing configured reviewer must fail before paid source execution with installation guidance: %v", err)
			}
		})
	}
}

func TestRunOverrideWizardValidation(t *testing.T) {
	for _, mode := range []tui.Mode{tui.ModeDoctor, tui.ModeDiscovery, tui.ModePipeline} {
		result := tui.Result{Mode: mode, RunOverride: &config.ModelSelection{Provider: "codex-cli", Model: "custom"}}
		if err := validateLaunchResult(result, Credentials{}); err == nil || !strings.Contains(err.Error(), "loop mode") {
			t.Fatalf("mode %s: %v", mode, err)
		}
		if _, err := interactiveConfig(result, Credentials{}); err == nil || !strings.Contains(err.Error(), "loop mode") {
			t.Fatalf("mode %s config: %v", mode, err)
		}
	}
	result := tui.Result{Mode: tui.ModeLoop, RunOverride: &config.ModelSelection{Provider: "codex-cli"}}
	if err := validateWizardRunOverride(result); err == nil {
		t.Fatal("partial selection accepted")
	}
}

func TestRunOverrideWizardProfileAndConfigNeverPersistSelection(t *testing.T) {
	base := config.Defaults()
	base.LLM.Provider = "claude-cli"
	base.LLM.Model = "saved-custom-model"
	result := profileResult()
	result.Mode = tui.ModeLoop
	result.RunOverride = &config.ModelSelection{Provider: "codex-cli", Model: "invocation-secret-model"}
	cfg := result.Apply(base)
	if cfg.LLM.RunOverride == nil || cfg.LLM.RunOverride.Model != "invocation-secret-model" {
		t.Fatal("wizard Apply lost selection")
	}
	dir := t.TempDir()
	configPath := filepath.Join(dir, "runner.yaml")
	if err := saveWizardConfig(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	store := profile.NewStore(filepath.Join(dir, "profiles"))
	if err := applyWizardProfile(result, cfg, store); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{configPath, store.ConfigPath(result.ProfileName)} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), "invocation-secret-model") || strings.Contains(string(raw), "run_override") {
			t.Fatalf("run selection persisted in %s", path)
		}
		var saved config.Config
		if err := yaml.Unmarshal(raw, &saved); err != nil {
			t.Fatal(err)
		}
		if saved.LLM.Provider != "claude-cli" || saved.LLM.Model != "saved-custom-model" || saved.LLM.RunOverride != nil {
			t.Fatalf("persistent defaults changed: %+v", saved.LLM)
		}
	}
	if cfg.LLM.RunOverride == nil {
		t.Fatal("save consumed runtime selection")
	}
}
