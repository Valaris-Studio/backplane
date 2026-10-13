// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package mcplaunch

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
)

// defaultProtocolVersion answers a client that names none.
const defaultProtocolVersion = "2025-06-18"

const methodNotFound = -32601

var unavailableReasons = map[string]string{
	ReasonNotConnected: "Backplane is not available here: Backplane Companion on this computer is not connected. " +
		"Open Backplane Companion and connect it, then start a new agent session.",
	ReasonNoMapping: "Backplane is not set up for this folder. In Backplane Companion, open Projects, bind this folder to a board " +
		"and turn on \"Let your agents work on this board\", then start a new agent session from inside the folder.",
	ReasonKeyMissing: "Backplane is not available here: this computer has no agent key. In Backplane Companion, turn " +
		"\"Let your agents work on this board\" off and on again, then start a new agent session.",
	ReasonStateUnreadable: "Backplane is not available here: this computer's local agent-access state is unreadable. " +
		"Open Backplane Companion to repair it, then start a new agent session.",
	ReasonUvxMissing: "Backplane is not available here: it needs uv (the uvx command), which was not found. " +
		"Install uv from https://docs.astral.sh/uv/ and start a new agent session.",
}

// ServeStub is a minimal MCP server with no tools whose instructions say why
// Backplane is unavailable and how to fix it. It returns at end of input.
func ServeStub(in io.Reader, out io.Writer, reason, version string) error {
	reader := bufio.NewReader(in)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if response, ok := stubResponse(line, reason, version); ok {
				if _, writeErr := out.Write(append(response, '\n')); writeErr != nil {
					return writeErr
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func stubResponse(line []byte, reason, version string) ([]byte, bool) {
	var request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			ProtocolVersion string `json:"protocolVersion"`
		} `json:"params"`
	}
	if json.Unmarshal(line, &request) != nil {
		return nil, false
	}
	if _, isRequest := compactID(request.ID); !isRequest {
		return nil, false
	}
	response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
	switch request.Method {
	case "initialize":
		protocol := request.Params.ProtocolVersion
		if protocol == "" {
			protocol = defaultProtocolVersion
		}
		response["result"] = map[string]any{
			"protocolVersion": protocol,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "backplane-companion", "version": version},
			"instructions":    unavailableReasons[reason],
		}
	case "tools/list":
		response["result"] = map[string]any{"tools": []any{}}
	case "ping":
		response["result"] = map[string]any{}
	default:
		response["error"] = map[string]any{"code": methodNotFound, "message": "Backplane is not available here"}
	}
	return encode(response), true
}
