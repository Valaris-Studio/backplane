// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

const (
	contentKind          = "claude_transcript"
	contentParserVersion = "companion-claude-transcript/1"
	// longLeafBytes: a toolUseResult string this long is a copy of what the
	// record declares elsewhere; the native record keeps its digest.
	longLeafBytes = 1 << 10
)

var errNotARecord = errors.New("claudecode: not a transcript record")

// harnessContext are the attachments that carry the harness's own context
// (system prompt, catalogs, environment, account): declared withheld, kept
// in the native record only as sizes and digests.
var harnessContext = map[string]bool{
	"prompt_snapshot": true, "skill_listing": true, "agent_listing_delta": true,
	"deferred_tools_delta": true, "deferred_tools_record": true, "environment": true,
	"credential_org": true, "session_context": true, "remote_session_change": true,
}

// markers open user records the harness writes, not the user: local
// commands, their output, interruptions.
var markers = []string{"<command-", "<local-command", "[Request interrupted by user"}

// ContentFile names the transcript every hook carries, or the subagent's
// own transcript beside it for a hook fired inside a subagent and for the
// Agent call's completion.
func (ClaudeCode) ContentFile(event string, payload map[string]any) (string, bool) {
	session, _ := payload["session_id"].(string)
	transcript, _ := payload["transcript_path"].(string)
	if !nativeID.MatchString(session) || !filepath.IsAbs(transcript) || filepath.Base(transcript) != session+".jsonl" {
		return "", false
	}
	transcript = filepath.Clean(transcript)
	agentID, _ := payload["agent_id"].(string)
	if agentID == "" && event == "PostToolUse" && payload["tool_name"] == "Agent" {
		response, _ := payload["tool_response"].(map[string]any)
		agentID, _ = response["agentId"].(string)
	}
	// ':' would name an NTFS alternate data stream, not a file.
	if agentID == "" || !nativeID.MatchString(agentID) || strings.ContainsRune(agentID, ':') {
		return transcript, true
	}
	return filepath.Join(filepath.Dir(transcript), session, "subagents", "agent-"+agentID+".jsonl"), true
}

func (ClaudeCode) ContentParser() agent.ContentParser { return transcriptParser{} }

// ContentRoots: Claude keeps every transcript, subagents' included, under
// <config dir>/projects.
func (ClaudeCode) ContentRoots(env agent.Env) []string {
	return []string{filepath.Join(configDir(env), "projects")}
}

type transcriptParser struct{}

func (transcriptParser) Kind() string    { return contentKind }
func (transcriptParser) Version() string { return contentParserVersion }

// Header states when a subagent's own transcript began: its first record is
// the subagent's prompt. A main transcript has no header; its first record
// may be a fork's copy of another session's, so its first hook bounds it.
func (transcriptParser) Header(firstLine []byte) (agent.ContentHeader, bool) {
	var first struct {
		ParentUUID  *string   `json:"parentUuid"`
		IsSidechain bool      `json:"isSidechain"`
		AgentID     string    `json:"agentId"`
		Timestamp   time.Time `json:"timestamp"`
	}
	if json.Unmarshal(firstLine, &first) != nil || !first.IsSidechain || first.AgentID == "" || first.ParentUUID != nil || first.Timestamp.IsZero() {
		return agent.ContentHeader{}, false
	}
	return agent.ContentHeader{Began: first.Timestamp}, true
}

// parserState is what a record needs from the ones before it.
type parserState struct {
	// Turn is the promptId of the latest user record; assistant blocks carry
	// none and belong to it.
	Turn string `json:"turn,omitempty"`
	// Compacted: since the last compaction no prompt came, so an attached
	// file is the harness re-attaching what was said before.
	Compacted bool `json:"compacted,omitempty"`
	// ParentCall is a subagent's Agent call, from its sidecar, read once.
	ParentCall  string `json:"parent_call,omitempty"`
	SidecarRead bool   `json:"sidecar_read,omitempty"`
}

func (transcriptParser) Parse(line agent.ContentLine, raw json.RawMessage) (agent.ContentRecord, json.RawMessage, error) {
	var state parserState
	if len(raw) > 0 && json.Unmarshal(raw, &state) != nil {
		state = parserState{}
	}
	record, err := decodeRecord(line.Bytes)
	if err != nil {
		// The state stays as it was: the daemon keeps what a failed parse
		// returns.
		return agent.ContentRecord{}, raw, err
	}
	reader := recordReader{line: line, state: &state, record: record}
	reader.readSidecar()
	parsed := reader.read()
	next, err := json.Marshal(state)
	if err != nil {
		return agent.ContentRecord{}, raw, err
	}
	return parsed, next, nil
}

func decodeRecord(line []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	var record map[string]any
	if err := decoder.Decode(&record); err != nil {
		return nil, err
	}
	if record == nil || decoder.More() {
		return nil, errNotARecord
	}
	if _, typed := record["type"].(string); !typed {
		return nil, errNotARecord
	}
	return record, nil
}

type recordReader struct {
	line   agent.ContentLine
	state  *parserState
	record map[string]any
	uuid   string
	parsed agent.ContentRecord
}

// sessionDir is <transcript dir>/<sessionId>, where Claude keeps a
// session's tool-results and subagents, derived from the file read and
// never from a path a record names.
func (r *recordReader) sessionDir() string {
	path := r.line.Path
	if path == "" {
		return ""
	}
	if isSubagentTranscript(path) {
		return filepath.Dir(filepath.Dir(path))
	}
	return filepath.Join(filepath.Dir(path), strings.TrimSuffix(filepath.Base(path), ".jsonl"))
}

func isSubagentTranscript(path string) bool {
	return filepath.Base(filepath.Dir(path)) == "subagents" && strings.HasPrefix(filepath.Base(path), "agent-")
}

// readSidecar takes a subagent's Agent call from its meta.json once per
// file; an unusable sidecar leaves the relation unknown.
func (r *recordReader) readSidecar() {
	if r.state.SidecarRead || r.line.Path == "" || !isSubagentTranscript(r.line.Path) {
		return
	}
	r.state.SidecarRead = true
	data, ok := agent.ReadSessionSidecar(strings.TrimSuffix(r.line.Path, ".jsonl")+".meta.json", r.sessionDir())
	if !ok {
		return
	}
	var meta struct {
		ToolUseID string `json:"toolUseId"`
	}
	if json.Unmarshal(data, &meta) == nil && nativeID.MatchString(meta.ToolUseID) {
		r.state.ParentCall = meta.ToolUseID
	}
}

func (r *recordReader) read() agent.ContentRecord {
	r.uuid, _ = r.record["uuid"].(string)
	at, _ := time.Parse(time.RFC3339Nano, stringAt(r.record, "timestamp"))
	r.parsed = agent.ContentRecord{At: at, SchemaVersion: "claude-code/unknown"}
	if version, ok := r.record["version"].(string); ok && version != "" {
		r.parsed.SchemaVersion = "claude-code/" + version
	}
	if promptID, ok := r.record["promptId"].(string); ok && promptID != "" && r.record["type"] == "user" {
		r.state.Turn = promptID
	}
	role := ""
	switch r.record["type"] {
	case "user":
		role = r.readUser()
	case "assistant":
		role = "assistant"
		r.readAssistant()
	case "attachment":
		role = r.readAttachment()
	case "system":
		if r.record["subtype"] == "compact_boundary" {
			r.state.Compacted = true
		}
	}
	if len(r.parsed.Items) == 0 || r.uuid == "" {
		return agent.ContentRecord{}
	}
	if rendered, ok := r.record["rendered"]; ok {
		r.record["rendered"] = digestLeaves(rendered)
	}
	native := encodeJSON(r.record)
	r.parsed.Items = append(r.parsed.Items, agent.ContentItem{NativeRef: r.uuid, Part: "native", Role: role, Channel: "native_record", MediaType: "application/json", Text: &native})
	return r.parsed
}

// add declares an item of the record and returns its key.
func (r *recordReader) add(item agent.ContentItem) string {
	if item.TurnID == "" {
		item.TurnID = r.state.Turn
	}
	item.ParentCallID = r.state.ParentCall
	r.parsed.Items = append(r.parsed.Items, item)
	return r.key(item.NativeRef, item.Part)
}

func (r *recordReader) key(nativeRef, part string) string {
	return agent.ContentKey(r.line.Harness, r.line.NativeSessionID, nativeRef, part)
}

func (r *recordReader) readUser() string {
	if meta, _ := r.record["isMeta"].(bool); meta {
		return ""
	}
	message, _ := r.record["message"].(map[string]any)
	if summary, _ := r.record["isCompactSummary"].(bool); summary {
		// The summary restates what came before the compaction; so do the
		// files the harness re-attaches after it.
		r.state.Compacted = true
		if text, ok := message["content"].(string); ok && text != "" {
			key := r.add(agent.ContentItem{NativeRef: r.uuid, Part: "summary", Role: "system", Channel: "summary", MediaType: "text/markdown", Text: &text, RestatesContext: true})
			message["content"] = ref(key)
		}
		return "system"
	}
	switch content := message["content"].(type) {
	case string:
		if isMarker(content) || content == "" {
			return ""
		}
		r.state.Compacted = false
		key := r.add(agent.ContentItem{NativeRef: r.uuid, Part: "text:0", Role: "user", Channel: "prompt", MediaType: "text/plain", Text: &content})
		message["content"] = ref(key)
		return "user"
	case []any:
		role := "user"
		prompted := false
		for index, child := range content {
			block, _ := child.(map[string]any)
			switch block["type"] {
			case "text":
				text, _ := block["text"].(string)
				if text == "" || isMarker(text) {
					continue
				}
				key := r.add(agent.ContentItem{NativeRef: r.uuid, Part: "text:" + strconv.Itoa(index), Role: "user", Channel: "prompt", MediaType: "text/plain", Text: &text})
				block["text"] = ref(key)
				prompted = true
			case "image":
				r.image(index, block, "user", "")
				prompted = true
			case "tool_result":
				role = "tool"
				r.readToolResult(block)
			}
		}
		if prompted && role == "user" {
			r.state.Compacted = false
		}
		return role
	}
	return ""
}

func isMarker(text string) bool {
	for _, marker := range markers {
		if strings.HasPrefix(text, marker) {
			return true
		}
	}
	return false
}

// image declares an embedded base64 image block; the source is only ever
// the transcript's own bytes.
func (r *recordReader) image(index int, block map[string]any, role, callID string) string {
	source, _ := block["source"].(map[string]any)
	encoded, _ := source["data"].(string)
	data, err := base64.StdEncoding.DecodeString(encoded)
	if source["type"] != "base64" || err != nil || len(data) == 0 {
		return ""
	}
	mediaType, _ := source["media_type"].(string)
	key := r.add(agent.ContentItem{NativeRef: r.uuid, Part: "image:" + strconv.Itoa(index), Role: role, Channel: "attachment", MediaType: mediaType, CallID: callID, Data: data})
	source["data"] = ref(key)
	return key
}

func (r *recordReader) readToolResult(block map[string]any) {
	id, _ := block["tool_use_id"].(string)
	call := agent.NativeCallID(id)
	part, channel := "output", "tool_output"
	if failed, _ := block["is_error"].(bool); failed {
		part, channel = "error", "error"
	}
	output := agent.ContentItem{NativeRef: r.uuid, Part: part, Role: "tool", Channel: channel, MediaType: "text/plain", CallID: call}
	var texts []string
	var imageKey string
	setText := func(key string) {}
	switch content := block["content"].(type) {
	case string:
		texts = append(texts, content)
		setText = func(key string) { block["content"] = ref(key) }
	case []any:
		var textBlocks []map[string]any
		structured := false
		for index, child := range content {
			inner, _ := child.(map[string]any)
			switch inner["type"] {
			case "text":
				text, _ := inner["text"].(string)
				texts = append(texts, text)
				textBlocks = append(textBlocks, inner)
			case "image":
				if key := r.image(index, inner, "tool", call); key != "" {
					imageKey = key
				}
			default:
				structured = true
			}
		}
		setText = func(key string) {
			for _, inner := range textBlocks {
				inner["text"] = ref(key)
			}
		}
		// A result of other blocks only (ToolSearch's tool references) is
		// output as the blocks themselves.
		if structured && len(textBlocks) == 0 {
			texts = append(texts, encodeJSON(content))
			output.MediaType = "application/json"
			setText = func(key string) { block["content"] = ref(key) }
		}
	}
	result := r.record["toolUseResult"]
	outputKey := ""
	if len(texts) > 0 {
		text := strings.Join(texts, "\n")
		output.Text = &text
		r.persisted(&output, result, text)
		outputKey = r.add(output)
		setText(outputKey)
	}
	r.readToolUseResult(call, outputKey, imageKey)
}

// persisted points a result Claude moved to the session's tool-results
// store at that store; the record then keeps only a preview and a cut copy.
func (r *recordReader) persisted(output *agent.ContentItem, result any, modelVisible string) {
	details, _ := result.(map[string]any)
	path, _ := details["persistedOutputPath"].(string)
	if path == "" {
		return
	}
	output.SourceTruncated = true
	if size, err := strconv.ParseInt(numberAt(details, "persistedOutputSize"), 10, 64); err == nil {
		output.OriginalBytes = size
	}
	preview, found := persistedPreview(modelVisible)
	switch stdout, ok := details["stdout"].(string); {
	case ok && stdout != "":
		output.Text = &stdout
	case found:
		// Without a cut copy the record keeps only the preview.
		output.Text = &preview
	}
	sessionDir := r.sessionDir()
	if sessionDir == "" || !found {
		return
	}
	output.Store = &agent.BodyStore{Path: path, Kind: "harness_session_store", Within: filepath.Join(sessionDir, "tool-results"), Matches: func(body []byte) bool {
		return bytes.HasPrefix(body, []byte(preview))
	}}
}

// persistedPreview is the head of a persisted output inside the
// <persisted-output> wrapper; the harness may cut its last code point,
// which becomes U+FFFD and is not compared.
func persistedPreview(text string) (string, bool) {
	_, after, found := strings.Cut(text, "\nPreview (first ")
	if !found {
		return "", false
	}
	_, preview, found := strings.Cut(after, "):\n")
	if !found {
		return "", false
	}
	preview, _, found = strings.Cut(preview, "\n...\n</persisted-output>")
	preview = strings.TrimRight(preview, "�")
	return preview, found && preview != ""
}

// readToolUseResult declares the edit a result reports and turns the
// result's copies of declared bodies into aliases.
func (r *recordReader) readToolUseResult(call, outputKey, imageKey string) {
	inputKey := ""
	if source, ok := r.record["sourceToolAssistantUUID"].(string); ok && source != "" {
		inputKey = r.key(source, "input")
	}
	switch result := r.record["toolUseResult"].(type) {
	case string:
		if outputKey != "" {
			r.record["toolUseResult"] = alias(result, outputKey)
		}
	case map[string]any:
		if patch, ok := result["structuredPatch"].([]any); ok && len(patch) > 0 {
			if path, ok := result["filePath"].(string); ok && path != "" {
				diff := unifiedDiff(path, patch)
				part := "diff:" + path
				r.add(agent.ContentItem{NativeRef: r.uuid, Part: part, Role: "tool", Channel: "diff", MediaType: "text/x-diff", CallID: call, Text: &diff})
				result["structuredPatch"] = pathRef(part)
			}
		}
		if original, ok := result["originalFile"].(string); ok {
			result["originalFile"] = leafDigest(original)
		}
		for _, echo := range []string{"oldString", "newString", "prompt"} {
			if text, ok := result[echo].(string); ok && inputKey != "" {
				result[echo] = alias(text, inputKey)
			}
		}
		if result["type"] == "create" && inputKey != "" {
			if text, ok := result["content"].(string); ok {
				result["content"] = alias(text, inputKey)
			}
		}
		if text, ok := result["stdout"].(string); ok && text != "" && outputKey != "" {
			result["stdout"] = alias(text, outputKey)
		}
		// stderr is part of what the output holds, not a whole copy of it.
		if text, ok := result["stderr"].(string); ok && text != "" {
			result["stderr"] = leafDigest(text)
		}
		if file, ok := result["file"].(map[string]any); ok && imageKey != "" {
			if data, ok := file["base64"].(string); ok {
				file["base64"] = alias(data, imageKey)
			}
		}
		r.record["toolUseResult"] = digestLongLeaves(result)
	}
}

func unifiedDiff(path string, hunks []any) string {
	var diff strings.Builder
	fmt.Fprintf(&diff, "--- %s\n+++ %s\n", path, path)
	for _, child := range hunks {
		hunk, _ := child.(map[string]any)
		fmt.Fprintf(&diff, "@@ -%s,%s +%s,%s @@\n", numberAt(hunk, "oldStart"), numberAt(hunk, "oldLines"), numberAt(hunk, "newStart"), numberAt(hunk, "newLines"))
		lines, _ := hunk["lines"].([]any)
		for _, line := range lines {
			text, _ := line.(string)
			diff.WriteString(text + "\n")
		}
	}
	return diff.String()
}

func (r *recordReader) readAssistant() {
	message, _ := r.record["message"].(map[string]any)
	content, _ := message["content"].([]any)
	for index, child := range content {
		block, _ := child.(map[string]any)
		switch block["type"] {
		case "text":
			if text, ok := block["text"].(string); ok && text != "" {
				key := r.add(agent.ContentItem{NativeRef: r.uuid, Part: "text:" + strconv.Itoa(index), Role: "assistant", Channel: "reply", MediaType: "text/markdown", Text: &text})
				block["text"] = ref(key)
			}
		case "thinking", "redacted_thinking":
			if thinking, ok := block["thinking"].(string); ok && thinking != "" {
				key := r.add(agent.ContentItem{NativeRef: r.uuid, Part: "summary", Role: "assistant", Channel: "reasoning", MediaType: "text/markdown", Text: &thinking})
				block["thinking"] = ref(key)
			}
			for _, opaque := range []string{"signature", "data"} {
				if text, ok := block[opaque].(string); ok && text != "" {
					r.add(agent.ContentItem{NativeRef: r.uuid, Part: "raw", Role: "assistant", Channel: "reasoning", Coverage: "source_unavailable", CoverageReason: "encrypted_at_source"})
					block[opaque] = leafDigest(text)
					break
				}
			}
		case "tool_use":
			id, _ := block["id"].(string)
			call := agent.NativeCallID(id)
			if call == "" {
				continue
			}
			input := encodeJSON(block["input"])
			key := r.add(agent.ContentItem{NativeRef: r.uuid, Part: "input", Role: "assistant", Channel: "tool_input", MediaType: "application/json", CallID: call, Text: &input})
			block["input"] = ref(key)
		}
	}
	// What was sent to the API may differ from the input (a cd prefix); its
	// text is the input's, kept as a digest.
	if wire, ok := r.record["wireToolInputs"]; ok {
		r.record["wireToolInputs"] = digestLeaves(wire)
	}
}

func (r *recordReader) readAttachment() string {
	attachment, _ := r.record["attachment"].(map[string]any)
	kind, _ := attachment["type"].(string)
	switch {
	case kind == "file":
		content, _ := attachment["content"].(map[string]any)
		file, _ := content["file"].(map[string]any)
		text, isText := file["content"].(string)
		path, _ := attachment["filename"].(string)
		if content["type"] != "text" || !isText || path == "" {
			return ""
		}
		part := "file:" + path
		r.add(agent.ContentItem{NativeRef: r.uuid, Part: part, Role: "user", Channel: "file_content", MediaType: "text/plain", DisplayPath: path, Text: &text, RestatesContext: r.state.Compacted})
		file["content"] = pathRef(part)
		return "user"
	case kind == "instructions":
		files, _ := attachment["files"].([]any)
		for index, child := range files {
			file, _ := child.(map[string]any)
			text, _ := file["content"].(string)
			path, _ := file["path"].(string)
			key := r.add(agent.ContentItem{NativeRef: r.uuid, Part: "instruction:" + strconv.Itoa(index), Role: "system", Channel: "instruction", MediaType: "text/markdown", DisplayPath: path, Text: &text})
			file["content"] = ref(key)
		}
		return "system"
	case harnessContext[kind]:
		size := int64(len(encodeJSON(attachment)))
		r.add(agent.ContentItem{NativeRef: r.uuid, Part: "context:" + kind, Role: "system", Channel: "instruction", MediaType: "application/json", Coverage: "withheld_by_policy", CoverageReason: "harness_context", OriginalBytes: size})
		r.record["attachment"] = digestLeaves(attachment)
		return "system"
	}
	return ""
}

// Native-record leaves (contract §4): a declared leaf becomes its item's
// reference, a path part's reference names the part for the declarer to
// place, a copy of a declared body is an alias, and anything else kept out
// is its size and digest.
func ref(key string) map[string]any { return map[string]any{"backplane_content_ref": key} }

func pathRef(part string) map[string]any {
	return map[string]any{"backplane_content_ref": map[string]any{"part": part}}
}

func leafDigest(text string) map[string]any {
	sum := sha256.Sum256([]byte(text))
	return map[string]any{"bytes": len(text), "sha256": hex.EncodeToString(sum[:])}
}

func alias(text, key string) map[string]any {
	leaf := leafDigest(text)
	leaf["alias_of"] = key
	return leaf
}

// digestLeaves keeps a value's structure and member names, each string
// leaf as its digest.
func digestLeaves(value any) any {
	switch typed := value.(type) {
	case string:
		return leafDigest(typed)
	case []any:
		for index, child := range typed {
			typed[index] = digestLeaves(child)
		}
	case map[string]any:
		for key, child := range typed {
			typed[key] = digestLeaves(child)
		}
	}
	return value
}

func digestLongLeaves(value any) any {
	switch typed := value.(type) {
	case string:
		if len(typed) >= longLeafBytes {
			return leafDigest(typed)
		}
	case []any:
		for index, child := range typed {
			typed[index] = digestLongLeaves(child)
		}
	case map[string]any:
		if _, isRef := typed["backplane_content_ref"]; isRef {
			return typed
		}
		if _, isDigest := typed["sha256"]; isDigest {
			return typed
		}
		for key, child := range typed {
			typed[key] = digestLongLeaves(child)
		}
	}
	return value
}

func encodeJSON(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(value) != nil {
		return "null"
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

func stringAt(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func numberAt(object map[string]any, key string) string {
	if number, ok := object[key].(json.Number); ok {
		return number.String()
	}
	return ""
}
