// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"fmt"
	"testing"
)

func TestMockProviderName(t *testing.T) {
	m := NewMockProvider()
	if m.Name() != "mock" {
		t.Errorf("Name() = %q, want %q", m.Name(), "mock")
	}
}

func TestMockProviderReturnsQueuedResponses(t *testing.T) {
	m := NewMockProvider("response-1", "response-2")

	r1, err := m.Execute(context.Background(), "prompt-1", Options{})
	if err != nil {
		t.Fatal(err)
	}
	if r1.Output != "response-1" {
		t.Errorf("output = %q, want %q", r1.Output, "response-1")
	}

	r2, err := m.Execute(context.Background(), "prompt-2", Options{})
	if err != nil {
		t.Fatal(err)
	}
	if r2.Output != "response-2" {
		t.Errorf("output = %q, want %q", r2.Output, "response-2")
	}
}

func TestMockProviderRecordsCalls(t *testing.T) {
	m := NewMockProvider("ok")

	opts := Options{Model: "sonnet", WorkingDir: "/tmp/repo"}
	m.Execute(context.Background(), "test prompt", opts)

	if m.CallCount() != 1 {
		t.Fatalf("call count = %d, want 1", m.CallCount())
	}

	last := m.LastCall()
	if last.Prompt != "test prompt" {
		t.Errorf("prompt = %q, want %q", last.Prompt, "test prompt")
	}
	if last.Options.Model != "sonnet" {
		t.Errorf("model = %q, want %q", last.Options.Model, "sonnet")
	}
	if last.Options.WorkingDir != "/tmp/repo" {
		t.Errorf("working_dir = %q, want %q", last.Options.WorkingDir, "/tmp/repo")
	}
}

func TestMockProviderFailsWhenQueueEmpty(t *testing.T) {
	m := NewMockProvider() // no responses queued

	_, err := m.Execute(context.Background(), "prompt", Options{})
	if err == nil {
		t.Fatal("expected error when no responses queued")
	}
}

func TestMockProviderFailWithError(t *testing.T) {
	m := NewMockProvider("this should not be returned")
	m.FailWith = fmt.Errorf("simulated LLM failure")

	result, err := m.Execute(context.Background(), "prompt", Options{})
	if err == nil {
		t.Fatal("expected error")
	}
	if result.ExitCode != 1 {
		t.Errorf("exit code = %d, want 1", result.ExitCode)
	}
}

func TestMockProviderLastCallNilWhenNoCalls(t *testing.T) {
	m := NewMockProvider()
	if m.LastCall() != nil {
		t.Error("LastCall should be nil when no calls made")
	}
}

func TestProviderInterfaceConformance(t *testing.T) {
	// Compile-time check that both implementations satisfy the interface.
	var _ Provider = &ClaudeCLI{}
	var _ Provider = &MockProvider{}
}
