// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import "regexp"

// editTools says where an agent's tool calls name the tool and hold its
// arguments, which arguments of its editing tools carry the text an edit
// writes, and which hold a shell command whose file content standard
// withholds (see WithholdCommandContent).
type editTools struct {
	toolMember, argumentsMember string
	// contentArguments lists, per editing tool, the argument members that
	// carry file content. A tool listed with none takes freeform arguments
	// that are all content: Codex's apply_patch arguments are the patch.
	contentArguments map[string][]string
	// commandArguments lists, per tool, the argument members that hold a
	// shell command.
	commandArguments map[string][]string
	// commandsInEveryTool marks an agent any of whose tools' arguments can
	// hold a command: Codex's exec JavaScript, exec_command and shell.
	commandsInEveryTool bool
	// eventMember and eventCommands locate a command a payload carries
	// outside any tool call, such as Pi's user_bash.
	eventMember   string
	eventCommands map[string][]string
}

var codexEdits = editTools{toolMember: "tool_name", argumentsMember: "arguments", contentArguments: map[string][]string{"apply_patch": nil}, commandsInEveryTool: true}

// editContent is the one table of edit content by agent. The text an edit
// writes is the file diff, and the file a command writes is file content;
// the standard level keeps both on the device, so they are digested before
// Beacon sees them and before any event is sent. Claude's editing tools need
// no row: Beacon copies none of their arguments into its events and derives
// only file.diff from them, which ApplyEventContentLevel digests.
var editContent = map[string]editTools{
	"claude_code": {toolMember: "tool_name", argumentsMember: "tool_input", commandArguments: map[string][]string{"Bash": {"command"}}},
	// Pi's edit takes edits[].oldText/newText, or the legacy top-level pair.
	"pi_cli": {
		toolMember: "toolName", argumentsMember: "input",
		contentArguments: map[string][]string{"edit": {"oldText", "newText", "edits"}, "write": {"content"}},
		commandArguments: map[string][]string{"bash": {"command"}},
		eventMember:      "type", eventCommands: map[string][]string{"user_bash": {"command"}},
	},
	"codex_cli":     codexEdits,
	"codex_desktop": codexEdits,
}

// ReduceEditContent applies the standard level's edit rules to a hook payload
// or OTLP attribute set of agent: an editing tool's content arguments are
// digested, and a command keeps everything but the file content it carries.
// It is idempotent.
func ReduceEditContent(call map[string]any, agent string, level ContentLevel) map[string]any {
	tools, known := editContent[agent]
	if level != Standard || !known {
		return call
	}
	out := make(map[string]any, len(call))
	for key, value := range call {
		out[key] = value
	}
	if event, _ := call[tools.eventMember].(string); tools.eventMember != "" {
		withholdCommandsAt(out, tools.eventCommands[event])
	}
	tool, _ := call[tools.toolMember].(string)
	arguments, present := call[tools.argumentsMember]
	if !present {
		return out
	}
	object, isObject := arguments.(map[string]any)
	contentArguments, isEdit := tools.contentArguments[tool]
	switch {
	case isEdit && (len(contentArguments) == 0 || !isObject):
		out[tools.argumentsMember] = digestStrings(arguments)
	case isEdit:
		reduced := copyObject(object)
		for _, name := range contentArguments {
			if value, present := reduced[name]; present {
				reduced[name] = digestStrings(value)
			}
		}
		out[tools.argumentsMember] = reduced
	case tools.commandsInEveryTool:
		out[tools.argumentsMember] = withholdCommandContentAny(arguments)
	case isObject && len(tools.commandArguments[tool]) > 0:
		reduced := copyObject(object)
		withholdCommandsAt(reduced, tools.commandArguments[tool])
		out[tools.argumentsMember] = reduced
	}
	return out
}

func copyObject(object map[string]any) map[string]any {
	out := make(map[string]any, len(object))
	for key, value := range object {
		out[key] = value
	}
	return out
}

func withholdCommandsAt(object map[string]any, members []string) {
	for _, member := range members {
		if value, present := object[member]; present {
			object[member] = withholdCommandContentAny(value)
		}
	}
}

func withholdCommandContentAny(value any) any {
	withheld, _ := withholdCommandContentIn(value)
	return withheld
}

// ReduceEditContentAttribute applies the standard level's edit rule to one
// OTLP attribute of agent's tool call, given the call's tool name.
func ReduceEditContentAttribute(agent, tool, attribute, value string) string {
	tools, known := editContent[agent]
	if !known || attribute != tools.argumentsMember {
		return value
	}
	if _, isEdit := tools.contentArguments[tool]; isEdit {
		return Digest(value)
	}
	if tools.commandsInEveryTool {
		return WithholdCommandContent(value)
	}
	return value
}

// withholdEventEditContent applies the edit rules wherever a normalized event
// of a known agent carries a tool's arguments or command: an editing tool's
// freeform arguments are digested, every command keeps all but its file
// content, and the raw copy of the native call is reduced as a payload is.
func withholdEventEditContent(event map[string]any) map[string]any {
	harness, _ := event["harness"].(map[string]any)
	agent, _ := harness["name"].(string)
	tools, known := editContent[agent]
	if !known {
		return event
	}
	tool, _ := event["tool"].(map[string]any)
	name, _ := tool["name"].(string)
	if contentArguments, isEdit := tools.contentArguments[name]; isEdit && len(contentArguments) == 0 {
		event = digestPaths(event, "", toolArgumentPaths).(map[string]any)
	} else {
		event = transformPaths(event, "", toolArgumentPaths, withholdCommandContentAny).(map[string]any)
	}
	if raw, ok := event["raw"].(map[string]any); ok {
		reduced := make(map[string]any, len(raw))
		for key, value := range raw {
			if native, isObject := value.(map[string]any); isObject {
				value = ReduceEditContent(native, agent, Standard)
			}
			reduced[key] = value
		}
		event["raw"] = reduced
	}
	return event
}

// toolArgumentPaths are where Beacon lifts a tool's arguments or command.
var toolArgumentPaths = map[string]bool{"gen_ai.tool.call.arguments": true, "tool.command": true, "command.command": true}

// A real apply_patch envelope opens with a file operation on the line after
// its begin marker. That newline may be raw or escaped (once in a JavaScript
// string, twice when that string sits in JSON), the header may be indented,
// and the markers are matched in any case. A bare mention of the markers,
// such as a grep for them, is not a patch. The backend ingest uses the same
// detector; testdata/patch_envelopes.json holds the cases both must pass.
const patchStart = `(?i)\*\*\* Begin Patch[ \t]*(?:\\+r)?(?:\\+n|\r?\n)(?:[ \t]|\\+t)*\*\*\* (?:Add File|Update File|Delete File|Move to):`

var (
	patchEnvelope = regexp.MustCompile(`(?s)` + patchStart + `.*?\*\*\* End Patch`)
	// One cut short before its end marker runs to the end of the value.
	unterminatedPatch = regexp.MustCompile(`(?s)` + patchStart + `.*`)
)

// WithholdPatchEnvelopes digests every apply_patch envelope in text and keeps
// the rest. It is idempotent.
func WithholdPatchEnvelopes(text string) string {
	text = patchEnvelope.ReplaceAllStringFunc(text, Digest)
	return unterminatedPatch.ReplaceAllStringFunc(text, Digest)
}
