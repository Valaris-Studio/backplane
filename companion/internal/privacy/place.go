// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"
)

// Place locates a session's project without any local path: the server sees
// the repository URL, the branch and paths relative to the project root.
type Place struct {
	// Roots are the project root as the device resolved it and as the agent
	// spelled it (e.g. through a symlink); paths inside become relative.
	Roots []string
	// Homes are the user's home directory spellings; paths inside become ~/….
	Homes   []string
	RepoURL string
	Branch  string
}

// The rules mirror the server's twin, backend/app/core/local_paths.py; both
// sides run the same table of cases.
var (
	// In a value that is a path: a home directory on macOS (any case: its
	// file system is case-insensitive, and under WSL's /mnt/<drive>), Linux
	// (including /var/home) or Windows, plain or URL-encoded, preceded by a
	// boundary; it becomes ~name.
	otherHomes = regexp.MustCompile(`(?i)(^|[^a-z0-9_.\-%])(?:(?:/mnt/[a-z])?/users/|(?:/var)?/home/|[a-z]:[\\/]users[\\/]|%2f(?:users|(?:var%2f)?home)%2f)([^/\\\s"'` + "`" + `%]+)`)
	// In prose only the unmistakable forms, so web routes (`GET /users/42/x`)
	// and words (`/home/about`) survive: macOS /Users/<name>/ in its
	// canonical case (also under WSL) and /home/<name>/ followed by a further
	// segment. The boundary excludes `/` and `:` so URL paths are left alone.
	// RE2 has no lookahead, so the character after the name is matched and
	// written back.
	proseMacHomes   = regexp.MustCompile(`(^|[^A-Za-z0-9_.\-%/:])(?:/mnt/[a-z])?/Users/([^/\\\s"'` + "`" + `%]+)/`)
	proseLinuxHomes = regexp.MustCompile(`(^|[^A-Za-z0-9_.\-%/:])/home/([^/\\\s"'` + "`" + `%]+)/([^/\s"'` + "`" + `])`)
	// Forms no web route can take are rewritten in prose in any case: WSL
	// homes, Windows drive homes and URL-encoded homes.
	proseWSLHomes     = regexp.MustCompile(`(?i)(^|[^a-z0-9_.\-%/:])/mnt/[a-z]/users/([^/\\\s"'` + "`" + `%]+)/`)
	proseWindowsHomes = regexp.MustCompile(`(?i)(^|[^a-z0-9_.\-%/:\\])[a-z]:[\\/]users[\\/]([^/\\\s"'` + "`" + `%]+)`)
	proseEncodedHomes = regexp.MustCompile(`(?i)(^|[^a-z0-9_.\-%])%2f(?:users|(?:var%2f)?home)%2f([^/\\\s"'` + "`" + `%&]+)`)
	// A file URL, with or without a host.
	fileURL = regexp.MustCompile("(?i)file://([^/\\s\"'`<>]*)(/[^\\s\"'`<>]*)")
	// The Windows extended-length prefix in front of a drive path (\\?\C:\...).
	extendedPrefix  = regexp.MustCompile(`\\\\\?\\([A-Za-z]:[\\/])`)
	drivePath       = regexp.MustCompile(`^[A-Za-z]:[\\/]`)
	driveAfterSlash = regexp.MustCompile(`^/[A-Za-z]:[\\/]`)
)

// rootHome is root's home directory, which no home spelling pattern covers;
// it is placed only in path values.
var rootHome = anchor{path: "/root", replacement: "~root"}

// PlaceEvent returns a copy of a normalized event that carries the place's
// repository and branch, with its local paths rewritten in every string
// value and member name. A value that is a path becomes relative inside a
// root (`.` for the root itself), ~/… under the device's home and ~name/…
// under any other home. In free text only unmistakable paths change: those
// in a root or the device's home, file:// URLs, and canonical home forms.
// It runs on every event before the event is retained for upload.
func PlaceEvent(event map[string]any, place Place) map[string]any {
	placer := place.placer()
	placedEvent := placer.strings(event).(map[string]any)
	setOrDrop(placedEvent, "repository", place.RepoURL)
	setOrDrop(placedEvent, "branch", place.Branch)
	if run, ok := placedEvent["run"].(map[string]any); ok {
		if _, has := run["repository"]; has {
			setOrDrop(run, "repository", place.RepoURL)
		}
		if _, has := run["branch"]; has {
			setOrDrop(run, "branch", place.Branch)
		}
	}
	return placedEvent
}

// PlaceText places the local paths inside free text, as an event's prose
// strings are placed.
func PlaceText(text string, place Place) string { return place.placer().text(text) }

// PlaceValue places a string that may be a whole path, as an event's string
// values are placed.
func PlaceValue(value string, place Place) string { return place.placer().value(value) }

func setOrDrop(object map[string]any, key, value string) {
	if value == "" {
		delete(object, key)
		return
	}
	object[key] = value
}

type anchor struct {
	path string
	// relative anchors a project root; any other anchor is replaced by
	// replacement.
	relative    bool
	replacement string
}

type placer struct{ roots, homes []anchor }

// placer orders each anchor list longest first, so a root inside the home
// directory becomes relative rather than ~/….
func (p Place) placer() placer {
	return placer{roots: anchorsFor(p.Roots, true, ""), homes: anchorsFor(p.Homes, false, "~")}
}

func anchorsFor(paths []string, relative bool, replacement string) []anchor {
	sorted := append([]string(nil), paths...)
	sort.SliceStable(sorted, func(i, j int) bool { return len(sorted[i]) > len(sorted[j]) })
	var anchors []anchor
	for _, path := range sorted {
		path = strings.TrimRight(path, `/\`)
		// A filesystem root anchors nothing.
		if len(path) < 2 || len(path) == 2 && path[1] == ':' {
			continue
		}
		anchors = append(anchors, anchor{path: path, relative: relative, replacement: replacement})
	}
	return anchors
}

func (p placer) strings(value any) any {
	switch typed := value.(type) {
	case string:
		return p.value(typed)
	case map[string]any:
		// Member names can be paths too. Sorted, so that when two names
		// place to the same one the first by original name wins every time.
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(typed))
		for _, key := range keys {
			placedKey := p.value(key)
			if _, taken := out[placedKey]; !taken {
				if directory, isText := typed[key].(string); isText && workingDirectoryMembers[strings.ToLower(key)] {
					out[placedKey] = p.workingDirectory(directory)
				} else {
					out[placedKey] = p.strings(typed[key])
				}
			}
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = p.strings(child)
		}
		return out
	}
	return value
}

func (p placer) value(value string) string {
	if path, ok := localPathOf(value); ok {
		return p.path(path)
	}
	return p.text(value)
}

// localPathOf returns the local path a whole value names, if it is one:
// surrounding space trimmed and a file:// URL decoded (`file:///C:/x` is
// `C:/x`). A URL-encoded path stays encoded; the home patterns cover it.
func localPathOf(value string) (string, bool) {
	candidate := strings.TrimSpace(value)
	if len(candidate) >= len("file://") && strings.EqualFold(candidate[:len("file://")], "file://") {
		parsed, err := url.Parse(candidate)
		if err != nil {
			return "", false
		}
		path := parsed.Path
		if driveAfterSlash.MatchString(path) {
			path = path[1:]
		}
		return path, path != ""
	}
	if candidate == "" || strings.IndexFunc(candidate, unicode.IsSpace) >= 0 {
		return "", false
	}
	if strings.HasPrefix(candidate, "/") || strings.HasPrefix(candidate, `\`) || drivePath.MatchString(candidate) ||
		len(candidate) >= 3 && strings.EqualFold(candidate[:3], "%2f") {
		return candidate, true
	}
	return "", false
}

func (p placer) path(path string) string {
	path = extendedPrefix.ReplaceAllString(path, "$1")
	for _, anchor := range p.roots {
		path = replaceAnchor(path, anchor)
	}
	for _, anchor := range p.homes {
		path = replaceAnchor(path, anchor)
	}
	path = replaceAnchor(path, rootHome)
	return otherHomes.ReplaceAllString(path, "${1}~${2}")
}

func (p placer) text(text string) string {
	found := literalsOf(text)
	for _, anchor := range p.roots {
		if found.has(anchor.literal()) {
			text = replaceAnchor(text, anchor)
		}
	}
	if found.has("file://") {
		text = p.fileURLs(text)
	}
	for _, anchor := range p.homes {
		if found.has(anchor.literal()) {
			text = replaceAnchor(text, anchor)
		}
	}
	for _, prose := range proseHomes {
		if found.has(prose.literal) {
			text = prose.pattern.ReplaceAllString(text, prose.replacement)
		}
	}
	return text
}

// proseHomes are the home spellings rewritten in free text, in order, each
// with a literal it cannot match without.
var proseHomes = []struct {
	pattern     *regexp.Regexp
	literal     string
	replacement string
}{
	{proseWindowsHomes, "users", "${1}~${2}"},
	{proseEncodedHomes, "%2f", "${1}~${2}"},
	{proseWSLHomes, "/mnt/", "${1}~${2}/"},
	{proseMacHomes, "/users/", "${1}~${2}/"},
	{proseLinuxHomes, "/home/", "${1}~${2}/${3}"},
}

func (p placer) fileURLs(text string) string {
	return fileURL.ReplaceAllStringFunc(text, func(match string) string {
		parts := fileURL.FindStringSubmatch(match)
		host, placedPath := parts[1], p.path(parts[2])
		if host != "" && !strings.HasPrefix(placedPath, "/") {
			host += "/"
		}
		return "file://" + host + placedPath
	})
}

// literal is the anchor's last path component, which every spelling of it
// (any separator, escaped, any case) contains.
func (a anchor) literal() string {
	path := strings.TrimRight(a.path, `/\`)
	if cut := strings.LastIndexAny(path, `/\`); cut >= 0 {
		path = path[cut+1:]
	}
	return foldLiterals(path)
}

// replaceAnchor rewrites each occurrence of the anchor that is a whole path
// prefix: not preceded by a name character and followed by a separator or
// the end of the path.
func replaceAnchor(text string, anchor anchor) string {
	pattern := anchorPattern(anchor.path)
	var out strings.Builder
	kept, from := 0, 0
	for {
		location := pattern.FindStringIndex(text[from:])
		if location == nil {
			break
		}
		index, end := from+location[0], from+location[1]
		from = end
		if index > 0 && isNameByte(text[index-1]) || end < len(text) && isNameByte(text[end]) {
			continue
		}
		out.WriteString(text[kept:index])
		separator := textSeparator.FindStringIndex(text[end:])
		switch {
		case !anchor.relative:
			out.WriteString(anchor.replacement)
		case separator != nil && end+separator[1] < len(text) && isNameByte(text[end+separator[1]]):
			// Inside the root: keep the relative remainder.
			end += separator[1]
		default:
			out.WriteString(".")
		}
		kept, from = end, end
	}
	out.WriteString(text[kept:])
	return out.String()
}

var (
	// A separator as text spells it: plain, either way round, or JSON
	// escaped (`\/`, `\\`).
	textSeparator = regexp.MustCompile(`^(?:\\\\|\\/|[\\/])`)
	// Roots on file systems that ignore case: Windows drives and shares, and
	// macOS's /Users and /Volumes. A Linux root's case is significant.
	caseInsensitiveRoot = regexp.MustCompile(`^(?:[A-Za-z]:[\\/]|\\\\|/Users/|/Volumes/)`)
	anchorPatterns      sync.Map
)

// anchorPattern is an anchor as text may spell it, as the server's twin
// spells it: separators in any form its system accepts or JSON escapes, in
// any case where its file system ignores case.
func anchorPattern(path string) *regexp.Regexp {
	if cached, ok := anchorPatterns.Load(path); ok {
		return cached.(*regexp.Regexp)
	}
	windows := drivePath.MatchString(path) || strings.HasPrefix(path, `\\`)
	separators, separator := "/", `(?:\\/|/)`
	if windows {
		separators, separator = `/\`, `(?:\\\\|\\/|[\\/])`
	}
	var expression strings.Builder
	if caseInsensitiveRoot.MatchString(path) {
		expression.WriteString("(?i)")
	}
	for _, char := range path {
		if strings.ContainsRune(separators, char) {
			expression.WriteString(separator)
		} else {
			expression.WriteString(regexp.QuoteMeta(string(char)))
		}
	}
	pattern := regexp.MustCompile(expression.String())
	anchorPatterns.Store(path, pattern)
	return pattern
}

func isNameByte(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_' || b == '.' || b == '-' || b >= 0x80
}

// AbsolutePath reports whether path is absolute by its syntax alone, on
// any host: POSIX, drive-letter or UNC.
func AbsolutePath(path string) bool {
	return strings.HasPrefix(path, "/") || drivePath.MatchString(path) || strings.HasPrefix(path, `\\`)
}
