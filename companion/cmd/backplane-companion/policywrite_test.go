// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func restrictedLayout(t *testing.T) store.Layout {
	t.Helper()
	layout, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	cached := policy.Cached{RefreshedAt: time.Now().UTC(), Policy: policy.Policy{
		Installation: policy.Installation{ID: "i", AutoMatchRepos: false, EnabledAgents: []string{"codex_cli"}, ExcludeGlobs: []string{"**/secret/**"}},
		Mappings:     []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: "/src/app", Enabled: false, ContentLevel: "metadata"}},
	}}
	if err := policy.Save(layout.Policy(), cached); err != nil {
		t.Fatal(err)
	}
	return layout
}

func loadedPolicy(t *testing.T, layout store.Layout) policy.Policy {
	t.Helper()
	cached, err := policy.Load(layout.Policy())
	if err != nil {
		t.Fatal(err)
	}
	return cached.Policy
}

func assertStillRestricted(t *testing.T, layout store.Layout, answer string) {
	t.Helper()
	installation := loadedPolicy(t, layout).Installation
	if installation.EnabledAgents == nil || strings.Join(installation.EnabledAgents, ",") != "codex_cli" || strings.Join(installation.ExcludeGlobs, ",") != "**/secret/**" || installation.AutoMatchRepos {
		t.Fatalf("answer %s widened capture: %+v", answer, installation)
	}
}

func TestApplyPolicyWrite_AnIncompleteSettingsAnswerNeverWidensCapture(t *testing.T) {
	for _, answer := range []string{
		`{}`,
		`{"paused":false}`,
		`{"auto_match_repos":true}`,
		`{"auto_match_repos":false,"exclude_globs":["**/secret/**"]}`,
		`{"auto_match_repos":false,"enabled_agents":null,"exclude_globs":["**/secret/**"]}`,
		`{"auto_match_repos":false,"enabled_agents":["codex_cli"],"exclude_globs":null}`,
		`{"auto_match_repos":null,"enabled_agents":["codex_cli"],"exclude_globs":[]}`,
	} {
		layout := restrictedLayout(t)
		applyPolicyWrite(context.Background(), layout, control.PolicyWrite{Settings: json.RawMessage(answer)})
		assertStillRestricted(t, layout, answer)
	}
}

func TestApplyPolicyWrite_ACompleteSettingsAnswerIsApplied(t *testing.T) {
	layout := restrictedLayout(t)
	answer := `{"paused":false,"auto_match_repos":true,"enabled_agents":["claude_code","codex_cli"],"exclude_globs":[],"retention_days":30}`
	if err := applyPolicyWrite(context.Background(), layout, control.PolicyWrite{Settings: json.RawMessage(answer)}); err != nil {
		t.Fatal(err)
	}
	installation := loadedPolicy(t, layout).Installation
	if !installation.AutoMatchRepos || strings.Join(installation.EnabledAgents, ",") != "claude_code,codex_cli" || installation.ExcludeGlobs == nil || len(installation.ExcludeGlobs) != 0 || installation.RetentionDays == nil || *installation.RetentionDays != 30 {
		t.Fatalf("complete answer not applied: %+v", installation)
	}
}

func TestApplyPolicyWrite_AnIncompleteMappingAnswerChangesNothing(t *testing.T) {
	for _, answer := range []string{
		`{"id":"m1","workspace_id":"w","root_path":"/src/app","enabled":true}`,
		`{"id":"m1","workspace_id":"w","root_path":"/src/app","content_level":"full"}`,
		`{"id":"m1","workspace_id":"w","root_path":"/src/app","enabled":null,"content_level":"full"}`,
		`{"id":"m1","workspace_id":"w","root_path":"/src/app","enabled":true,"content_level":"everything"}`,
		`{"id":"m1","enabled":true,"content_level":"full"}`,
		`{"id":"m2","workspace_id":"w","enabled":true,"content_level":"full"}`,
	} {
		layout := restrictedLayout(t)
		applyPolicyWrite(context.Background(), layout, control.PolicyWrite{Mapping: json.RawMessage(answer)})
		mappings := loadedPolicy(t, layout).Mappings
		if len(mappings) != 1 || mappings[0].Enabled || mappings[0].ContentLevel != "metadata" {
			t.Fatalf("answer %s changed the mappings: %+v", answer, mappings)
		}
	}
}

func TestApplyPolicyWrite_ACompleteMappingAnswerIsApplied(t *testing.T) {
	layout := restrictedLayout(t)
	answer := `{"id":"m1","workspace_id":"w","board_id":null,"root_path":"/src/app","repo_url_normalized":null,"origin":"explicit","enabled":true,"content_level":"full"}`
	if err := applyPolicyWrite(context.Background(), layout, control.PolicyWrite{Mapping: json.RawMessage(answer)}); err != nil {
		t.Fatal(err)
	}
	if mappings := loadedPolicy(t, layout).Mappings; len(mappings) != 1 || !mappings[0].Enabled || mappings[0].ContentLevel != "full" {
		t.Fatalf("complete mapping answer not applied: %+v", mappings)
	}
}
