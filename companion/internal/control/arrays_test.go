// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type nested struct {
	Names   []string        `json:"names"`
	Skipped []string        `json:"skipped,omitempty"`
	Raw     json.RawMessage `json:"raw"`
	Inner   *nested         `json:"inner,omitempty"`
	hidden  []string
}

func TestEncode_NilSlicesAreEmptyArrays(t *testing.T) {
	value := map[string]any{"list": []int(nil), "item": nested{Inner: &nested{}, Raw: json.RawMessage(`{"kept":null}`)}, "items": []nested{{}}}
	encoded, err := encodeJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{`"list":null`, `"names":null`} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("%s in %s", forbidden, text)
		}
	}
	if strings.Contains(text, `"skipped"`) || !strings.Contains(text, `{"kept":null}`) {
		t.Fatalf("omitempty and raw JSON must be left as they are: %s", text)
	}
}

func TestResponsesAndEvents_NormalizeNilSlices(t *testing.T) {
	server := newTestServer(t, func(config *Config) {
		config.Backend = &nilSliceBackend{fakeBackend: &fakeBackend{}}
	})
	if reply := server.do(t, "GET", "/v1/agents", ""); strings.Contains(string(reply.body), "null") {
		t.Fatalf("response: %s", reply.body)
	}
	stream := server.subscribe(t)
	stream.next(t, "status")
	server.Publish("agents", []string(nil))
	if event := stream.next(t, "agents"); event.data != "[]" {
		t.Fatalf("event data %q", event.data)
	}
}

type nilSliceBackend struct{ *fakeBackend }

func (b *nilSliceBackend) Agents(context.Context) (any, error) {
	return []nested(nil), nil
}
