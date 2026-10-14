// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
)

const (
	maxBootstrapReadBytes = 4 << 20
	// Desktop's first hook follows the injected instruction by a few seconds.
	// A resumed older thread must not turn this startup read into history import.
	maxBootstrapAdmissionDelay = time.Minute
	// A hookless thread is first seen at its header's creation stamp, which
	// the header line's own timestamp follows by up to ~2 s in recorded
	// rollouts. A header written later than this is not the observed startup.
	maxBootstrapHeaderLag = 5 * time.Second
)

type bootstrapLine struct {
	Timestamp time.Time `json:"timestamp"`
	Type      string    `json:"type"`
	Payload   struct {
		ID, Cwd, Originator, Type, Role, Name string
		Output                                json.RawMessage `json:"output"`
	} `json:"payload"`
}

func (Codex) ReadInitialPrompt(read agent.InitialPromptRead) (agent.InitialPromptResult, error) {
	done := agent.InitialPromptResult{Done: true}
	file, _, ok := openRollout(read.Env, read.Transcript)
	if !ok {
		return done, nil
	}
	defer file.Close()
	reader := bufio.NewReader(io.LimitReader(file, maxBootstrapReadBytes))
	var created time.Time
	var consumed int
	for {
		line, err := reader.ReadBytes('\n')
		consumed += len(line)
		if consumed >= maxBootstrapReadBytes || len(line) > maxRolloutLineBytes {
			return done, nil
		}
		if err == io.EOF {
			return agent.InitialPromptResult{}, nil
		}
		if err != nil {
			return agent.InitialPromptResult{}, err
		}
		var entry bootstrapLine
		if json.Unmarshal(line, &entry) != nil {
			return done, nil
		}
		if created.IsZero() {
			cwd, valid := scope.CanonicalDir(entry.Payload.Cwd)
			if entry.Type != "session_meta" || entry.Payload.ID != read.SessionID || entry.Payload.Originator != "Codex Desktop" || !valid || cwd != read.Cwd || entry.Timestamp.IsZero() || entry.Timestamp.After(read.Now) || read.FirstSeen.IsZero() || read.FirstSeen.Sub(entry.Timestamp) > maxBootstrapAdmissionDelay || entry.Timestamp.Sub(read.FirstSeen) > maxBootstrapHeaderLag {
				return done, nil
			}
			created = entry.Timestamp
			continue
		}
		if entry.Type != "response_item" {
			continue
		}
		payload := entry.Payload
		if payload.Type == "function_call_output" && payload.Name == "create_thread" {
			var output string
			if json.Unmarshal(payload.Output, &output) != nil {
				return done, nil
			}
			prompt, ok := delegatedPrompt(output, read.SessionID)
			if !ok || entry.Timestamp.Before(created) || entry.Timestamp.After(read.Now) || read.Allowed == nil || !read.Allowed(entry.Timestamp) {
				return done, nil
			}
			sum := sha256.Sum256([]byte("codex_initial_prompt\x00" + read.SessionID))
			event, err := json.Marshal(map[string]any{
				"schema_version": "1.0", "timestamp": entry.Timestamp.UTC().Format(time.RFC3339Nano),
				"event":   map[string]any{"id": hex.EncodeToString(sum[:]), "action": "prompt.submitted", "category": "interaction", "fidelity": "observed"},
				"harness": map[string]any{"name": DesktopID, "collection_method": string(agent.IngressPoll)},
				"session": map[string]any{"id": read.SessionID, "working_directory": read.Cwd},
				"prompt":  map[string]any{"text": prompt},
				"raw":     map[string]any{"source": "codex_create_thread"},
			})
			return agent.InitialPromptResult{Event: event, Harness: DesktopID, ObservedAt: entry.Timestamp, Done: true}, err
		}
		if payload.Role == "assistant" || payload.Type == "function_call" || payload.Type == "custom_tool_call" || payload.Type == "function_call_output" || payload.Type == "custom_tool_call_output" {
			return done, nil
		}
	}
}

func delegatedPrompt(output, sessionID string) (string, bool) {
	body, ok := strings.CutPrefix(strings.TrimSpace(output), "<codex_delegation>")
	if !ok {
		return "", false
	}
	body, ok = strings.CutSuffix(strings.TrimSpace(body), "</codex_delegation>")
	if !ok {
		return "", false
	}
	body, ok = strings.CutPrefix(strings.TrimSpace(body), "<source_thread_id>")
	if !ok {
		return "", false
	}
	parent, body, ok := strings.Cut(body, "</source_thread_id>")
	if !ok || !nativeID.MatchString(parent) || parent == sessionID {
		return "", false
	}
	body, ok = strings.CutPrefix(strings.TrimSpace(body), "<input>")
	if !ok {
		return "", false
	}
	// The instruction can itself contain XML-like examples; remove only the
	// outer suffix instead of interpreting the instruction as XML.
	body, ok = strings.CutSuffix(strings.TrimRight(body, "\r\n\t "), "</input>")
	return body, ok && strings.TrimSpace(body) != ""
}
