// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"bytes"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	mediaPNG     = "image/png"
	mediaText    = "text/plain"
	mediaUnknown = "application/octet-stream"
	sniffBytes   = 1 << 10
)

var rasterSignatures = []struct {
	mediaType string
	matches   func([]byte) bool
}{
	{mediaPNG, func(data []byte) bool { return bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) }},
	{"image/jpeg", func(data []byte) bool { return bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}) }},
	{"image/gif", func(data []byte) bool {
		return bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a"))
	}},
	{"image/webp", func(data []byte) bool {
		return len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP"))
	}},
	{"image/avif", func(data []byte) bool {
		return len(data) >= 12 && (bytes.Equal(data[4:12], []byte("ftypavif")) || bytes.Equal(data[4:12], []byte("ftypavis")))
	}},
	{"application/pdf", func(data []byte) bool { return bytes.HasPrefix(data, []byte("%PDF-")) }},
}

// SniffMediaType names what bytes are, from their content alone. Markup
// that can carry script (SVG, HTML) is named so it is never taken for text.
func SniffMediaType(data []byte) string {
	for _, signature := range rasterSignatures {
		if signature.matches(data) {
			return signature.mediaType
		}
	}
	head := data[:min(len(data), sniffBytes)]
	if !utf8.Valid(head[:validPrefix(head)]) || bytes.IndexByte(head, 0) >= 0 {
		return mediaUnknown
	}
	markup := strings.ToLower(strings.TrimLeft(strings.TrimPrefix(string(head), "\ufeff"), " \t\r\n"))
	switch {
	case strings.HasPrefix(markup, "<svg"), strings.HasPrefix(markup, "<?xml") && strings.Contains(markup, "<svg"):
		return "image/svg+xml"
	case strings.HasPrefix(markup, "<!doctype html"), strings.HasPrefix(markup, "<html"):
		return "text/html"
	}
	return mediaText
}

// validPrefix leaves out a code point the sniff window cut in two.
func validPrefix(head []byte) int {
	for cut := 0; cut < utf8.UTFMax && cut < len(head); cut++ {
		if utf8.Valid(head[:len(head)-cut]) {
			return len(head) - cut
		}
	}
	return len(head)
}

// textHints may refine bytes sniffed as plain text.
var textHints = map[string]bool{mediaText: true, "text/markdown": true, "application/json": true}

// Admission is the verdict on an embedded attachment.
type Admission struct {
	MediaType string
	// Coverage and Reason are empty when the attachment is captured.
	Coverage string
	Reason   string
}

// AdmitAttachment sniffs an embedded attachment: the declared type is only
// a hint. An image hint needs image bytes; a text hint (markdown, JSON) may
// refine bytes sniffed as plain text. It must be a permitted type within
// limit bytes.
func AdmitAttachment(hint string, data []byte, limit int64) Admission {
	sniffed := SniffMediaType(data)
	admission := Admission{MediaType: sniffed}
	if sniffed == mediaText && textHints[hint] {
		admission.MediaType = hint
	}
	switch {
	case strings.HasPrefix(hint, "image/") && !strings.HasPrefix(sniffed, "image/"),
		!uplink.AttachmentMediaTypes[admission.MediaType]:
		admission.Coverage, admission.Reason = coverageWithheld, "media_type_not_permitted"
	case int64(len(data)) > limit:
		admission.Coverage, admission.Reason = coverageWithheld, "attachment_oversized"
	}
	return admission
}

// ErrStoreRefused: a harness body store failed a descriptor check.
var ErrStoreRefused = errors.New("harness_store_refused")
