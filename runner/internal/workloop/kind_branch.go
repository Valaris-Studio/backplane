// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleBranch evaluates step.Params.expression and returns the matched
// case as a next-step override. The expression language is intentionally
// minimal:
//
//   - "${var_name}"        substitute WalkState.Variables[var_name] as a string.
//   - "${last_decision}"   the most recent decision-producing kind's output.
//   - literal "foo"        the literal string "foo" — useful for static branches
//                          that test a non-variable value (rare; mostly for tests).
//
// step.Params.cases is a map[string]string of literal-equality cases keyed by
// expression-resolved value, mapping to the next step name. Unknown values
// fall back to cases["default"] when present; otherwise to step.Next.
//
// The handler reports the matched key as the decision and the case's target
// step name as the next-override. Decision + nextOverride together let the
// walker either route by name (deterministic) or by step.Branches when an
// outer kind wraps the branch result. In practice the nextOverride wins —
// branch is the explicit "go to step X" kind, not a decision-emitter for an
// enclosing branch.
//
// Why this is enough: backend pipeline_config_validation typechecks every
// kind's params. branch is the operator's escape hatch for things the closed
// kind set didn't anticipate (e.g., route on a custom mcp_call output). Real
// expression engines (CEL, etc.) are out of scope; if a future role needs
// more, file a kind for it.
func lifecycleBranch(_ context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	expr := paramString(step, "expression", "")
	if expr == "" {
		return "", "", &configError{msg: "branch requires param 'expression'"}
	}
	cases, _ := step.Params["cases"].(map[string]any)
	if cases == nil {
		return "", "", &configError{msg: "branch requires param 'cases' (object)"}
	}

	value := resolveBranchExpression(expr, ws)

	if target, ok := cases[value].(string); ok && target != "" {
		// Decision = the matched key (for observability + nested-branch support);
		// nextOverride = the target step (the actual routing instruction).
		return value, target, nil
	}
	if target, ok := cases["default"].(string); ok && target != "" {
		return "default", target, nil
	}
	// No matching case and no default → walker falls through to step.Next, or
	// errors if neither is set. Operators who want strict matching set a
	// "default" with an explicit terminate target.
	return "", "", nil
}

// resolveBranchExpression handles the trivial substitution rules. Inputs that
// look like ${X} dereference X from the walk state; everything else is
// returned literally.
func resolveBranchExpression(expr string, ws *lifecycle.WalkState) string {
	if len(expr) > 3 && expr[:2] == "${" && expr[len(expr)-1] == '}' {
		key := expr[2 : len(expr)-1]
		switch key {
		case "last_decision":
			return ws.LastDecision
		default:
			return ws.GetString(key)
		}
	}
	return expr
}

