// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// ContentSource is an agent whose own session files hold what rich capture
// reads: prompts, replies, tool input and output, embedded attachments.
// The agent only names its files and parses their lines; reading, admission,
// redaction, placement, spooling and upload are the daemon's.
type ContentSource interface {
	// ContentFile names the session file a hook observation belongs to, from
	// the raw payload. It must stay cheap: the hook shim calls it.
	ContentFile(event string, payload map[string]any) (string, bool)
	ContentParser() ContentParser
	// ContentRoots are the absolute directories the agent's own session
	// files live under, honoring its env overrides; the daemon reads no
	// session file outside them, however it was named.
	ContentRoots(env Env) []string
}

// HarnessFamily is a ContentSource whose session files may name harnesses
// besides its own id (Codex CLI and Desktop): capture is windowed for each
// apart, and a file naming any other harness is captured for the adapter.
type HarnessFamily interface {
	Harnesses() []string
}

// ContentDiscoverer is a ContentSource whose sessions run without hooks
// (Codex Desktop): it names the session files under its own directories,
// newest first, which the daemon's transcript poll reads like any other.
type ContentDiscoverer interface {
	DiscoverContent(env Env, limit int) []ContentFileRef
}

// ContentFileRef is a session file found without a hook, with the session
// it holds as its own header states it.
type ContentFileRef struct {
	Path            string
	NativeSessionID string
	Cwd             string
	// Harness names the harness when one adapter serves several.
	Harness string
	// Began is when the session began, zero when its header does not say;
	// ParentSessionID the session it forked from.
	Began           time.Time
	ParentSessionID string
	// ParentThreadID is the thread that spawned this one as a subagent,
	// which shares none of its history, unlike ParentSessionID's.
	ParentThreadID string
}

// SessionRelations is an agent whose session files name, in their own
// header, the session they hold and the one it descends from, so a hook's
// claim about a file can be checked against the file itself.
type SessionRelations interface {
	// SessionRelation reads path's header, confined to the agent's own
	// directories and bounded; ok is false when it is no readable header.
	SessionRelation(env Env, path string) (relation SessionRelation, ok bool)
}

// SessionRelation is what a session file's header states: its session and
// the one it forked from, else the one that spawned it ("" for neither).
type SessionRelation struct {
	SessionID       string
	ParentSessionID string
}

// EnvelopeParent is the session the upload envelopes name as this one's
// parent: the one it forked from, else the one that spawned it.
func (ref ContentFileRef) EnvelopeParent() string {
	if ref.ParentSessionID != "" {
		return ref.ParentSessionID
	}
	return ref.ParentThreadID
}

// LineTimestamps is a ContentParser that reads a line's time alone, so
// placing a resumed session's cursor parses none of what came before it.
type LineTimestamps interface {
	LineAt(line []byte) (time.Time, bool)
}

// ContentParser reads one agent's session file format.
type ContentParser interface {
	// Kind is the source kind declared upstream (claude_transcript,
	// codex_rollout, pi_session); Version labels the parser, e.g.
	// companion-claude-transcript/1.
	Kind() string
	Version() string
	// Header reads what a file's first line says of its session, for files
	// that record it (a Pi header, Codex session_meta).
	Header(firstLine []byte) (ContentHeader, bool)
	// Parse reads one complete line. state is the parser's own state for the
	// file, persisted with the read position; nil on the file's first read.
	Parse(line ContentLine, state json.RawMessage) (ContentRecord, json.RawMessage, error)
}

// ContentHeader is what a session file says of its session.
type ContentHeader struct {
	// Began is when the native session itself started.
	Began time.Time
	// ParentSessionID names the session this one forked from (Pi
	// parentSession, Codex forked_from_id): items it already declared are
	// copies here, never this session's content.
	ParentSessionID string
	// Harness is the harness the file itself names, when one adapter serves
	// several (Codex session_meta.originator); it decides over a sighting's.
	Harness string
}

type ContentLine struct {
	Bytes []byte
	// Path is the absolute session file the line is read from; harness-owned
	// locations derive from it, never from a path the record names.
	Path string
	// Offset is where the line starts in its file.
	Offset          int64
	Harness         string
	NativeSessionID string
}

// ContentRecord is what one native line holds.
type ContentRecord struct {
	// At is the line's own time; admission is decided at it.
	At time.Time
	// Cwd is the directory the line's turn ran in, for sources that record
	// it per turn; "" is the session's.
	Cwd string
	// SchemaVersion is <source>/<agent version>.
	SchemaVersion string
	// Copied marks a line a fork or resume copied from another session: it is
	// that session's content, never this one's.
	Copied bool
	Items  []ContentItem
}

// ContentItem is one content item of a line. It carries a text body, an
// embedded attachment, a harness body store, or no body with the coverage
// that says why.
type ContentItem struct {
	// NativeRef is the source's own item id; Part follows the contract's
	// part grammar (text:<i>, image:<i>, input, output, ...).
	NativeRef    string
	Part         string
	Role         string
	Channel      string
	MediaType    string
	EventID      string
	CallID       string
	ParentCallID string
	TurnID       string
	// DisplayPath is the local file an instruction or attachment names; it
	// is placed before it leaves the device.
	DisplayPath string
	Text        *string
	// Data is an embedded attachment's decoded bytes; MediaType is then only
	// a hint, the bytes are sniffed.
	Data  []byte
	Store *BodyStore
	// Coverage and CoverageReason preset what the agent alone can tell:
	// encrypted, harness context, a remote or missing reference.
	Coverage       string
	CoverageReason string
	// RestatesContext marks a compaction summary or re-attached file: in a
	// session begun before its capture generation it restates what was never
	// admitted, and only its metadata is declared.
	RestatesContext bool
	// SourceTruncated: the agent itself stored Text cut, from OriginalBytes.
	SourceTruncated bool
	OriginalBytes   int64
}

// BodyStore is a file the harness keeps a body in beside its record (Claude
// Code's tool-results, Pi's full bash log), the only files besides session
// files that rich capture opens.
type BodyStore struct {
	Path string
	// Kind is harness_session_store or harness_temp_log.
	Kind string
	// Within is the directory the store must lie under.
	Within string
	// Matches confirms the body is the one the record kept part of (its head
	// equals the record's preview, or its tail the kept tail).
	Matches func(body []byte) bool
}

// ContentKey is a content item's identity: native ids only, never content,
// so two identical prompts are two items.
func ContentKey(harness, nativeSessionID, nativeRef, part string) string {
	sum := sha256.Sum256([]byte(harness + "\x00" + nativeSessionID + "\x00" + nativeRef + "\x00" + part))
	return hex.EncodeToString(sum[:])
}

// maxSidecarBytes bounds a harness's session-metadata sidecar.
const maxSidecarBytes = 4 << 10

// ReadSessionSidecar reads a harness's own small session-metadata file
// (Claude's subagents/agent-<id>.meta.json) within dir, through the guarded
// open harness body stores use. It supplies relations only; ok is false for
// anything unreadable, and the relation is then omitted, never guessed.
func ReadSessionSidecar(path, dir string) (data []byte, ok bool) {
	data, err := store.ReadOwnedFile(path, dir, maxSidecarBytes)
	return data, err == nil
}
