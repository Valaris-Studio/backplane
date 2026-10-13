// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"strings"

	"github.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve"
)

// largeText is the size from which a body is first searched for the
// literals each pattern needs: the patterns have no literal prefix, so the
// regexp engine scans all of a large body with its slow matcher, while a
// pattern without its literal in the text cannot match.
const largeText = 64 << 10

// literals answers which literals a text contains, case and Unicode simple
// folds aside; for a short text it answers yes, so every pattern runs.
type literals struct {
	folded string
	active bool
}

func literalsOf(text string) literals {
	if len(text) < largeText {
		return literals{}
	}
	return literals{folded: foldLiterals(text), active: true}
}

func (l literals) has(literal string) bool { return !l.active || strings.Contains(l.folded, literal) }

// foldLiterals lowercases as (?i) folds ASCII letters: ToLower already maps
// the Kelvin sign to k; the long s folds to s.
func foldLiterals(text string) string {
	return strings.ReplaceAll(strings.ToLower(text), "ſ", "s")
}

// secretLiterals: every secret pattern of asymptoteobserve.RedactString
// needs one of these.
var secretLiterals = []string{"api", "token", "secret", "password", "authorization", "bearer", "sk-"}

// Redact passes text through the secret filter and counts what it
// replaced.
func Redact(text string) (string, int) {
	if found := literalsOf(text); found.active && !hasAny(found, secretLiterals) {
		return text, 0
	}
	redacted := asymptoteobserve.RedactString(text)
	if redacted == text {
		return text, 0
	}
	return redacted, max(strings.Count(redacted, redactedMarker)-strings.Count(text, redactedMarker), 1)
}

const redactedMarker = "[REDACTED]"

func hasAny(found literals, candidates []string) bool {
	for _, candidate := range candidates {
		if found.has(candidate) {
			return true
		}
	}
	return false
}
