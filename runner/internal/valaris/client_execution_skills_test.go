// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLogExecutionStartWithSkills_StampsSkills(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &payload)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "exec-1"})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	skills := []AssignmentSkill{
		{Slug: "house-style", Name: "House Style", Version: 3, ContentHash: "abc123"},
	}
	id, err := client.LogExecutionStartWithSkills(context.Background(),
		"agent-1", "default", "implement_card", "board-1", "card-1", "summary", "implementer",
		"slug", "model", "provider", skills)
	if err != nil {
		t.Fatalf("LogExecutionStartWithSkills: %v", err)
	}
	if id != "exec-1" {
		t.Errorf("execution id = %q, want exec-1", id)
	}

	raw, ok := payload["skills"]
	if !ok {
		t.Fatalf("payload has no skills field: %v", payload)
	}
	rows, ok := raw.([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("skills = %v, want one row", raw)
	}
	row, _ := rows[0].(map[string]any)
	if row["slug"] != "house-style" || row["content_hash"] != "abc123" {
		t.Errorf("skills[0] = %v, want the materialized skill identity", row)
	}
}

func TestLogExecutionStartWithSkills_OmitsEmptySkills(t *testing.T) {
	// omitempty keeps the payload byte-identical to the pre-registry shape, so
	// a backend without the column still accepts it.
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &payload)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "exec-2"})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if _, err := client.LogExecutionStartWithSkills(context.Background(),
		"agent-1", "default", "implement_card", "board-1", "card-1", "summary", "implementer",
		"", "", "", nil); err != nil {
		t.Fatalf("LogExecutionStartWithSkills: %v", err)
	}
	if _, present := payload["skills"]; present {
		t.Errorf("payload carries a skills field on an empty manifest: %v", payload)
	}
}

func TestLogExecutionStart_StillOmitsSkills(t *testing.T) {
	// The original entry point must stay unchanged for every non-card caller.
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &payload)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "exec-3"})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if _, err := client.LogExecutionStart(context.Background(),
		"agent-1", "default", "implement_card", "board-1", "card-1", "summary", "implementer"); err != nil {
		t.Fatalf("LogExecutionStart: %v", err)
	}
	if _, present := payload["skills"]; present {
		t.Errorf("legacy entry point sent a skills field: %v", payload)
	}
}
