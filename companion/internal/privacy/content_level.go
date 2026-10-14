// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

type ContentLevel string

const (
	Metadata ContentLevel = "metadata"
	Standard ContentLevel = "standard"
	Full     ContentLevel = "full"
	// Rich is full plus the session's content bodies, uncut, read from the
	// agent's own session files and uploaded beside the events.
	Rich ContentLevel = "rich"
)

var ErrUnknownContentLevel = errors.New("unknown_content_level")

func ParseContentLevel(value string) (ContentLevel, error) {
	switch ContentLevel(value) {
	case "":
		return Standard, nil
	case Metadata, Standard, Full, Rich:
		return ContentLevel(value), nil
	}
	return "", ErrUnknownContentLevel
}

// EventLevel is the level a mapping's events are reduced to. A rich
// mapping's events are exactly full events: what rich adds travels as
// content items, never inside an event.
func EventLevel(level ContentLevel) ContentLevel {
	if level == Rich {
		return Full
	}
	return level
}

// contentMembers carry what a person or tool said or did, as opposed to the
// identities, names, timings and counts that describe the activity.
var contentMembers = map[string]bool{
	"prompt": true, "message": true, "last_assistant_message": true, "error": true,
	"tool_input": true, "tool_response": true, "tool_output": true, "output": true,
	"input": true, "content": true, "text": true, "diff": true, "patch": true,
	"command": true, "details": true, "code": true, "result": true,
	"images": true, "data": true,
}

// messageStructure are the members of a Pi message (and its content parts)
// that describe its shape rather than what was said; Beacon maps only
// assistant messages and needs them. Nowhere else is anything exempt.
var messageStructure = map[string]bool{
	"role": true, "type": true, "model": true, "responsemodel": true, "provider": true,
}

const omittedPrefix = "[omitted "

// ApplyContentLevel returns payload reduced to level. Metadata replaces every
// string inside content members with its size and a short hash, keeping the
// member shape so normalizers still recognize the event; Standard does the
// same to the agent's replies only. It is idempotent.
func ApplyContentLevel(payload map[string]any, level ContentLevel) map[string]any {
	switch level {
	case Metadata:
		return digestContent(payload)
	case Standard:
		return withholdReplies(payload).(map[string]any)
	}
	return payload
}

func digestContent(payload map[string]any) map[string]any {
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		message, isMessage := value.(map[string]any)
		switch {
		case strings.ToLower(key) == "message" && isMessage:
			out[key] = digestMessage(message)
		case contentMembers[strings.ToLower(key)]:
			out[key] = digestStrings(value)
		default:
			out[key] = value
		}
	}
	return out
}

// withholdReplies digests what the model said, wherever it sits: a hook's
// last assistant message and an assistant message (a Pi payload, or the raw
// copy Beacon keeps of it).
func withholdReplies(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			message, isMessage := child.(map[string]any)
			switch {
			case strings.ToLower(key) == "last_assistant_message":
				out[key] = digestStrings(child)
			case strings.ToLower(key) == "message" && isMessage && message["role"] == "assistant":
				out[key] = digestMessage(message)
			default:
				out[key] = withholdReplies(child)
			}
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = withholdReplies(child)
		}
		return out
	}
	return value
}

func digestMessage(message map[string]any) map[string]any {
	out := make(map[string]any, len(message))
	for key, value := range message {
		switch parts, isList := value.([]any); {
		case strings.ToLower(key) == "content" && isList:
			digested := make([]any, len(parts))
			for index, part := range parts {
				if object, ok := part.(map[string]any); ok {
					digested[index] = keepStructure(object)
				} else {
					digested[index] = digestStrings(part)
				}
			}
			out[key] = digested
		default:
			out[key] = keepOrDigest(key, value)
		}
	}
	return out
}

func keepStructure(object map[string]any) map[string]any {
	out := make(map[string]any, len(object))
	for key, value := range object {
		out[key] = keepOrDigest(key, value)
	}
	return out
}

func keepOrDigest(key string, value any) any {
	if _, isText := value.(string); isText && messageStructure[strings.ToLower(key)] {
		return value
	}
	return digestStrings(value)
}

func digestStrings(value any) any {
	switch typed := value.(type) {
	case string:
		if strings.HasPrefix(typed, omittedPrefix) {
			return typed
		}
		return digestText(typed)
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			out[key] = digestStrings(child)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = digestStrings(child)
		}
		return out
	default:
		return typed
	}
}

func digestText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%s%d bytes sha256:%s]", omittedPrefix, len(text), hex.EncodeToString(sum[:8]))
}

// Digest replaces text with its size and a short hash, as the metadata
// content level does for every content string.
func Digest(text string) string { return digestStrings(text).(string) }
