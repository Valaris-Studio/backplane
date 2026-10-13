// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

var (
	// Device tokens (bpc_) and API keys (vlr_), wherever they appear.
	credentialPattern = regexp.MustCompile(`\b(?:bpc|vlr)_[A-Za-z0-9_-]+`)
	bearerPattern     = regexp.MustCompile(`(?i)\b(bearer)\s+[^\s"',;]+`)
	// scheme://user:secret@host keeps the scheme and host.
	urlUserinfoPattern = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^/\s"'@]+@`)
	// Query strings and fragments can carry tokens; host/owner/repo stays.
	urlQueryPattern = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://[^\s"'?#]*)[?#][^\s"']*`)
)

// Scrub removes what diagnostics must never carry: the home directory (shown
// as ~), credentials, and URL credentials or queries. caseInsensitive
// matches home in any case, as the macOS and Windows filesystems resolve it.
func Scrub(data []byte, homes []string, caseInsensitive bool) []byte {
	text := string(data)
	if pattern := homePattern(homes, caseInsensitive); pattern != nil {
		text = replaceHomes(text, pattern)
	}
	text = credentialPattern.ReplaceAllString(text, "[redacted]")
	text = bearerPattern.ReplaceAllString(text, "$1 [redacted]")
	text = urlUserinfoPattern.ReplaceAllString(text, "$1")
	text = urlQueryPattern.ReplaceAllString(text, "$1")
	return []byte(text)
}

// homePattern matches any spelling of home; replaceHomes checks the
// boundaries on both sides.
func homePattern(homes []string, caseInsensitive bool) *regexp.Regexp {
	quoted := []string{}
	for _, home := range homes {
		if len(home) > 1 {
			quoted = append(quoted, regexp.QuoteMeta(home))
		}
	}
	if len(quoted) == 0 {
		return nil
	}
	// Longest first, so a spelling is never cut short by its own prefix.
	slices.SortFunc(quoted, func(a, b string) int { return len(b) - len(a) })
	flags := ""
	if caseInsensitive {
		flags = "i"
	}
	return regexp.MustCompile(`(?` + flags + `:` + strings.Join(quoted, "|") + `)`)
}

// replaceHomes writes ~ for each home that is a whole path of its own: not
// inside another path (/other/home/jane) and not the start of a longer name
// (/home/janet). RE2 has no lookaround, and a boundary consumed by one match
// could not open the next (PATH=/home/jane/bin:/home/jane/go), so the
// boundaries are checked here rather than in the pattern.
func replaceHomes(text string, pattern *regexp.Regexp) string {
	var scrubbed strings.Builder
	copied, searchFrom, previousEnd := 0, 0, -1
	for searchFrom <= len(text) {
		match := pattern.FindStringIndex(text[searchFrom:])
		if match == nil {
			break
		}
		start, end := searchFrom+match[0], searchFrom+match[1]
		// A home right after the one just scrubbed follows ~, not a path.
		startsPath := start == previousEnd || homeStartsAt(text, start)
		if !startsPath || end < len(text) && isPathByte(text[end]) {
			searchFrom = start + 1
			continue
		}
		scrubbed.WriteString(text[copied:start])
		scrubbed.WriteByte('~')
		copied, searchFrom, previousEnd = end, end, end
	}
	scrubbed.WriteString(text[copied:])
	return scrubbed.String()
}

func isPathByte(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || strings.IndexByte("._-", b) >= 0
}

// escapedWhitespacePattern is a JSON \n, \r or \t escape right before home, as in
// a log message carried in a JSON string.
var escapedWhitespacePattern = regexp.MustCompile(`\\[nrt]$`)

// fileURLPrefixPattern is file: and its slashes, JSON-escaped or not, right
// before home, as in file:///home/jane.
var fileURLPrefixPattern = regexp.MustCompile(`(?i)file:(?:/|\\/)*$`)

// encodedSlashSuffixPattern is a slash or backslash percent-encoded once or
// twice right before home, as in file%3A%2F%2F%2Fhome%2Fjane.
var encodedSlashSuffixPattern = regexp.MustCompile(`(?i)%(?:25)?(?:2F|5C)$`)

// homeStartsAt reports whether home at start opens a path rather than
// continuing one.
func homeStartsAt(text string, start int) bool {
	if start == 0 {
		return true
	}
	previous := text[start-1]
	if !isPathByte(previous) && previous != '/' && previous != '\\' {
		return true
	}
	before := text[max(0, start-16):start]
	return escapedWhitespacePattern.MatchString(before) || fileURLPrefixPattern.MatchString(before) || encodedSlashSuffixPattern.MatchString(before)
}

// homeSpellings lists how home may be written in a file: as given and
// resolved through symlinks, in each of the encodings encodedSpellings adds.
func homeSpellings(home string) []string {
	if home == "" || !filepath.IsAbs(home) {
		return nil
	}
	spellings := []string{filepath.Clean(home)}
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		spellings = append(spellings, resolved)
	}
	return encodedSpellings(spellings, filepath.Separator)
}

// encodedSpellings adds each path with forward slashes, JSON-escaped (both a
// doubled backslash and an escaped slash), and percent-encoded once or twice
// (%2F, %252F) in either hex case: its slashes, a Windows path's
// backslashes, and a drive colon, which a file URL (file:///C%3A/home/jane)
// encodes even between plain slashes. The colon and the separators may be
// encoded differently; deeper encodings are not chased.
func encodedSpellings(paths []string, separator byte) []string {
	spellings := []string{}
	for _, path := range paths {
		forward := strings.ReplaceAll(path, string(separator), "/")
		spellings = append(spellings, path, forward, strings.ReplaceAll(path, `\`, `\\`), strings.ReplaceAll(forward, "/", `\/`))
		separatorForms := []string{forward}
		for _, slash := range percentEncodings("2F") {
			separatorForms = append(separatorForms, strings.ReplaceAll(forward, "/", slash))
		}
		if separator == '\\' {
			for _, backslash := range percentEncodings("5C") {
				separatorForms = append(separatorForms, strings.ReplaceAll(path, `\`, backslash))
			}
		}
		for _, form := range separatorForms {
			for _, colon := range append([]string{":"}, percentEncodings("3A")...) {
				spellings = append(spellings, strings.ReplaceAll(form, ":", colon))
			}
		}
	}
	slices.Sort(spellings)
	return slices.Compact(spellings)
}

// percentEncodings is a byte's hex code encoded once and twice (%25 is the
// percent sign itself), in both hex cases.
func percentEncodings(hex string) []string {
	upper, lower := strings.ToUpper(hex), strings.ToLower(hex)
	return []string{"%" + upper, "%" + lower, "%25" + upper, "%25" + lower}
}
