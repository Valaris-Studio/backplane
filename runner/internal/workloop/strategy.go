// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"log/slog"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/harness"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Strategy defines role-specific tick behavior.
type Strategy interface {
	Name() string
	Tick(ctx context.Context, l *Loop) error
	AllowedTools() []string
}

// NewStrategyFromConfig creates a DataDrivenStrategy from a StageConfig.
func NewStrategyFromConfig(cfg valaris.StageConfig, registry *harness.SensorRegistry) Strategy {
	return NewDataDrivenStrategy(cfg, registry)
}

// buildStrategies creates strategies for the given roles using the pipeline config.
func buildStrategies(roles []string, pipeline valaris.PipelineConfig, registry *harness.SensorRegistry) map[string]Strategy {
	strategies := make(map[string]Strategy, len(roles))
	for _, role := range roles {
		if stage := StageForRole(pipeline, role); stage != nil {
			strategies[role] = NewStrategyFromConfig(*stage, registry)
		} else {
			slog.Warn("no pipeline config for role, creating minimal strategy", "role", role)
			strategies[role] = NewStrategyFromConfig(valaris.StageConfig{Role: role}, registry)
		}
	}
	return strategies
}

// renderCommitMessage replaces {{.CardID}} and {{.Title}} placeholders in a template.
func renderCommitMessage(template, cardID, title string) string {
	r := strings.NewReplacer("{{.CardID}}", cardID, "{{.Title}}", title)
	return r.Replace(template)
}

// derefFloat64 safely dereferences a *float64, returning 0 for nil.
func derefFloat64(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
