// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// All closed-set kinds must have a registered handler. The init() in
// lifecycle_bridge.go already panics on a missing one — this test exists so
// the failure surfaces during `go test` rather than at runner startup, and so
// a CI run on a feature branch catches a half-wired addition immediately.
func TestKindHandlers_AllKindsRegistered(t *testing.T) {
	for kind := range lifecycle.Kinds {
		if _, ok := lifecycle.Handlers[kind]; !ok {
			t.Errorf("kind %q has no registered handler", kind)
		}
	}
}

// makeWalkState wires a minimal *Loop + *DataDrivenStrategy + *discoverResult
// into a WalkState. Used by per-kind tests that don't need a live HTTP server.
func makeWalkState(t *testing.T, loop *Loop, strategy *DataDrivenStrategy, card *discoverResult) *lifecycle.WalkState {
	t.Helper()
	return &lifecycle.WalkState{
		Loop:     loop,
		Strategy: strategy,
		Sensors:  strategy.sensors,
		Card:     card,
	}
}

// kindHandlersServer captures every request method+path for assertion. Kind
// handlers that wrap REST helpers (move_card, apply_label, create_note, etc.)
// can be exercised against this server to verify the right endpoint fires.
func kindHandlersServer(t *testing.T, boardID string) (*httptest.Server, *requestRecorder) {
	t.Helper()
	rec := &requestRecorder{}

	columns := []map[string]any{
		{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
		{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
		{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r.Method, r.URL.Path)
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		switch {
		case strings.Contains(r.URL.Path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(r.URL.Path, "/cards"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      boardID,
				"name":    "Test Board",
				"columns": columns,
			})
		case strings.Contains(r.URL.Path, "/cards/") && r.Method == http.MethodGet && !strings.Contains(r.URL.Path, "/search"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     "card-x",
				"title":  "T",
				"labels": []string{},
			})
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

type requestRecorder struct {
	mu   sync.Mutex
	hits []string
}

func (r *requestRecorder) record(method, path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hits = append(r.hits, method+" "+path)
}

func (r *requestRecorder) any(matchPath, matchMethod string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, h := range r.hits {
		if strings.Contains(h, matchMethod+" ") && strings.Contains(h, matchPath) {
			return true
		}
	}
	return false
}

func newLoopForKindTest(t *testing.T, serverURL string) *Loop {
	t.Helper()
	cfg := testConfig()
	client := testClientWithURL(serverURL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	return mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
}

// --- move_card ---

func TestKindMoveCard_HappyPath(t *testing.T) {
	boardID := "board-mc"
	srv, rec := kindHandlersServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)

	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	card := &discoverResult{CardID: "card-1", BoardID: boardID, Title: "t"}
	ws := makeWalkState(t, loop, strat, card)

	step := &valaris.LifecycleStep{
		Name: "move", Kind: "move_card",
		Params: map[string]any{"to_column_type": "done"},
	}

	if _, _, err := lifecycleMoveCard(context.Background(), ws, step); err != nil {
		t.Fatalf("move_card: %v", err)
	}
	if !rec.any("/cards/card-1/move", "POST") && !rec.any("/cards/card-1/move", "PUT") &&
		!rec.any("/cards/card-1/position", "PUT") && !rec.any("/cards/card-1/position", "POST") {
		// MoveCard hits whatever the client uses; just ensure the board lookup happened.
		if !rec.any("/boards/"+boardID, "GET") {
			t.Errorf("expected at least a GET /boards/%s, hits=%v", boardID, rec.hits)
		}
	}
}

func TestKindMoveCard_MissingParam(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "move", Kind: "move_card"}
	_, _, err := lifecycleMoveCard(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "to_column_type") {
		t.Errorf("want missing-param error, got: %v", err)
	}
}

func TestKindMoveCard_RequiresCard(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := &lifecycle.WalkState{Loop: loop, Strategy: strat}
	step := &valaris.LifecycleStep{Name: "m", Kind: "move_card", Params: map[string]any{"to_column_type": "done"}}
	_, _, err := lifecycleMoveCard(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "requires a card") {
		t.Errorf("want requires-a-card error, got: %v", err)
	}
}

// --- apply_label / remove_label ---

func TestKindApplyLabel_HappyPath(t *testing.T) {
	srv, rec := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "lbl", Kind: "apply_label", Params: map[string]any{"label": "tested"}}
	if _, _, err := lifecycleApplyLabel(context.Background(), ws, step); err != nil {
		t.Fatalf("apply_label: %v", err)
	}
	// addLabel reads then writes — at minimum a GET on the card.
	if !rec.any("/cards/c1", "GET") {
		t.Errorf("expected GET on card, hits=%v", rec.hits)
	}
}

func TestKindApplyLabel_MissingParam(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "lbl", Kind: "apply_label"}
	_, _, err := lifecycleApplyLabel(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "label") {
		t.Errorf("want missing-label error, got: %v", err)
	}
}

func TestKindRemoveLabel_MissingParam(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "lbl", Kind: "remove_label"}
	_, _, err := lifecycleRemoveLabel(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "label") {
		t.Errorf("want missing-label error, got: %v", err)
	}
}

// --- create_note ---
// NOTE: happy-path body resolution + error cases live in kind_create_note_test.go.
// The two tests below guard kind-handler-level smoke (a real lifecycleCreateNote
// invocation reaching the test HTTP server) without duplicating contract coverage.

// Sanity: a fully-specified create_note step (kind + non-empty body source)
// reaches the backend with a POST. Body parsing is covered in kind_create_note_test.go.
func TestKindCreateNote_FiresPOST(t *testing.T) {
	srv, rec := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	ws.LLMRawOutput = "raw stdout"
	step := &valaris.LifecycleStep{
		Name: "note", Kind: "create_note",
		Params: map[string]any{"kind": "plan", "body_from": "raw"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	hasPost := false
	for _, h := range rec.hits {
		if strings.HasPrefix(h, "POST ") && strings.Contains(h, "/notes") {
			hasPost = true
			break
		}
	}
	if !hasPost {
		t.Errorf("expected POST on /notes, hits=%v", rec.hits)
	}
}

// Missing kind is the canonical config error — no POST should reach the server.
func TestKindCreateNote_MissingKindIsHardError(t *testing.T) {
	srv, rec := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "n", Kind: "create_note"}
	_, _, err := lifecycleCreateNote(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "kind") {
		t.Errorf("want missing-kind error, got: %v", err)
	}
	for _, h := range rec.hits {
		if strings.Contains(h, "POST") && strings.Contains(h, "/notes") {
			t.Errorf("expected NO note POST on config error, got: %s", h)
		}
	}
}

// --- enqueue_for_merge ---

func TestKindEnqueueForMerge_RequiresPRURL(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"}) // no PRURL
	step := &valaris.LifecycleStep{Name: "q", Kind: "enqueue_for_merge"}
	_, _, err := lifecycleEnqueueForMerge(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "PR URL") {
		t.Errorf("want missing-pr error, got: %v", err)
	}
}

// --- mcp_call ---

func TestKindMCPCall_UnknownTool(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "x", Kind: "mcp_call",
		Params: map[string]any{"tool": "no_such_tool", "args": map[string]any{}},
	}
	_, _, err := lifecycleMCPCall(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "unknown tool") {
		t.Errorf("want unknown-tool error, got: %v", err)
	}
}

func TestKindMCPCall_UpdateCard(t *testing.T) {
	srv, rec := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "uc", Kind: "mcp_call",
		Params: map[string]any{
			"tool": "update_card",
			"args": map[string]any{"fields": map[string]any{"priority": "high"}},
		},
	}
	if _, _, err := lifecycleMCPCall(context.Background(), ws, step); err != nil {
		t.Fatalf("mcp_call update_card: %v", err)
	}
	// update_card lands as a PATCH (or PUT) on /cards/c1.
	found := false
	for _, h := range rec.hits {
		if strings.Contains(h, "/cards/c1") && (strings.HasPrefix(h, "PATCH") || strings.HasPrefix(h, "PUT")) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected PATCH/PUT on /cards/c1, hits=%v", rec.hits)
	}
}

// --- branch ---

func TestKindBranch_ResolvesFromLastDecision(t *testing.T) {
	ws := &lifecycle.WalkState{LastDecision: "approve"}
	step := &valaris.LifecycleStep{
		Name: "b", Kind: "branch",
		Params: map[string]any{
			"expression": "${last_decision}",
			"cases":      map[string]any{"approve": "go_ship", "request_changes": "go_reject"},
		},
	}
	dec, next, err := lifecycleBranch(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	if dec != "approve" {
		t.Errorf("decision = %q, want approve (matched case key)", dec)
	}
	if next != "go_ship" {
		t.Errorf("next = %q, want go_ship", next)
	}
}

func TestKindBranch_ResolvesFromVariable(t *testing.T) {
	ws := &lifecycle.WalkState{}
	ws.Set("verdict", "fail")
	step := &valaris.LifecycleStep{
		Name: "b", Kind: "branch",
		Params: map[string]any{
			"expression": "${verdict}",
			"cases":      map[string]any{"pass": "continue", "fail": "abort"},
		},
	}
	_, next, err := lifecycleBranch(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	if next != "abort" {
		t.Errorf("next = %q, want abort", next)
	}
}

func TestKindBranch_DefaultCase(t *testing.T) {
	ws := &lifecycle.WalkState{LastDecision: "weird_value"}
	step := &valaris.LifecycleStep{
		Name: "b", Kind: "branch",
		Params: map[string]any{
			"expression": "${last_decision}",
			"cases":      map[string]any{"approve": "ship", "default": "investigate"},
		},
	}
	dec, next, err := lifecycleBranch(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	if next != "investigate" {
		t.Errorf("next = %q, want investigate (default fallthrough)", next)
	}
	if dec != "default" {
		t.Errorf("decision = %q, want default", dec)
	}
}

func TestKindBranch_MissingExpression(t *testing.T) {
	step := &valaris.LifecycleStep{Name: "b", Kind: "branch", Params: map[string]any{"cases": map[string]any{}}}
	_, _, err := lifecycleBranch(context.Background(), &lifecycle.WalkState{}, step)
	if err == nil || !strings.Contains(err.Error(), "expression") {
		t.Errorf("want missing-expression error, got: %v", err)
	}
}

func TestKindBranch_MissingCases(t *testing.T) {
	step := &valaris.LifecycleStep{Name: "b", Kind: "branch", Params: map[string]any{"expression": "x"}}
	_, _, err := lifecycleBranch(context.Background(), &lifecycle.WalkState{}, step)
	if err == nil || !strings.Contains(err.Error(), "cases") {
		t.Errorf("want missing-cases error, got: %v", err)
	}
}

// --- sensor ---

func TestKindSensor_RequiresName(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "s", Kind: "sensor", Params: map[string]any{"config": map[string]any{}}}
	_, _, err := lifecycleSensor(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "name") {
		t.Errorf("want missing-name error, got: %v", err)
	}
}

func TestKindSensor_ReturnsPassDecision(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	registry := fakeRegistry(&fakeSensor{name: "fake", passed: true, summary: "ok"})
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, registry)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "s", Kind: "sensor",
		Params: map[string]any{"name": "fake", "on_pass": "pass", "on_fail": "fail"},
	}
	dec, _, err := lifecycleSensor(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("sensor: %v", err)
	}
	if dec != "pass" {
		t.Errorf("decision = %q, want pass", dec)
	}
}

func TestKindSensor_ReturnsFailDecision(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	registry := fakeRegistry(&fakeSensor{name: "fake", passed: false, summary: "broken"})
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, registry)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "s", Kind: "sensor",
		Params: map[string]any{"name": "fake", "on_pass": "pass", "on_fail": "fail"},
	}
	dec, _, err := lifecycleSensor(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("sensor: %v", err)
	}
	if dec != "fail" {
		t.Errorf("decision = %q, want fail", dec)
	}
}

// --- discover ---

func TestKindDiscover_NoCardEmitsErrNoWork(t *testing.T) {
	// Backend NextAssignment returns 204 (no card). Our discoverWithConfig
	// falls back through the empty-body branch and ultimately returns an
	// empty discoverResult; lifecycleDiscover translates that to ErrNoWork.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/next-assignment") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// For legacy fallback paths: empty card lists.
		if strings.Contains(r.URL.Path, "/cards") {
			_ = json.NewEncoder(w).Encode([]any{})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role:     "x",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
	}, nil)
	ws := &lifecycle.WalkState{Loop: loop, Strategy: strat}
	_, _, err := lifecycleDiscover(context.Background(), ws, &valaris.LifecycleStep{Name: "d", Kind: "discover"})
	if err == nil {
		t.Fatal("want ErrNoWork, got nil")
	}
	// errors.Is for the sentinel
	if err.Error() == "" || (err.Error() != "lifecycle: no work available") {
		// Loose match — bridge wrapping may add prefix.
		if !strings.Contains(err.Error(), "no work available") {
			t.Errorf("want no-work sentinel, got: %v", err)
		}
	}
}

// --- claim ---

func TestKindClaim_PopulatesExecutionID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/executions") && r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-life-1"})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role:  "x",
		Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "implement_card"},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b1", Title: "t"})
	step := &valaris.LifecycleStep{Name: "claim", Kind: "claim"}
	if _, _, err := lifecycleClaim(context.Background(), ws, step); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if ws.ExecutionID != "exec-life-1" {
		t.Errorf("ExecutionID = %q, want exec-life-1", ws.ExecutionID)
	}
}

// --- git_setup ---

func TestKindGitSetup_ActionNoneIsNoop(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role: "x",
		Git:  valaris.GitDef{Action: "none"},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "g", Kind: "git_setup"}
	if _, _, err := lifecycleGitSetup(context.Background(), ws, step); err != nil {
		t.Fatalf("git_setup: %v", err)
	}
	if ws.RepoDir != "" {
		t.Errorf("RepoDir = %q, want empty for action=none", ws.RepoDir)
	}
}

// --- llm ---

func TestKindLLM_CustomStageRunsAndProducesDecision(t *testing.T) {
	// We don't have a real LLM in tests; we rely on the LLM stage emitting a
	// "no_prompt" sentinel decision when no template is cached + no fallback
	// is registered. That confirms executeLLM was invoked and decision routing
	// works.
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role: "researcher",
		LLM: valaris.LLMDef{
			Stage:           "investigate",
			PostProcessKind: "produces_decision",
		},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "llm", Kind: "llm",
		Params: map[string]any{"stage": "investigate", "post_process_kind": "produces_decision"},
	}
	dec, _, err := lifecycleLLM(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("llm: %v", err)
	}
	if dec != "no_prompt" {
		t.Errorf("decision = %q, want no_prompt (graceful-skip sentinel)", dec)
	}
}
