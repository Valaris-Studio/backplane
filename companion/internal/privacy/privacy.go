// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package privacy bounds and redacts native agent payloads before anything is
// retained, and reduces them to the configured content level.
package privacy

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve"
)

const (
	contentStringLimit        = 4096
	maxMemberNameBytes        = 256
	maxCoveragePathBytes      = 256
	maxCoveragePaths          = 64
	maxCoveragePathBytesTotal = 8192
	maxPayloadDepth           = 64
	maxPayloadNodes           = 10000
)

var ErrUnsupportedStructure = errors.New("unsupported_payload_structure")

type Coverage struct {
	Transcript        string   `json:"transcript"`
	AssistantOutput   string   `json:"assistant_output"`
	TruncatedFields   []string `json:"truncated_fields"`
	RemovedFields     []string `json:"removed_fields"`
	Redaction         string   `json:"redaction"`
	OmittedFieldPaths int      `json:"omitted_field_paths"`
}

// ValidateStructure rejects payloads that are too deep, too large, or carry
// member names that are oversized or look like secrets. Names are never
// rewritten, so two distinct members can never collide after redaction.
func ValidateStructure(value any) error {
	nodes := 0
	return validateNode(value, 0, &nodes)
}

func validateNode(value any, depth int, nodes *int) error {
	*nodes++
	if depth > maxPayloadDepth || *nodes > maxPayloadNodes {
		return ErrUnsupportedStructure
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if !SupportedMemberName(key) {
				return ErrUnsupportedStructure
			}
			if err := validateNode(child, depth+1, nodes); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := validateNode(child, depth+1, nodes); err != nil {
				return err
			}
		}
	}
	return nil
}

func SupportedMemberName(key string) bool {
	return len(key) <= maxMemberNameBytes && asymptoteobserve.RedactString(key) == key
}

// Sanitize redacts and bounds a payload as the standard level retains it.
func Sanitize(input map[string]any) (map[string]any, Coverage) {
	return SanitizeFor(input, nil, Standard)
}

// SanitizeFor redacts and bounds a payload. At the full level the named
// tool-output members keep up to MaxFullToolOutputBytes per string, with a
// truncation marker; every other string keeps the general bound.
func SanitizeFor(input map[string]any, toolOutput []string, level ContentLevel) (map[string]any, Coverage) {
	fullOutput := map[string]bool{}
	if EventLevel(level) == Full {
		for _, member := range toolOutput {
			fullOutput[member] = true
		}
	}
	coverage := Coverage{Transcript: "not_read", AssistantOutput: "unavailable", TruncatedFields: []string{}, RemovedFields: []string{}, Redaction: "heuristic_v1"}
	pathCount, pathBytes := 0, 0
	addPath := func(paths *[]string, path coveragePath) {
		encoded, _ := json.Marshal(path.text)
		if path.omitted || pathCount >= maxCoveragePaths || pathBytes+len(encoded) > maxCoveragePathBytesTotal {
			coverage.OmittedFieldPaths++
			return
		}
		*paths = append(*paths, path.text)
		pathCount++
		pathBytes += len(encoded)
	}
	var visit func(any, coveragePath) any
	visit = func(value any, path coveragePath) any {
		switch typed := value.(type) {
		case string:
			typed = ReplaceDataURLs(typed)
			if IsBinaryString(path.key, typed) {
				return BinaryPlaceholder(typed)
			}
			clean := asymptoteobserve.RedactString(typed)
			if fullOutput[path.top] {
				if bounded, truncated := TruncateToolOutput(clean); truncated {
					addPath(&coverage.TruncatedFields, path)
					clean = bounded
				}
				return clean
			}
			if len(clean) > contentStringLimit {
				addPath(&coverage.TruncatedFields, path)
				clean = truncateUTF8(clean, contentStringLimit)
			}
			return clean
		case map[string]any:
			if blob, found := embeddedBinary(typed); found {
				return binaryDescriptor(typed, blob)
			}
			out := make(map[string]any, len(typed))
			for key, child := range typed {
				childPath := boundedCoveragePath(path, key)
				switch strings.ToLower(key) {
				case "transcript_path", "transcriptpath", "sessionfile":
					addPath(&coverage.RemovedFields, childPath)
				case "api_key", "apikey", "api-key", "token", "access_token", "refresh_token", "secret", "password", "authorization":
					out[key] = "[REDACTED]"
				default:
					out[key] = visit(child, childPath)
				}
			}
			return out
		case []any:
			out := make([]any, len(typed))
			for index, child := range typed {
				out[index] = visit(child, boundedCoveragePath(path, "[]"))
			}
			return out
		default:
			return typed
		}
	}
	clean := visit(input, coveragePath{}).(map[string]any)
	if text, ok := clean["last_assistant_message"].(string); ok && text != "" {
		coverage.AssistantOutput = "hook_payload_only"
	}
	sort.Strings(coverage.TruncatedFields)
	sort.Strings(coverage.RemovedFields)
	return clean, coverage
}

func truncateUTF8(text string, limit int) string {
	text = text[:limit]
	for !utf8.ValidString(text) {
		text = text[:len(text)-1]
	}
	return text
}

type coveragePath struct {
	text    string
	omitted bool
	// key is the member name the value sits under, for binary detection.
	key string
	// top is the top-level member the value belongs to.
	top string
}

func boundedCoveragePath(parent coveragePath, key string) coveragePath {
	top := parent.top
	if parent.text == "" && !parent.omitted && top == "" {
		top = key
	}
	if parent.omitted {
		parent.key = key
		return parent
	}
	if parent.text != "" && key != "[]" {
		parent.text += "."
	}
	if key == "" {
		key = `[""]`
	}
	if len(parent.text)+len(key) > maxCoveragePathBytes {
		return coveragePath{omitted: true, key: key, top: top}
	}
	return coveragePath{text: parent.text + key, key: key, top: top}
}
