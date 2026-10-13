// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"bytes"
	"testing"
)

func TestSniffNamesFormatsByTheirBytes(t *testing.T) {
	cases := map[string][]byte{
		"image/png":                swatchHead(),
		"image/jpeg":               {0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 'J', 'F', 'I', 'F'},
		"image/gif":                []byte("GIF89a\x01\x00\x01\x00"),
		"image/webp":               []byte("RIFF\x24\x00\x00\x00WEBPVP8 "),
		"image/avif":               []byte("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00"),
		"application/pdf":          []byte("%PDF-1.7\n"),
		"image/svg+xml":            []byte("  <svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
		"text/html":                []byte("<!DOCTYPE html><html></html>"),
		"text/plain":               []byte("just words\nand more"),
		"application/octet-stream": {0x00, 0x01, 0x02, 0xFF, 0xFE},
	}
	for want, data := range cases {
		if got := SniffMediaType(data); got != want {
			t.Errorf("sniffed %q as %s, want %s", data[:min(len(data), 12)], got, want)
		}
	}
	if got := SniffMediaType([]byte("<?xml version=\"1.0\"?>\n<svg/>")); got != "image/svg+xml" {
		t.Errorf("XML-prologued SVG sniffed as %s", got)
	}
}

func swatchHead() []byte { return []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR") }

func TestAttachmentAdmissionTrustsBytesNotTheHint(t *testing.T) {
	cases := []struct {
		name, hint string
		data       []byte
		limit      int64
		want       Admission
	}{
		{"png named jpeg", "image/jpeg", swatchHead(), 1 << 20, Admission{MediaType: "image/png"}},
		{"svg named png", "image/png", []byte("<svg/>"), 1 << 20, Admission{MediaType: "image/svg+xml", Coverage: "withheld_by_policy", Reason: "media_type_not_permitted"}},
		{"html named markdown", "text/markdown", []byte("<html><script></script></html>"), 1 << 20, Admission{MediaType: "text/html", Coverage: "withheld_by_policy", Reason: "media_type_not_permitted"}},
		{"text named png", "image/png", []byte("plain words"), 1 << 20, Admission{MediaType: "text/plain", Coverage: "withheld_by_policy", Reason: "media_type_not_permitted"}},
		{"markdown file", "text/markdown", []byte("# Notes\n"), 1 << 20, Admission{MediaType: "text/markdown"}},
		{"json file", "application/json", []byte(`{"a":1}`), 1 << 20, Admission{MediaType: "application/json"}},
		{"json named png", "image/png", []byte(`{"a":1}`), 1 << 20, Admission{MediaType: "text/plain", Coverage: "withheld_by_policy", Reason: "media_type_not_permitted"}},
		{"zip", "application/zip", []byte("PK\x03\x04\x00\x00"), 1 << 20, Admission{MediaType: "application/octet-stream", Coverage: "withheld_by_policy", Reason: "media_type_not_permitted"}},
		{"oversized png", "image/png", append(swatchHead(), bytes.Repeat([]byte{0}, 64)...), 32, Admission{MediaType: "image/png", Coverage: "withheld_by_policy", Reason: "attachment_oversized"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := AdmitAttachment(c.hint, c.data, c.limit); got != c.want {
				t.Fatalf("admitted %+v, want %+v", got, c.want)
			}
		})
	}
}
