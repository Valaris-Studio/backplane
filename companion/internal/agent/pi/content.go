// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pi

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	contentKind          = "pi_session"
	contentParserVersion = "companion-pi-session/1"
	// maxPendingCalls bounds the calls whose path a parser remembers until
	// their result: a session that never answers a call cannot grow it.
	maxPendingCalls = 256
)

var errNotAnEntry = errors.New("pi: not a session entry")

// ContentFile is the session file the managed extension reports, accepted
// only when its name is the event's own session's (Pi names its files
// <timestamp>_<session id>.jsonl).
func (Pi) ContentFile(_ string, payload map[string]any) (string, bool) {
	session, _ := payload["sessionId"].(string)
	file, _ := payload["sessionFile"].(string)
	if session == "" || !filepath.IsAbs(file) || !strings.HasSuffix(filepath.Base(file), "_"+session+".jsonl") {
		return "", false
	}
	return filepath.Clean(file), true
}

func (Pi) ContentParser() agent.ContentParser { return sessionParser{} }

// ContentRoots are where Pi keeps session files: <agent dir>/sessions, and
// a sessionDir its global settings name. A project's own settings or
// --session-dir can put a session elsewhere; such files are not read.
func (Pi) ContentRoots(env agent.Env) []string {
	roots := []string{filepath.Join(agentDir(env), "sessions")}
	var settings struct {
		SessionDir string `json:"sessionDir"`
	}
	if data, ok := readSettings(filepath.Join(agentDir(env), "settings.json")); ok && json.Unmarshal(data, &settings) == nil {
		dir := settings.SessionDir
		if rest, found := strings.CutPrefix(dir, "~/"); found {
			dir = filepath.Join(env.Home, rest)
		}
		if filepath.IsAbs(dir) {
			roots = append(roots, filepath.Clean(dir))
		}
	}
	return roots
}

// maxSettingsBytes bounds the settings file ContentRoots reads on every
// content pass.
const maxSettingsBytes = 64 << 10

// readSettings reads Pi's settings through the guarded open: a regular
// file of this user's, never a FIFO that would block every pass or a link.
func readSettings(path string) ([]byte, bool) {
	data, err := store.ReadOwnedFile(path, filepath.Dir(path), maxSettingsBytes)
	return data, err == nil
}

type sessionParser struct{}

func (sessionParser) Kind() string    { return contentKind }
func (sessionParser) Version() string { return contentParserVersion }

type sessionHeader struct {
	Type          string    `json:"type"`
	Version       int       `json:"version"`
	Timestamp     time.Time `json:"timestamp"`
	Cwd           string    `json:"cwd"`
	ParentSession string    `json:"parentSession"`
}

func (sessionParser) Header(firstLine []byte) (agent.ContentHeader, bool) {
	var header sessionHeader
	if json.Unmarshal(firstLine, &header) != nil || header.Type != "session" || header.Timestamp.IsZero() {
		return agent.ContentHeader{}, false
	}
	return agent.ContentHeader{Began: header.Timestamp, ParentSessionID: sessionOfFile(header.ParentSession)}, true
}

// sessionOfFile reads the session id from a Pi session file's name.
func sessionOfFile(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	if path == "" || name == filepath.Base(path) {
		return ""
	}
	_, session, found := strings.Cut(name, "_")
	if !found {
		return ""
	}
	return session
}

// parserState is what a line needs from the lines before it: the header's
// directory and format version, and the path each pending edit call named.
type parserState struct {
	Cwd     string            `json:"cwd,omitempty"`
	Version int               `json:"version,omitempty"`
	Paths   map[string]string `json:"paths,omitempty"`
}

func (sessionParser) Parse(line agent.ContentLine, raw json.RawMessage) (agent.ContentRecord, json.RawMessage, error) {
	var state parserState
	if len(raw) > 0 && json.Unmarshal(raw, &state) != nil {
		state = parserState{}
	}
	entry, err := decodeEntry(line.Bytes)
	if err != nil {
		// The state stays as it was: the daemon keeps what a failed parse
		// returns.
		return agent.ContentRecord{}, raw, err
	}
	reader := entryReader{line: line, state: &state, entry: entry}
	record := reader.read()
	next, err := json.Marshal(state)
	if err != nil {
		return agent.ContentRecord{}, raw, err
	}
	return record, next, nil
}

func decodeEntry(line []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	var entry map[string]any
	if err := decoder.Decode(&entry); err != nil {
		return nil, err
	}
	if entry == nil || decoder.More() {
		return nil, errNotAnEntry
	}
	if _, typed := entry["type"].(string); !typed {
		return nil, errNotAnEntry
	}
	return entry, nil
}

type entryReader struct {
	line   agent.ContentLine
	state  *parserState
	entry  map[string]any
	id     string
	record agent.ContentRecord
	// thinking are an entry's thinking blocks with text, declared together
	// once the entry is read (amendment 35).
	thinking  []map[string]any
	signature bool
}

func (r *entryReader) read() agent.ContentRecord {
	r.id, _ = r.entry["id"].(string)
	at, _ := time.Parse(time.RFC3339Nano, stringAt(r.entry, "timestamp"))
	r.record = agent.ContentRecord{At: at, SchemaVersion: r.schemaVersion()}
	role := ""
	switch r.entry["type"] {
	case "session":
		r.readHeader()
		return agent.ContentRecord{}
	case "message":
		message, _ := r.entry["message"].(map[string]any)
		if message == nil {
			return agent.ContentRecord{}
		}
		role = r.readMessage(message)
	case "compaction", "branch_summary":
		// A summary restates what the session said before it.
		if summary, ok := r.entry["summary"].(string); ok && summary != "" {
			key := r.add(agent.ContentItem{NativeRef: r.id, Part: "summary", Role: "system", Channel: "summary", MediaType: "text/markdown", Text: &summary, RestatesContext: true})
			r.entry["summary"] = ref(key)
		}
		role = "system"
	}
	if len(r.record.Items) == 0 || r.id == "" {
		return agent.ContentRecord{}
	}
	r.addNative(role)
	return r.record
}

func (r *entryReader) schemaVersion() string {
	if r.state.Version == 0 {
		return "pi-session/unknown"
	}
	return "pi-session/" + strconv.Itoa(r.state.Version)
}

func (r *entryReader) readHeader() {
	var header sessionHeader
	encoded, _ := json.Marshal(r.entry)
	if json.Unmarshal(encoded, &header) == nil {
		r.state.Cwd, r.state.Version = header.Cwd, header.Version
	}
}

func (r *entryReader) readMessage(message map[string]any) string {
	switch message["role"] {
	case "user":
		r.readBlocks(message, "user", r.userBlock)
		return "user"
	case "assistant":
		r.readBlocks(message, "assistant", r.assistantBlock)
		r.declareThinking()
		if failure, ok := message["errorMessage"].(string); ok && failure != "" {
			key := r.add(agent.ContentItem{NativeRef: r.id, Part: "error", Role: "assistant", Channel: "error", MediaType: "text/plain", Text: &failure})
			message["errorMessage"] = ref(key)
		}
		return "assistant"
	case "toolResult":
		r.readToolResult(message)
		return "tool"
	case "bashExecution":
		r.readUserShell(message)
		return "user"
	}
	return ""
}

func (r *entryReader) readBlocks(message map[string]any, role string, read func(index int, block map[string]any)) {
	switch content := message["content"].(type) {
	case string:
		block := map[string]any{"type": "text", "text": content}
		read(0, block)
		message["content"] = block["text"]
	case []any:
		for index, child := range content {
			if block, ok := child.(map[string]any); ok {
				read(index, block)
			}
		}
	}
}

// fileSpan is how Pi inlines an @file into a prompt: the path, then its
// text between newlines. An image's span is empty and only names it.
var fileSpan = regexp.MustCompile(`(?s)<file name="([^"]*)">(.*?)</file>\n?`)

func (r *entryReader) userBlock(index int, block map[string]any) {
	part := strconv.Itoa(index)
	switch block["type"] {
	case "text":
		text, _ := block["text"].(string)
		var refs []any
		textAt := -1
		for _, span := range fileSpan.FindAllStringSubmatchIndex(text, -1) {
			name, body := text[span[2]:span[3]], text[span[4]:span[5]]
			body = strings.TrimSuffix(strings.TrimPrefix(body, "\n"), "\n")
			if span[0] > 0 && textAt < 0 && strings.TrimSpace(text[:span[0]]) != "" {
				textAt = len(refs)
			}
			if body == "" {
				continue
			}
			path := r.absolute(name)
			r.add(agent.ContentItem{NativeRef: r.id, Part: "file:" + path, Role: "user", Channel: "file_content", MediaType: "text/plain", DisplayPath: path, Text: &body})
			refs = append(refs, pathRef("file:"+path))
		}
		remaining := fileSpan.ReplaceAllString(text, "")
		if strings.TrimSpace(remaining) != "" {
			key := r.add(agent.ContentItem{NativeRef: r.id, Part: "text:" + part, Role: "user", Channel: "prompt", MediaType: "text/plain", Text: &remaining})
			if textAt < 0 {
				textAt = len(refs)
			}
			refs = append(refs[:textAt], append([]any{ref(key)}, refs[textAt:]...)...)
		}
		switch len(refs) {
		case 0:
		case 1:
			block["text"] = refs[0]
		default:
			block["text"] = refs
		}
	case "image":
		r.image(index, block, "user")
	}
}

func (r *entryReader) image(index int, block map[string]any, role string) {
	encoded, _ := block["data"].(string)
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 {
		block["data"] = digest(encoded)
		return
	}
	mediaType, _ := block["mimeType"].(string)
	key := r.add(agent.ContentItem{NativeRef: r.id, Part: "image:" + strconv.Itoa(index), Role: role, Channel: "attachment", MediaType: mediaType, Data: data})
	block["data"] = ref(key)
}

func (r *entryReader) assistantBlock(index int, block map[string]any) {
	switch block["type"] {
	case "text":
		if text, ok := block["text"].(string); ok && text != "" {
			key := r.add(agent.ContentItem{NativeRef: r.id, Part: "text:" + strconv.Itoa(index), Role: "assistant", Channel: "reply", MediaType: "text/markdown", Text: &text})
			block["text"] = ref(key)
		}
	case "thinking":
		if thinking, ok := block["thinking"].(string); ok && thinking != "" {
			r.thinking = append(r.thinking, block)
		}
		if signature, ok := block["thinkingSignature"].(string); ok && signature != "" {
			r.signature = true
			block["thinkingSignature"] = digest(signature)
		}
	case "toolCall":
		id, _ := block["id"].(string)
		call := agent.NativeCallID(id)
		if call == "" {
			// Nothing can key its input, so none is declared and nothing of
			// it stays readable.
			block["arguments"] = digest(encodeJSON(block["arguments"]))
			return
		}
		arguments, _ := block["arguments"].(map[string]any)
		input := encodeJSON(block["arguments"])
		// One entry can hold several calls and input is not an indexed
		// part, so a call's input is keyed by the call (amendment 32).
		key := r.add(agent.ContentItem{NativeRef: call, Part: "input", Role: "assistant", Channel: "tool_input", MediaType: "application/json", CallID: call, Text: &input})
		block["arguments"] = ref(key)
		if path, ok := arguments["path"].(string); ok && path != "" {
			r.rememberPath(call, path)
		}
	}
}

// declareThinking declares an entry's provider summaries as one, in block
// order, and one raw item when any block was signed (encrypted at source).
func (r *entryReader) declareThinking() {
	if len(r.thinking) > 0 {
		var texts []string
		for _, block := range r.thinking {
			texts = append(texts, block["thinking"].(string))
		}
		summary := strings.Join(texts, "\n\n")
		key := r.add(agent.ContentItem{NativeRef: r.id, Part: "summary", Role: "assistant", Channel: "reasoning", MediaType: "text/markdown", Text: &summary})
		for _, block := range r.thinking {
			block["thinking"] = ref(key)
		}
	}
	if r.signature {
		r.add(agent.ContentItem{NativeRef: r.id, Part: "raw", Role: "assistant", Channel: "reasoning", Coverage: "source_unavailable", CoverageReason: "encrypted_at_source"})
	}
}

func (r *entryReader) rememberPath(call, path string) {
	if r.state.Paths == nil {
		r.state.Paths = map[string]string{}
	}
	if len(r.state.Paths) >= maxPendingCalls {
		r.state.Paths = map[string]string{}
	}
	r.state.Paths[call] = path
}

func (r *entryReader) readToolResult(message map[string]any) {
	id, _ := message["toolCallId"].(string)
	call := agent.NativeCallID(id)
	path := r.state.Paths[call]
	delete(r.state.Paths, call)
	part, channel := "output", "tool_output"
	if failed, _ := message["isError"].(bool); failed {
		part, channel = "error", "error"
	}
	output := agent.ContentItem{NativeRef: r.id, Part: part, Role: "tool", Channel: channel, MediaType: "text/plain", CallID: call}
	details, _ := message["details"].(map[string]any)
	var texts []string
	var textBlocks []map[string]any
	if content, ok := message["content"].([]any); ok {
		for index, child := range content {
			block, _ := child.(map[string]any)
			switch block["type"] {
			case "text":
				text, _ := block["text"].(string)
				texts = append(texts, text)
				textBlocks = append(textBlocks, block)
			case "image":
				r.image(index, block, "tool")
			}
		}
	}
	if len(textBlocks) > 0 {
		text := strings.Join(texts, "\n")
		output.Text = &text
		truncation, _ := details["truncation"].(map[string]any)
		if truncated, _ := truncation["truncated"].(bool); truncated {
			r.truncated(&output, truncation, details)
		} else if truncation == nil && message["toolName"] == "codemode" {
			// Codemode spills only after truncation; this signal does not authorize reading the log.
			full, _ := details["fullOutputPath"].(string)
			output.SourceTruncated = full != ""
		}
		key := r.add(output)
		for index, block := range textBlocks {
			if index == 0 {
				block["text"] = ref(key)
			} else {
				// Held in the joined output after the first block.
				block["text"] = alias(texts[index], key)
			}
		}
		if truncation != nil {
			if tail, ok := truncation["content"].(string); ok {
				truncation["content"] = alias(tail, key)
			}
		}
	}
	if patch, ok := details["patch"].(string); ok && patch != "" {
		if path == "" {
			path = patchTarget(patch)
		}
		if path != "" {
			part := "diff:" + r.absolute(path)
			r.add(agent.ContentItem{NativeRef: r.id, Part: part, Role: "tool", Channel: "diff", MediaType: "text/x-diff", CallID: call, Text: &patch})
			details["patch"] = pathRef(part)
		}
	}
	if display, ok := details["diff"].(string); ok {
		details["diff"] = digest(display)
	}
}

// truncated marks a result Pi kept only the tail of, naming the full log it
// wrote; the log counts only in this machine's temp dir, whatever the record
// says, and only when it ends with the kept tail.
func (r *entryReader) truncated(output *agent.ContentItem, truncation, details map[string]any) {
	output.SourceTruncated = true
	if total, err := strconv.ParseInt(numberAt(truncation, "totalBytes"), 10, 64); err == nil {
		output.OriginalBytes = total
	}
	full, _ := details["fullOutputPath"].(string)
	tail, _ := truncation["content"].(string)
	if full == "" || tail == "" {
		return
	}
	output.Store = &agent.BodyStore{Path: full, Kind: "harness_temp_log", Within: os.TempDir(), Matches: func(body []byte) bool {
		return bytes.HasSuffix(body, []byte(tail)) || bytes.HasSuffix(bytes.TrimSuffix(body, []byte("\n")), []byte(tail))
	}}
}

func (r *entryReader) readUserShell(message map[string]any) {
	if command, ok := message["command"].(string); ok && command != "" {
		key := r.add(agent.ContentItem{NativeRef: r.id, Part: "command", Role: "user", Channel: "tool_input", MediaType: "text/plain", Text: &command})
		message["command"] = ref(key)
	}
	if output, ok := message["output"].(string); ok {
		item := agent.ContentItem{NativeRef: r.id, Part: "output", Role: "tool", Channel: "command_output", MediaType: "text/plain", Text: &output}
		if truncated, _ := message["truncated"].(bool); truncated {
			item.SourceTruncated = true
			if full, _ := message["fullOutputPath"].(string); full != "" {
				item.Store = &agent.BodyStore{Path: full, Kind: "harness_temp_log", Within: os.TempDir(), Matches: func(body []byte) bool {
					return bytes.HasSuffix(bytes.TrimSuffix(body, []byte("\n")), []byte(strings.TrimSuffix(output, "\n")))
				}}
			}
		}
		key := r.add(item)
		message["output"] = ref(key)
	}
}

// patchTarget is the file a unified diff's +++ header names.
func patchTarget(patch string) string {
	for _, line := range strings.Split(patch, "\n") {
		if target, found := strings.CutPrefix(line, "+++ "); found {
			return strings.TrimSpace(target)
		}
	}
	return ""
}

// absolute resolves a path the session named relative to its directory;
// without one it stays as named.
func (r *entryReader) absolute(path string) string {
	if filepath.IsAbs(path) || r.state.Cwd == "" {
		return path
	}
	return filepath.Join(r.state.Cwd, path)
}

func (r *entryReader) add(item agent.ContentItem) string {
	r.record.Items = append(r.record.Items, item)
	return agent.ContentKey(r.line.Harness, r.line.NativeSessionID, item.NativeRef, item.Part)
}

func (r *entryReader) addNative(role string) {
	native := encodeJSON(r.entry)
	if role == "" {
		role = "unknown"
	}
	r.record.Items = append(r.record.Items, agent.ContentItem{NativeRef: r.id, Part: "native", Role: role, Channel: "native_record", MediaType: "application/json", Text: &native})
}

// Native-record leaves (contract §4): a declared leaf becomes its item's
// reference, a path part's reference names the part for the declarer to
// place, a copy of a declared body is an alias, anything else kept out is
// its size and digest.
func ref(key string) map[string]any { return map[string]any{"backplane_content_ref": key} }

func pathRef(part string) map[string]any {
	return map[string]any{"backplane_content_ref": map[string]any{"part": part}}
}

func digest(text string) map[string]any {
	sum := sha256.Sum256([]byte(text))
	return map[string]any{"bytes": len(text), "sha256": hex.EncodeToString(sum[:])}
}

func alias(text, key string) map[string]any {
	leaf := digest(text)
	leaf["alias_of"] = key
	return leaf
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
