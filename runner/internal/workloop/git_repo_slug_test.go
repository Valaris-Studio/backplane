// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// On a multi-repo board a fix card with a wrong/unknown git_repo_slug silently
// misroutes to the wrong repo (the scheduler degrades an unknown slug to the
// board's first repo). The fix card must INHERIT the parent (audited) card's
// git_repo_slug verbatim — the fix targets the same repo the auditor was
// driving — never the repo display name, never nothing.
func TestCreateFixCards_InheritsParentGitRepoSlug(t *testing.T) {
	boardID := "b-slug"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{
		CardID: "parent-card", BoardID: boardID, GitRepoSlug: "frontend",
	})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{
		Decision: "request_changes",
		FixCards: []FixCardSpec{
			{Title: "UI-FIX: a", Description: "fix a"},
			{Title: "UI-FIX: b", Description: "fix b"},
		},
	}}

	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, fixCardStep()); err != nil {
		t.Fatalf("create_fix_cards: %v", err)
	}
	if rec.count() != 2 {
		t.Fatalf("expected 2 fix cards, got %d", rec.count())
	}
	for i, body := range rec.creates {
		if body["git_repo_slug"] != "frontend" {
			t.Errorf("fix card %d git_repo_slug = %v, want parent's slug %q inherited verbatim",
				i, body["git_repo_slug"], "frontend")
		}
	}
}

// A parent card with NO git_repo_slug must not invent one: the create payload
// omits the key entirely (the backend then applies its own primary-repo
// default) rather than sending "" or a repo display name.
func TestCreateFixCards_NoParentSlugOmitsGitRepoSlug(t *testing.T) {
	boardID := "b-noslug"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{
		CardID: "parent-card", BoardID: boardID, // no GitRepoSlug
	})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{
		Decision: "request_changes",
		FixCards: []FixCardSpec{{Title: "UI-FIX: a", Description: "fix a"}},
	}}

	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, fixCardStep()); err != nil {
		t.Fatalf("create_fix_cards: %v", err)
	}
	if rec.count() != 1 {
		t.Fatalf("expected 1 fix card, got %d", rec.count())
	}
	if _, present := rec.creates[0]["git_repo_slug"]; present {
		t.Errorf("fix card payload must omit git_repo_slug when the parent has none, got %v",
			rec.creates[0]["git_repo_slug"])
	}
}

// The assignment bundle's card carries its own git_repo_slug (CardRead);
// the runner must plumb it onto discoverResult verbatim — even when the
// resolved repo's slug differs (the card's stamp is authoritative).
func TestDiscoverResultFromAssignment_InheritsCardGitRepoSlugVerbatim(t *testing.T) {
	resp := &valaris.NextAssignmentResponse{
		Card:  valaris.Card{ID: "c1", Title: "t", GitRepoSlug: "frontend"},
		Board: valaris.AssignmentBoard{ID: "b1"},
		Repo: &valaris.AssignmentRepo{
			Slug: "backend", Name: "some-display-name",
			URL: "https://example.com/r", DefaultBranch: "main",
		},
	}

	r := discoverResultFromAssignment(resp)

	if r.GitRepoSlug != "frontend" {
		t.Errorf("GitRepoSlug = %q, want the card's own slug %q (verbatim)", r.GitRepoSlug, "frontend")
	}
}

// A card with no slug of its own stamps from repo metadata: the registered
// SLUG, never the display name. On boards where name != slug (the proven-live
// misroute), echoing the name routes the fix card to the wrong repo.
func TestDiscoverResultFromAssignment_FallsBackToRepoSlugNeverName(t *testing.T) {
	resp := &valaris.NextAssignmentResponse{
		Card:  valaris.Card{ID: "c1", Title: "t"}, // no git_repo_slug
		Board: valaris.AssignmentBoard{ID: "b1"},
		Repo: &valaris.AssignmentRepo{
			Slug: "frontend", Name: "console-display-name",
			URL: "https://example.com/r", DefaultBranch: "main",
		},
	}

	r := discoverResultFromAssignment(resp)

	if r.GitRepoSlug != "frontend" {
		t.Errorf("GitRepoSlug = %q, want the registered repo slug %q, never the display name", r.GitRepoSlug, "frontend")
	}
}

// Legacy discover paths build the result from repo metadata directly; same
// rule applies — registered slug, never the display name.
func TestNewDiscoverResultFromRepo_UsesRegisteredSlugNotName(t *testing.T) {
	repo := &valaris.GitRepo{
		ID: "r1", Slug: "frontend", Name: "console-display-name",
		URL: "https://example.com/r", DefaultBranch: "main",
	}

	r := newDiscoverResultFromRepo("c1", "b1", "title", "", "", repo)

	if r.GitRepoSlug != "frontend" {
		t.Errorf("GitRepoSlug = %q, want the registered repo slug %q, never the display name", r.GitRepoSlug, "frontend")
	}
}
