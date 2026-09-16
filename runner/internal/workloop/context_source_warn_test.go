// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"reflect"
	"testing"
)

func TestUnreferencedContextSources_DeclaredButUnreferenced(t *testing.T) {
	tmpl := `Do the work. No context here.`
	sources := map[string]string{"pipeline_expectations": "rendered expectations"}

	got := unreferencedContextSources(tmpl, sources)

	want := []string{"pipeline_expectations"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestUnreferencedContextSources_ReferencedIsNotFlagged(t *testing.T) {
	tmpl := `Expectations:\n{{ index .ContextSources "pipeline_expectations" }}`
	sources := map[string]string{"pipeline_expectations": "x"}

	if got := unreferencedContextSources(tmpl, sources); got != nil {
		t.Errorf("expected no unreferenced sources, got %v", got)
	}
}

func TestUnreferencedContextSources_WhitespaceFreeIndexForm(t *testing.T) {
	tmpl := `{{index .ContextSources "deps"}}`
	sources := map[string]string{"deps": "x"}

	if got := unreferencedContextSources(tmpl, sources); got != nil {
		t.Errorf("expected whitespace-free index form to match, got %v", got)
	}
}

func TestUnreferencedContextSources_LegacyBridgeAliasesExcluded(t *testing.T) {
	// board_definition / review_history reach the prompt via the legacy
	// {{.ProjectDirectives}} / {{.ReviewHistory}} fields, so they are never
	// "unconsumed" even without an index reference.
	tmpl := `Directives:\n{{.ProjectDirectives}}`
	sources := map[string]string{
		"board_definition": "dirs",
		"review_history":   "history",
	}

	if got := unreferencedContextSources(tmpl, sources); got != nil {
		t.Errorf("legacy bridge aliases must be excluded, got %v", got)
	}
}

func TestUnreferencedContextSources_MixedSorted(t *testing.T) {
	tmpl := `{{ index .ContextSources "linked_cards" }}`
	sources := map[string]string{
		"linked_cards":          "referenced",
		"sibling_cards":         "unreferenced",
		"pipeline_expectations": "unreferenced",
		"board_definition":      "legacy, excluded",
	}

	got := unreferencedContextSources(tmpl, sources)

	want := []string{"pipeline_expectations", "sibling_cards"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v (sorted, legacy + referenced excluded)", got, want)
	}
}

func TestUnreferencedContextSources_EmptyMap(t *testing.T) {
	if got := unreferencedContextSources(`{{.Anything}}`, nil); got != nil {
		t.Errorf("expected nil for empty sources, got %v", got)
	}
}
