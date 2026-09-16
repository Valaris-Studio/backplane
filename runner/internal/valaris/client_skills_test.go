// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNextAssignment_DecodesSkills(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"card":         map[string]any{"id": "card-s", "title": "with skills"},
			"board":        map[string]any{"id": "b1", "slug": "main", "name": "Main"},
			"column":       map[string]any{"id": "c1", "name": "In Progress", "column_type": "in_progress"},
			"role":         "implementer",
			"stage_action": "implement_card",
			"reservation":  map[string]any{"id": "r1", "expires_at": "2026-04-26T00:00:00Z"},
			"skills": []map[string]any{
				{
					"slug":         "house-style",
					"name":         "House Style",
					"description":  "Naming and comment discipline",
					"version":      3,
					"content_hash": "abc123",
				},
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	resp, err := client.NextAssignment(context.Background(), "default", "agent-1", NextAssignmentRequest{})
	if err != nil {
		t.Fatalf("NextAssignment: %v", err)
	}
	if len(resp.Skills) != 1 {
		t.Fatalf("Skills length = %d, want 1", len(resp.Skills))
	}
	got := resp.Skills[0]
	if got.Slug != "house-style" || got.Name != "House Style" ||
		got.Description != "Naming and comment discipline" ||
		got.Version != 3 || got.ContentHash != "abc123" {
		t.Errorf("Skills[0] = %+v, want the full decoded row", got)
	}
}

func TestNextAssignment_AbsentSkillsIsNil(t *testing.T) {
	// Backends predating the skills registry omit the field entirely. The
	// runner must read that as "no skills bound" and never as an error.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"card":         map[string]any{"id": "card-n", "title": "no skills"},
			"board":        map[string]any{"id": "b1", "slug": "main", "name": "Main"},
			"column":       map[string]any{"id": "c1", "name": "In Progress", "column_type": "in_progress"},
			"role":         "implementer",
			"stage_action": "implement_card",
			"reservation":  map[string]any{"id": "r1", "expires_at": "2026-04-26T00:00:00Z"},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	resp, err := client.NextAssignment(context.Background(), "default", "agent-1", NextAssignmentRequest{})
	if err != nil {
		t.Fatalf("NextAssignment: %v", err)
	}
	if resp.Skills != nil {
		t.Errorf("Skills = %v, want nil on a pre-registry payload", resp.Skills)
	}
}

func TestFetchSkillVersionFiles(t *testing.T) {
	var gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		json.NewEncoder(w).Encode(map[string]any{
			"content_hash": "hash-9",
			"version":      4,
			"files": []map[string]any{
				{"path": "SKILL.md", "content": "# House Style\n"},
				{"path": "references/naming.md", "content": "prefer semantic names\n"},
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	files, err := client.FetchSkillVersionFiles(context.Background(), "default", "house-style", 4)
	if err != nil {
		t.Fatalf("FetchSkillVersionFiles: %v", err)
	}
	if want := "/api/workspaces/default/skills/house-style/versions/4"; gotPath != want {
		t.Errorf("request path = %q, want %q", gotPath, want)
	}
	if gotAuth != "Bearer vlr_test" {
		t.Errorf("Authorization = %q, want bearer token", gotAuth)
	}
	if files.ContentHash != "hash-9" {
		t.Errorf("ContentHash = %q, want hash-9", files.ContentHash)
	}
	if len(files.Files) != 2 {
		t.Fatalf("Files length = %d, want 2", len(files.Files))
	}
	if files.Files[0].Path != "SKILL.md" || files.Files[0].Content != "# House Style\n" {
		t.Errorf("Files[0] = %+v, want the decoded SKILL.md entry", files.Files[0])
	}
	if files.Files[1].Path != "references/naming.md" {
		t.Errorf("Files[1].Path = %q, want the nested reference path", files.Files[1].Path)
	}
}

func TestGetBoardEffectiveSkills(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewEncoder(w).Encode(map[string]any{
			"skills": []map[string]any{
				{"slug": "house-style", "name": "House Style", "version": 3, "content_hash": "abc123"},
				{"slug": "tdd", "name": "TDD", "version": 1, "content_hash": "def456"},
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	skills, err := client.GetBoardEffectiveSkills(context.Background(), "default", "board-1")
	if err != nil {
		t.Fatalf("GetBoardEffectiveSkills: %v", err)
	}
	if want := "/api/workspaces/default/boards/board-1/skills"; gotPath != want {
		t.Errorf("request path = %q, want %q", gotPath, want)
	}
	if len(skills) != 2 {
		t.Fatalf("skills length = %d, want 2", len(skills))
	}
	if skills[0].Slug != "house-style" || skills[0].Version != 3 || skills[0].ContentHash != "abc123" {
		t.Errorf("skills[0] = %+v, want the decoded binding row", skills[0])
	}
	if skills[1].Slug != "tdd" {
		t.Errorf("skills[1].Slug = %q, want tdd", skills[1].Slug)
	}
}
