// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package lifecycle defines the closed set of step kinds the runner's
// generic lifecycle walker (lane A.2) executes.
//
// Source of truth: backend/app/services/agents/lifecycle_kinds.py.
// The parity test backend/tests/services/agents/test_lifecycle_kinds_parity.py
// asserts both sides agree on names + produces_decision + terminal flags.
// Update both files in the same change.
//
// This file is intentionally standalone — it does not import from workloop or
// any other internal package. Lane A.2 consumes Kinds; lane A.1 only ships the
// enum.
package lifecycle

// KindSchema mirrors backend/app/services/agents/lifecycle_kinds.py:KindSchema.
// ParamsSchema is intentionally a free-form map; the backend is authoritative
// on the editor schema. The runner reads only Name / ProducesDecision /
// Terminal at execution time.
type KindSchema struct {
	Name             string
	ProducesDecision bool
	Terminal         bool
}

// Kinds is the closed registry. Mirrors LIFECYCLE_KINDS in the Python source.
var Kinds = map[string]KindSchema{
	"discover":          {Name: "discover", ProducesDecision: false, Terminal: false},
	"claim":             {Name: "claim", ProducesDecision: false, Terminal: false},
	"git_setup":         {Name: "git_setup", ProducesDecision: false, Terminal: false},
	// skills_setup copies the board's bound workspace skills into the working
	// tree at the coding agent's own discovery path. The runner writes the
	// published files verbatim and never reads them — the agent decides what
	// to do with a skill. Mirrors backend lifecycle_kinds.py.
	"skills_setup":      {Name: "skills_setup", ProducesDecision: false, Terminal: false},
	"llm":               {Name: "llm", ProducesDecision: true, Terminal: false},
	"sensor":            {Name: "sensor", ProducesDecision: true, Terminal: false},
	"move_card":         {Name: "move_card", ProducesDecision: false, Terminal: true},
	"apply_label":       {Name: "apply_label", ProducesDecision: false, Terminal: false},
	"remove_label":      {Name: "remove_label", ProducesDecision: false, Terminal: true},
	"create_note":       {Name: "create_note", ProducesDecision: false, Terminal: true},
	"enqueue_for_merge": {Name: "enqueue_for_merge", ProducesDecision: false, Terminal: true},
	"mcp_call":          {Name: "mcp_call", ProducesDecision: false, Terminal: false},
	// create_fix_cards reads the prior produces_decision step's structured
	// fix_cards[] and creates one board card per entry (an auditor role like
	// ui_validator filing follow-up work). Non-terminal so it chains into the
	// label-swap that records the audit verdict. Mirrors backend lifecycle_kinds.py.
	"create_fix_cards":  {Name: "create_fix_cards", ProducesDecision: false, Terminal: false},
	"branch":            {Name: "branch", ProducesDecision: true, Terminal: false},
	"wake_role":         {Name: "wake_role", ProducesDecision: false, Terminal: false},
	"create_pr":         {Name: "create_pr", ProducesDecision: false, Terminal: false},
	"enable_auto_merge": {Name: "enable_auto_merge", ProducesDecision: false, Terminal: false},
	"merge_pr":          {Name: "merge_pr", ProducesDecision: false, Terminal: false},
	"post_pr_review":    {Name: "post_pr_review", ProducesDecision: false, Terminal: false},
	"ship":              {Name: "ship", ProducesDecision: false, Terminal: true},
	// No-op terminal. Lets a non-terminal kind chain into an explicit
	// stop. Mirrors backend lifecycle_kinds.py.
	"end":               {Name: "end", ProducesDecision: false, Terminal: true},
}

// IsKnown reports whether kind is in the closed set.
func IsKnown(kind string) bool {
	_, ok := Kinds[kind]
	return ok
}

// setupKinds are the steps that get a card's workspace ready rather than doing
// work on it: finding a card, reserving it, and cloning/checking out the repo.
// Their wall-clock cost (a cold clone, a slow claim round-trip) is not work the
// card asked for, so the walker charges them to a separate setup budget and
// only starts the card's work budget once the last of them has run — matching
// what the legacy tickCard path does with cardSetupTimeout.
//
// Deliberately NOT a KindSchema field: Name/ProducesDecision/Terminal are a
// parity contract with backend/app/services/agents/lifecycle_kinds.py (regex-
// parsed by test_lifecycle_kinds_parity.py). Budget phase is a runner-side
// execution concern the backend validator has no opinion on, so it lives here.
var setupKinds = map[string]bool{
	"discover":     true,
	"claim":        true,
	"git_setup":    true,
	"skills_setup": true,
}

// IsSetupKind reports whether kind belongs to the pre-work setup phase.
func IsSetupKind(kind string) bool { return setupKinds[kind] }
