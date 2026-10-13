// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// Rich capture reads each Codex thread's rollout, the one file the CLI and
// Desktop's app-server both write. It holds completed items only; the
// designated content of a line is its item_completed item, the user
// response_item's images and instructions, and the code-mode script's own
// call and output. Every other copy (an assistant response_item, the
// formatted_output a model saw, compaction's replacement history) is an
// alias in a native record or nothing.
const (
	contentKind          = "codex_rollout"
	contentParserVersion = "companion-codex-rollout/1"
)

func (c Codex) ContentFile(event string, payload map[string]any) (string, bool) {
	if _, agentThread := payload["agent_id"]; agentThread {
		// A subagent's hooks name the child's rollout beside the parent's
		// session_id (codex-cli 0.161): the child's own thread names it.
		return "", false
	}
	if event == "Stop" {
		// Stop is not an installed hook, but when Codex runs one it names
		// the rollout the final answer was just written to.
		event = "UserPromptSubmit"
	}
	path, ok := c.UsageTranscript(event, payload)
	session, _ := payload["session_id"].(string)
	if !ok || session == "" || !rolloutName.MatchString(filepath.Base(path)) || !strings.HasSuffix(filepath.Base(path), "-"+session+".jsonl") {
		return "", false
	}
	return path, true
}

func (Codex) ContentParser() agent.ContentParser { return rolloutParser{} }

func (Codex) ContentRoots(env agent.Env) []string {
	return []string{filepath.Join(codexHome(env), "sessions")}
}

type rolloutParser struct{}

func (rolloutParser) Kind() string    { return contentKind }
func (rolloutParser) Version() string { return contentParserVersion }

type rolloutEnvelope struct {
	Timestamp string          `json:"timestamp"`
	Ordinal   *int64          `json:"ordinal"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type sessionMetaPayload struct {
	ID           string `json:"id"`
	Timestamp    string `json:"timestamp"`
	Cwd          string `json:"cwd"`
	Originator   string `json:"originator"`
	CLIVersion   string `json:"cli_version"`
	ForkedFromID string `json:"forked_from_id"`
	// ParentThreadID is, for a subagent, the thread that spawned it; its
	// session_id is the tree's root, the same only for a child of the root
	// (Desktop 0.160), not for one a subagent spawned (guardian_review).
	ParentThreadID string `json:"parent_thread_id"`
	Base           *struct {
		Text string `json:"text"`
	} `json:"base_instructions"`
}

func (rolloutParser) Header(firstLine []byte) (agent.ContentHeader, bool) {
	meta, ok := readSessionMeta(firstLine)
	if !ok {
		return agent.ContentHeader{}, false
	}
	began, err := time.Parse(time.RFC3339Nano, meta.Timestamp)
	if err != nil {
		return agent.ContentHeader{}, false
	}
	return agent.ContentHeader{Began: began.UTC(), ParentSessionID: meta.parent(), Harness: harnessOf(meta.Originator)}, true
}

// parent is the thread this one forked from, when forked_from_id names
// another thread.
func (meta sessionMetaPayload) parent() string {
	return meta.otherThread(meta.ForkedFromID)
}

// spawnedBy is the thread that spawned this one as a subagent, its
// parent_thread_id. session_id alone names the tree's root, which proves no
// immediate parent.
func (meta sessionMetaPayload) spawnedBy() string {
	return meta.otherThread(meta.ParentThreadID)
}

func (meta sessionMetaPayload) otherThread(id string) string {
	if nativeID.MatchString(id) && id != meta.ID {
		return id
	}
	return ""
}

func readSessionMeta(line []byte) (sessionMetaPayload, bool) {
	var envelope rolloutEnvelope
	var meta sessionMetaPayload
	if json.Unmarshal(line, &envelope) != nil || envelope.Type != "session_meta" || json.Unmarshal(envelope.Payload, &meta) != nil || !nativeID.MatchString(meta.ID) {
		return sessionMetaPayload{}, false
	}
	return meta, true
}

// harnessOf is the harness a rollout's originator implies, as the usage
// reader attributes it.
func harnessOf(originator string) string {
	switch {
	case originator == "":
		return ""
	case cliOriginators[originator]:
		return ID
	}
	return DesktopID
}

// contentState is what the lines read so far say of the thread.
type contentState struct {
	// Version is session_meta's cli_version; unknown to a read that began
	// past it.
	Version string `json:"version,omitempty"`
	Turn    string `json:"turn,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	// Script is the code-mode exec call open in ScriptTurn: the commands,
	// edits and MCP calls completed meanwhile ran inside it.
	Script     string `json:"script,omitempty"`
	ScriptTurn string `json:"script_turn,omitempty"`
	// Forked: what a fork writes before its first turn starts is
	// synthetic, never the fork's content.
	Forked  bool `json:"forked,omitempty"`
	Started bool `json:"started,omitempty"`
}

var errNoTimestamp = errors.New("rollout line without a timestamp")

// Parse never changes the state it was given unless the line parsed: the
// daemon keeps whatever state is returned.
func (p rolloutParser) Parse(line agent.ContentLine, raw json.RawMessage) (agent.ContentRecord, json.RawMessage, error) {
	var envelope rolloutEnvelope
	if err := json.Unmarshal(line.Bytes, &envelope); err != nil {
		return agent.ContentRecord{}, raw, err
	}
	at, err := time.Parse(time.RFC3339Nano, envelope.Timestamp)
	if err != nil {
		return agent.ContentRecord{}, raw, errors.Join(errNoTimestamp, err)
	}
	var state contentState
	if len(raw) > 0 {
		json.Unmarshal(raw, &state)
	}
	reader := lineReader{line: line, envelope: envelope, state: state}
	if err := reader.read(); err != nil {
		return agent.ContentRecord{}, raw, err
	}
	next, err := json.Marshal(reader.state)
	if err != nil {
		return agent.ContentRecord{}, raw, err
	}
	record := agent.ContentRecord{At: at.UTC(), Cwd: reader.state.Cwd, SchemaVersion: contentKind + "/unknown", Copied: reader.copied, Items: reader.items}
	if reader.state.Version != "" {
		record.SchemaVersion = contentKind + "/" + reader.state.Version
	}
	if record.Copied {
		record.Items = nil
	} else if native, ok := reader.nativeRecord(); ok {
		record.Items = append(record.Items, native)
	}
	return record, next, nil
}

// lineReader turns one line into its items and the edits that make its
// native record: every leaf declared becomes a reference, every copy of
// one a digest, so no text is stored twice.
type lineReader struct {
	line     agent.ContentLine
	envelope rolloutEnvelope
	state    contentState
	items    []agent.ContentItem
	copied   bool
	// nativeRef names the line's native record; edits rewrite its leaves.
	nativeRef string
	role      string
	turn      string
	// callID and parentCallID link every item of the line.
	callID       string
	parentCallID string
	edits        []leafEdit
}

func (r *lineReader) read() error {
	payload := r.envelope.Payload
	switch r.envelope.Type {
	case "session_meta":
		return r.sessionMeta(payload)
	case "turn_context":
		var context struct {
			TurnID string `json:"turn_id"`
			Cwd    string `json:"cwd"`
		}
		if err := json.Unmarshal(payload, &context); err != nil {
			return err
		}
		r.state.Turn, r.state.Cwd = context.TurnID, context.Cwd
	case "world_state":
		return r.worldState(payload)
	case "compacted":
		// replacement_history re-copies kept items under their original ids.
		r.copied = true
	case "event_msg":
		return r.eventMessage(payload)
	case "response_item":
		err := r.responseItem(payload)
		if r.state.Forked && !r.state.Started && len(r.items) > 0 {
			r.copied = true
		}
		return err
	}
	return nil
}

func (r *lineReader) sessionMeta(payload json.RawMessage) error {
	var meta sessionMetaPayload
	if err := json.Unmarshal(payload, &meta); err != nil {
		return err
	}
	if meta.ID != "" && meta.ID != r.line.NativeSessionID {
		r.copied = true
		return nil
	}
	r.state.Version, r.state.Cwd, r.state.Forked = meta.CLIVersion, meta.Cwd, meta.ForkedFromID != ""
	r.nativeRef, r.role = meta.ID, "system"
	if meta.Base != nil && meta.Base.Text != "" {
		r.harnessContext(meta.ID, "context:base_instructions", "system", int64(len(meta.Base.Text)))
		r.digest([]any{"payload", "base_instructions", "text"}, meta.Base.Text, "")
	}
	// Account identity rides session_meta; the native record keeps only
	// its digest.
	for _, identity := range []string{"creator_user_id", "creator_account_id"} {
		r.edits = append(r.edits, leafEdit{path: []any{"payload", identity}, value: digestFromRaw})
	}
	return nil
}

func (r *lineReader) worldState(payload json.RawMessage) error {
	var world struct {
		Full  bool            `json:"full"`
		State json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal(payload, &world); err != nil {
		return err
	}
	// A delta restates settings; only the full state is the harness
	// context a turn began with.
	if !world.Full || r.envelope.Ordinal == nil {
		return nil
	}
	r.nativeRef, r.role = "ordinal:"+strconv.FormatInt(*r.envelope.Ordinal, 10), "system"
	r.harnessContext(r.nativeRef, "context:world_state", "system", int64(len(world.State)))
	r.edits = append(r.edits, leafEdit{path: []any{"payload", "state"}, value: digestLeaf(world.State, "")})
	return nil
}

func (r *lineReader) eventMessage(payload json.RawMessage) error {
	var message struct {
		Type     string          `json:"type"`
		ThreadID string          `json:"thread_id"`
		TurnID   string          `json:"turn_id"`
		Item     json.RawMessage `json:"item"`
	}
	if err := json.Unmarshal(payload, &message); err != nil {
		return err
	}
	switch message.Type {
	case "task_started":
		r.state.Turn, r.state.Started = message.TurnID, true
		r.state.Script, r.state.ScriptTurn = "", ""
		return nil
	case "item_completed":
	default:
		// item_started and item_updated are not yet what the item will be;
		// it is declared once, completed (amendment 31).
		return nil
	}
	if message.ThreadID != "" && message.ThreadID != r.line.NativeSessionID {
		// Another thread's record, e.g. copied from a parent.
		r.copied = true
		return nil
	}
	r.turn = message.TurnID
	if r.turn == "" {
		r.turn = r.state.Turn
	}
	return r.completedItem(message.Item)
}

func (r *lineReader) responseItem(payload json.RawMessage) error {
	var item struct {
		Type     string `json:"type"`
		ID       string `json:"id"`
		Metadata struct {
			TurnID string `json:"turn_id"`
		} `json:"internal_chat_message_metadata_passthrough"`
	}
	if err := json.Unmarshal(payload, &item); err != nil {
		return err
	}
	r.turn = item.Metadata.TurnID
	if r.turn == "" {
		r.turn = r.state.Turn
	}
	switch item.Type {
	case "message":
		return r.message(payload)
	case "custom_tool_call", "function_call":
		return r.toolCall(payload)
	case "custom_tool_call_output", "function_call_output":
		return r.toolOutput(payload)
	case "agent_message":
		return r.agentMessage(payload)
	}
	// reasoning: its ciphertext is never declared over the completed item.
	return nil
}

// key is an item's content key in this line's session.
func (r *lineReader) key(ref, part string) string {
	return agent.ContentKey(r.line.Harness, r.line.NativeSessionID, ref, part)
}

func (r *lineReader) add(item agent.ContentItem) agent.ContentItem {
	if item.TurnID == "" {
		item.TurnID = r.turn
	}
	item.ParentCallID = r.parentCallID
	if r.nativeRef == "" {
		r.nativeRef, r.role = item.NativeRef, item.Role
	}
	r.items = append(r.items, item)
	return item
}

func (r *lineReader) text(ref, part, role, channel, mediaType, body string) agent.ContentItem {
	return r.add(agent.ContentItem{NativeRef: ref, Part: part, Role: role, Channel: channel, MediaType: mediaType, Text: &body, CallID: r.callID})
}

func (r *lineReader) withheld(ref, part, role, channel, mediaType, coverage, reason string, size int64) agent.ContentItem {
	return r.add(agent.ContentItem{NativeRef: ref, Part: part, Role: role, Channel: channel, MediaType: mediaType, Coverage: coverage, CoverageReason: reason, OriginalBytes: size, CallID: r.callID})
}

func (r *lineReader) harnessContext(ref, part, role string, size int64) {
	r.withheld(ref, part, role, "instruction", mediaPlain, "withheld_by_policy", "harness_context", size)
}

const (
	mediaPlain    = "text/plain"
	mediaMarkdown = "text/markdown"
	mediaJSON     = "application/json"
	mediaDiff     = "text/x-diff"
	mediaUnknown  = "application/octet-stream"
)

var (
	agentsMDHeader     = regexp.MustCompile(`^# AGENTS\.md instructions for (.+)\n`)
	unreadableImage    = regexp.MustCompile("^Codex could not read the local image at `")
	omittedBytesMarker = regexp.MustCompile(`\n\.\.\. ([0-9]+) bytes omitted \.\.\.\n`)
)

type contentEntry struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	ImageURL string `json:"image_url"`
}

func (r *lineReader) message(payload json.RawMessage) error {
	var message struct {
		ID       string         `json:"id"`
		Role     string         `json:"role"`
		Content  []contentEntry `json:"content"`
		Metadata struct {
			Kinds []string `json:"content_item_kinds"`
		} `json:"internal_chat_message_metadata_passthrough"`
	}
	if err := json.Unmarshal(payload, &message); err != nil {
		return err
	}
	if !nativeID.MatchString(message.ID) {
		return nil
	}
	for index, entry := range message.Content {
		part, path := strconv.Itoa(index), []any{"payload", "content", index}
		kind := ""
		if index < len(message.Metadata.Kinds) {
			kind = message.Metadata.Kinds[index]
		}
		switch {
		case message.Role == "developer" || message.Role == "system":
			r.harnessContext(message.ID, "text:"+part, "developer", int64(len(entry.Text)))
			r.digest(append(path, "text"), entry.Text, "")
		case message.Role != "user":
			// The assistant's words are its completed AgentMessage.
			return r.dropItems()
		case entry.Type == "input_image":
			r.ref(append(path, "image_url"), r.image(message.ID, "image:"+part, "user", entry.ImageURL))
		case kind == "agents_md.instructions" || kind == "" && agentsMDHeader.MatchString(entry.Text):
			item := r.text(message.ID, "instruction:"+part, "user", "instruction", mediaMarkdown, entry.Text)
			if match := agentsMDHeader.FindStringSubmatch(entry.Text); match != nil {
				r.items[len(r.items)-1].DisplayPath = filepath.Join(match[1], "AGENTS.md")
			}
			r.ref(append(path, "text"), item)
		case unreadableImage.MatchString(entry.Text):
			r.withheld(message.ID, "image:"+part, "user", "attachment", mediaUnknown, "source_unavailable", "file_missing", 0)
			r.digest(append(path, "text"), entry.Text, "")
		case kind == "user.text" || kind == "" && (!strings.HasPrefix(entry.Text, "<") || strings.HasPrefix(entry.Text, "<image") || entry.Text == "</image>"):
			// The prompt's own record is its completed UserMessage.
			r.digest(append(path, "text"), entry.Text, "")
		default:
			r.harnessContext(message.ID, "text:"+part, "user", int64(len(entry.Text)))
			r.digest(append(path, "text"), entry.Text, "")
		}
	}
	return nil
}

func (r *lineReader) dropItems() error {
	r.items, r.edits = nil, nil
	return nil
}

// image declares an embedded image; only data URLs carry one.
func (r *lineReader) image(ref, part, role, url string) agent.ContentItem {
	mediaType, encoded, isData := strings.Cut(strings.TrimPrefix(url, "data:"), ";base64,")
	if !strings.HasPrefix(url, "data:") || !isData {
		return r.withheld(ref, part, role, "attachment", mediaUnknown, "source_unavailable", "remote_reference", 0)
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return r.withheld(ref, part, role, "attachment", mediaUnknown, "collection_failed", "parse_error", int64(len(encoded)))
	}
	return r.add(agent.ContentItem{NativeRef: ref, Part: part, Role: role, Channel: "attachment", MediaType: mediaType, Data: data, CallID: r.callID})
}

func (r *lineReader) toolCall(payload json.RawMessage) error {
	var call struct {
		Type      string `json:"type"`
		ID        string `json:"id"`
		Name      string `json:"name"`
		CallID    string `json:"call_id"`
		Input     string `json:"input"`
		Arguments string `json:"arguments"`
	}
	if err := json.Unmarshal(payload, &call); err != nil {
		return err
	}
	if !nativeID.MatchString(call.ID) {
		return nil
	}
	r.callID = call.CallID
	if call.Type == "custom_tool_call" {
		r.ref([]any{"payload", "input"}, r.text(call.ID, "input", "assistant", "tool_input", mediaPlain, call.Input))
		if call.Name == "exec" {
			r.state.Script, r.state.ScriptTurn = call.CallID, r.turn
		}
		return nil
	}
	if call.Name == "spawn_agent" {
		// Its message travels encrypted to the child.
		r.ref([]any{"payload", "arguments"}, r.withheld(call.ID, "input", "assistant", "tool_input", mediaJSON, "source_unavailable", "encrypted_at_source", int64(len(call.Arguments))))
		return nil
	}
	mediaType := mediaPlain
	if json.Valid([]byte(call.Arguments)) {
		mediaType = mediaJSON
	}
	r.ref([]any{"payload", "arguments"}, r.text(call.ID, "input", "assistant", "tool_input", mediaType, call.Arguments))
	return nil
}

func (r *lineReader) toolOutput(payload json.RawMessage) error {
	var output struct {
		ID     string          `json:"id"`
		CallID string          `json:"call_id"`
		Output json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(payload, &output); err != nil {
		return err
	}
	if output.CallID != "" && output.CallID == r.state.Script {
		r.state.Script, r.state.ScriptTurn = "", ""
	}
	if !nativeID.MatchString(output.ID) {
		return nil
	}
	r.callID = output.CallID
	var whole string
	if json.Unmarshal(output.Output, &whole) == nil {
		if whole != "" {
			r.ref([]any{"payload", "output"}, r.text(output.ID, "output", "tool", "tool_output", mediaPlain, whole))
		}
		return nil
	}
	var entries []contentEntry
	if err := json.Unmarshal(output.Output, &entries); err != nil {
		return err
	}
	var texts strings.Builder
	for _, entry := range entries {
		if entry.Type == "input_text" {
			texts.WriteString(entry.Text)
		}
	}
	// One leaf, several items (amendment 27): the text runs are one output,
	// each image its own attachment, referenced in source order.
	var refs []any
	if texts.Len() > 0 {
		item := r.text(output.ID, "output", "tool", "tool_output", mediaPlain, texts.String())
		refs = append(refs, map[string]any{"backplane_content_ref": r.key(item.NativeRef, item.Part)})
	}
	for index, entry := range entries {
		if entry.Type == "input_image" {
			item := r.image(output.ID, "image:"+strconv.Itoa(index), "tool", entry.ImageURL)
			refs = append(refs, map[string]any{"backplane_content_ref": r.key(item.NativeRef, item.Part)})
		}
	}
	if len(refs) > 0 {
		r.edits = append(r.edits, leafEdit{path: []any{"payload", "output"}, value: refs})
	}
	return nil
}

func (r *lineReader) agentMessage(payload json.RawMessage) error {
	var message struct {
		ID      string         `json:"id"`
		Content []contentEntry `json:"content"`
	}
	if err := json.Unmarshal(payload, &message); err != nil {
		return err
	}
	if !nativeID.MatchString(message.ID) {
		return nil
	}
	// A message between agents enters this thread as its input.
	for index, entry := range message.Content {
		part, path := "text:"+strconv.Itoa(index), []any{"payload", "content", index}
		switch entry.Type {
		case "input_text":
			r.ref(append(path, "text"), r.text(message.ID, part, "user", "prompt", mediaPlain, entry.Text))
		case "encrypted_content":
			r.withheld(message.ID, part, "user", "prompt", mediaPlain, "source_unavailable", "encrypted_at_source", 0)
			r.edits = append(r.edits, leafEdit{path: path, value: map[string]any{"type": "encrypted_content", "backplane_content_ref": r.key(message.ID, part)}})
		}
	}
	return nil
}

type completedItem struct {
	Type    string         `json:"type"`
	ID      string         `json:"id"`
	Content []contentEntry `json:"content"`
	// Reasoning
	SummaryText []string `json:"summary_text"`
	RawContent  []string `json:"raw_content"`
	// CommandExecution
	Command          []string               `json:"command"`
	ParsedCommand    []struct{ Cmd string } `json:"parsed_cmd"`
	Cwd              string                 `json:"cwd"`
	Stdout           string                 `json:"stdout"`
	Stderr           string                 `json:"stderr"`
	AggregatedOutput string                 `json:"aggregated_output"`
	FormattedOutput  string                 `json:"formatted_output"`
	// FileChange
	Changes map[string]struct {
		Type        string `json:"type"`
		UnifiedDiff string `json:"unified_diff"`
		Content     string `json:"content"`
	} `json:"changes"`
	// McpToolCall
	Arguments json.RawMessage `json:"arguments"`
	Result    json.RawMessage `json:"result"`
	Error     *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (r *lineReader) completedItem(raw json.RawMessage) error {
	var item completedItem
	if err := json.Unmarshal(raw, &item); err != nil {
		return err
	}
	if !nativeID.MatchString(item.ID) {
		return nil
	}
	path := func(leaf ...any) []any { return append([]any{"payload", "item"}, leaf...) }
	switch item.Type {
	case "UserMessage", "AgentMessage":
		role, channel, mediaType := "user", "prompt", mediaPlain
		if item.Type == "AgentMessage" {
			role, channel, mediaType = "assistant", "reply", mediaMarkdown
		}
		for index, entry := range item.Content {
			// local_image entries are paths, never opened: the image is the
			// user response_item's data.
			if strings.EqualFold(entry.Type, "text") {
				r.ref(path("content", index, "text"), r.text(item.ID, "text:"+strconv.Itoa(index), role, channel, mediaType, entry.Text))
			}
		}
	case "Reasoning":
		if summary := strings.Join(item.SummaryText, "\n\n"); summary != "" {
			r.ref(path("summary_text"), r.text(item.ID, "summary", "assistant", "reasoning", mediaMarkdown, summary))
		}
		if raw := strings.Join(item.RawContent, "\n\n"); raw != "" {
			r.ref(path("raw_content"), r.text(item.ID, "raw", "assistant", "reasoning", mediaPlain, raw))
		} else {
			// Only the response_item's ciphertext holds it; the placeholder
			// comes from this designated item, never from that copy.
			r.withheld(item.ID, "raw", "assistant", "reasoning", mediaPlain, "source_unavailable", "encrypted_at_source", 0)
		}
	case "CommandExecution":
		r.commandExecution(item, path)
	case "FileChange":
		r.callID = item.ID
		r.inScript()
		paths := make([]string, 0, len(item.Changes))
		for changed := range item.Changes {
			paths = append(paths, changed)
		}
		sort.Strings(paths)
		for _, changed := range paths {
			change := item.Changes[changed]
			switch {
			case change.UnifiedDiff != "":
				r.text(item.ID, "diff:"+changed, "tool", "diff", mediaDiff, change.UnifiedDiff)
				r.partRef(path("changes", changed, "unified_diff"), "diff:"+changed)
			case change.Content != "":
				r.text(item.ID, "file:"+changed, "tool", "file_content", mediaPlain, change.Content)
				r.partRef(path("changes", changed, "content"), "file:"+changed)
			}
		}
		r.output(item.ID, "stdout", "tool_output", item.Stdout, path("stdout"))
		r.output(item.ID, "stderr", "tool_output", item.Stderr, path("stderr"))
	case "McpToolCall":
		r.callID = item.ID
		r.inScript()
		if arguments, ok := compactJSON(item.Arguments); ok {
			r.ref(path("arguments"), r.text(item.ID, "input", "assistant", "tool_input", mediaJSON, arguments))
		}
		if result, ok := compactJSON(item.Result); ok {
			r.ref(path("result"), r.text(item.ID, "output", "tool", "tool_output", mediaJSON, result))
		}
		if item.Error != nil && item.Error.Message != "" {
			r.ref(path("error", "message"), r.text(item.ID, "error", "tool", "error", mediaPlain, item.Error.Message))
		}
	case "ContextCompaction":
		r.withheld(item.ID, "summary", "system", "summary", mediaPlain, "source_unavailable", "encrypted_at_source", 0)
	}
	return nil
}

func (r *lineReader) commandExecution(item completedItem, path func(...any) []any) {
	r.callID = item.ID
	r.inScript()
	command := commandText(item.Command)
	commandItem := r.text(item.ID, "command", "tool", "tool_input", mediaPlain, command)
	r.ref(path("command"), commandItem)
	for index, parsed := range item.ParsedCommand {
		r.digest(path("parsed_cmd", index, "cmd"), parsed.Cmd, r.key(item.ID, "command"))
	}
	stdout := r.output(item.ID, "stdout", "command_output", item.Stdout, path("stdout"))
	r.output(item.ID, "stderr", "command_output", item.Stderr, path("stderr"))
	switch {
	case item.AggregatedOutput == item.Stdout && stdout != "":
		r.digest(path("aggregated_output"), item.AggregatedOutput, stdout)
	default:
		r.output(item.ID, "aggregated", "command_output", item.AggregatedOutput, path("aggregated_output"))
	}
	if item.FormattedOutput != "" {
		// What the model saw: a cut view of the same output.
		r.digest(path("formatted_output"), item.FormattedOutput, stdout)
	}
	if cwd, isURL := strings.CutPrefix(item.Cwd, "file://"); isURL {
		r.edits = append(r.edits, leafEdit{path: path("cwd"), value: cwd})
	}
}

// output declares a non-empty output stream, cut at source when Codex
// says so, and returns its key.
func (r *lineReader) output(ref, part, channel, body string, leaf []any) string {
	if body == "" {
		return ""
	}
	item := agent.ContentItem{NativeRef: ref, Part: part, Role: "tool", Channel: channel, MediaType: mediaPlain, Text: &body, CallID: r.callID}
	if marks := omittedBytesMarker.FindAllStringSubmatchIndex(body, 2); len(marks) == 1 {
		// Codex keeps 1 MiB, head and tail, around "... N bytes omitted ...".
		omitted, _ := strconv.ParseInt(body[marks[0][2]:marks[0][3]], 10, 64)
		item.SourceTruncated = true
		item.OriginalBytes = int64(len(body)) - int64(marks[0][1]-marks[0][0]) + omitted
	}
	r.ref(leaf, r.add(item))
	return r.key(ref, part)
}

// inScript links the item completing now to the code-mode script open in
// its turn; a late item, or one in another turn, links to nothing.
func (r *lineReader) inScript() {
	if r.state.Script != "" && r.state.ScriptTurn == r.turn {
		r.parentCallID = r.state.Script
	}
}

// commandText is the script a shell ran, as Codex shows it.
func commandText(argv []string) string {
	if len(argv) == 3 && (argv[1] == "-lc" || argv[1] == "-c") {
		return argv[2]
	}
	return strings.Join(argv, " ")
}

func compactJSON(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", false
	}
	var compacted bytes.Buffer
	if json.Compact(&compacted, raw) != nil {
		return "", false
	}
	return compacted.String(), true
}
