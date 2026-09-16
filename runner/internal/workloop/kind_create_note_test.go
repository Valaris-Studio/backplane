// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// notePOST captures a single POST to /notes for body-level assertions.
type notePOST struct {
	Body         string         // raw JSON
	Decoded      map[string]any // parsed JSON payload
}

// noteCapturingServer answers GETs minimally and records every POST hitting a
// /notes endpoint. Returns the server + a getter for the captured POSTs.
func noteCapturingServer(t *testing.T) (*httptest.Server, func() []notePOST) {
	t.Helper()
	var mu sync.Mutex
	var captured []notePOST

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/notes") {
			body, _ := io.ReadAll(r.Body)
			var decoded map[string]any
			_ = json.Unmarshal(body, &decoded)
			mu.Lock()
			captured = append(captured, notePOST{Body: string(body), Decoded: decoded})
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	return srv, func() []notePOST {
		mu.Lock()
		defer mu.Unlock()
		out := make([]notePOST, len(captured))
		copy(out, captured)
		return out
	}
}

// newCreateNoteFixture builds the standard ws + step harness used across
// kind_create_note tests. Tests mutate the returned WalkState (e.g. setting
// LLMResult) before invoking lifecycleCreateNote.
func newCreateNoteFixture(t *testing.T) (*lifecycle.WalkState, func() []notePOST) {
	t.Helper()
	srv, getPosts := noteCapturingServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	return ws, getPosts
}

// --- hard-error cases (no POST should occur) ---

func TestLifecycleCreateNote_RejectsMissingKind(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	step := &valaris.LifecycleStep{Name: "n", Kind: "create_note", Params: map[string]any{}}
	_, _, err := lifecycleCreateNote(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "kind") {
		t.Fatalf("want error mentioning kind, got: %v", err)
	}
	if posts := getPosts(); len(posts) != 0 {
		t.Errorf("client should not POST when kind missing; got %d posts", len(posts))
	}
}

func TestLifecycleCreateNote_RejectsEmptyKind(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	step := &valaris.LifecycleStep{Name: "n", Kind: "create_note", Params: map[string]any{"kind": "  "}}
	_, _, err := lifecycleCreateNote(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "kind") {
		t.Fatalf("want error mentioning kind, got: %v", err)
	}
	if posts := getPosts(); len(posts) != 0 {
		t.Errorf("client should not POST when kind empty; got %d posts", len(posts))
	}
}

func TestLifecycleCreateNote_RejectsFromLLMOutputAlias(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan", "from_llm_output": true},
	}
	_, _, err := lifecycleCreateNote(context.Background(), ws, step)
	if err == nil {
		t.Fatal("expected error rejecting from_llm_output alias")
	}
	msg := err.Error()
	if !strings.Contains(msg, "from_llm_output") || !strings.Contains(msg, "body_from") {
		t.Errorf("error must mention both from_llm_output and body_from; got: %v", err)
	}
	if posts := getPosts(); len(posts) != 0 {
		t.Errorf("client should not POST when from_llm_output present; got %d posts", len(posts))
	}
}

func TestLifecycleCreateNote_RejectsUnknownBodyFrom(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan", "body_from": "banana"},
	}
	_, _, err := lifecycleCreateNote(context.Background(), ws, step)
	if err == nil {
		t.Fatal("expected error for unknown body_from")
	}
	msg := err.Error()
	for _, allowed := range []string{"findings", "raw", "summary", "decision"} {
		if !strings.Contains(msg, allowed) {
			t.Errorf("error should list allowed value %q; got: %v", allowed, err)
		}
	}
	if posts := getPosts(); len(posts) != 0 {
		t.Errorf("client should not POST on unknown body_from; got %d posts", len(posts))
	}
}

func TestLifecycleCreateNote_RejectsEmptyBody_DefaultFindings(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	// No LLMResult set; default body_from=findings resolves to "".
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan"},
	}
	_, _, err := lifecycleCreateNote(context.Background(), ws, step)
	if err == nil {
		t.Fatal("expected error when resolved body is empty")
	}
	msg := err.Error()
	if !strings.Contains(msg, "empty") || !strings.Contains(msg, "findings") {
		t.Errorf("error must mention empty + body_from value; got: %v", err)
	}
	if posts := getPosts(); len(posts) != 0 {
		t.Errorf("client should not POST when body empty; got %d posts", len(posts))
	}
}

// --- happy-path body resolution ---

func TestLifecycleCreateNote_BodyFromFindings_Default(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Decision: "approve", Findings: "F"}}
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["content"].(string); got != "F" {
		t.Errorf("content = %q, want F", got)
	}
}

func TestLifecycleCreateNote_BodyFromRaw(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	ws.LLMRawOutput = "raw payload"
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan", "body_from": "raw"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["content"].(string); got != "raw payload" {
		t.Errorf("content = %q, want raw payload", got)
	}
}

func TestLifecycleCreateNote_BodyFromSummary(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Summary: "S"}}
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan", "body_from": "summary"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["content"].(string); got != "S" {
		t.Errorf("content = %q, want S", got)
	}
}

func TestLifecycleCreateNote_BodyFromDecision(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Decision: "approve"}}
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan", "body_from": "decision"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["content"].(string); got != "approve" {
		t.Errorf("content = %q, want approve", got)
	}
}

// --- field propagation ---

func TestLifecycleCreateNote_PassesFailureClass(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Findings: "some findings"}}
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "review_verdict", "failure_class": "needs_rework"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["failure_class"].(string); got != "needs_rework" {
		t.Errorf("failure_class = %q, want needs_rework", got)
	}
}

func TestLifecycleCreateNote_DefaultTitleWhenMissing(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Findings: "F"}}
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	want := "Note: c1"
	if got, _ := posts[0].Decoded["title"].(string); got != want {
		t.Errorf("title = %q, want %q", got, want)
	}
}

func TestLifecycleCreateNote_PassesExplicitTitle(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Findings: "F"}}
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan", "title": "My plan"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["title"].(string); got != "My plan" {
		t.Errorf("title = %q, want My plan", got)
	}
}

func TestLifecycleCreateNote_PassesKindToClient(t *testing.T) {
	ws, getPosts := newCreateNoteFixture(t)
	ws.LLMResult = &llmStageResult{reviewResult: &reviewResult{Findings: "F"}}
	step := &valaris.LifecycleStep{
		Name: "n", Kind: "create_note",
		Params: map[string]any{"kind": "plan"},
	}
	if _, _, err := lifecycleCreateNote(context.Background(), ws, step); err != nil {
		t.Fatalf("create_note: %v", err)
	}
	posts := getPosts()
	if len(posts) != 1 {
		t.Fatalf("want 1 note POST, got %d", len(posts))
	}
	if got, _ := posts[0].Decoded["kind"].(string); got != "plan" {
		t.Errorf("kind = %q, want plan", got)
	}
}
