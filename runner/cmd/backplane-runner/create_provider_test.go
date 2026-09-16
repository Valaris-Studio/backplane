// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
)

// TestBuildProviders_DefaultSelectedByConfig proves the binary wires the
// default LLM provider from llm.provider — the config lever, no code change to
// switch agents.
func TestBuildProviders_DefaultSelectedByConfig(t *testing.T) {
	for _, tc := range []struct {
		provider string
		wantName string
	}{
		{"claude-cli", "claude-cli"},
		{"codex-cli", "codex-cli"},
	} {
		cfg := &config.Config{}
		cfg.LLM.Provider = tc.provider
		registry, def := buildProviders(cfg)
		if def == nil {
			t.Fatalf("provider %q: buildProviders returned nil default", tc.provider)
		}
		if got := def.Name(); got != tc.wantName {
			t.Errorf("provider %q: default Name() = %q, want %q", tc.provider, got, tc.wantName)
		}
		if _, ok := registry[tc.provider]; !ok {
			t.Errorf("provider %q: registry should contain the default", tc.provider)
		}
	}
}

// TestBuildProviders_RegistersExtras proves a pipeline can mix agents: the
// default plus each llm.extra_providers entry is built and keyed by name, so a
// per-stage provider declaration can resolve to any of them.
func TestBuildProviders_RegistersExtras(t *testing.T) {
	cfg := &config.Config{}
	cfg.LLM.Provider = "codex-cli"
	cfg.LLM.ExtraProviders = []string{"claude-cli"}

	registry, def := buildProviders(cfg)
	if def.Name() != "codex-cli" {
		t.Fatalf("default should be codex-cli, got %q", def.Name())
	}
	for _, want := range []string{"codex-cli", "claude-cli"} {
		p, ok := registry[want]
		if !ok {
			t.Fatalf("registry missing %q", want)
		}
		if p.Name() != want {
			t.Errorf("registry[%q].Name() = %q", want, p.Name())
		}
	}
}
