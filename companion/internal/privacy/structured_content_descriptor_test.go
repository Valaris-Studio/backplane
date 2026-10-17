// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/valaris/backplane/companion/internal/agent/pi"
	"github.com/valaris/backplane/companion/internal/privacy"
)

func TestPiStructuredContentRejectsMalformedDescriptors(t *testing.T) {
	digest := strings.Repeat("a", 64)
	for _, test := range []struct {
		name  string
		value map[string]any
	}{
		{"text byte count with checksum-looking digest", map[string]any{"bytes": "PRIVATE_RESULT_TEXT", "sha256": digest}},
		{"numeric byte count with ordinary text digest", map[string]any{"bytes": 12, "sha256": "PRIVATE_CHECKSUM_TEXT"}},
		{"negative byte count", map[string]any{"bytes": -1, "sha256": digest}},
		{"fractional byte count", map[string]any{"bytes": 1.5, "sha256": digest}},
		{"prefixed checksum", map[string]any{"bytes": 12, "sha256": "sha256:" + digest}},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"type": "tool_result", "toolName": "bash", "toolCallId": "call_descriptor", "structuredContent": test.value}
			members := pi.New().ToolOutput("tool_result")
			clean, _ := privacy.SanitizeFor(privacy.ReduceToolOutput(payload, members, privacy.Standard), members, privacy.Standard)
			retained := privacy.ApplyContentLevel(clean, privacy.Standard)
			if !reflect.DeepEqual(retained["structuredContent"], privacy.OutputDescriptor(test.value)) {
				t.Errorf("raw descriptor-shaped output survived Standard retention: %v", retained["structuredContent"])
			}
			encoded, err := json.Marshal(retained)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(encoded), "PRIVATE_") {
				t.Error("Standard retained ordinary private text inside a descriptor-shaped result")
			}
			if retained["toolName"] != "bash" || retained["toolCallId"] != "call_descriptor" {
				t.Error("retention changed the tool call identity")
			}
		})
	}
}

func TestPiStructuredContentDescriptorSurvivesRepeatedRetentionAndJSONRoundTrip(t *testing.T) {
	for _, value := range []any{"", map[string]any{"text": "private café result", "exitCode": 2}} {
		descriptor := privacy.OutputDescriptor(value)
		payload := map[string]any{"type": "tool_result", "structuredContent": descriptor}
		members := pi.New().ToolOutput("tool_result")
		retain := func(input map[string]any) map[string]any {
			clean, _ := privacy.SanitizeFor(privacy.ReduceToolOutput(input, members, privacy.Standard), members, privacy.Standard)
			return privacy.ApplyContentLevel(clean, privacy.Standard)
		}
		once := retain(payload)
		if !reflect.DeepEqual(once["structuredContent"], descriptor) {
			t.Fatalf("retention changed the produced descriptor: %v", once["structuredContent"])
		}
		if !reflect.DeepEqual(retain(once), once) {
			t.Error("repeated retention changed the original output digest or byte count")
		}
		encoded, err := json.Marshal(once)
		if err != nil {
			t.Fatal(err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(retain(decoded), decoded) {
			t.Error("retention changed a produced descriptor after its inbox JSON round trip")
		}
	}
}
