// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/profile"
)

// suggestedFreshName is what store.SuggestName yields for testDeps' seed
// credentials (workspace "valaris" @ first label of localhost:8000). Pinned
// literally so a drift in the suggestion convention fails loudly here.
const suggestedFreshName = "valaris@localhost"

// emptyStoreDeps is testDeps plus a wired-but-empty store: the picker is
// skipped (nothing to pick), but registration and save-as-profile are live.
func emptyStoreDeps(t *testing.T) WizardDeps {
	t.Helper()
	deps := testDeps()
	deps.Profiles = profile.NewStore(t.TempDir())
	return deps
}

// atRegistrationOffer connects with credentials the store has never seen and
// expects the wizard to offer saving them as a profile before moving on.
func atRegistrationOffer(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := drive(atCredentials(t, deps), key("enter"))
	if w.Step() != StepConnect {
		t.Fatalf("expected a connect attempt, got %v", w.Step())
	}
	w = drive(w, connectedMsg{identity: mustConnect(t, deps)})
	if w.Step() == StepMode || w.Step() == StepWorkspace {
		t.Fatalf("credentials the store has never seen should be offered for registration before the flow moves on, got %v", w.Step())
	}
	if view := w.View(); !strings.Contains(view, suggestedFreshName) {
		t.Fatalf("the offer should carry the suggested name %q, got:\n%s", suggestedFreshName, view)
	}
	return w
}

func TestRegistrationOffer_AppearsForUnrecognizedCredentials(t *testing.T) {
	defer ForcePlain()()

	w := atRegistrationOffer(t, emptyStoreDeps(t))
	if !strings.Contains(strings.ToLower(w.View()), "profile") {
		t.Errorf("the offer should say it is about a profile, got:\n%s", w.View())
	}
	if got := w.Result().ProfileName; got != "" {
		t.Errorf("nothing is registered before the operator answers, got %q", got)
	}
}

func TestRegistrationOffer_AcceptRegistersTheSuggestedName(t *testing.T) {
	defer ForcePlain()()

	w := drive(atRegistrationOffer(t, emptyStoreDeps(t)), key("y"))
	if w.Step() != StepMode {
		t.Fatalf("accepting should continue the normal flow, got %v", w.Step())
	}
	// Accepting records intent — the write happens at launch with the rest.
	if got := w.Result().ProfileName; got != suggestedFreshName {
		t.Errorf("accepting should register the suggested name, got %q want %q", got, suggestedFreshName)
	}
}

func TestRegistrationOffer_SuggestedNameIsEditable(t *testing.T) {
	defer ForcePlain()()

	w := drive(atRegistrationOffer(t, emptyStoreDeps(t)), key("e"))
	w = typeRunes(w, "-eu")
	w = drive(w, key("enter"))

	if w.Step() != StepMode {
		t.Fatalf("committing an edited name should continue the flow, got %v", w.Step())
	}
	if got, want := w.Result().ProfileName, suggestedFreshName+"-eu"; got != want {
		t.Errorf("the edited name should be what registers, got %q want %q", got, want)
	}
}

func TestRegistrationOffer_DeclineProceedsUnregistered(t *testing.T) {
	defer ForcePlain()()

	w := drive(atRegistrationOffer(t, emptyStoreDeps(t)), key("n"))
	if w.Step() != StepMode {
		t.Fatalf("declining must not block the flow, got %v", w.Step())
	}
	if got := w.Result().ProfileName; got != "" {
		t.Errorf("declining should register nothing, got %q", got)
	}
	if profiles, err := w.deps.Profiles.List(); err != nil || len(profiles) != 0 {
		t.Errorf("declining must write nothing to the store, got %d profiles (%v)", len(profiles), err)
	}
}

func TestRegistrationOffer_SkippedWhenCredentialsMatchAProfile(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	store := profile.NewStore(t.TempDir())
	// Stored credentials identical to the seed the credentials step commits.
	mustSaveProfile(t, store, "known", profile.Credentials{
		APIKey:    deps.Credentials.APIKey,
		APIURL:    deps.Credentials.Host,
		Workspace: deps.Credentials.Workspace,
	}, []byte("valaris: {}\n"))
	deps.Profiles = store

	// The store is non-empty, so the splash lands on the picker; start fresh,
	// then commit the seed credentials the store already knows.
	w := drive(atProfilePicker(t, deps), key("n"), key("enter"))
	if w.Step() != StepConnect {
		t.Fatalf("expected a connect attempt, got %v", w.Step())
	}
	w = drive(w, connectedMsg{identity: mustConnect(t, deps)})

	if w.Step() != StepMode {
		t.Errorf("known credentials mean no offer — the flow should settle on mode select, got %v", w.Step())
	}
}

// atProfileReview walks a fresh run (empty store) to the review screen,
// answering the registration offer with offerKey on the way.
func atProfileReview(t *testing.T, deps WizardDeps, offerKey string) Wizard {
	t.Helper()
	w := drive(atRegistrationOffer(t, deps), key(offerKey))
	if w.Step() != StepMode {
		t.Fatalf("answering the offer should land on mode select, got %v", w.Step())
	}
	w = selectMode(t, w, ModeLoop)
	boards, err := deps.LoadBoards(context.Background(), "valaris")
	if err != nil {
		t.Fatalf("test deps LoadBoards failed: %v", err)
	}
	w = drive(w, boardsLoadedMsg{boards: boards})
	w = drive(w, key("enter")) // board
	w = drive(w, key("enter")) // work dir
	w = drive(w, key("enter")) // provider
	if w.Step() != StepReview {
		t.Fatalf("expected the review step, got %v", w.Step())
	}
	return w
}

func TestReviewStep_SaveToggleBecomesSaveAsProfile(t *testing.T) {
	defer ForcePlain()()

	// Even after declining the offer, the review screen still proposes a
	// profile save under the suggested name — the second chance.
	view := atProfileReview(t, emptyStoreDeps(t), "n").View()
	if !strings.Contains(view, "save as profile") {
		t.Errorf("the save toggle should read save-as-profile, got:\n%s", view)
	}
	if !strings.Contains(view, suggestedFreshName) {
		t.Errorf("a fresh run's save name should default to the suggestion %q, got:\n%s", suggestedFreshName, view)
	}
}

func TestReviewStep_ProfileNameIsEditable(t *testing.T) {
	defer ForcePlain()()

	w := drive(atProfileReview(t, emptyStoreDeps(t), "n"), key("e"))
	w = typeRunes(w, "-blue")
	w = drive(w, key("enter"))

	if w.Step() != StepReview {
		t.Fatalf("committing the name edit should stay on review, got %v", w.Step())
	}
	want := suggestedFreshName + "-blue"
	if !strings.Contains(w.View(), want) {
		t.Errorf("the edited name should be on screen, got:\n%s", w.View())
	}
	if got := w.Result().ProfileName; got != want {
		t.Errorf("Result should carry the edited name, got %q want %q", got, want)
	}
}

func TestReviewStep_ExistingNameDemandsOverwriteConfirmation(t *testing.T) {
	defer ForcePlain()()

	// A different profile already owns the name the operator will type.
	deps := profileDeps(t)
	w := drive(atProfilePicker(t, deps), key("n"), key("enter"))
	w = drive(w, connectedMsg{identity: mustConnect(t, deps)})
	// Seed credentials differ from acme's, so registration is offered; accept
	// the suggestion, then rename it to the taken name on the review screen.
	if !strings.Contains(w.View(), suggestedFreshName) {
		t.Fatalf("expected the registration offer, got:\n%s", w.View())
	}
	w = drive(w, key("y"))
	w = selectMode(t, w, ModeDiscovery)
	w = drive(w, key("enter")) // work dir
	w = drive(w, key("enter")) // provider
	if w.Step() != StepReview {
		t.Fatalf("expected the review step, got %v", w.Step())
	}

	// Replace the suggested name with the taken one, character by character —
	// the editor is driven exactly as an operator would.
	w = drive(w, key("e"))
	for range suggestedFreshName {
		w = drive(w, key("backspace"))
	}
	w = typeRunes(w, acmeName)
	w = drive(w, key("enter"))
	if !strings.Contains(w.View(), acmeName) {
		t.Fatalf("the renamed save target should be on screen, got:\n%s", w.View())
	}

	// Launch: the name collides, so an explicit overwrite confirmation gates it.
	model, cmd := w.Update(key("enter"))
	w = model.(Wizard)
	if cmd != nil || w.launched {
		t.Fatal("a colliding profile name must not launch without confirmation")
	}
	if !strings.Contains(strings.ToLower(w.View()), "overwrite") {
		t.Fatalf("the collision should ask about overwriting, got:\n%s", w.View())
	}

	// Declining keeps the operator on review, unlaunched, store untouched.
	w = drive(w, key("n"))
	if w.Step() != StepReview || w.launched {
		t.Fatalf("declining the overwrite should stay on review unlaunched, got %v (launched=%v)", w.Step(), w.launched)
	}
	if p, err := deps.Profiles.Load(acmeName); err != nil || p.Credentials != acmeCreds {
		t.Errorf("declining must leave the stored profile untouched (%v)", err)
	}

	// Confirming lets the launch proceed, with the overwrite recorded.
	model, _ = w.Update(key("enter"))
	w = model.(Wizard)
	if !strings.Contains(strings.ToLower(w.View()), "overwrite") {
		t.Fatalf("relaunching should re-ask about the overwrite, got:\n%s", w.View())
	}
	model, cmd = w.Update(key("y"))
	w = model.(Wizard)
	if cmd == nil || !w.launched {
		t.Fatal("confirming the overwrite should launch")
	}
	res := w.Result()
	if res.ProfileName != acmeName {
		t.Errorf("the launch should save under the confirmed name, got %q", res.ProfileName)
	}
	if !res.ProfileOverwrite {
		t.Error("the confirmed overwrite must be recorded so the caller may replace the profile")
	}
}
