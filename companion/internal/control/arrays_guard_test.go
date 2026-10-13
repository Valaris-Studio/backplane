// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"strings"
	"testing"
)

type chain struct {
	Names []string `json:"names"`
	Next  *chain   `json:"next,omitempty"`
	Any   any      `json:"any,omitempty"`
}

func TestEncode_CyclicValueFailsWithoutCrashing(t *testing.T) {
	loop := &chain{}
	loop.Next = loop
	if _, err := encodeJSON(loop); err == nil {
		t.Fatal("a cyclic value must fail to encode")
	}
	viaMap := map[string]any{}
	viaMap["self"] = viaMap
	if _, err := encodeJSON(viaMap); err == nil {
		t.Fatal("a cyclic map must fail to encode")
	}
}

func TestEncode_DeepValueBeyondTheGuardIsLeftAsItIs(t *testing.T) {
	root := &chain{}
	tail := root
	for range 10 * maxNormalizeDepth {
		tail.Next = &chain{}
		tail = tail.Next
	}
	encoded, err := encodeJSON(root)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if !strings.HasPrefix(text, `{"names":[],"next":{"names":[]`) {
		t.Fatalf("shallow nil slices are still normalized: %.80s", text)
	}
	if !strings.Contains(text, `"names":null`) {
		t.Fatal("beyond the guard the value is returned unchanged")
	}
}

func TestEncode_SharedPointerIsNotACycle(t *testing.T) {
	shared := &chain{}
	encoded, err := encodeJSON([]*chain{shared, shared, {Next: shared, Any: shared}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "null") {
		t.Fatalf("a value reached twice is normalized both times: %s", encoded)
	}
}
