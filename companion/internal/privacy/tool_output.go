// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// MaxFullToolOutputBytes bounds each tool-output string at the full level;
// longer values are cut and end with truncationMarker.
const MaxFullToolOutputBytes = 16 << 10

const truncationMarker = " …[truncated]"

// ReduceToolOutput applies the tool-output rule of level to the named
// top-level members: standard replaces each with {bytes, sha256} of the raw
// value; full and metadata leave them to SanitizeFor and ApplyContentLevel.
// It is idempotent, so a second pass keeps the original digest.
func ReduceToolOutput(payload map[string]any, members []string, level ContentLevel) map[string]any {
	if level != Standard {
		return payload
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = value
	}
	for _, member := range members {
		if value, present := out[member]; present && !isOutputDescriptor(value) {
			out[member] = OutputDescriptor(value)
		}
	}
	return out
}

// OutputDescriptor says how much output there was and what it hashed to,
// without the output itself.
func OutputDescriptor(value any) map[string]any {
	raw := serialized(value)
	return map[string]any{"bytes": len(raw), "sha256": fullSHA256(raw)}
}

// OutputPlaceholder is OutputDescriptor for a string-valued slot, such as
// an OTLP attribute.
func OutputPlaceholder(text string) string {
	return fmt.Sprintf(`{"bytes":%d,"sha256":"%s"}`, len(text), fullSHA256(text))
}

func isOutputDescriptor(value any) bool {
	object, ok := value.(map[string]any)
	if !ok || len(object) != 2 {
		return false
	}
	_, hasBytes := object["bytes"]
	_, hasHash := object["sha256"].(string)
	return hasBytes && hasHash
}

func serialized(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.Encode(value)
	return string(bytes.TrimSpace(buffer.Bytes()))
}

// TruncateToolOutput bounds one tool-output string for the full level.
func TruncateToolOutput(text string) (string, bool) {
	if len(text) <= MaxFullToolOutputBytes {
		return text, false
	}
	return truncateUTF8(text, MaxFullToolOutputBytes) + truncationMarker, true
}
