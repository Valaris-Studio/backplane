// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package config

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestRunOverrideValidationAndSerialization(t *testing.T) {
	for _, selection := range []ModelSelection{{}, {Provider: "codex-cli"}, {Model: "custom-id"}, {Provider: "unknown", Model: "custom-id"}, {Provider: "codex-cli", Model: "premium"}, {Provider: "claude-cli", Model: " MID "}, {Provider: "codex-cli", Model: "low"}, {Provider: "codex-cli", Model: "  "}, {Provider: "codex-cli", Model: "model\nattack"}, {Provider: "codex-cli", Model: "model\x00"}} {
		if selection.Validate() == nil {
			t.Errorf("accepted invalid selection %#v", selection)
		}
	}
	for _, provider := range []string{"claude-cli", "codex-cli"} {
		selection := &ModelSelection{Provider: provider, Model: "future/custom-model-123"}
		if err := selection.Validate(); err != nil {
			t.Fatal(err)
		}
		cfg := LLMConfig{Provider: "claude-cli", Model: "sonnet", RunOverride: selection}
		if !strings.Contains(strings.Join(cfg.ProviderSet(), ","), provider) {
			t.Fatal("override provider absent")
		}
		data, err := yaml.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), selection.Model) || strings.Contains(string(data), "run_override") {
			t.Fatalf("ephemeral override persisted: %s", data)
		}
		var restored LLMConfig
		if err := yaml.Unmarshal(data, &restored); err != nil {
			t.Fatal(err)
		}
		if restored.RunOverride != nil || restored.Model != "sonnet" {
			t.Fatalf("roundtrip changed persisted config: %#v", restored)
		}
	}
}

func TestRunOverrideModelStorageBoundaryAndWhitespace(t *testing.T) {
	for _, model := range []string{" custom-model", "custom-model ", strings.Repeat("x", 101), strings.Repeat("界", 101)} {
		if err := (&ModelSelection{Provider: "codex-cli", Model: model}).Validate(); err == nil {
			t.Errorf("accepted unrepresentable model %q", model)
		}
	}
	for _, model := range []string{strings.Repeat("x", 100), strings.Repeat("界", 100)} {
		if err := (&ModelSelection{Provider: "codex-cli", Model: model}).Validate(); err != nil {
			t.Errorf("rejected valid boundary model: %v", err)
		}
	}
}
