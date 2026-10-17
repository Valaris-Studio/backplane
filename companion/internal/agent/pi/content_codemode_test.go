// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
)

func TestCodemodeSpillMarksOnlyKnownSourceTruncation(t *testing.T) {
	const kept = "synthetic shortened codemode output"
	spill := filepath.Join(t.TempDir(), "codemode-full.log")
	if err := os.WriteFile(spill, []byte("FULL_LOG_MUST_NOT_BE_READ\n"+kept), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, tool string
		details    map[string]any
		truncated  bool
		original   int64
	}{
		{"known codemode spill", "codemode", map[string]any{"fullOutputPath": spill}, true, 0},
		{"missing codemode spill file", "codemode", map[string]any{"fullOutputPath": spill + ".missing"}, true, 0},
		{"empty codemode path", "codemode", map[string]any{"fullOutputPath": ""}, false, 0},
		{"non-string codemode path", "codemode", map[string]any{"fullOutputPath": 7}, false, 0},
		{"other tool path is not proof", "custom_tool", map[string]any{"fullOutputPath": spill}, false, 0},
		{"existing negative truncation wins", "codemode", map[string]any{"fullOutputPath": spill, "truncation": map[string]any{"truncated": false}}, false, 0},
		{"existing positive truncation retained", "codemode", map[string]any{"fullOutputPath": spill, "truncation": map[string]any{"truncated": true, "totalBytes": 9000}}, true, 9000},
		{"other tool explicit truncation retained", "custom_tool", map[string]any{"truncation": map[string]any{"truncated": true, "totalBytes": 9000}}, true, 9000},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw, err := json.Marshal(map[string]any{
				"type": "message", "id": "codemode-result", "timestamp": "2026-10-17T00:00:00Z",
				"message": map[string]any{"role": "toolResult", "toolName": test.tool, "toolCallId": "call_codemode",
					"isError": false, "content": []any{map[string]any{"type": "text", "text": kept}}, "details": test.details},
			})
			if err != nil {
				t.Fatal(err)
			}
			record, _, err := contentSource(t).ContentParser().Parse(agent.ContentLine{Bytes: raw, Harness: ID, NativeSessionID: mainSession}, nil)
			if err != nil {
				t.Fatal(err)
			}
			output := item(t, parsedLine{record: record}, "output")
			if output.SourceTruncated != test.truncated || output.OriginalBytes != test.original {
				t.Errorf("source truncation = %v from %d bytes; want %v from %d", output.SourceTruncated, output.OriginalBytes, test.truncated, test.original)
			}
			if output.Store != nil || text(t, output) != kept || output.CallID != "call_codemode" {
				t.Fatalf("the recorded text and call must stay unchanged, without a spill reader: %+v", output)
			}
			declarer := richcapture.Declarer{Harness: ID, NativeSessionID: mainSession, Kind: "pi_session", Parser: "companion-pi-session/1",
				Place: privacy.Place{Roots: []string{t.TempDir()}}, Limits: policy.DeviceRichLimits, ObservedAt: time.Now()}
			declaration := declarer.Declare(record, output, 0).Declaration
			wantCoverage := "captured"
			if test.truncated {
				wantCoverage = "truncated"
			}
			if declaration.Coverage != wantCoverage {
				t.Errorf("coverage = %q, want %q", declaration.Coverage, wantCoverage)
			}
			if test.truncated && (declaration.CoverageReason == nil || *declaration.CoverageReason != "source_limit") {
				t.Errorf("source truncation reason = %v", declaration.CoverageReason)
			}
			if test.original == 0 && declaration.OriginalByteCount != nil {
				t.Errorf("unknown original size became %d", *declaration.OriginalByteCount)
			}
			if test.original > 0 && (declaration.OriginalByteCount == nil || *declaration.OriginalByteCount != test.original) {
				t.Errorf("original size lost: %v", declaration.OriginalByteCount)
			}
			if declaration.Source.BodyFrom != "" || declaration.InlineText == nil || *declaration.InlineText != kept {
				t.Fatalf("declaration must use the recorded shortened text, not the log: %+v", declaration)
			}
		})
	}
}
