// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package contracttest

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// Agent is a generic hook agent whose session files are fixture lines: the
// test reader rich capture's provider-neutral path is exercised with. Its
// hook payload is {"session_id", "cwd", "hook_event_name", "session_file"}.
type Agent struct {
	Name string
	// Parsed, when set, counts the lines parsed.
	Parsed *atomic.Int64
	// Lines, when set, receives each line handed to the parser.
	Lines func(agent.ContentLine)
	// Discovered, when set, is what a hookless discovery finds.
	Discovered func() []agent.ContentFileRef
	// Root is the directory its session files live under.
	Root string
	// OtherHarnesses are the harnesses besides Name its files may name.
	OtherHarnesses []string
	// ParseOnly hides the parser's LineAt, as for a parser without one.
	ParseOnly bool
}

const fixtureParserVersion = "companion-contract-fixture/1"

func (a Agent) ID() string                      { return a.Name }
func (Agent) Discover(agent.Env) agent.Presence { return agent.Presence{Installed: true} }
func (Agent) Install(agent.Env) error           { return nil }
func (Agent) Uninstall(agent.Env) error         { return nil }
func (Agent) Status(agent.Env) agent.IntegrationStatus {
	return agent.IntegrationStatus{State: agent.Installed}
}
func (Agent) Repair(agent.Env) (bool, error)      { return false, nil }
func (Agent) Ingress() agent.Ingress              { return agent.IngressHook }
func (Agent) BeaconPlatform() string              { return "claude" }
func (Agent) BeaconCommand(string) (string, bool) { return "claude-hook", true }
func (Agent) ToolOutput(string) []string          { return nil }
func (Agent) RewriteCwd(payload map[string]any, cwd string) {
	payload["cwd"] = cwd
}

func (Agent) PrepareBeaconInput(_ string, payload map[string]any) map[string]any { return payload }

func (Agent) IdentityPreserved(observation agent.Observation, sanitized map[string]any) bool {
	return sanitized["session_id"] == observation.NativeSessionID
}

func (Agent) ParseHook(raw []byte) (agent.Observation, map[string]any, error) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return agent.Observation{}, nil, agent.ErrInvalidHook
	}
	session, _ := payload["session_id"].(string)
	cwd, _ := payload["cwd"].(string)
	event, _ := payload["hook_event_name"].(string)
	if session == "" {
		return agent.Observation{}, nil, agent.ErrMissingIdentity
	}
	return agent.Observation{NativeSessionID: session, Cwd: cwd, Event: event}, payload, nil
}

func (Agent) ContentFile(_ string, payload map[string]any) (string, bool) {
	path, ok := payload["session_file"].(string)
	return path, ok && path != ""
}

func (a Agent) ContentParser() agent.ContentParser {
	parser := fixtureParser{parsed: a.Parsed, lines: a.Lines}
	if a.ParseOnly {
		return parseOnlyParser{parser}
	}
	return parser
}

// parseOnlyParser is the fixture parser without LineAt.
type parseOnlyParser struct{ parser fixtureParser }

func (p parseOnlyParser) Kind() string    { return p.parser.Kind() }
func (p parseOnlyParser) Version() string { return p.parser.Version() }
func (p parseOnlyParser) Header(firstLine []byte) (agent.ContentHeader, bool) {
	return p.parser.Header(firstLine)
}
func (p parseOnlyParser) Parse(line agent.ContentLine, raw json.RawMessage) (agent.ContentRecord, json.RawMessage, error) {
	return p.parser.Parse(line, raw)
}

func (a Agent) ContentRoots(agent.Env) []string {
	if a.Root == "" {
		return nil
	}
	return []string{a.Root}
}

func (a Agent) Harnesses() []string { return a.OtherHarnesses }

func (a Agent) DiscoverContent(_ agent.Env, limit int) []agent.ContentFileRef {
	if a.Discovered == nil {
		return nil
	}
	found := a.Discovered()
	return found[:min(limit, len(found))]
}

// Line is one fixture session-file line. A line of type "session" is the
// file's header and states when the session began.
type Line struct {
	Type   string     `json:"type,omitempty"`
	Began  *time.Time `json:"began,omitempty"`
	Parent string     `json:"parent,omitempty"`
	// Harness, on a header, is the harness the file names.
	Harness string    `json:"harness,omitempty"`
	ID      string    `json:"id,omitempty"`
	At      time.Time `json:"at,omitzero"`
	Cwd     string    `json:"cwd,omitempty"`
	Copied  bool      `json:"copied,omitempty"`
	Items   []Item    `json:"items,omitempty"`
}

type Item struct {
	Part            string  `json:"part"`
	Role            string  `json:"role"`
	Channel         string  `json:"channel"`
	MediaType       string  `json:"media_type"`
	CallID          string  `json:"call_id,omitempty"`
	TurnID          string  `json:"turn_id,omitempty"`
	DisplayPath     string  `json:"display_path,omitempty"`
	RestatesContext bool    `json:"restates_context,omitempty"`
	Text            *string `json:"text,omitempty"`
	DataBase64      string  `json:"data_base64,omitempty"`
	Store           *Store  `json:"store,omitempty"`
	Coverage        string  `json:"coverage,omitempty"`
	Reason          string  `json:"reason,omitempty"`
	SourceTruncated bool    `json:"source_truncated,omitempty"`
	OriginalBytes   int64   `json:"original_bytes,omitempty"`
}

// Store names a harness body store; Head is what the record kept of it.
type Store struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Within string `json:"within"`
	Head   string `json:"head"`
}

// Encode is the line as the session file holds it, newline included.
func (l Line) Encode() string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.Encode(l)
	return buffer.String()
}

// TextItem is a text item; Text sets its body.
func TextItem(part, role, channel, mediaType, text string) Item {
	return Item{Part: part, Role: role, Channel: channel, MediaType: mediaType, Text: &text}
}

// WireItems are the items a wire example's record declares, with the inline
// bodies it carries and the given body for each uploaded text item, so the
// reader is driven by the contract's own shapes.
func WireItems(t testing.TB, name string, uploadedText func(channel string) string) []Item {
	t.Helper()
	var record struct {
		Contents []struct {
			Role       string  `json:"role"`
			Channel    string  `json:"channel"`
			MediaType  string  `json:"media_type"`
			Coverage   string  `json:"coverage"`
			Delivery   string  `json:"delivery"`
			InlineText *string `json:"inline_text"`
			CallID     string  `json:"call_id"`
			TurnID     string  `json:"turn_id"`
		} `json:"contents"`
	}
	if err := json.Unmarshal(WireExample(t, name).Body, &record); err != nil {
		t.Fatal(err)
	}
	var items []Item
	for index, content := range record.Contents {
		if content.Channel == "attachment" || content.Delivery == "none" {
			continue
		}
		item := Item{Part: "text:" + strconv.Itoa(index), Role: content.Role, Channel: content.Channel, MediaType: content.MediaType, CallID: content.CallID, TurnID: content.TurnID}
		switch {
		case content.InlineText != nil:
			item.Text = content.InlineText
		default:
			body := uploadedText(content.Channel)
			item.Text = &body
		}
		items = append(items, item)
	}
	return items
}

type fixtureParser struct {
	parsed *atomic.Int64
	lines  func(agent.ContentLine)
}

func (fixtureParser) Kind() string    { return "pi_session" }
func (fixtureParser) Version() string { return fixtureParserVersion }

func (fixtureParser) Header(firstLine []byte) (agent.ContentHeader, bool) {
	var header Line
	if json.Unmarshal(firstLine, &header) != nil || header.Type != "session" || header.Began == nil {
		return agent.ContentHeader{}, false
	}
	return agent.ContentHeader{Began: *header.Began, ParentSessionID: header.Parent, Harness: header.Harness}, true
}

// parserState counts the lines parsed, so tests can see it survive restarts.
type parserState struct {
	Lines int `json:"lines"`
}

func (fixtureParser) LineAt(line []byte) (time.Time, bool) {
	var stamped struct {
		At time.Time `json:"at"`
	}
	if json.Unmarshal(line, &stamped) != nil || stamped.At.IsZero() {
		return time.Time{}, false
	}
	return stamped.At, true
}

func (p fixtureParser) Parse(line agent.ContentLine, raw json.RawMessage) (agent.ContentRecord, json.RawMessage, error) {
	if p.parsed != nil {
		p.parsed.Add(1)
	}
	if p.lines != nil {
		p.lines(line)
	}
	var state parserState
	if len(raw) > 0 {
		json.Unmarshal(raw, &state)
	}
	state.Lines++
	next, _ := json.Marshal(state)
	var parsed Line
	if err := json.Unmarshal(line.Bytes, &parsed); err != nil {
		return agent.ContentRecord{}, next, err
	}
	record := agent.ContentRecord{At: parsed.At, Cwd: parsed.Cwd, Copied: parsed.Copied, SchemaVersion: "fixture/1"}
	for _, item := range parsed.Items {
		content := agent.ContentItem{
			NativeRef: parsed.ID, Part: item.Part, Role: item.Role, Channel: item.Channel, MediaType: item.MediaType,
			CallID: item.CallID, TurnID: item.TurnID, DisplayPath: item.DisplayPath, Text: item.Text, RestatesContext: item.RestatesContext,
			Coverage: item.Coverage, CoverageReason: item.Reason, SourceTruncated: item.SourceTruncated, OriginalBytes: item.OriginalBytes,
		}
		if item.DataBase64 != "" {
			data, err := base64.StdEncoding.DecodeString(item.DataBase64)
			if err != nil {
				return agent.ContentRecord{}, next, err
			}
			content.Data = data
		}
		if item.Store != nil {
			head := item.Store.Head
			content.Store = &agent.BodyStore{Path: item.Store.Path, Kind: item.Store.Kind, Within: item.Store.Within, Matches: func(body []byte) bool {
				return strings.HasPrefix(string(body), head)
			}}
		}
		record.Items = append(record.Items, content)
	}
	return record, next, nil
}
