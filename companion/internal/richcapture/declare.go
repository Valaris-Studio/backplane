// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// FilterVersion labels the secret filter every body passes.
const FilterVersion = "asymptoteobserve-redact/1"

const (
	coverageCaptured  = "captured"
	coverageRedacted  = "partially_redacted"
	coverageTruncated = "truncated"
	coverageWithheld  = "withheld_by_policy"
	coverageMissing   = "source_unavailable"
	coverageFailed    = "collection_failed"
)

// Declarer turns a parsed item into its declaration and the body to spool.
type Declarer struct {
	Harness         string
	NativeSessionID string
	Kind            string
	Parser          string
	Place           privacy.Place
	Limits          policy.RichCaptureLimits
	ObservedAt      time.Time
	// SessionBegan and AdmittedFrom decide whether a restated context (a
	// compaction summary, a re-attached file) restates pre-admission
	// activity; an unknown start counts as before.
	SessionBegan time.Time
	AdmittedFrom time.Time
	// Excluded reports whether a placed display path matches the
	// installation's exclude globs.
	Excluded func(displayPath string) bool
	// nativeRef is the item being declared, whose refs a native record
	// resolves; malformed counts the refs written as null.
	nativeRef string
	malformed *int
}

// Declared is one item ready to queue: its declaration, and the body to
// spool when it is uploaded.
type Declared struct {
	Declaration uplink.ContentDeclaration
	Body        []byte
	// MalformedRefs counts native-record refs written as null.
	MalformedRefs int
}

// Declare redacts, places and bounds an item. order is the line's offset.
func (d Declarer) Declare(record agent.ContentRecord, item agent.ContentItem, order int64) Declared {
	malformed := 0
	d.nativeRef, d.malformed = item.NativeRef, &malformed
	declared := d.declare(record, item, order)
	declared.MalformedRefs = malformed
	return declared
}

func (d Declarer) declare(record agent.ContentRecord, item agent.ContentItem, order int64) Declared {
	declaration := d.base(record, item, order)
	if path := namedPath(item); path != "" {
		placed := privacy.PlaceValue(path, d.Place)
		// A relative path has no known directory to place it from.
		unplaceable := !privacy.AbsolutePath(path)
		if !unplaceable && uplink.ValidDisplayPath(placed) {
			declaration.DisplayPath = &placed
		}
		switch {
		case unplaceable || !uplink.ValidDisplayPath(placed) || strings.HasPrefix(placed, "~"):
			return bodiless(declaration, coverageWithheld, "outside_mapped_root", 0)
		case d.Excluded != nil && d.Excluded(placed):
			return bodiless(declaration, coverageWithheld, "excluded_path", 0)
		}
	}
	switch {
	case item.Coverage != "":
		return bodiless(declaration, item.Coverage, item.CoverageReason, item.OriginalBytes)
	case item.RestatesContext && (d.SessionBegan.IsZero() || d.SessionBegan.Before(d.AdmittedFrom)):
		return bodiless(declaration, coverageWithheld, "pre_admission_context", 0)
	case item.Data != nil:
		return d.attachment(declaration, item.Data)
	}
	body, sourceTruncated := item.Text, item.SourceTruncated
	if item.Store != nil {
		stored, err := ReadHarnessStore(*item.Store, d.Limits.MaxTextBodyBytes)
		if err == nil && (item.Store.Matches == nil || item.Store.Matches(stored)) {
			text := string(stored)
			body, sourceTruncated = &text, false
			declaration.Source.BodyFrom = item.Store.Kind
		}
	}
	if body == nil {
		return bodiless(declaration, coverageMissing, "file_missing", 0)
	}
	original := int64(0)
	if sourceTruncated {
		original = item.OriginalBytes
	}
	return d.text(declaration, *body, original, sourceTruncated, false)
}

// Key is the item's content key in the declarer's session.
func (d Declarer) Key(item agent.ContentItem) string {
	return agent.ContentKey(d.Harness, d.NativeSessionID, item.NativeRef, d.placedPart(item.Part))
}

func (d Declarer) base(record agent.ContentRecord, item agent.ContentItem, order int64) uplink.ContentDeclaration {
	occurred := record.At
	if occurred.IsZero() {
		occurred = d.ObservedAt
	}
	schema := record.SchemaVersion
	if schema == "" {
		schema = d.Kind + "/unknown"
	}
	mediaType := item.MediaType
	if mediaType == "" {
		mediaType = mediaText
	}
	return uplink.ContentDeclaration{
		ContentKey: d.Key(item),
		EventID:    eventID(item.EventID), CallID: nativeID(item.CallID), ParentCallID: nativeID(item.ParentCallID), TurnID: nativeID(item.TurnID),
		Role: item.Role, Channel: item.Channel,
		Source:     uplink.ContentSource{Kind: d.Kind, NativeRef: nativeID(item.NativeRef), Order: order, Parser: d.Parser, SchemaVersion: schema},
		OccurredAt: occurred.UTC(), ObservedAt: d.ObservedAt.UTC(), MediaType: mediaType,
		Redaction: uplink.RedactionFact{FilterVersion: FilterVersion},
	}
}

// pathParts are the parts that name a file.
var pathParts = []string{"diff:", "file:"}

// namedPath is the file an item names: its display path, else the path of
// a diff: or file: part. Exclusion and the mapped root apply to either.
func namedPath(item agent.ContentItem) string {
	if item.DisplayPath != "" {
		return item.DisplayPath
	}
	for _, prefix := range pathParts {
		if path, found := strings.CutPrefix(item.Part, prefix); found {
			return path
		}
	}
	return ""
}

// placedPart places the path a diff: or file: part names, so a key never
// digests a local path.
func (d Declarer) placedPart(part string) string {
	for _, prefix := range pathParts {
		if path, found := strings.CutPrefix(part, prefix); found {
			return prefix + privacy.PlaceValue(path, d.Place)
		}
	}
	return part
}

// nativeID keeps an id only in the server's native id shape; a link the
// server would refuse is dropped, never the whole record.
func nativeID(value string) *string {
	if value == "" || !uplink.NativeIDPattern.MatchString(value) {
		return nil
	}
	return &value
}

func eventID(value string) *string {
	if value == "" || len(value) > 64 {
		return nil
	}
	return &value
}

func (d Declarer) attachment(declaration uplink.ContentDeclaration, data []byte) Declared {
	admission := AdmitAttachment(declaration.MediaType, data, d.Limits.MaxAttachmentBytes)
	declaration.MediaType = admission.MediaType
	if admission.Coverage != "" {
		return bodiless(declaration, admission.Coverage, admission.Reason, int64(len(data)))
	}
	if uplink.TextMediaTypes[admission.MediaType] {
		return d.text(declaration, string(data), 0, false, true)
	}
	return withBody(declaration, coverageCaptured, "", data, 0, true, d.Limits.MaxInlineBodyBytes)
}

// text passes a text body through the secret filter and placement, then
// bounds it. sourceTruncated: the agent stored it cut, from original bytes
// when it said (0 when it did not).
func (d Declarer) text(declaration uplink.ContentDeclaration, body string, original int64, sourceTruncated, forceUpload bool) Declared {
	if !utf8.ValidString(body) {
		body = strings.ToValidUTF8(body, "\ufffd")
	}
	isJSON := declaration.MediaType == "application/json" || declaration.MediaType == "application/x-ndjson"
	if isJSON {
		// Before anything rewrites the record, so a ref's raw path is keyed
		// as its part is and never written out.
		body = d.eachJSONLine(body, d.resolvePathRefs, func(line string) string { return line })
	}
	redacted, replacements := privacy.Redact(privacy.ReplaceDataURLs(body))
	placed := d.place(redacted, isJSON)
	if d.place(placed, isJSON) != placed {
		// The server's backstop would refuse it; nothing of it is sent.
		return bodiless(declaration, coverageFailed, "placement_failed", int64(len(placed)))
	}
	coverage, reason := coverageCaptured, ""
	if sourceTruncated {
		// The agent's own cut, whether or not it said from how much.
		coverage, reason = coverageTruncated, "source_limit"
		if original <= int64(len(placed)) {
			original = 0
		}
	}
	if limit := d.Limits.MaxTextBodyBytes; int64(len(placed)) > limit {
		original = max(original, int64(len(placed)))
		placed = cutUTF8(placed, int(limit))
		coverage, reason = coverageTruncated, "body_limit"
	}
	if replacements > 0 {
		coverage, reason = coverageRedacted, "secret_filter"
	}
	declaration.Redaction.Replacements = replacements
	return withBody(declaration, coverage, reason, []byte(placed), original, forceUpload, d.Limits.MaxInlineBodyBytes)
}

func (d Declarer) place(text string, isJSON bool) string {
	if !isJSON {
		return privacy.PlaceText(text, d.Place)
	}
	return d.eachJSONLine(text, d.placeValues, func(line string) string { return privacy.PlaceText(line, d.Place) })
}

// eachJSONLine rewrites every JSON document of a JSON or NDJSON body with
// transform, and any other line with prose.
func (d Declarer) eachJSONLine(text string, transform func(any) any, prose func(string) string) string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		lines = append(lines, d.transformJSON(line, transform, prose))
	}
	return strings.Join(lines, "\n")
}

func (d Declarer) transformJSON(text string, transform func(any) any, prose func(string) string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil || decoder.More() {
		return prose(text)
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(transform(value)) != nil {
		return prose(text)
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

// contentRefMember marks a native-record leaf declared as its own item.
const contentRefMember = "backplane_content_ref"

// resolvePathRefs turns a parser's {"backplane_content_ref": {"part": …}}
// leaf into the key that part is declared under, placed as its declaration
// is, whether or not this pass declares it (amendment 22). A malformed one
// becomes null and is counted: written as given it could carry a raw path.
// A string ref is already a key and is kept.
func (d Declarer) resolvePathRefs(value any) any {
	switch typed := value.(type) {
	case []any:
		for index, child := range typed {
			typed[index] = d.resolvePathRefs(child)
		}
	case map[string]any:
		if ref, isObject := typed[contentRefMember].(map[string]any); isObject {
			part, named := ref["part"].(string)
			if !named || len(ref) != 1 || len(typed) != 1 || !partGrammar.MatchString(part) {
				if d.malformed != nil {
					*d.malformed++
				}
				return nil
			}
			return map[string]any{contentRefMember: d.Key(agent.ContentItem{NativeRef: d.nativeRef, Part: part})}
		}
		for key, child := range typed {
			typed[key] = d.resolvePathRefs(child)
		}
	}
	return value
}

// partGrammar is the frozen part grammar of contract §4.
var partGrammar = regexp.MustCompile(`^(?:(?:text|image|instruction):[0-9]+|input|output|error|command|stdout|stderr|aggregated|summary|raw|native|context:[a-z0-9_]+|(?:diff|file):.+)$`)

func (d Declarer) placeValues(value any) any {
	switch typed := value.(type) {
	case string:
		return privacy.PlaceValue(typed, d.Place)
	case []any:
		for index, child := range typed {
			typed[index] = d.placeValues(child)
		}
		return typed
	case map[string]any:
		placed := make(map[string]any, len(typed))
		for key, child := range typed {
			placed[privacy.PlaceValue(key, d.Place)] = d.placeValues(child)
		}
		return placed
	}
	return value
}

func cutUTF8(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

func withBody(declaration uplink.ContentDeclaration, coverage, reason string, body []byte, original int64, forceUpload bool, inlineLimit int64) Declared {
	size := int64(len(body))
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	declaration.Coverage, declaration.CoverageReason = coverage, optional(reason)
	declaration.ByteCount, declaration.SHA256 = &size, &digest
	if original > size {
		declaration.OriginalByteCount = &original
	}
	if !forceUpload && size <= inlineLimit {
		inline := string(body)
		declaration.Delivery, declaration.InlineText = uplink.DeliveryInline, &inline
		return Declared{Declaration: declaration}
	}
	declaration.Delivery = uplink.DeliveryUpload
	return Declared{Declaration: declaration, Body: body}
}

func bodiless(declaration uplink.ContentDeclaration, coverage, reason string, original int64) Declared {
	declaration.Coverage, declaration.CoverageReason, declaration.Delivery = coverage, optional(reason), uplink.DeliveryNone
	declaration.ByteCount, declaration.SHA256, declaration.InlineText = nil, nil, nil
	declaration.Source.BodyFrom = ""
	declaration.Redaction.Replacements = 0
	declaration.OriginalByteCount = nil
	if original > 0 {
		declaration.OriginalByteCount = &original
	}
	return Declared{Declaration: declaration}
}

func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// TooLarge declares a line over MaxLineBytes, which nothing could parse.
// Its key is its position: there is no native id to read.
func (d Declarer) TooLarge(offset int64, at time.Time) Declared {
	ref := fmt.Sprintf("offset:%d", offset)
	declaration := d.base(agent.ContentRecord{At: at}, agent.ContentItem{NativeRef: ref, Part: "native", Role: "unknown", Channel: "native_record", MediaType: "application/json"}, offset)
	declaration.Source.NativeRef = nil
	return bodiless(declaration, coverageFailed, "record_too_large", 0)
}

// WithoutBody turns a declared body into a bodiless one that says why.
func WithoutBody(declared Declared, coverage, reason string) Declared {
	original := int64(0)
	if size := declared.Declaration.ByteCount; size != nil {
		original = *size
	}
	if before := declared.Declaration.OriginalByteCount; before != nil {
		original = max(original, *before)
	}
	return bodiless(declared.Declaration, coverage, reason, original)
}
