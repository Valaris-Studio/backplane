// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
)

// The captured Desktop subagent is not a fork: session_id and
// parent_thread_id name its parent, while its own id names its rollout.
// Reuse the native corpus, relocating only its paths and timestamps.
func TestHooklessDesktopNativeSubagentEnvelopesNameTheirParent(t *testing.T) {
	for _, level := range []string{"metadata", "rich"} {
		t.Run(level, func(t *testing.T) {
			f := codexContentFixture(t, level)
			lines := f.fixtureRolloutLines(t, "codex-desktop", "rollout-subagent.jsonl", f.since(t, 10*time.Second))
			var meta struct {
				Payload struct {
					ID             string `json:"id"`
					SessionID      string `json:"session_id"`
					ParentThreadID string `json:"parent_thread_id"`
					ForkedFromID   string `json:"forked_from_id"`
				} `json:"payload"`
			}
			if err := json.Unmarshal([]byte(lines[0]), &meta); err != nil {
				t.Fatal(err)
			}
			if meta.Payload.ID != codexDesktopChild || meta.Payload.SessionID != codexDesktopThread || meta.Payload.ParentThreadID != codexDesktopThread || meta.Payload.ForkedFromID != "" {
				t.Fatalf("native subagent fixture no longer describes the expected relation: %+v", meta.Payload)
			}
			header, ok := codex.New().ContentParser().Header([]byte(lines[0]))
			if !ok || header.ParentSessionID != "" {
				t.Fatalf("a subagent's envelope relation must not become a fork-history header: %+v, ok %v", header, ok)
			}

			writeLines(t, f.codexRollout(codexDesktopChild), lines)
			f.since(t, 30*time.Second)
			discoverDesktop(t, f)
			assertNativeDesktopSubagent(t, f, level)
			before := len(f.server.Records())
			discoverDesktop(t, f)
			if after := len(f.server.Records()); after != before {
				t.Errorf("unchanged subagent uploaded again: %d records became %d", before, after)
			}
		})
	}
}

func assertNativeDesktopSubagent(t *testing.T, f *fixture, level string) {
	t.Helper()
	var outputs []float64
	var contentCount int
	for _, record := range f.server.Records() {
		if record["native_session_id"] != codexDesktopChild || record["harness"] != codex.DesktopID || record["mapping_id"] != richMapping {
			t.Fatalf("native subagent lost its own session, harness or authorized mapping: %v", record)
		}
		events, _ := record["events"].([]any)
		contents, _ := record["contents"].([]any)
		if len(events) == 0 && len(contents) == 0 {
			continue
		}
		if record["parent_native_session_id"] != codexDesktopThread {
			kind := "usage"
			if len(contents) > 0 {
				kind = "rich content"
			}
			t.Errorf("native subagent %s envelope has parent %v, want %s", kind, record["parent_native_session_id"], codexDesktopThread)
		}
		contentCount += len(contents)
		for _, raw := range events {
			event := raw.(map[string]any)
			usage := event["gen_ai"].(map[string]any)["usage"].(map[string]any)
			outputs = append(outputs, usage["output_tokens"].(float64))
		}
	}
	if !reflect.DeepEqual(outputs, []float64{62, 15}) {
		t.Errorf("native subagent usage = %v, want its two responses [62 15] exactly once", outputs)
	}
	if level == "rich" {
		key := agent.ContentKey(codex.DesktopID, codexDesktopChild, "msg_086d8e06a084ea5d016ac8501973208193b22171ff2bf68f90", "text:0")
		if len(declarationsByKey(f)[key]) != 1 || len(f.server.Body(key)) == 0 || contentCount == 0 {
			t.Error("native subagent's reply must remain in its own rich session")
		}
	} else if contentCount != 0 || len(f.server.Declarations()) != 0 {
		t.Error("metadata-only subagent must not upload captured content")
	}
	assertUsageHasNoPrivateText(t, f)
}
