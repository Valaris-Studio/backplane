// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

func TestPiStructuredContentIsWithheldAtMetadataAndStandard(t *testing.T) {
	structured := map[string]any{"answer": "PRIVATE_STRUCTURED_OUTPUT", "nested": []any{map[string]any{"text": "PRIVATE_NESTED_OUTPUT"}}, "exitCode": 3}
	for _, level := range []privacy.ContentLevel{privacy.Metadata, privacy.Standard} {
		t.Run(string(level), func(t *testing.T) {
			payload := map[string]any{"type": "tool_result", "toolName": "bash", "toolCallId": "call_structured", "sessionId": "session-structured",
				"input": map[string]any{"command": "make check"}, "structuredContent": structured}
			members := pi.New().ToolOutput("tool_result")
			reduced := privacy.ReduceToolOutput(payload, members, level)
			clean, _ := privacy.SanitizeFor(reduced, members, level)
			once := privacy.ApplyContentLevel(clean, level)
			encoded, _ := json.Marshal(once)
			for _, secret := range []string{"PRIVATE_STRUCTURED_OUTPUT", "PRIVATE_NESTED_OUTPUT"} {
				if strings.Contains(string(encoded), secret) {
					t.Errorf("%s retained structured content %q", level, secret)
				}
			}
			if once["toolName"] != "bash" || once["toolCallId"] != "call_structured" || once["sessionId"] != "session-structured" {
				t.Errorf("event identity changed: %s", encoded)
			}
			if level == privacy.Standard {
				if !reflect.DeepEqual(once["structuredContent"], privacy.OutputDescriptor(structured)) {
					t.Errorf("standard must retain the original descriptor, got %v", once["structuredContent"])
				}
				if once["input"].(map[string]any)["command"] != "make check" {
					t.Error("standard lost the command")
				}
			}
			again := privacy.ReduceToolOutput(once, members, level)
			again, _ = privacy.SanitizeFor(again, members, level)
			again = privacy.ApplyContentLevel(again, level)
			if !reflect.DeepEqual(once, again) {
				t.Errorf("a second privacy pass changed retained evidence: %v -> %v", once, again)
			}
			if structured["answer"] != "PRIVATE_STRUCTURED_OUTPUT" {
				t.Error("privacy reduction mutated source payload")
			}
		})
	}
}

func TestMetadataRecognizesStructuredContentMemberCase(t *testing.T) {
	for _, member := range []string{"structuredContent", "structuredcontent", "STRUCTUREDCONTENT"} {
		result := privacy.ApplyContentLevel(map[string]any{member: map[string]any{"text": "PRIVATE_CASE_OUTPUT"}}, privacy.Metadata)
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), "PRIVATE_CASE_OUTPUT") {
			t.Errorf("metadata retained %s", member)
		}
	}
}

func TestPiStructuredContentFullAndRichRetainExactGeneralBoundAndRedaction(t *testing.T) {
	for _, level := range []privacy.ContentLevel{privacy.Full, privacy.Rich} {
		t.Run(string(level), func(t *testing.T) {
			payload := map[string]any{"type": "tool_result", "structuredContent": map[string]any{
				"text": strings.Repeat("x", 8192), "token": "PRIVATE_STRUCTURED_TOKEN", "summary": "token=structuredSecretValue",
			}}
			members := pi.New().ToolOutput("tool_result")
			clean, coverage := privacy.SanitizeFor(privacy.ReduceToolOutput(payload, members, level), members, level)
			clean = privacy.ApplyContentLevel(clean, level)
			structured, ok := clean["structuredContent"].(map[string]any)
			if !ok {
				t.Fatalf("%s replaced full structured content: %v", level, clean)
			}
			if structured["text"] != strings.Repeat("x", 4096) {
				t.Errorf("%s changed the exact existing 4KiB bound (got %d bytes)", level, len(structured["text"].(string)))
			}
			if structured["token"] != "[REDACTED]" {
				t.Errorf("structured token was not redacted: %v", structured["token"])
			}
			encoded, _ := json.Marshal(clean)
			if strings.Contains(string(encoded), "structuredSecretValue") {
				t.Error("inline secret escaped redaction")
			}
			if !reflect.DeepEqual(coverage.TruncatedFields, []string{"structuredContent.text"}) {
				t.Errorf("truncation evidence changed: %v", coverage.TruncatedFields)
			}
			again, _ := privacy.SanitizeFor(privacy.ReduceToolOutput(clean, members, level), members, level)
			if !reflect.DeepEqual(clean, again) {
				t.Error("repeated full/rich reduction changed retained content")
			}
		})
	}
}
