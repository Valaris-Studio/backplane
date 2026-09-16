// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import "github.com/Valaris-Studio/backplane/runner/internal/valaris"

// PipelineConfigForAgent returns the pipeline config from the platform-supplied
// workspace config. Loop.New refuses to start when the platform returns no
// pipeline_config, so wsCfg.PipelineConfig is non-nil at every runtime call
// site. A nil here means the invariant was violated upstream — panic so the
// bug surfaces at the boundary that broke it instead of masking it with a
// silent default.
func PipelineConfigForAgent(wsCfg valaris.WorkspaceConfigData) valaris.PipelineConfig {
	if wsCfg.PipelineConfig == nil {
		panic("PipelineConfigForAgent: wsCfg.PipelineConfig is nil; Loop.New must reject this upstream")
	}
	return *wsCfg.PipelineConfig
}

// StageForRole finds the StageConfig for a given role name, or nil if not found.
func StageForRole(cfg valaris.PipelineConfig, role string) *valaris.StageConfig {
	for i := range cfg.Stages {
		if cfg.Stages[i].Role == role {
			return &cfg.Stages[i]
		}
	}
	return nil
}
