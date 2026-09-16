// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// fixCardServer serves the board (so the active column resolves) and records
// every card-create POST body so a test can assert title/labels/priority/column.
func fixCardServer(t *testing.T, boardID string) (*httptest.Server, *fixCardRecorder) {
	t.Helper()
	rec := &fixCardRecorder{}
	columns := []map[string]any{
		{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
		{"id": "col-done", "name": "Done", "column_type": "done", "position": 3072.0},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		switch {
		case strings.Contains(r.URL.Path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.HasSuffix(r.URL.Path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": boardID, "name": "B", "columns": columns})
		// Dependency POST: .../cards/{card_id}/dependencies — record (source card_id, depends_on).
		case strings.HasSuffix(r.URL.Path, "/dependencies") && r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			// path is .../cards/<card_id>/dependencies — pull the card_id segment.
			parts := strings.Split(r.URL.Path, "/")
			var sourceCardID string
			for i, p := range parts {
				if p == "cards" && i+1 < len(parts) {
					sourceCardID = parts[i+1]
				}
			}
			dependsOn, _ := body["depends_on_card_id"].(string)
			rec.recordDep(sourceCardID, dependsOn)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{}`))
		case strings.HasSuffix(r.URL.Path, "/cards") && r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			id := rec.record(body)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"` + id + `"}`))
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

type fixDep struct {
	source    string
	dependsOn string
}

type fixCardRecorder struct {
	mu      sync.Mutex
	creates []map[string]any
	deps    []fixDep
	nextID  int
}

// record stores the create body and returns a UNIQUE new card id so a caller can
// assert which fix card a dependency edge points at.
func (r *fixCardRecorder) record(body map[string]any) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.creates = append(r.creates, body)
	r.nextID++
	return fmt.Sprintf("fix-card-%d", r.nextID)
}

func (r *fixCardRecorder) recordDep(source, dependsOn string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deps = append(r.deps, fixDep{source: source, dependsOn: dependsOn})
}

func (r *fixCardRecorder) depList() []fixDep {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]fixDep, len(r.deps))
	copy(out, r.deps)
	return out
}

func (r *fixCardRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.creates)
}

func fixCardStep() *valaris.LifecycleStep {
	return &valaris.LifecycleStep{Name: "file_fixes", Kind: "create_fix_cards"}
}

// request_changes verdict carrying two fix_cards → engine creates two cards in
// the active column with the default routing stamp (urgent + direct-implement).
func TestCreateFixCards_CreatesOnePerSpec(t *testing.T) {
	boardID := "b-fix"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: boardID})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{
		Decision: "request_changes",
		FixCards: []FixCardSpec{
			{Title: "UI-FIX: fork nav umbrella", Description: "navigate to created.id"},
			{Title: "UI-FIX: empty-state polish", Description: "add empty states"},
		},
	}}

	dec, next, err := lifecycleCreateFixCards(context.Background(), ws, fixCardStep())
	if err != nil {
		t.Fatalf("create_fix_cards: %v", err)
	}
	if dec != "" || next != "" {
		t.Errorf("dec=%q next=%q, want both empty (non-terminal, no decision)", dec, next)
	}
	if rec.count() != 2 {
		t.Fatalf("expected 2 cards created, got %d", rec.count())
	}
	// First card: correct column, priority, routing labels.
	first := rec.creates[0]
	if first["column_id"] != "col-active" {
		t.Errorf("fix card column_id = %v, want col-active", first["column_id"])
	}
	if first["priority"] != "urgent" {
		t.Errorf("fix card priority = %v, want urgent", first["priority"])
	}
	if first["title"] != "UI-FIX: fork nav umbrella" {
		t.Errorf("fix card title = %v", first["title"])
	}
	labels, _ := first["labels"].([]any)
	hasDirect := false
	for _, l := range labels {
		if l == "direct-implement" {
			hasDirect = true
		}
		if l == "needs-ui-validation" {
			t.Error("fix card must NOT carry needs-ui-validation (reviewer re-applies it; carrying it now strands the card in the implementer's exclude)")
		}
	}
	if !hasDirect {
		t.Errorf("fix card must carry direct-implement (skip planner); labels=%v", labels)
	}
}

// Each created fix card must BLOCK the source card: the engine adds a dependency
// edge source_card depends_on fix_card, so the source (e.g. a ui_validator's
// failed Done card) can't be re-validated until every fix lands in Done. Without
// this, the ui_validator re-reserves the same unfixed card every poll (the
// re-validation money-loop). The source card_id is the card under validation
// (ws.Card), and each dependency points at a freshly-created fix card id.
func TestCreateFixCards_LinksFixesAsBlockersOfSourceCard(t *testing.T) {
	boardID := "b-dep"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "source-card", BoardID: boardID})
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
	deps := rec.depList()
	if len(deps) != 2 {
		t.Fatalf("expected 2 dependency edges (one per fix card), got %d: %+v", len(deps), deps)
	}
	for _, d := range deps {
		if d.source != "source-card" {
			t.Errorf("dependency source = %q, want the card under validation 'source-card'", d.source)
		}
		if d.dependsOn != "fix-card-1" && d.dependsOn != "fix-card-2" {
			t.Errorf("dependency depends_on = %q, want a freshly-created fix card id", d.dependsOn)
		}
	}
	// Both distinct fix cards must be linked.
	linked := map[string]bool{}
	for _, d := range deps {
		linked[d.dependsOn] = true
	}
	if !linked["fix-card-1"] || !linked["fix-card-2"] {
		t.Errorf("both fix cards must block the source; linked=%v", linked)
	}
}

// C backstop: a request_changes verdict that filed ZERO fix cards (the
// loop-cause — author chose "rework, not a follow-up card", but this lifecycle
// has no rework branch and never strips needs-ui-validation) must SYNTHESIZE
// exactly one umbrella fix card from the verdict body AND link it as a blocker,
// so re-validation is gated by the edge instead of money-looping forever.
func TestCreateFixCards_SynthesizesUmbrellaOnEmptyRequestChanges(t *testing.T) {
	boardID := "b-synth"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "looped-card", BoardID: boardID, Title: "OP2 · Bandeja"})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{
		Decision: "request_changes",
		Summary:  "bandeja renders empty on real mock data",
		Findings: flexString("Severe: useOperaciones 404s on mount (SW race). file: src/lib/operaciones/useOperaciones.ts"),
		FixCards: nil, // author filed none — "rework, not a follow-up"
	}}

	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, fixCardStep()); err != nil {
		t.Fatalf("create_fix_cards (synthesis): %v", err)
	}
	if rec.count() != 1 {
		t.Fatalf("a failing verdict with no fix_cards must synthesize exactly 1 card, got %d", rec.count())
	}
	card := rec.creates[0]
	// Title derives from the card under validation so the fix is traceable.
	if title, _ := card["title"].(string); !strings.Contains(title, "OP2 · Bandeja") {
		t.Errorf("synthesized title should reference the source card; got %q", title)
	}
	// Body carries the verdict so the implementer has the failure to act on.
	if desc, _ := card["description"].(string); !strings.Contains(desc, "useOperaciones") {
		t.Errorf("synthesized description should carry the verdict findings; got %q", desc)
	}
	// The edge is the whole point: source depends_on the synthesized fix.
	deps := rec.depList()
	if len(deps) != 1 || deps[0].source != "looped-card" {
		t.Fatalf("synthesized card must block the source card; deps=%+v", deps)
	}
}

// APPROVE-PATH (Path B, now engine-owned): an approve verdict that carries
// fix_cards[] (minor follow-ups the auditor wants tracked after a pass) must
// file each card with the SAME Path-A stamp (active column, urgent,
// direct-implement) but emit ZERO dependency edges — the source card is Done,
// so an edge from it would dangle. Before this fix the approve branch no-op'd
// these and the LLM was told to call create_card itself, scattering them into
// Backlog at default priority.
func TestCreateFixCards_ApproveFilesCardsWithoutEdge(t *testing.T) {
	boardID := "b-approve"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "done-card", BoardID: boardID})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{
		Decision: "approve",
		FixCards: []FixCardSpec{
			{Title: "UI fix: buildInfo badge umbrella", Description: "wire EXPO_PUBLIC_BUILD_SHA"},
			{Title: "UI fix: Shimmer into UiGallery", Description: "import + wire Shimmer"},
		},
	}}
	// link_to_source:false is how the approve branch's step is configured.
	step := fixCardStep()
	step.Params = map[string]any{"link_to_source": false}

	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, step); err != nil {
		t.Fatalf("create_fix_cards (approve): %v", err)
	}
	if rec.count() != 2 {
		t.Fatalf("approve verdict with 2 fix_cards must file 2 cards, got %d", rec.count())
	}
	// Same Path-A stamp: active column, urgent, direct-implement.
	first := rec.creates[0]
	if first["column_id"] != "col-active" {
		t.Errorf("approve fix card column_id = %v, want col-active (NOT backlog)", first["column_id"])
	}
	if first["priority"] != "urgent" {
		t.Errorf("approve fix card priority = %v, want urgent", first["priority"])
	}
	labels, _ := first["labels"].([]any)
	hasDirect := false
	for _, l := range labels {
		if l == "direct-implement" {
			hasDirect = true
		}
	}
	if !hasDirect {
		t.Errorf("approve fix card must carry direct-implement; labels=%v", labels)
	}
	// The whole point of the approve path: NO dependency edge (source is Done).
	if deps := rec.depList(); len(deps) != 0 {
		t.Errorf("approve-path fix cards must have ZERO dependency edges, got %d: %+v", len(deps), deps)
	}
}

// link_to_source defaults to true (Path A): a request_changes verdict still
// links each fix as a blocker even when the step omits the param entirely. The
// approve path opts out by setting link_to_source:false. This guards the
// default so the fail path's re-validation gate can never silently regress.
func TestCreateFixCards_LinkToSourceDefaultsTrue(t *testing.T) {
	boardID := "b-linkdefault"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "src", BoardID: boardID})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{
		Decision: "request_changes",
		FixCards: []FixCardSpec{{Title: "UI-FIX: a", Description: "fix a"}},
	}}
	// No params at all — link_to_source must default to true.
	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, fixCardStep()); err != nil {
		t.Fatalf("create_fix_cards: %v", err)
	}
	if deps := rec.depList(); len(deps) != 1 || deps[0].source != "src" {
		t.Fatalf("request_changes with default params must link the edge; deps=%+v", deps)
	}
}

// An approve verdict with NO fix_cards stays a clean no-op (the common case).
func TestCreateFixCards_ApproveEmptyIsNoop(t *testing.T) {
	boardID := "b-approve-empty"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: boardID})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Decision: "approve"}}
	step := fixCardStep()
	step.Params = map[string]any{"link_to_source": false}

	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, step); err != nil {
		t.Fatalf("create_fix_cards (approve empty): %v", err)
	}
	if rec.count() != 0 {
		t.Errorf("approve with no fix_cards must create nothing, got %d", rec.count())
	}
}

// A dependency-edge failure must NOT abort the audit-verdict swap (best-effort,
// like the create failures) — the validated card's state is the load-bearing
// outcome. The cards are still created even if a dep POST errors.
func TestCreateFixCards_DepEdgeFailureIsNonFatal(t *testing.T) {
	boardID := "b-depfail"
	rec := &fixCardRecorder{}
	columns := []map[string]any{
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		switch {
		case strings.Contains(r.URL.Path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.HasSuffix(r.URL.Path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": boardID, "name": "B", "columns": columns})
		case strings.HasSuffix(r.URL.Path, "/dependencies") && r.Method == http.MethodPost:
			w.WriteHeader(http.StatusInternalServerError) // dep edge fails
		case strings.HasSuffix(r.URL.Path, "/cards") && r.Method == http.MethodPost:
			rec.record(map[string]any{})
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"fix-x"}`))
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "s", BoardID: boardID})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{
		Decision: "request_changes",
		FixCards: []FixCardSpec{{Title: "UI-FIX: a", Description: "fix a"}},
	}}
	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, fixCardStep()); err != nil {
		t.Fatalf("a dep-edge failure must not abort create_fix_cards: %v", err)
	}
	if rec.count() != 1 {
		t.Errorf("fix card must still be created despite dep-edge failure, got %d", rec.count())
	}
}

// approve verdict (or any with no fix_cards) → no cards created, no error.
func TestCreateFixCards_NoSpecsIsNoop(t *testing.T) {
	boardID := "b-fix2"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c2", BoardID: boardID})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Decision: "approve"}}

	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, fixCardStep()); err != nil {
		t.Fatalf("create_fix_cards noop: %v", err)
	}
	if rec.count() != 0 {
		t.Errorf("approve verdict must create no fix cards, got %d", rec.count())
	}
}

// No LLMResult at all (defensive) → no panic, no create, no error.
func TestCreateFixCards_NilLLMResultIsSafe(t *testing.T) {
	boardID := "b-fix3"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c3", BoardID: boardID})

	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, fixCardStep()); err != nil {
		t.Fatalf("nil LLMResult: %v", err)
	}
	if rec.count() != 0 {
		t.Errorf("nil result must create nothing, got %d", rec.count())
	}
}

// to_column_type param overrides the default landing column.
func TestCreateFixCards_ColumnParamOverride(t *testing.T) {
	boardID := "b-fix4"
	srv, rec := fixCardServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "ui_validator"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c4", BoardID: boardID})
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{
		Decision: "request_changes",
		FixCards: []FixCardSpec{{Title: "x", Description: "y"}},
	}}
	step := fixCardStep()
	step.Params = map[string]any{"to_column_type": "backlog"}

	if _, _, err := lifecycleCreateFixCards(context.Background(), ws, step); err != nil {
		t.Fatalf("column override: %v", err)
	}
	if rec.count() != 1 || rec.creates[0]["column_id"] != "col-backlog" {
		t.Errorf("expected 1 card in col-backlog, got %+v", rec.creates)
	}
}

func TestCreateFixCards_RegisteredInBridge(t *testing.T) {
	if _, ok := lifecycle.Handlers["create_fix_cards"]; !ok {
		t.Fatal("create_fix_cards handler missing from lifecycle.Handlers")
	}
}
