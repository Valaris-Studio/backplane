// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Rich capture's wire contract (contracts/rich-capture/wire): content
// declared beside a record's events, its acknowledgement and the chunked
// upload of bodies too large to travel inline.

type ContentSource struct {
	Kind      string  `json:"kind"`
	NativeRef *string `json:"native_ref,omitempty"`
	Order     int64   `json:"order"`
	Parser    string  `json:"parser"`
	// SchemaVersion is <source>/<agent version>.
	SchemaVersion string `json:"schema_version"`
	BodyFrom      string `json:"body_from,omitempty"`
}

// RedactionFact says the secret filter ran and how often it replaced text.
type RedactionFact struct {
	FilterVersion string `json:"filter_version"`
	Replacements  int    `json:"replacements"`
}

// ContentDeclaration is one content item of a session. Its key derives from
// native identities only, never from what it says.
type ContentDeclaration struct {
	ContentKey        string        `json:"content_key"`
	EventID           *string       `json:"event_id,omitempty"`
	CallID            *string       `json:"call_id,omitempty"`
	ParentCallID      *string       `json:"parent_call_id,omitempty"`
	TurnID            *string       `json:"turn_id,omitempty"`
	Role              string        `json:"role"`
	Channel           string        `json:"channel"`
	Source            ContentSource `json:"source"`
	DisplayPath       *string       `json:"display_path,omitempty"`
	OccurredAt        time.Time     `json:"occurred_at"`
	ObservedAt        time.Time     `json:"observed_at"`
	MediaType         string        `json:"media_type"`
	Coverage          string        `json:"coverage"`
	CoverageReason    *string       `json:"coverage_reason,omitempty"`
	Delivery          string        `json:"delivery"`
	ByteCount         *int64        `json:"byte_count,omitempty"`
	SHA256            *string       `json:"sha256,omitempty"`
	OriginalByteCount *int64        `json:"original_byte_count,omitempty"`
	InlineText        *string       `json:"inline_text,omitempty"`
	Redaction         RedactionFact `json:"redaction"`
}

// Delivery of a body.
const (
	DeliveryInline = "inline"
	DeliveryUpload = "upload"
	DeliveryNone   = "none"
)

// The server's ContentDeclaration bounds (backend/app/schemas/session_content.py).
const (
	maxInlineBodyBytes     = 16 << 10
	maxInlineRecordBytes   = 1 << 20
	maxTextBodyBytes       = 32 << 20
	maxAttachmentBodyBytes = 20 << 20
	maxContentsPerRecord   = 256
	maxEventsPerRecord     = 256
	maxChunkBytes          = 4 << 20
	maxChunks              = 8
	maxSourceOrder         = 1 << 62
	maxDisplayPathBytes    = 1024
)

var (
	digestPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	generationPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	uuidPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// NativeIDPattern is the server's NATIVE_ID_PATTERN.
	NativeIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@/+=|-]{0,199}$`)
	mediaTypePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$`)
	versionPattern   = regexp.MustCompile(`^[A-Za-z0-9._:/+-]{1,64}$`)
)

func setOf(values ...string) map[string]bool {
	set := map[string]bool{}
	for _, value := range values {
		set[value] = true
	}
	return set
}

var (
	contentRoles    = setOf("user", "assistant", "tool", "system", "developer", "unknown")
	contentChannels = setOf("prompt", "reply", "reasoning", "tool_input", "tool_output", "diff", "file_content", "command_output", "error", "summary", "instruction", "native_record", "attachment")
	sourceKinds     = setOf("hook", "otlp", "plugin", "claude_transcript", "codex_rollout", "pi_session")
	bodySources     = setOf("harness_session_store", "harness_temp_log")
	deliveries      = setOf(DeliveryInline, DeliveryUpload, DeliveryNone)
	// coverageReasons is COVERAGE_REASONS: which reasons explain which
	// coverage; captured takes none.
	coverageReasons = map[string]map[string]bool{
		"captured":           {},
		"partially_redacted": setOf("secret_filter"),
		"withheld_by_policy": setOf("content_level", "excluded_path", "outside_mapped_root", "media_type_not_permitted", "attachment_oversized", "quota_exceeded", "pre_admission_context", "harness_context"),
		"source_unavailable": setOf("file_missing", "remote_reference", "source_not_supported", "source_replaced", "encrypted_at_source"),
		"collection_failed":  setOf("parse_error", "record_too_large", "file_changed", "spool_full", "source_stalled", "upload_failed", "placement_failed"),
		"truncated":          setOf("body_limit", "source_limit"),
		"not_yet_uploaded":   setOf("upload_pending"),
		"expired":            setOf("staging_expired"),
	}
	bodyCoverage       = setOf("captured", "partially_redacted", "truncated")
	serverOnlyCoverage = setOf("not_yet_uploaded", "expired")
	// AttachmentMediaTypes may be uploaded as attachments; raster images
	// alone render inline.
	AttachmentMediaTypes = setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf", "text/plain", "text/markdown", "application/json")
	// TextMediaTypes are what every channel but attachments carries.
	TextMediaTypes = setOf("text/plain", "text/markdown", "text/x-diff", "application/json", "application/x-ndjson")
)

var errInvalidContent = errors.New("invalid_content")

func invalidContent(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errInvalidContent, fmt.Sprintf(format, args...))
}

func checkCoverage(coverage string, reason *string) error {
	allowed, known := coverageReasons[coverage]
	if !known {
		return invalidContent("unknown coverage %q", coverage)
	}
	if (reason == nil) != (len(allowed) == 0) || reason != nil && !allowed[*reason] {
		return invalidContent("coverage %s does not take reason %v", coverage, reason)
	}
	return nil
}

func optionalNativeID(name string, value *string) error {
	if value != nil && !NativeIDPattern.MatchString(*value) {
		return invalidContent("%s is not a native id", name)
	}
	return nil
}

// ValidDisplayPath reports whether a path is placed: relative to the root or
// ~/…, never absolute and without control characters.
func ValidDisplayPath(path string) bool {
	if path == "" || len(path) > maxDisplayPathBytes || strings.HasPrefix(path, "/") || strings.HasPrefix(path, `\`) || len(path) > 1 && path[1] == ':' {
		return false
	}
	return strings.IndexFunc(path, func(char rune) bool { return char < 0x20 }) < 0
}

// validTruncation: the device's cut states the larger original size; the
// agent's own cut (source_limit) states it only when the agent said it
// (amendment 17).
func validTruncation(d ContentDeclaration) bool {
	if d.OriginalByteCount == nil {
		return d.CoverageReason != nil && *d.CoverageReason == "source_limit"
	}
	return *d.OriginalByteCount > *d.ByteCount
}

// Validate checks a declaration as the server's ContentDeclaration does, so
// the device never sends one the server would reject.
func (d ContentDeclaration) Validate() error {
	switch {
	case !digestPattern.MatchString(d.ContentKey):
		return invalidContent("content_key")
	case d.EventID != nil && (len(*d.EventID) < 1 || len(*d.EventID) > 64):
		return invalidContent("event_id")
	case !contentRoles[d.Role] || !contentChannels[d.Channel] || !deliveries[d.Delivery]:
		return invalidContent("role, channel or delivery")
	case !sourceKinds[d.Source.Kind] || d.Source.Order < 0 || d.Source.Order > maxSourceOrder:
		return invalidContent("source")
	case !versionPattern.MatchString(d.Source.Parser) || !versionPattern.MatchString(d.Source.SchemaVersion) || !versionPattern.MatchString(d.Redaction.FilterVersion):
		return invalidContent("version labels")
	case d.Source.BodyFrom != "" && !bodySources[d.Source.BodyFrom]:
		return invalidContent("body_from")
	case d.DisplayPath != nil && !ValidDisplayPath(*d.DisplayPath):
		return invalidContent("display_path must be placed")
	case d.OccurredAt.IsZero() || d.ObservedAt.IsZero():
		return invalidContent("times")
	case len(d.MediaType) > 127 || !mediaTypePattern.MatchString(d.MediaType):
		return invalidContent("media_type")
	case d.Channel == "native_record" && d.MediaType != "application/json" && d.MediaType != "application/x-ndjson":
		// Its refs resolve only in JSON: in any other type a raw path stays.
		return invalidContent("native_record media_type")
	case d.Redaction.Replacements < 0:
		return invalidContent("replacements")
	case serverOnlyCoverage[d.Coverage]:
		return invalidContent("only the server reports %s", d.Coverage)
	case d.ByteCount != nil && (*d.ByteCount < 0 || *d.ByteCount > maxTextBodyBytes):
		return invalidContent("byte_count")
	case d.SHA256 != nil && !digestPattern.MatchString(*d.SHA256):
		return invalidContent("sha256")
	case d.OriginalByteCount != nil && *d.OriginalByteCount < 0:
		return invalidContent("original_byte_count")
	}
	for name, id := range map[string]*string{"native_ref": d.Source.NativeRef, "call_id": d.CallID, "parent_call_id": d.ParentCallID, "turn_id": d.TurnID} {
		if err := optionalNativeID(name, id); err != nil {
			return err
		}
	}
	if err := checkCoverage(d.Coverage, d.CoverageReason); err != nil {
		return err
	}
	hasBody := bodyCoverage[d.Coverage]
	switch {
	case hasBody == (d.Delivery == DeliveryNone):
		return invalidContent("coverage %s contradicts delivery %s", d.Coverage, d.Delivery)
	case hasBody != (d.ByteCount != nil && d.SHA256 != nil):
		return invalidContent("a body, and only a body, states byte_count and sha256")
	case d.Source.BodyFrom != "" && !hasBody:
		return invalidContent("body_from names where a body came from")
	case (d.Coverage == "partially_redacted") != (d.Redaction.Replacements > 0):
		return invalidContent("partially_redacted means the filter replaced text")
	case d.Coverage == "truncated" && !validTruncation(d):
		return invalidContent("truncated needs the larger original_byte_count")
	case (d.Delivery == DeliveryInline) != (d.InlineText != nil):
		return invalidContent("inline_text comes with inline delivery only")
	}
	if d.Channel == "attachment" {
		switch {
		case d.Delivery == DeliveryInline:
			return invalidContent("attachments are uploaded, never inline")
		case hasBody && !AttachmentMediaTypes[d.MediaType]:
			return invalidContent("%s is not a permitted attachment type", d.MediaType)
		case d.ByteCount != nil && *d.ByteCount > maxAttachmentBodyBytes:
			return invalidContent("attachment too large")
		}
	} else if hasBody && !TextMediaTypes[d.MediaType] {
		return invalidContent("%s content is text, not %s", d.Channel, d.MediaType)
	}
	if d.InlineText != nil {
		sum := sha256.Sum256([]byte(*d.InlineText))
		switch {
		case len(*d.InlineText) > maxInlineBodyBytes:
			return invalidContent("inline_text too large")
		case *d.ByteCount != int64(len(*d.InlineText)):
			return invalidContent("byte_count must be inline_text's size")
		case *d.SHA256 != hex.EncodeToString(sum[:]):
			return invalidContent("sha256 must be inline_text's digest")
		}
	}
	return nil
}

// CaptureGeneration is the forward-only capture generation a record's
// contents belong to.
type CaptureGeneration struct {
	ID             string    `json:"id"`
	Profile        string    `json:"profile"`
	AdmittedFrom   time.Time `json:"admitted_from"`
	PolicyRevision string    `json:"policy_revision"`
}

// ValidateRich checks a record that declares content as the server's
// RichCaptureRecord does.
func (r Record) ValidateRich() error {
	switch {
	case len(r.Events) == 0 && len(r.Contents) == 0:
		return invalidContent("a record carries events, contents or both")
	case len(r.Events) > maxEventsPerRecord || len(r.Contents) > maxContentsPerRecord:
		return invalidContent("too many events or contents")
	case (len(r.Contents) > 0) != (r.CaptureGeneration != nil):
		return invalidContent("contents come with their capture_generation")
	}
	if generation := r.CaptureGeneration; generation != nil {
		if !generationPattern.MatchString(generation.ID) || generation.Profile != "rich" || generation.AdmittedFrom.IsZero() || !digestPattern.MatchString(generation.PolicyRevision) {
			return invalidContent("capture_generation")
		}
	}
	keys := map[string]bool{}
	var inline int64
	for _, declaration := range r.Contents {
		if keys[declaration.ContentKey] {
			return invalidContent("a content item is declared once per record")
		}
		keys[declaration.ContentKey] = true
		if err := declaration.Validate(); err != nil {
			return err
		}
		if declaration.InlineText != nil {
			inline += *declaration.ByteCount
		}
	}
	if inline > maxInlineRecordBytes {
		return invalidContent("inline bodies exceed a record's inline bound")
	}
	return nil
}

// EventsOnlyCaptureID is capture_id' = sha256("events-only" ‖ capture_id)[:32].
func EventsOnlyCaptureID(captureID string) string {
	sum := sha256.Sum256([]byte("events-only\x00" + captureID))
	return hex.EncodeToString(sum[:])[:32]
}

// EventsOnly is the record without its rich members, under capture_id': what
// a server that refused the rich record still accepts. ok is false when
// nothing but content is left.
func (r Record) EventsOnly() (Record, bool) {
	if len(r.Events) == 0 {
		return Record{}, false
	}
	r.CaptureID = EventsOnlyCaptureID(r.CaptureID)
	r.Contents, r.CaptureGeneration = nil, nil
	return r, true
}

type UploadSlot struct {
	ChunkBytes     int64     `json:"chunk_bytes"`
	ChunkCount     int       `json:"chunk_count"`
	ReceivedChunks []int     `json:"received_chunks"`
	ExpiresAt      time.Time `json:"expires_at"`
}

// Content outcomes. available, recorded, dropped and rejected settle the
// spooled body; upload_required keeps it until the upload settles.
const (
	OutcomeAvailable      = "available"
	OutcomeRecorded       = "recorded"
	OutcomeUploadRequired = "upload_required"
	OutcomeDropped        = "dropped"
	OutcomeRejected       = "rejected"
)

type ContentAck struct {
	CaptureID      string      `json:"capture_id"`
	ContentKey     string      `json:"content_key"`
	Outcome        string      `json:"outcome"`
	ContentID      string      `json:"content_id,omitempty"`
	Coverage       string      `json:"coverage,omitempty"`
	CoverageReason string      `json:"coverage_reason,omitempty"`
	Rejection      string      `json:"rejection,omitempty"`
	Upload         *UploadSlot `json:"upload,omitempty"`
}

type ChunkReceipt struct {
	ContentID      string `json:"content_id"`
	Index          int    `json:"index"`
	ReceivedChunks []int  `json:"received_chunks"`
	ChunkCount     int    `json:"chunk_count"`
	Complete       bool   `json:"complete"`
}

// Upload states.
const (
	UploadPending   = "pending"
	UploadAvailable = "available"
	UploadRecorded  = "recorded"
)

type ContentUploadState struct {
	ContentID      string      `json:"content_id"`
	State          string      `json:"state"`
	Coverage       string      `json:"coverage"`
	CoverageReason string      `json:"coverage_reason,omitempty"`
	Upload         *UploadSlot `json:"upload,omitempty"`
}

// Content upload error codes the device acts on.
const (
	CodeUploadIncomplete       = "upload_incomplete"
	CodeChunkConflict          = "chunk_conflict"
	CodeBodyChecksumMismatch   = "body_checksum_mismatch"
	CodeChunkChecksumMismatch  = "chunk_checksum_mismatch"
	CodeRichCaptureUnavailable = "rich_capture_unavailable"
)

// Requests carry their own deadline on a client without a global timeout:
// a 4 MiB chunk may need longer than a JSON call ever should.
var (
	jsonDeadline  = 15 * time.Second
	chunkDeadline = 60 * time.Second
)

const chunkDigestHeader = "Backplane-Chunk-SHA256"

func contentPath(contentID string) string {
	return "/api/companion/contents/" + url.PathEscape(contentID)
}

// PutContentChunk uploads one chunk of a body the ingest answered
// upload_required.
func (c *Client) PutContentChunk(ctx context.Context, contentID string, index int, chunk []byte) (ChunkReceipt, error) {
	sum := sha256.Sum256(chunk)
	data, err := c.send(ctx, exchange{
		method: http.MethodPut, path: contentPath(contentID) + "/chunks/" + strconv.Itoa(index), token: c.token, body: chunk,
		contentType: "application/octet-stream", headers: map[string]string{chunkDigestHeader: hex.EncodeToString(sum[:])}, deadline: chunkDeadline,
	})
	if err != nil {
		return ChunkReceipt{}, err
	}
	var receipt ChunkReceipt
	if err := decode(data, &receipt); err != nil {
		return ChunkReceipt{}, err
	}
	if err := receipt.validate(); err != nil {
		return ChunkReceipt{}, fmt.Errorf("%w: %v", ErrInvalidResponse, err)
	}
	return receipt, nil
}

// FinalizeContent publishes an uploaded body once it matches its
// declaration.
func (c *Client) FinalizeContent(ctx context.Context, contentID string, byteCount int64, sha256 string) (ContentUploadState, error) {
	data, err := c.do(ctx, http.MethodPost, contentPath(contentID)+"/finalize", c.token, map[string]any{"byte_count": byteCount, "sha256": sha256})
	if err != nil {
		return ContentUploadState{}, err
	}
	return parseUploadState(data)
}

// ContentUpload reads where an upload stands, to resume it.
func (c *Client) ContentUpload(ctx context.Context, contentID string) (ContentUploadState, error) {
	data, err := c.do(ctx, http.MethodGet, contentPath(contentID), c.token, nil)
	if err != nil {
		return ContentUploadState{}, err
	}
	return parseUploadState(data)
}

func parseUploadState(data []byte) (ContentUploadState, error) {
	var state ContentUploadState
	if err := decode(data, &state); err != nil {
		return ContentUploadState{}, err
	}
	if err := state.validate(); err != nil {
		return ContentUploadState{}, fmt.Errorf("%w: %v", ErrInvalidResponse, err)
	}
	return state, nil
}

func (s UploadSlot) validate() error {
	if s.ChunkBytes < 1 || s.ChunkBytes > maxChunkBytes || s.ChunkCount < 1 || s.ChunkCount > maxChunks || len(s.ReceivedChunks) > maxChunks {
		return invalidContent("upload slot")
	}
	for _, index := range s.ReceivedChunks {
		if index < 0 || index >= s.ChunkCount {
			return invalidContent("received_chunks must index the upload's chunks")
		}
	}
	return nil
}

func (r ChunkReceipt) validate() error {
	received := map[int]bool{}
	for _, index := range r.ReceivedChunks {
		received[index] = true
	}
	switch {
	case !uuidPattern.MatchString(r.ContentID) || r.Index < 0 || r.Index >= maxChunks || r.ChunkCount < 1 || r.ChunkCount > maxChunks || len(r.ReceivedChunks) > maxChunks:
		return invalidContent("chunk receipt")
	case !received[r.Index]:
		return invalidContent("a receipt's chunk is among the received ones")
	case r.Complete != (len(received) == r.ChunkCount):
		return invalidContent("complete means every chunk was received")
	}
	return nil
}

func (s ContentUploadState) validate() error {
	var reason *string
	if s.CoverageReason != "" {
		reason = &s.CoverageReason
	}
	switch {
	case !uuidPattern.MatchString(s.ContentID) || !setOf(UploadPending, UploadAvailable, UploadRecorded)[s.State]:
		return invalidContent("upload state")
	case (s.State == UploadPending) != (s.Upload != nil):
		return invalidContent("a pending upload states its slot")
	case s.State == UploadAvailable && !bodyCoverage[s.Coverage]:
		return invalidContent("an available body has body coverage")
	case s.Upload != nil && s.Upload.validate() != nil:
		return s.Upload.validate()
	}
	return checkCoverage(s.Coverage, reason)
}

var (
	contentOutcomes   = setOf(OutcomeAvailable, OutcomeRecorded, OutcomeUploadRequired, OutcomeDropped, OutcomeRejected)
	contentRejections = setOf("invalid", "conflict", "before_admission", "generation_mismatch")
)

func (a ContentAck) validate() error {
	stored := a.Outcome == OutcomeAvailable || a.Outcome == OutcomeRecorded || a.Outcome == OutcomeUploadRequired
	switch {
	case !captureIDPattern.MatchString(a.CaptureID) || !digestPattern.MatchString(a.ContentKey) || !contentOutcomes[a.Outcome]:
		return invalidContent("content ack")
	case stored != (a.ContentID != ""), a.ContentID != "" && !uuidPattern.MatchString(a.ContentID):
		return invalidContent("stored outcomes, and only they, name the content_id")
	case (a.Outcome == OutcomeUploadRequired) != (a.Upload != nil):
		return invalidContent("upload comes with upload_required only")
	case (a.Outcome == OutcomeRejected) != (a.Rejection != ""), a.Rejection != "" && !contentRejections[a.Rejection]:
		return invalidContent("rejection comes with rejected only")
	case (a.Outcome == OutcomeRecorded) != (a.Coverage != ""):
		return invalidContent("recorded states the coverage the server applied")
	case a.Coverage == "" && a.CoverageReason != "":
		return invalidContent("coverage_reason needs coverage")
	case a.Upload != nil && a.Upload.validate() != nil:
		return a.Upload.validate()
	}
	if a.Coverage != "" {
		var reason *string
		if a.CoverageReason != "" {
			reason = &a.CoverageReason
		}
		return checkCoverage(a.Coverage, reason)
	}
	return nil
}

// validateContents checks the content acks as RichIngestResult does: each
// is well formed, belongs to an acknowledged record, and a dropped record's
// are all dropped.
func (a Ack) validateContents() error {
	acknowledged, dropped := map[string]bool{}, map[string]bool{}
	for _, id := range a.Acknowledged {
		acknowledged[id] = true
	}
	for _, drop := range a.Dropped {
		dropped[drop.CaptureID] = true
	}
	for _, content := range a.Contents {
		if err := content.validate(); err != nil {
			return err
		}
		if !acknowledged[content.CaptureID] {
			return invalidContent("content acks belong to acknowledged records")
		}
		if dropped[content.CaptureID] && content.Outcome != OutcomeDropped {
			return invalidContent("a dropped record's declarations are dropped")
		}
	}
	return nil
}

// RichCaptureStatus is the heartbeat's rich_capture member, sent only to a
// server that offered rich capture.
type RichCaptureStatus struct {
	Sources []RichSourceStatus `json:"sources"`
	Spool   SpoolStatus        `json:"spool"`
}

type RichSourceStatus struct {
	Harness string `json:"harness"`
	// State is capturing, unsupported, source_unavailable, stalled or error.
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

type SpoolStatus struct {
	PendingBodies   int        `json:"pending_bodies"`
	PendingBytes    int64      `json:"pending_bytes"`
	OldestPendingAt *time.Time `json:"oldest_pending_at,omitempty"`
	FailedTotal     uint64     `json:"failed_total"`
}
