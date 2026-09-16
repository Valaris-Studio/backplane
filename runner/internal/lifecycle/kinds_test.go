// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package lifecycle

import "testing"

func TestKindsContainsExpectedNames(t *testing.T) {
	expected := []string{
		"discover", "claim", "git_setup", "skills_setup", "llm", "sensor",
		"move_card", "apply_label", "remove_label", "create_note",
		"enqueue_for_merge", "mcp_call", "create_fix_cards", "branch", "wake_role",
		"create_pr", "enable_auto_merge", "merge_pr", "post_pr_review", "ship",
		"end",
	}
	for _, name := range expected {
		if _, ok := Kinds[name]; !ok {
			t.Fatalf("Kinds is missing %q", name)
		}
	}
	if len(Kinds) != len(expected) {
		t.Fatalf("Kinds size = %d, want %d (lane A.1 closed set drift)",
			len(Kinds), len(expected))
	}
}

func TestKindSelfNameMatchesMapKey(t *testing.T) {
	for key, schema := range Kinds {
		if schema.Name != key {
			t.Errorf("Kinds[%q].Name = %q (must match map key)", key, schema.Name)
		}
	}
}

func TestTerminalKindsDoNotProduceDecisions(t *testing.T) {
	// A terminal step has no `next`/`branches`, so a decision would dangle.
	// Branch is the explicit decision-router; terminal + decision is a
	// configuration nonsense the validator should never accept.
	for name, schema := range Kinds {
		if schema.Terminal && schema.ProducesDecision {
			t.Errorf("kind %q is both terminal and produces_decision", name)
		}
	}
}

func TestIsKnownRecognisesEveryKind(t *testing.T) {
	for name := range Kinds {
		if !IsKnown(name) {
			t.Errorf("IsKnown(%q) = false, want true", name)
		}
	}
	if IsKnown("not_a_real_kind") {
		t.Error("IsKnown returned true for unknown kind")
	}
}

func TestSkillsSetupIsASetupKind(t *testing.T) {
	// Materializing skills readies the working tree before the card's own work
	// starts, so its wall-clock cost belongs to the setup budget — same as the
	// clone it depends on.
	if !IsSetupKind("skills_setup") {
		t.Error("IsSetupKind(\"skills_setup\") = false, want true")
	}
	schema, ok := Kinds["skills_setup"]
	if !ok {
		t.Fatal("Kinds is missing skills_setup")
	}
	if schema.ProducesDecision {
		t.Error("skills_setup must not produce a decision — it has no routing opinion")
	}
	if schema.Terminal {
		t.Error("skills_setup must not be terminal — it chains into the work steps")
	}
}
