// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"reflect"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
)

func TestCompletionProvidersApplyRequiresConfirmationAndPreservesProfileRegistry(t *testing.T) {
	base := config.Defaults()
	base.LLM.Provider = "claude-cli"
	base.LLM.ExtraProviders = []string{"gemini-cli"}
	for _, confirmed := range []bool{false, true} {
		var result Result
		payload, _ := json.Marshal(map[string]any{
			"Mode": "loop", "Provider": "claude-cli", "Model": "fable",
			"ExtraProviders":               []string{"codex-cli", "gemini-cli", "codex-cli"},
			"CompletionProvidersConfirmed": confirmed,
		})
		if err := json.Unmarshal(payload, &result); err != nil {
			t.Fatal(err)
		}
		got := result.Apply(base)
		want := []string{"gemini-cli"}
		if confirmed {
			want = append(want, "codex-cli")
		}
		if !reflect.DeepEqual(got.LLM.ExtraProviders, want) {
			t.Fatalf("confirmed=%v providers=%v want=%v", confirmed, got.LLM.ExtraProviders, want)
		}
		if got.LLM.Provider != "claude-cli" || got.LLM.Model != "fable" {
			t.Fatal("completion provider replaced source model")
		}
		if !reflect.DeepEqual(base.LLM.ExtraProviders, []string{"gemini-cli"}) {
			t.Fatal("Apply mutated saved profile")
		}
	}
}

func TestCompletionProvidersSelectedBoardIsReviewedBeforeRegistration(t *testing.T) {
	deps := testDeps()
	calls := 0
	deps.LoadCompletionRequirements = func(ctx context.Context, workspace, board string) (*valaris.CompletionRequirements, error) {
		calls++
		if workspace != "chosen-workspace" || board != "chosen-board" {
			t.Fatalf("wrong requirements scope: %s/%s", workspace, board)
		}
		return &valaris.CompletionRequirements{PolicyHash: "policy", Requirements: []valaris.CompletionRequirement{
			{Kind: "review", Role: "operator-auditor", Provider: "codex-cli", Model: "review-model"},
			{Kind: "validation", Role: "operator-checks", Provider: "", Model: ""},
		}}, nil
	}
	w := NewWizard(deps)
	w.step = StepBoard
	w.workspaceStep.chosen = WorkspaceChoice{Slug: "chosen-workspace"}
	w.boardStep.boards = []BoardChoice{{ID: "chosen-board", Name: "Selected"}}
	model, cmd := w.Update(key("enter"))
	w = model.(Wizard)
	if cmd == nil {
		t.Fatal("selected board requirements were not fetched")
	}
	w = drive(w, cmd())
	if calls != 1 {
		t.Fatalf("requirements reads=%d", calls)
	}
	w.step = StepReview
	view := stripANSI(w.View())
	for _, want := range []string{"operator-auditor", "codex-cli", "review-model"} {
		if !strings.Contains(view, want) {
			t.Errorf("required dispatch %q missing from review: %s", want, view)
		}
	}
	if w.Result().CompletionProvidersConfirmed {
		t.Fatal("viewing review silently confirmed registry changes")
	}
	w = drive(w, key("enter"))
	if !w.launched || !w.Result().CompletionProvidersConfirmed {
		t.Fatalf("explicit launch did not confirm required providers: %#v", w.Result())
	}
	if !reflect.DeepEqual(w.Result().ExtraProviders, []string{"codex-cli"}) {
		t.Fatalf("direct checks registered model provider: %v", w.Result().ExtraProviders)
	}
}

func TestCompletionProvidersFailedReadBlocksLaunchWithoutLeakingError(t *testing.T) {
	deps := testDeps()
	deps.LoadCompletionRequirements = func(context.Context, string, string) (*valaris.CompletionRequirements, error) {
		return nil, errors.New("secret-upstream-body")
	}
	w := NewWizard(deps)
	w.step = StepBoard
	w.workspaceStep.chosen = WorkspaceChoice{Slug: "default"}
	w.boardStep.boards = []BoardChoice{{ID: "board", Name: "Selected"}}
	model, cmd := w.Update(key("enter"))
	w = model.(Wizard)
	if cmd == nil {
		t.Fatal("requirements read missing")
	}
	w = drive(w, cmd())
	w.step = StepReview
	w = drive(w, key("enter"))
	if w.launched || w.Result().CompletionProvidersConfirmed {
		t.Fatal("unverified board requirements reached launch")
	}
	if strings.Contains(w.View(), "secret-upstream-body") {
		t.Fatal("upstream body leaked")
	}
}

func TestCompletionProvidersIgnoreLateResponseForPreviousBoard(t *testing.T) {
	deps := testDeps()
	deps.LoadCompletionRequirements = func(ctx context.Context, workspace, board string) (*valaris.CompletionRequirements, error) {
		return &valaris.CompletionRequirements{Requirements: []valaris.CompletionRequirement{{Kind: "review", Role: board, Provider: "codex-cli", Model: "model"}}}, nil
	}
	w := NewWizard(deps)
	w.step = StepBoard
	w.workspaceStep.chosen = WorkspaceChoice{Slug: "default"}
	w.boardStep.boards = []BoardChoice{{ID: "first", Name: "First"}, {ID: "second", Name: "Second"}}
	model, first := w.Update(key("enter"))
	w = model.(Wizard)
	w.step = StepBoard
	w.boardStep.cursor = 1
	model, second := w.Update(key("enter"))
	w = model.(Wizard)
	w = drive(w, second())
	w = drive(w, first())
	w.step = StepReview
	if !strings.Contains(w.View(), "second: codex-cli") || strings.Contains(w.View(), "first: codex-cli") {
		t.Fatalf("stale requirements changed selected board: %s", w.View())
	}
}

func TestCompletionProvidersMissingLocalRuntimeDoesNotConfirmOrLaunch(t *testing.T) {
	deps := testDeps()
	deps.Providers = []string{"claude"}
	deps.LoadCompletionRequirements = func(context.Context, string, string) (*valaris.CompletionRequirements, error) {
		return &valaris.CompletionRequirements{Requirements: []valaris.CompletionRequirement{{Kind: "review", Role: "custom-checker", Provider: "codex-cli", Model: "model"}}}, nil
	}
	w := NewWizard(deps)
	w.step = StepBoard
	w.boardStep.boards = []BoardChoice{{ID: "board", Name: "Board"}}
	model, cmd := w.Update(key("enter"))
	w = model.(Wizard)
	w = drive(w, cmd())
	w.step = StepReview
	w = drive(w, key("enter"))
	if w.launched || w.Result().CompletionProvidersConfirmed {
		t.Fatal("missing required runtime launched")
	}
	if !strings.Contains(w.View(), "codex-cli") {
		t.Fatal("missing provider not identified")
	}
}

func TestCompletionBoardPickerNamesExplicitBlockedCards(t *testing.T) {
	var board BoardChoice
	if err := json.Unmarshal([]byte(`{"ID":"board","Name":"Selected","StateNote":"parked · nothing ready","ExplicitlyBlockedCount":2}`), &board); err != nil {
		t.Fatal(err)
	}
	w := NewWizard(testDeps())
	w.step = StepBoard
	w.boardStep.boards = []BoardChoice{board}
	if !strings.Contains(w.View(), "2 cards in Blocked") {
		t.Fatalf("explicit blocked cards hidden: %s", w.View())
	}
}

func TestCompletionProvidersDoNotFollowAChangedMode(t *testing.T) {
	result := Result{Mode: ModePipeline, ExtraProviders: []string{"codex-cli"}, CompletionProvidersConfirmed: true}
	base := config.Defaults()
	base.LLM.ExtraProviders = []string{"gemini-cli"}
	if got := result.Apply(base).LLM.ExtraProviders; !reflect.DeepEqual(got, base.LLM.ExtraProviders) {
		t.Fatalf("previous board requirements escaped loop scope: %v", got)
	}
}
