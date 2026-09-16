// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// applyWizardProfile executes the wizard's save-as-profile intent — the
// Result records the name and any confirmed overwrite, this is the caller
// that writes through the store. The profile's runner.yaml carries the
// ${VALARIS_API_KEY} placeholder, never the key itself: the raw credentials
// belong to the profile's own credentials file, which the store writes 0600.
func applyWizardProfile(result tui.Result, cfg *config.Config, store *profile.Store) error {
	if result.ProfileName == "" || store == nil || cfg == nil {
		return nil
	}
	path := cfg.LLM.MCPConfigPath
	if result.MCPConfigPath != "" {
		path = result.MCPConfigPath
	}
	if result.MCPConfigSkipped {
		path = ""
	}
	mcpConfig := []byte("{}\n")
	if path != "" {
		path = absoluteMCPPath(path, "")
		if err := validateMCPConfig(path); err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("Selected MCP config could not be read; profile was not saved")
		}
		mcpConfig = data
	}
	saved := *cfg
	saved.LLM.MCPConfigPath = path
	runnerYAML, err := tui.MarshalConfigYAML(&saved)
	if err != nil {
		return err
	}
	creds := profile.Credentials{
		APIKey: result.APIKey, APIURL: result.APIURL, Workspace: result.Workspace,
	}
	if result.ProfileOverwrite {
		return store.SaveOverwrite(result.ProfileName, creds, runnerYAML, mcpConfig)
	}
	return store.Save(result.ProfileName, creds, runnerYAML, mcpConfig)
}

// resolveDoctorConfigPath picks the config the doctor report should describe,
// arbitrating the -config and -profile flags the same way the run path does.
func resolveDoctorConfigPath(root, configFlag, profileFlag string) (string, error) {
	return profile.ResolveRunConfigPath(root, configFlag, profileFlag)
}

// profileRunBaseConfig parses the loaded profile's runner.yaml over the
// shipped defaults, so an interactive USE/EDIT launch honors the profile's
// non-wizard settings (log level, workloop tuning, …). Lenient like the
// wizard's own prefill — interactiveConfig validates afterward.
func profileRunBaseConfig(name string) *config.Config {
	cfg := config.Defaults()
	store := profile.NewStore(profile.DefaultRoot())
	data, err := os.ReadFile(store.ConfigPath(name))
	if err != nil {
		return cfg
	}
	_ = yaml.Unmarshal(data, cfg)
	return cfg
}
