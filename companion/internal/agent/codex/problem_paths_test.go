// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

func TestStatus_ConfigTomlProblemsPointAtConfigToml(t *testing.T) {
	env := newEnv(t)
	write(t, env.configFile(), "[otel]\ntrace_exporter = \"statsig\"\n")
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	status := codex.Status(env.Env)
	if got := status.ProblemConfigPaths["conflict_existing_otel"]; got != env.configFile() {
		t.Fatalf("conflict_existing_otel concerns %q, want config.toml: %+v", got, status)
	}
	if status.ConfigPath != env.hooksFile() {
		t.Fatalf("config_path stays hooks.json: %q", status.ConfigPath)
	}
}

func TestStatus_InvalidConfigTomlPointsAtConfigToml(t *testing.T) {
	env := newEnv(t)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	write(t, env.configFile(), "this is = = not toml\n")
	status := codex.Status(env.Env)
	if !contains(status.Problems, "config_invalid") || status.ProblemConfigPaths["config_invalid"] != env.configFile() {
		t.Fatalf("config_invalid must point at config.toml: %+v", status)
	}
}

func TestStatus_HooksProblemsPointAtHooksJSON(t *testing.T) {
	env := newEnv(t)
	write(t, env.hooksFile(), "{ not json")
	status := New().Status(env.Env)
	if status.State != agent.InvalidConfig || status.ProblemConfigPaths["hooks_invalid"] != env.hooksFile() {
		t.Fatalf("hooks_invalid must point at hooks.json: %+v", status)
	}
}

func TestStatus_EveryConfigProblemHasAPathAndNoOtherProblemDoes(t *testing.T) {
	env := newEnv(t)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	write(t, env.hooksFile(), `{"hooks":{}}`)
	write(t, env.configFile(), "[otel]\ntrace_exporter = \"statsig\"\n")
	status := codex.Status(env.Env)
	if len(status.Problems) == 0 {
		t.Fatal("precondition: problems expected")
	}
	for _, problem := range status.Problems {
		path, present := status.ProblemConfigPaths[problem]
		if problem == "companion_executable_missing" {
			if present {
				t.Fatalf("%s concerns no config file", problem)
			}
			continue
		}
		if path != env.hooksFile() && path != env.configFile() {
			t.Fatalf("%s points at %q", problem, path)
		}
	}
	for problem := range status.ProblemConfigPaths {
		if !contains(status.Problems, problem) {
			t.Fatalf("%s is not a current problem", problem)
		}
	}
}

func TestStatus_NoProblemPathsWhenHealthy(t *testing.T) {
	env := newEnv(t)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	if status := codex.Status(env.Env); len(status.Problems) == 0 && status.ProblemConfigPaths != nil {
		t.Fatalf("no problems, no paths: %+v", status)
	}
}
