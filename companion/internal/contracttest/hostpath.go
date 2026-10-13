// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package contracttest

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"runtime"
	"testing"
)

// The native fixtures were recorded on macOS, so the paths they name are
// POSIX. On Windows such a path is not absolute, and the adapters rightly
// refuse it; these helpers respell a fixture as if this host had recorded it.

// HostPath is this platform's absolute spelling of a POSIX fixture path:
// unchanged on Unix, rooted on drive C: on Windows.
func HostPath(posix string) string {
	if filepath.Separator == '/' {
		return posix
	}
	return `C:` + filepath.FromSlash(posix)
}

// HostFixture respells every path under each root in a JSON fixture line in
// HostPath form, so the line reads as recorded on this host.
func HostFixture(raw []byte, roots ...string) []byte {
	for _, root := range roots {
		raw = ReplacePath(raw, root, HostPath(root))
	}
	return raw
}

// ReplacePath moves every path under the POSIX path from to the same place
// under to, in this platform's spelling, JSON-encoded so the document stays
// valid. A from that is only the start of a longer name is left alone.
func ReplacePath(raw []byte, from, to string) []byte {
	needle := jsonText(from)
	var out bytes.Buffer
	for {
		at := bytes.Index(raw, needle)
		if at < 0 {
			out.Write(raw)
			return out.Bytes()
		}
		end := at + len(needle)
		if end < len(raw) && continuesName(raw[end]) {
			out.Write(raw[:end])
			raw = raw[end:]
			continue
		}
		rest := end
		for rest < len(raw) && !endsPath(raw[rest]) {
			rest++
		}
		out.Write(raw[:at])
		out.Write(jsonText(to + filepath.FromSlash(string(raw[end:rest]))))
		raw = raw[rest:]
	}
}

func continuesName(b byte) bool {
	return b == '.' || b == '_' || b == '-' || b >= '0' && b <= '9' || b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z'
}

// endsPath: a path inside a JSON string runs to the string's end, an escape
// or whitespace.
func endsPath(b byte) bool {
	return b == '"' || b == '\\' || b == ' ' || b == '\n'
}

func jsonText(s string) []byte {
	encoded, _ := json.Marshal(s)
	return encoded[1 : len(encoded)-1]
}

// SetTempDir points os.TempDir at dir for the rest of the test: Unix reads
// TMPDIR, Windows TMP and then TEMP.
func SetTempDir(t testing.TB, dir string) {
	if runtime.GOOS == "windows" {
		t.Setenv("TMP", dir)
		t.Setenv("TEMP", dir)
		return
	}
	t.Setenv("TMPDIR", dir)
}
