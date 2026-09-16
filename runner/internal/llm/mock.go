// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// MockProvider returns queued responses for testing.
// Thread-safe — can be used across goroutines.
type MockProvider struct {
	mu                  sync.Mutex
	responses           []string
	structuredResponses [][]byte
	Calls               []MockCall
	FailWith            error   // If set, all calls return this error.
	FailWithCostUSD     float64 // Cost reported alongside FailWith (e.g. to simulate a budget cutoff that spent ~the ceiling before erroring).
	// Tokens reported alongside FailWith. A real mid-pass cutoff errors AFTER the
	// model spent tokens; a hard arg/CLI crash errors with ZERO. Salvage gates on
	// this (0 tokens = the model never ran → leftover commits, don't salvage).
	FailWithInputTokens  int
	FailWithOutputTokens int

	// InputTokens/OutputTokens, when non-zero, are attached to every successful
	// Result so tests can exercise the cost/token accounting path (Loop.execute
	// estimates cost from these when CostUSD is zero, as real subscription-auth
	// runs do). The real provider gets these from the CLI's stream-json usage event.
	InputTokens  int
	OutputTokens int

	// Caps is returned by Capabilities(). Zero value = a bare provider that
	// reports nothing (useful for exercising the loop's degradation paths).
	Caps Capabilities

	// NameOverride lets a test give the mock a concrete provider identity
	// (e.g. "claude-cli" / "codex-cli") so per-stage provider routing can be
	// asserted by which mock received the call. Empty => "mock".
	NameOverride string
}

// Capabilities returns the configured Caps (zero value by default).
func (m *MockProvider) Capabilities() Capabilities { return m.Caps }

// MockCall records a single invocation of Execute.
type MockCall struct {
	Prompt  string
	Options Options
	At      time.Time
}

func NewMockProvider(responses ...string) *MockProvider {
	return &MockProvider{responses: responses}
}

func (m *MockProvider) Name() string {
	if m.NameOverride != "" {
		return m.NameOverride
	}
	return "mock"
}

func (m *MockProvider) Execute(_ context.Context, prompt string, opts Options) (*Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.Calls = append(m.Calls, MockCall{
		Prompt:  prompt,
		Options: opts,
		At:      time.Now(),
	})

	if m.FailWith != nil {
		return &Result{
			ExitCode:     1,
			CostUSD:      m.FailWithCostUSD,
			InputTokens:  m.FailWithInputTokens,
			OutputTokens: m.FailWithOutputTokens,
			Error:        m.FailWith,
		}, m.FailWith
	}

	if len(m.responses) == 0 {
		return nil, fmt.Errorf("mock: no more responses queued (call #%d)", len(m.Calls))
	}

	resp := m.responses[0]
	m.responses = m.responses[1:]

	r := &Result{
		Output:       resp,
		Duration:     50 * time.Millisecond,
		InputTokens:  m.InputTokens,
		OutputTokens: m.OutputTokens,
	}
	if len(m.structuredResponses) > 0 {
		r.StructuredOutput = m.structuredResponses[0]
		m.structuredResponses = m.structuredResponses[1:]
	}
	return r, nil
}

// QueueStructured pairs the next queued response with a structured output
// payload. The payload (raw JSON) is exposed on the Result.StructuredOutput
// field, mirroring what claude --json-schema emits in the result event.
func (m *MockProvider) QueueStructured(structured []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.structuredResponses = append(m.structuredResponses, structured)
}

// CallCount returns the number of times Execute was called.
func (m *MockProvider) CallCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.Calls)
}

// LastCall returns the most recent call, or nil if no calls were made.
func (m *MockProvider) LastCall() *MockCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.Calls) == 0 {
		return nil
	}
	call := m.Calls[len(m.Calls)-1]
	return &call
}
