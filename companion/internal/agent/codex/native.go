// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

type leafEdit struct {
	path  []any
	value any
}

// ref replaces the leaf at path with a reference to the item it became.
func (r *lineReader) ref(path []any, item agent.ContentItem) {
	r.edits = append(r.edits, leafEdit{path: path, value: map[string]any{"backplane_content_ref": r.key(item.NativeRef, item.Part)}})
}

// partRef is ref for a diff: or file: part, whose key hashes the placed
// path only the core knows: it names the raw part (amendment 22).
func (r *lineReader) partRef(path []any, part string) {
	r.edits = append(r.edits, leafEdit{path: path, value: map[string]any{"backplane_content_ref": map[string]any{"part": part}}})
}

// digest replaces a leaf with its size and sha256, aliasing the item whose
// body it repeats when aliasOf names one.
func (r *lineReader) digest(path []any, value, aliasOf string) {
	r.edits = append(r.edits, leafEdit{path: path, value: digestLeaf([]byte(value), aliasOf)})
}

func digestLeaf(value []byte, aliasOf string) map[string]any {
	sum := sha256.Sum256(value)
	leaf := map[string]any{"bytes": len(value), "sha256": hex.EncodeToString(sum[:])}
	if aliasOf != "" {
		leaf["alias_of"] = aliasOf
	}
	return leaf
}

// digestFromRaw marks an edit that digests whatever string the leaf holds.
var digestFromRaw = &struct{}{}

// nativeRecord is the line itself with every leaf edited: what was
// declared, referenced; what repeats it or is harness context, digested.
func (r *lineReader) nativeRecord() (agent.ContentItem, bool) {
	if len(r.items) == 0 || r.nativeRef == "" {
		return agent.ContentItem{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(r.line.Bytes))
	decoder.UseNumber()
	var record any
	if decoder.Decode(&record) != nil {
		return agent.ContentItem{}, false
	}
	for _, edit := range r.edits {
		record = setLeaf(record, edit.path, edit.value)
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(record) != nil {
		return agent.ContentItem{}, false
	}
	text := strings.TrimSuffix(encoded.String(), "\n")
	return agent.ContentItem{NativeRef: r.nativeRef, Part: "native", Role: r.role, Channel: "native_record", MediaType: mediaJSON, Text: &text, TurnID: r.turn, CallID: r.callID, ParentCallID: r.parentCallID}, true
}

// setLeaf replaces the value at path, leaving the record as it is where
// the path does not lead.
func setLeaf(node any, path []any, value any) any {
	if len(path) == 0 {
		if value == digestFromRaw {
			text, _ := node.(string)
			if node == nil {
				return nil
			}
			return digestLeaf([]byte(text), "")
		}
		return value
	}
	switch step := path[0].(type) {
	case string:
		if object, ok := node.(map[string]any); ok {
			if child, present := object[step]; present {
				object[step] = setLeaf(child, path[1:], value)
			}
		}
	case int:
		if array, ok := node.([]any); ok && step < len(array) {
			array[step] = setLeaf(array[step], path[1:], value)
		}
	}
	return node
}
