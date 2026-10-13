// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"reflect"
	"testing"
)

// A snapshot's tools list is nullable, but when present every member is a
// string: a null or non-string member never coerces into a tool name.
func TestContextDispatchSnapshotRefusesNonStringTools(t *testing.T) {
	for name, tools := range map[string][]any{
		"null_member":   {nil},
		"number_member": {1},
		"mixed_members": {"Read", nil},
	} {
		t.Run(name, func(t *testing.T) {
			f := newInvocationHTTP()
			f.snapshot["dispatch"].(map[string]any)["tools"] = tools
			c := newInvocationCase(t, f, "continue_project")
			if err := c.run(context.Background()); err == nil {
				t.Error("a snapshot with a non-string tool was accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("non-string tools escaped their boundary: preparations=%d current=%d stale=%d", len(f.payloads), c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}

// Actual tool strings travel verbatim, an intentional empty one included.
func TestContextDispatchSnapshotKeepsStringToolsVerbatim(t *testing.T) {
	for name, tools := range map[string][]string{
		"empty_string_member": {""},
		"operator_strings":    {"Read", "", "mcp__operator__inspect"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newInvocationHTTP()
			f.snapshot["dispatch"].(map[string]any)["tools"] = tools
			c := newInvocationCase(t, f, "continue_project")
			if err := c.run(context.Background()); err != nil {
				t.Fatalf("valid string tools refused: %v", err)
			}
			if c.current.CallCount() != 1 {
				t.Fatalf("valid string tools did not reach the provider once: %d", c.current.CallCount())
			}
			if got := c.current.LastCall().Options.AllowedTools; !reflect.DeepEqual(got, tools) {
				t.Errorf("tools changed in transport: %q, want %q", got, tools)
			}
		})
	}
}
