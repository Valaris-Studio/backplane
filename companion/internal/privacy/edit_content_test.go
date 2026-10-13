// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func piToolCall(tool string, input map[string]any) map[string]any {
	return map[string]any{"type": "tool_call", "sessionId": "s1", "toolCallId": "c1", "toolName": tool, "input": input}
}

func encodedText(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestReduceEditContent_StandardDigestsPiEditAndWriteContent(t *testing.T) {
	for _, payload := range []map[string]any{
		piToolCall("edit", map[string]any{"path": "src/app.py", "oldText": "EDIT_OLD", "newText": "EDIT_NEW"}),
		piToolCall("edit", map[string]any{"path": "src/app.py", "edits": []any{map[string]any{"oldText": "EDIT_OLD", "newText": "EDIT_NEW"}}}),
		piToolCall("write", map[string]any{"path": "src/app.py", "content": "EDIT_NEW"}),
	} {
		reduced := encodedText(ReduceEditContent(payload, "pi_cli", Standard))
		if strings.Contains(reduced, "EDIT_OLD") || strings.Contains(reduced, "EDIT_NEW") {
			t.Fatalf("standard sent an edit's content: %s", reduced)
		}
		if !strings.Contains(reduced, `"path":"src/app.py"`) || !strings.Contains(reduced, `"toolName":"`+payload["toolName"].(string)+`"`) {
			t.Fatalf("withholding an edit must keep what Beacon describes it by: %s", reduced)
		}
	}
}

func TestReduceEditContent_OtherToolsAndLevelsUnchanged(t *testing.T) {
	bash := piToolCall("bash", map[string]any{"command": "make test", "content": "NOT_AN_EDIT"})
	if reduced := encodedText(ReduceEditContent(bash, "pi_cli", Standard)); !strings.Contains(reduced, "NOT_AN_EDIT") {
		t.Fatalf("a tool that edits nothing keeps its arguments: %s", reduced)
	}
	edit := piToolCall("edit", map[string]any{"path": "a.py", "newText": "EDIT_NEW"})
	if reduced := encodedText(ReduceEditContent(edit, "pi_cli", Full)); !strings.Contains(reduced, "EDIT_NEW") {
		t.Fatalf("full keeps an edit's content: %s", reduced)
	}
	if reduced := encodedText(ReduceEditContent(edit, "claude_code", Standard)); !strings.Contains(reduced, "EDIT_NEW") {
		t.Fatalf("another agent's payload is not read as Pi's: %s", reduced)
	}
}

func TestReduceEditContent_Idempotent(t *testing.T) {
	once := ReduceEditContent(piToolCall("edit", map[string]any{"path": "a.py", "newText": "EDIT_NEW"}), "pi_cli", Standard)
	if twice := ReduceEditContent(once, "pi_cli", Standard); encodedText(twice) != encodedText(once) {
		t.Fatalf("a second pass changed %s into %s", encodedText(once), encodedText(twice))
	}
}

func codexToolEvent(tool, arguments string) map[string]any {
	return map[string]any{
		"event":   map[string]any{"action": "tool.invoked"},
		"harness": map[string]any{"name": "codex_cli"},
		"gen_ai":  map[string]any{"tool": map[string]any{"name": tool, "call": map[string]any{"id": "call_2", "arguments": arguments}}},
		"tool":    map[string]any{"name": tool, "command": arguments},
		"raw":     map[string]any{"attributes": map[string]any{"tool_name": tool, "arguments": arguments}},
	}
}

func TestApplyEventContentLevel_StandardWithholdsCodexPatchContent(t *testing.T) {
	patch := "*** Begin Patch\n*** Update File: a.py\n+PATCH_CONTENT\n*** End Patch"
	reduced := encodedText(ApplyEventContentLevel(codexToolEvent("apply_patch", patch), Standard))
	if strings.Contains(reduced, "PATCH_CONTENT") || !strings.Contains(reduced, `"name":"apply_patch"`) {
		t.Fatalf("standard must describe a patch and keep its content: %s", reduced)
	}
	if full := encodedText(ApplyEventContentLevel(codexToolEvent("apply_patch", patch), Full)); !strings.Contains(full, "PATCH_CONTENT") {
		t.Fatalf("full sends a patch: %s", full)
	}
	command := encodedText(ApplyEventContentLevel(codexToolEvent("exec_command", `{"cmd":"make test"}`), Standard))
	if !strings.Contains(command, "make test") {
		t.Fatalf("standard sends commands: %s", command)
	}
}

func TestApplyEventContentLevel_StandardWithholdsPiEditContentInRaw(t *testing.T) {
	event := map[string]any{
		"event":   map[string]any{"action": "file.modified"},
		"harness": map[string]any{"name": "pi_cli"},
		"tool":    map[string]any{"name": "edit", "path": "a.py"},
		"raw":     map[string]any{"pi": piToolCall("edit", map[string]any{"path": "a.py", "oldText": "EDIT_OLD", "newText": "EDIT_NEW"})},
	}
	reduced := encodedText(ApplyEventContentLevel(event, Standard))
	if strings.Contains(reduced, "EDIT_OLD") || strings.Contains(reduced, "EDIT_NEW") || !strings.Contains(reduced, `"path":"a.py"`) {
		t.Fatalf("standard must keep a Pi edit's content on the device: %s", reduced)
	}
}

// codexExecPatchArguments is the exec tool's JavaScript as codex-cli 0.159.0
// sent it in a live run: the patch inside a JS string, newlines escaped.
const codexExecPatchArguments = `text(await tools.apply_patch("*** Begin Patch\n*** Update File: cli/existing.txt\n@@\n+MARK-EDIT\n*** Add File: cli/new.txt\n+MARK-NEW\n*** End Patch"));`

// editContentVectors is shared with the backend ingest's tests, so the two
// detectors cannot drift apart.
const editContentVectors = "testdata/edit_content_vectors.json"

func TestWithholdCommandContent_SharedVectors(t *testing.T) {
	data, err := os.ReadFile(editContentVectors)
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			Name     string   `json:"name"`
			Input    string   `json:"input"`
			Withheld bool     `json:"withheld"`
			Kept     []string `json:"kept"`
			Gone     []string `json:"gone"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			withheld := WithholdCommandContent(vector.Input)
			if !vector.Withheld {
				if withheld != vector.Input {
					t.Fatalf("carries no file content, but %q became %q", vector.Input, withheld)
				}
				return
			}
			if !strings.Contains(withheld, omittedPrefix) {
				t.Fatalf("file content was sent: %q", withheld)
			}
			for _, text := range vector.Gone {
				if strings.Contains(withheld, text) {
					t.Errorf("%q still carries %q", withheld, text)
				}
			}
			for _, text := range vector.Kept {
				if !strings.Contains(withheld, text) {
					t.Errorf("%q lost part of the command, %q", withheld, text)
				}
			}
			if again := WithholdCommandContent(withheld); again != withheld {
				t.Errorf("a second pass changed %q into %q", withheld, again)
			}
		})
	}
}

func TestReduceEditContent_StandardWithholdsPatchesInsideCodexWrappers(t *testing.T) {
	for _, tool := range []string{"exec", "exec_command", "shell"} {
		call := map[string]any{"tool_name": tool, "tool_namespace": "functions", "arguments": codexExecPatchArguments}
		reduced := encodedText(ReduceEditContent(call, "codex_cli", Standard))
		if strings.Contains(reduced, "MARK-") || !strings.Contains(reduced, "tools.apply_patch(") {
			t.Errorf("%s: standard must keep the wrapper and withhold its patch: %s", tool, reduced)
		}
		if full := encodedText(ReduceEditContent(call, "codex_cli", Full)); !strings.Contains(full, "MARK-EDIT") {
			t.Errorf("%s: full sends the patch: %s", tool, full)
		}
	}
	plain := map[string]any{"tool_name": "exec_command", "arguments": `{"cmd":"make test"}`}
	if reduced := encodedText(ReduceEditContent(plain, "codex_cli", Standard)); !strings.Contains(reduced, "make test") {
		t.Fatalf("standard sends commands: %s", reduced)
	}
	pi := piToolCall("bash", map[string]any{"command": "*** Begin Patch\n*** Add File: a\n+MARK-NEW\n*** End Patch"})
	if reduced := encodedText(ReduceEditContent(pi, "pi_cli", Standard)); strings.Contains(reduced, "MARK-NEW") {
		t.Fatalf("a patch in Pi's bash command is file content too: %s", reduced)
	}
}

func TestApplyEventContentLevel_StandardWithholdsPatchesInsideCodexExec(t *testing.T) {
	event := codexToolEvent("exec", codexExecPatchArguments)
	event["prompt"] = map[string]any{"text": "please apply *** Begin Patch\n*** Add File: p\n+PROMPT-KEPT\n*** End Patch"}
	reduced := encodedText(ApplyEventContentLevel(event, Standard))
	if strings.Contains(reduced, "MARK-") || !strings.Contains(reduced, "tools.apply_patch(") || !strings.Contains(reduced, `"name":"exec"`) {
		t.Fatalf("standard must describe the exec and withhold its patch: %s", reduced)
	}
	if !strings.Contains(reduced, "PROMPT-KEPT") {
		t.Fatalf("standard sends prompts, a pasted patch included: %s", reduced)
	}
	if full := encodedText(ApplyEventContentLevel(codexToolEvent("exec", codexExecPatchArguments), Full)); !strings.Contains(full, "MARK-NEW") {
		t.Fatalf("full sends the patch: %s", full)
	}
}

const heredocWrite = "mkdir -p src && cat > src/app.py <<'EOF'\nprint('FILE-CONTENT')\nEOF"

func TestReduceEditContent_StandardWithholdsFileContentInEveryAgentsCommands(t *testing.T) {
	for _, call := range []struct {
		agent   string
		payload map[string]any
	}{
		{"claude_code", map[string]any{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": map[string]any{"command": heredocWrite, "description": "write app"}}},
		{"pi_cli", piToolCall("bash", map[string]any{"command": heredocWrite})},
		{"pi_cli", map[string]any{"type": "user_bash", "sessionId": "s1", "command": heredocWrite}},
		{"codex_cli", map[string]any{"tool_name": "exec_command", "arguments": `{"cmd":` + encodeJSON(heredocWrite) + `}`}},
	} {
		reduced := encodeJSON(ReduceEditContent(call.payload, call.agent, Standard))
		if strings.Contains(reduced, "FILE-CONTENT") || !strings.Contains(reduced, "cat > src/app.py") {
			t.Errorf("%s: standard keeps the command and withholds what it writes: %s", call.agent, reduced)
		}
		if full := encodeJSON(ReduceEditContent(call.payload, call.agent, Full)); !strings.Contains(full, "FILE-CONTENT") {
			t.Errorf("%s: full sends what a command writes: %s", call.agent, full)
		}
	}
}

func TestReduceEditContent_StandardKeepsCommandsThatWriteNoFile(t *testing.T) {
	for _, command := range []string{"psql <<'SQL'\nSELECT 'KEPT';\nSQL", "git commit -F - <<'EOF'\nfix: KEPT\nEOF", "make test"} {
		call := map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": command}}
		if reduced := ReduceEditContent(call, "claude_code", Standard); encodeJSON(reduced) != encodeJSON(call) {
			t.Errorf("%q changed: %s", command, encodeJSON(reduced))
		}
	}
	other := map[string]any{"tool_name": "Write", "tool_input": map[string]any{"content": heredocWrite}}
	if reduced := encodeJSON(ReduceEditContent(other, "claude_code", Standard)); !strings.Contains(reduced, "FILE-CONTENT") {
		t.Fatalf("only Claude's Bash arguments are read as a command: %s", reduced)
	}
}

func TestApplyEventContentLevel_StandardWithholdsFileContentInCommands(t *testing.T) {
	for _, event := range []map[string]any{
		{"harness": map[string]any{"name": "claude_code"}, "tool": map[string]any{"name": "Bash", "command": heredocWrite}, "command": map[string]any{"command": heredocWrite}},
		{"harness": map[string]any{"name": "pi_cli"}, "tool": map[string]any{"name": "bash", "command": heredocWrite}, "command": map[string]any{"command": heredocWrite},
			"raw": map[string]any{"pi": piToolCall("bash", map[string]any{"command": heredocWrite})}},
		{"harness": map[string]any{"name": "pi_cli"}, "tool": map[string]any{"name": "bash", "command": heredocWrite},
			"raw": map[string]any{"pi": map[string]any{"type": "user_bash", "command": heredocWrite}}},
	} {
		reduced := encodeJSON(ApplyEventContentLevel(event, Standard))
		if strings.Contains(reduced, "FILE-CONTENT") || !strings.Contains(reduced, "cat > src/app.py") {
			t.Errorf("standard keeps the command and withholds what it writes: %s", reduced)
		}
	}
}
