// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

func parseRunOverride(provider, model string, passed, loop, doctor, discover, interactive bool) (*config.ModelSelection, error) {
	if !passed {
		return nil, nil
	}
	if strings.TrimSpace(provider) == "" || strings.TrimSpace(model) == "" {
		return nil, fmt.Errorf("run override requires both -run-provider and -run-model")
	}
	if interactive {
		return nil, fmt.Errorf("run override flags cannot be combined with -interactive; select the invocation override in the wizard instead")
	}
	if (!loop && !doctor) || discover {
		return nil, fmt.Errorf("run override requires -loop or -doctor, without -discover")
	}
	selection := &config.ModelSelection{Provider: provider, Model: model}
	if err := selection.Validate(); err != nil {
		return nil, err
	}
	return selection, nil
}

func validateWizardRunOverride(result tui.Result) error {
	if result.RunOverride == nil {
		return nil
	}
	if result.Mode != tui.ModeLoop {
		return fmt.Errorf("run model override requires loop mode")
	}
	return result.RunOverride.Validate()
}

// A source-model override does not remove providers configured for other roles.
func launchProviderSet(cfg *config.Config) []string {
	return cfg.LLM.ProviderSet()
}

// A replaced source default stays registered for completion roles, but needs no
// installation until the board's workflow requirements actually select it.
func launchPreflightProviderSet(cfg *config.Config) []string {
	if cfg.LLM.RunOverride == nil {
		return launchProviderSet(cfg)
	}
	selection := cfg.LLM
	selection.Provider = cfg.LLM.RunOverride.Provider
	return selection.ProviderSet()
}

func launchDefaultProvider(cfg *config.Config) string {
	if cfg.LLM.RunOverride != nil {
		return cfg.LLM.RunOverride.Provider
	}
	return cfg.LLM.Provider
}

func launchModel(cfg *config.Config) string {
	if cfg.LLM.RunOverride != nil {
		return cfg.LLM.RunOverride.Model
	}
	return cfg.LLM.Model
}
