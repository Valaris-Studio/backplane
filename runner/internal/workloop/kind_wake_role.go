// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleWakeRole resets the scheduler's idle cooldown for sibling roles so
// they pick up downstream work on the next tick instead of waiting out their
// backoff. Mirrors legacy on_success.wake_roles. WakeRole is a silent no-op
// when the runner is single-role (l.scheduler == nil) — unknown role names
// are equally tolerated.
func lifecycleWakeRole(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	roles, err := paramStringList(step, "roles")
	if err != nil {
		return "", "", err
	}
	if len(roles) == 0 {
		return "", "", &configError{msg: "wake_role requires param 'roles' (non-empty list of strings)"}
	}
	for _, role := range roles {
		l.WakeRole(role)
	}
	return "", "", nil
}

// paramStringList reads a []string param. Returns an error if the value is
// present but not a list of strings; returns (nil, nil) when the key is absent
// so callers can decide whether emptiness is an error.
func paramStringList(step *valaris.LifecycleStep, key string) ([]string, error) {
	if step.Params == nil {
		return nil, nil
	}
	raw, ok := step.Params[key]
	if !ok {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok {
		// JSON round-trips array-of-strings as []any; an already-typed
		// []string is also accepted for handlers built in-memory.
		if typed, ok := raw.([]string); ok {
			return typed, nil
		}
		return nil, &configError{msg: "param '" + key + "' must be a list of strings"}
	}
	out := make([]string, 0, len(items))
	for _, v := range items {
		s, ok := v.(string)
		if !ok {
			return nil, &configError{msg: "param '" + key + "' must contain only strings"}
		}
		out = append(out, s)
	}
	return out, nil
}
