// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestContextDispatchInvocationFreshPacketAcrossCallers(t *testing.T) {
	for _, stage := range []string{"continue_project", "implement", "review", "document"} {
		t.Run(stage, func(t *testing.T) {
			f := newInvocationHTTP()
			f.snapshot["dispatch"].(map[string]any)["prompt_target"].(map[string]any)["stage"] = stage
			c := newInvocationCase(t, f, stage)
			if err := c.run(context.Background()); err != nil {
				t.Fatalf("valid prepared invocation: %v", err)
			}
			c.assertPreparedCall(t, invocationExpectedPrompt("Fresh card é"))
		})
	}
}

func TestContextDispatchInvocationWaitsBeforeRefresh(t *testing.T) {
	f := newInvocationHTTP()
	c := newInvocationCase(t, f, "continue_project")
	c.loop.limiter = newRateLimiter(1)
	started := time.Now()
	c.loop.limiter.timestamps = []time.Time{started.Add(-time.Minute + 200*time.Millisecond)}
	permitSeen := false
	f.onRefresh = func() {
		c.loop.limiter.mu.Lock()
		defer c.loop.limiter.mu.Unlock()
		permitSeen = len(c.loop.limiter.timestamps) == 1 && !c.loop.limiter.timestamps[0].Before(started)
	}
	finished := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() { finished <- c.run(ctx) }()
	// The limiter is still occupied; edit only server-owned snapshot state.
	time.Sleep(30 * time.Millisecond)
	f.mu.Lock()
	f.snapshot["card"].(map[string]any)["title"] = "Edited while waiting é"
	f.snapshot["dispatch_revision"] = strings.Repeat("9", 64)
	f.mu.Unlock()
	if err := <-finished; err != nil {
		t.Fatalf("valid invocation after rate wait: %v", err)
	}
	f.mu.Lock()
	if !permitSeen {
		t.Errorf("snapshot refresh did not observe an actually granted rate permit; refreshes=%d", len(f.queries))
	}
	f.mu.Unlock()
	c.assertPreparedCall(t, invocationExpectedPrompt("Edited while waiting é"))
}

func TestContextDispatchInvocationCancellationDuringRateWait(t *testing.T) {
	f := newInvocationHTTP()
	c := newInvocationCase(t, f, "continue_project")
	c.loop.limiter = newRateLimiter(1)
	c.loop.limiter.timestamps = []time.Time{time.Now()}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := c.run(ctx); err == nil {
		t.Error("canceled rate wait accepted")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queries) != 0 || len(f.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
		t.Errorf("canceled wait reached dispatch: refresh=%d prepare=%d provider=%d", len(f.queries), len(f.payloads), c.current.CallCount()+c.stale.CallCount())
	}
}

func TestContextDispatchInvocationNamedSecondStepUsesOwnEmptySources(t *testing.T) {
	f := newInvocationHTTP()
	f.snapshot["invocation"] = map[string]any{"kind": "lifecycle", "step_name": "synthesize-second", "prompt_slot": "main"}
	f.snapshot["context"] = map[string]string{}
	f.snapshot["context_manifest"].(map[string]any)["sources"] = []any{}
	f.snapshot["dispatch"].(map[string]any)["required_source_indices"] = []int{}
	f.snapshot["dispatch"].(map[string]any)["input_template"] = "Second step {{ index .Card \"title\" }}|{{len .ContextSources}}"
	f.ackMutate = func(ack map[string]any) { ack["inclusion_verification"] = "no_required_sources" }
	c := newInvocationCase(t, f, "continue_project")
	c.strategy.config.Lifecycle = []valaris.LifecycleStep{
		{Name: "first-call", Kind: "llm", Params: map[string]any{"stage": "continue_project", "model": "first-only-model", "context_sources": []any{map[string]any{"kind": "card_notes", "as": "first-only"}}}},
		{Name: "synthesize-second", Kind: "llm", Params: map[string]any{"stage": "continue_project", "context_sources": []any{}}},
	}
	ws := makeWalkState(t, c.loop, c.strategy, c.card)
	ws.ExecutionID, ws.RepoDir = c.execution, c.repoDir
	_, _, err := lifecycleLLM(context.Background(), ws, &c.strategy.config.Lifecycle[1])
	if err != nil {
		t.Fatalf("valid second lifecycle LLM step: %v", err)
	}
	c.assertPreparedCall(t, "Second step Fresh card é|0")
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queries) != 1 || f.queries[0].Get("invocation_kind") != "lifecycle" || f.queries[0].Get("step_name") != "synthesize-second" || f.queries[0].Get("prompt_slot") != "main" {
		t.Errorf("second step identity not passed to current snapshot: %v", f.queries)
	}
	if !reflect.DeepEqual(f.payloads[0]["invocation"], f.snapshot["invocation"]) {
		t.Errorf("prepared invocation differs from actual second step: %v", f.payloads[0]["invocation"])
	}
}

func TestContextDispatchInvocationMalformedTemplateNeverFallsBack(t *testing.T) {
	for _, template := range []string{"{{if}}", `partially rendered prefix {{ index .ContextSources "approved" 999999 }}`} {
		t.Run(template, func(t *testing.T) {
			f := newInvocationHTTP()
			f.snapshot["dispatch"].(map[string]any)["input_template"] = template
			c := newInvocationCase(t, f, "continue_project")
			if err := c.run(context.Background()); err == nil {
				t.Error("invalid required template accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.queries) != 1 || len(f.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("render error escaped through cached/partial prompt: refresh=%d prepare=%d provider=%d", len(f.queries), len(f.payloads), c.current.CallCount()+c.stale.CallCount())
			}
		})
	}
}

func TestContextDispatchInvocationCurrentAliasesOverrideAncillaryText(t *testing.T) {
	f := newInvocationHTTP()
	f.snapshot["context"] = map[string]string{"approved": invocationSource, "board_definition": "CURRENT DIRECTIVES", "review_history": "CURRENT REVIEW"}
	sources := f.snapshot["context_manifest"].(map[string]any)["sources"].([]any)
	for _, source := range []struct{ alias, body string }{{"board_definition", "CURRENT DIRECTIVES"}, {"review_history", "CURRENT REVIEW"}} {
		sources = append(sources, map[string]any{"source_index": len(sources), "kind": source.alias, "alias": source.alias, "filter": map[string]any{}, "coverage": "source_only", "rendered_sha256": invocationDigest(source.body), "rendered_bytes": len(source.body), "records": []any{}})
	}
	f.snapshot["context_manifest"].(map[string]any)["sources"] = sources
	f.snapshot["dispatch"].(map[string]any)["input_template"] = "{{.ProjectDirectives}}|{{.ReviewHistory}}|{{ index .ContextSources \"approved\" }}"
	c := newInvocationCase(t, f, "implement")
	if err := c.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.assertPreparedCall(t, "CURRENT DIRECTIVES|CURRENT REVIEW|"+invocationSource)
}

func TestContextDispatchInvocationExplicitLegacyRetainsCachedPath(t *testing.T) {
	f := newInvocationHTTP()
	f.base.contract["mode"], f.base.contract["minimum_version"] = "legacy", 0
	f.base.assignment["context_dispatch"].(map[string]any)["mode"] = "legacy"
	f.base.start["context_binding"].(map[string]any)["context_dispatch"].(map[string]any)["mode"] = "legacy"
	c := newInvocationCase(t, f, "continue_project")
	if err := c.run(context.Background()); err != nil {
		t.Fatalf("explicit negotiated legacy control: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queries) != 0 || len(f.payloads) != 0 || c.current.CallCount() != 0 || c.stale.CallCount() != 1 {
		t.Errorf("explicit legacy behavior changed: refresh=%d prepare=%d current=%d stale=%d", len(f.queries), len(f.payloads), c.current.CallCount(), c.stale.CallCount())
	}
	call := c.stale.LastCall()
	if call == nil || call.Prompt != "STALE CACHED TEMPLATE Exact é🧪 note\n" || call.Options.ContextDispatchVersion != 0 {
		t.Errorf("legacy cached call = %v", call)
	}
}

func TestContextDispatchInvocationRetainsRequiredBindingAfterPolicyRemoval(t *testing.T) {
	f := newInvocationHTTP()
	c := newInvocationCase(t, f, "continue_project")
	f.legacyAfterBind = true
	if err := c.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.assertPreparedCall(t, invocationExpectedPrompt("Fresh card é"))
}

func TestContextDispatchInvocationRefusesMissingBindingOrSnapshot(t *testing.T) {
	for _, failure := range []string{"missing_binding", "missing_execution", "snapshot_404", "snapshot_503"} {
		t.Run(failure, func(t *testing.T) {
			f := newInvocationHTTP()
			c := newInvocationCase(t, f, "continue_project")
			switch failure {
			case "missing_binding":
				c.card.Dispatch = nil
				c.loop.cfg.ContextDispatch.Require = true
			case "missing_execution":
				c.execution = ""
			case "snapshot_404":
				f.snapshotStatus = 404
			case "snapshot_503":
				f.snapshotStatus = 503
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := c.run(ctx); err == nil {
				t.Error("required dispatch failure accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("required failure fell through to inference: prepare=%d current=%d stale=%d", len(f.payloads), c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}

func TestContextDispatchInvocationGuardsAdapterChannelsBeforePreparation(t *testing.T) {
	for _, mode := range []string{"undeclared_builtin_name", "fresh_input_missing", "resume_input_missing", "resume_supported"} {
		t.Run(mode, func(t *testing.T) {
			f := newInvocationHTTP()
			c := newInvocationCase(t, f, "implement")
			switch mode {
			case "undeclared_builtin_name":
				c.current.NameOverride = "claude-cli"
				c.loop.providers["claude-cli"] = c.current
				f.snapshot["dispatch"].(map[string]any)["provider"] = "claude-cli"
				c.current.Caps.PromptChannels = llm.PromptChannels{}
			case "fresh_input_missing":
				c.current.Caps.PromptChannels.FreshInput = false
			case "resume_input_missing", "resume_supported":
				c.loop.sessions.Set(runnerDispatchAgent, runnerDispatchCard, "implement", "owned-session-58")
				c.current.Caps.PromptChannels.FreshInput = false
				c.current.Caps.PromptChannels.ResumeInput = mode == "resume_supported"
			}
			err := c.run(context.Background())
			if mode == "resume_supported" {
				if err != nil {
					t.Fatal(err)
				}
				c.assertPreparedCall(t, invocationExpectedPrompt("Fresh card é"))
				call := c.current.LastCall()
				f.mu.Lock()
				defer f.mu.Unlock()
				if call.Options.ResumeSessionID != "owned-session-58" || f.payloads[0]["resume_session_id"] != "owned-session-58" {
					t.Errorf("actual resumed session not prepared: %q / %v", call.Options.ResumeSessionID, f.payloads[0]["resume_session_id"])
				}
				want := map[string]any{"version": float64(1), "input": "verbatim", "system": "empty", "resume": true}
				if !reflect.DeepEqual(f.payloads[0]["channel_contract"], want) {
					t.Errorf("resume channel declaration = %v", f.payloads[0]["channel_contract"])
				}
				return
			}
			if err == nil {
				t.Error("unsupported required input channel accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.queries) != 1 || len(f.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("unsupported channels escaped gate: refresh=%d prepare=%d current=%d stale=%d", len(f.queries), len(f.payloads), c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}
