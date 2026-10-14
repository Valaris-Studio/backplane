// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestContextDispatchPreparationRejectsEveryCorruptAcknowledgement(t *testing.T) {
	changes := map[string]func(map[string]any){
		"version":           func(a map[string]any) { a["protocol_version"] = 2 },
		"acknowledged":      func(a map[string]any) { a["acknowledged"] = "queued" },
		"receipt_uuid":      func(a map[string]any) { a["receipt_id"] = "not-a-receipt" },
		"execution_uuid":    func(a map[string]any) { a["execution_id"] = runnerDispatchCard },
		"request_key":       func(a map[string]any) { a["client_request_id"] = "another-request" },
		"context_revision":  func(a map[string]any) { a["context_revision"] = strings.Repeat("8", 64) },
		"dispatch_revision": func(a map[string]any) { a["dispatch_revision"] = strings.Repeat("8", 64) },
		"ordinal":           func(a map[string]any) { a["ordinal"] = 0 },
		"input_hash":        func(a map[string]any) { a["prompt_sha256"] = strings.Repeat("8", 64) },
		"input_runes_not_bytes": func(a map[string]any) {
			a["prompt_bytes"] = utf8.RuneCountInString(invocationExpectedPrompt("Fresh card é"))
		},
		"system_hash":                func(a map[string]any) { a["system_prompt_sha256"] = strings.Repeat("8", 64) },
		"system_bytes":               func(a map[string]any) { a["system_prompt_bytes"] = 1 },
		"required_inclusion":         func(a map[string]any) { a["inclusion_verification"] = "no_required_sources" },
		"use_verification":           func(a map[string]any) { a["use_verification"] = "verified" },
		"missing_input_hash":         func(a map[string]any) { delete(a, "prompt_sha256") },
		"null_empty_system_bytes":    func(a map[string]any) { a["system_prompt_bytes"] = nil },
		"missing_empty_system_bytes": func(a map[string]any) { delete(a, "system_prompt_bytes") },
		"missing_header":             nil,
		"wrong_header":               nil,
	}
	for name, mutate := range changes {
		t.Run(name, func(t *testing.T) {
			f := newInvocationHTTP()
			f.ackMutate = mutate
			if name == "missing_header" {
				f.ackHeader = ""
			} else if name == "wrong_header" {
				f.ackHeader = "2"
			}
			c := newInvocationCase(t, f, "continue_project")
			if err := c.run(context.Background()); err == nil {
				t.Error("corrupt acknowledgement accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.queries) != 1 || len(f.payloads) != 1 || c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("invalid acknowledgement did not stop exactly before inference: refresh=%d prepare=%d current=%d stale=%d", len(f.queries), len(f.payloads), c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}

func TestContextDispatchPreparationRetriesExactPayloadOnlyWithinBound(t *testing.T) {
	for _, mode := range []string{"transient_then_ambiguous_then_success", "exhausted", "forbidden", "invalid_payload", "unrelated_conflict"} {
		t.Run(mode, func(t *testing.T) {
			f := newInvocationHTTP()
			attempts := 1
			wantSuccess := false
			switch mode {
			case "transient_then_ambiguous_then_success":
				f.responses = []string{"502", "close"}
				attempts, wantSuccess = 3, true
			case "exhausted":
				f.responses = []string{"502", "502", "502", "502"}
				attempts = 3
			case "forbidden":
				f.responses = []string{"403"}
			case "invalid_payload":
				f.responses = []string{"422"}
			case "unrelated_conflict":
				f.responses = []string{"other_conflict"}
			}
			c := newInvocationCase(t, f, "continue_project")
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			err := c.run(ctx)
			if (err == nil) != wantSuccess {
				t.Errorf("success=%t, expected=%t, error=%v", err == nil, wantSuccess, err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.queries) != 1 || len(f.payloads) != attempts {
				t.Errorf("retry counts: refresh=%d prepare=%d; expected 1/%d", len(f.queries), len(f.payloads), attempts)
			}
			for i := 1; i < len(f.payloads); i++ {
				if !reflect.DeepEqual(f.payloads[0], f.payloads[i]) {
					t.Errorf("ambiguous retry changed semantic payload/key at attempt %d", i+1)
				}
			}
			wantCalls := 0
			if wantSuccess {
				wantCalls = 1
			}
			if c.current.CallCount() != wantCalls || c.stale.CallCount() != 0 {
				t.Errorf("retry provider count: current=%d stale=%d expected=%d/0", c.current.CallCount(), c.stale.CallCount(), wantCalls)
			}
		})
	}
}

func TestContextDispatchPreparationOneRevisionRefreshGetsNewPayloadAndKey(t *testing.T) {
	for _, mode := range []string{"context_changed", "dispatch_changed", "second_conflict"} {
		t.Run(mode, func(t *testing.T) {
			f := newInvocationHTTP()
			f.responses = []string{mode}
			if mode == "second_conflict" {
				f.responses = []string{"context_changed", "dispatch_changed"}
			}
			c := newInvocationCase(t, f, "continue_project")
			err := c.run(context.Background())
			wantSuccess := mode != "second_conflict"
			if (err == nil) != wantSuccess {
				t.Errorf("success=%t expected=%t error=%v", err == nil, wantSuccess, err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.queries) != 2 || len(f.payloads) != 2 {
				t.Fatalf("one revision refresh: refresh=%d prepare=%d, want 2/2", len(f.queries), len(f.payloads))
			}
			first, second := f.payloads[0], f.payloads[1]
			uuid := regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
			key1, _ := first["client_request_id"].(string)
			key2, _ := second["client_request_id"].(string)
			if !uuid.MatchString(key1) || !uuid.MatchString(key2) || key1 == key2 {
				t.Errorf("revision retry needs distinct request UUIDs: %q / %q", key1, key2)
			}
			expectedSecond := invocationExpectedPrompt("Changed after conflict é")
			if mode != "dispatch_changed" {
				expectedSecond += "Changed approved source 🧪\n"
			}
			if first["input_prompt"] != invocationExpectedPrompt("Fresh card é") || second["input_prompt"] != expectedSecond || first["dispatch_revision"] == second["dispatch_revision"] {
				t.Errorf("revision retry did not rerender actual current inputs: first=%v second=%v", first, second)
			}
			wantCalls := 0
			if wantSuccess {
				wantCalls = 1
				if call := c.current.LastCall(); call == nil || call.Prompt != second["input_prompt"] {
					t.Errorf("provider did not receive last prepared revision: %v", call)
				}
			}
			if c.current.CallCount() != wantCalls || c.stale.CallCount() != 0 {
				t.Errorf("revision conflict escaped into provider: current=%d stale=%d", c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}

func TestContextDispatchPreparationCancellationBeforeAckStopsInference(t *testing.T) {
	f := newInvocationHTTP()
	c := newInvocationCase(t, f, "continue_project")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.beforeAck = cancel
	if err := c.run(ctx); err == nil {
		t.Error("invocation continued after cancellation before complete acknowledgement")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.payloads) != 1 || c.current.CallCount()+c.stale.CallCount() != 0 {
		t.Errorf("cancellation dispatch counts: prepare=%d current=%d stale=%d", len(f.payloads), c.current.CallCount(), c.stale.CallCount())
	}
}

func TestContextDispatchPreparationRetryHonorsShortContextDeadline(t *testing.T) {
	f := newInvocationHTTP()
	f.responses = []string{"502", "502", "502", "502"}
	c := newInvocationCase(t, f, "continue_project")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := c.run(ctx); err == nil {
		t.Error("failed preparation accepted")
	}
	if time.Since(started) > time.Second {
		t.Error("retry ignored invocation context cancellation")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.payloads) == 0 || len(f.payloads) > 3 || c.current.CallCount()+c.stale.CallCount() != 0 {
		t.Errorf("canceled retry counts: prepare=%d current=%d stale=%d", len(f.payloads), c.current.CallCount(), c.stale.CallCount())
	}
}
