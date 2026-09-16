// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleSensor wraps DataDrivenStrategy.runSensors but for a single sensor
// defined inline on the step (name + config + on_pass + on_fail). The strategy
// helper runs ALL sensors from s.config.Sensors; for the lifecycle DSL each
// sensor is its own step so the walker can route per-result. We temporarily
// swap s.config.Sensors to a singleton built from step.Params, then restore.
//
// Returns the sensor's on_pass / on_fail string as the decision. Aggregated
// state lands on WalkState.SensorResult so applyActionFlags-style steps can
// pull findings later.
func lifecycleSensor(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	s := strategyFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}

	def := valaris.SensorDef{
		Name:   paramString(step, "name", ""),
		Config: paramMap(step, "config"),
		OnPass: paramString(step, "on_pass", ""),
		OnFail: paramString(step, "on_fail", ""),
	}
	if def.Name == "" {
		return "", "", &configError{msg: "sensor step missing required param 'name'"}
	}

	prev := s.config.Sensors
	s.config.Sensors = []valaris.SensorDef{def}
	defer func() { s.config.Sensors = prev }()

	result, err := s.runSensors(ctx, l, card, ws.ExecutionID, ws.RepoDir)
	if err != nil {
		return "", "", err
	}
	ws.SensorResult = result
	if result == nil {
		return "", "", nil
	}
	return result.decision, "", nil
}

// configError differentiates handler-config errors (param missing/wrong type)
// from runtime failures (network 500, sensor crash). The walker treats both
// the same today, but operators reading the error message benefit from the
// "step misconfigured" prefix.
type configError struct{ msg string }

func (e *configError) Error() string { return "step misconfigured: " + e.msg }
