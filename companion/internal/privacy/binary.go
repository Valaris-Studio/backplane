// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

// minBinaryBytes is the shortest value treated as an embedded binary: short
// base64-looking strings are ordinary identifiers or tokens.
const minBinaryBytes = 1024

// binaryKeys name members that agents use for embedded bytes (Pi images'
// data, Claude image sources, attachments).
var binaryKeys = map[string]bool{"data": true, "image": true, "base64": true, "blob": true, "bytes": true, "source": true}

var (
	base64Text = regexp.MustCompile(`^[A-Za-z0-9+/_\-\s]+={0,2}\s*$`)
	dataURL    = regexp.MustCompile(`data:[a-zA-Z0-9.+/-]*(;[a-zA-Z0-9=.+-]+)*;base64,`)
	// dataURLSpan is a whole base64 data URL, wherever it sits in a string
	// (e.g. a markdown image in a prompt).
	dataURLSpan = regexp.MustCompile(`data:[a-zA-Z0-9.+/-]*(;[a-zA-Z0-9=.+-]+)*;base64,[A-Za-z0-9+/_\-]*={0,2}`)
)

// ReplaceDataURLs replaces every base64 data URL inside text with a
// placeholder, keeping the surrounding text.
func ReplaceDataURLs(text string) string {
	if !dataURL.MatchString(text) {
		return text
	}
	return dataURLSpan.ReplaceAllStringFunc(text, BinaryPlaceholder)
}

// mediaIndicators mark an object as an image or other media payload.
var mediaIndicators = []string{"mimeType", "mime_type", "media_type", "mime"}

// IsBinaryString reports whether value, found under key, is an embedded
// binary (a base64 data URL anywhere, or long base64 under a binary key).
// Binary content is never retained at any content level.
func IsBinaryString(key, value string) bool {
	if dataURL.MatchString(value) {
		return true
	}
	return len(value) >= minBinaryBytes && binaryKeys[strings.ToLower(key)] && base64Text.MatchString(value)
}

// binaryDescriptor replaces an object that embeds binary data with what can
// be said without the bytes.
func binaryDescriptor(object map[string]any, blob string) map[string]any {
	descriptor := map[string]any{"bytes": decodedLength(blob), "sha256": fullSHA256(blob)}
	if kind, ok := object["type"].(string); ok {
		descriptor["type"] = kind
	}
	for _, key := range mediaIndicators {
		if mime, ok := object[key].(string); ok {
			descriptor["mime"] = mime
			break
		}
	}
	return descriptor
}

// BinaryPlaceholder stands in for a binary string outside a describable
// object, e.g. a data URL.
func BinaryPlaceholder(blob string) string {
	return fmt.Sprintf("[binary omitted %d bytes sha256:%s]", decodedLength(blob), fullSHA256(blob)[:16])
}

func decodedLength(blob string) int {
	if location := dataURL.FindStringIndex(blob); location != nil && location[0] == 0 {
		blob = blob[location[1]:]
	}
	compact := strings.Join(strings.Fields(blob), "")
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if decoded, err := encoding.DecodeString(compact); err == nil {
			return len(decoded)
		}
	}
	return len(blob)
}

func fullSHA256(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// embeddedBinary returns the binary an object carries under a binary key
// (such an object is an image or attachment and is described instead). A
// data URL under any other key is replaced as a string on its own.
func embeddedBinary(object map[string]any) (string, bool) {
	// Media data is described whatever its size: a small image is still an image.
	if data, ok := object["data"].(string); ok && isMedia(object) {
		return data, true
	}
	for key, value := range object {
		if text, ok := value.(string); ok && binaryKeys[strings.ToLower(key)] && IsBinaryString(key, text) {
			return text, true
		}
	}
	return "", false
}

func isMedia(object map[string]any) bool {
	if object["type"] == "image" {
		return true
	}
	for _, key := range mediaIndicators {
		if _, ok := object[key].(string); ok {
			return true
		}
	}
	return false
}
