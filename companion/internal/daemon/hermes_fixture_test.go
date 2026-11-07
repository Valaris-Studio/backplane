// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/hermes"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

const (
	hermesAgent    = "hermes_agent"
	hermesSession  = "20260924_115958_a1b2c3"
	hermesMapping  = "m-hermes"
	hermesSentinel = "HERMES_SENTINEL"
)

var hermesEvents = []string{"on_session_start", "post_tool_call", "post_approval_response", "on_session_finalize"}

// hermesFakeAPIKey is assembled at run time so the tree holds no
// credential-shaped literal; the redaction heuristics miss it.
func hermesFakeAPIKey() string { return "sk-" + "proj-" + strings.Repeat("Q7x", 12) }

// hermesTestdata reads the adapter's fixtures, which are shared with its own tests.
func hermesTestdata(t *testing.T, name, cwd string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "agent", "hermes", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	quotedCwd, _ := json.Marshal(cwd)
	data = bytes.ReplaceAll(data, []byte(`"__CWD__"`), quotedCwd)
	return bytes.ReplaceAll(data, []byte("__API_KEY__"), []byte(hermesFakeAPIKey()))
}

func hermesInput(t *testing.T, event, cwd string) []byte {
	return hermesTestdata(t, event+".input.json", cwd)
}

func decodeHermesJSON(t *testing.T, data []byte) map[string]any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("%v: %s", err, data)
	}
	return value
}

func hermesCanonical(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// hermesVariant is an event's fixture input after edit.
func hermesVariant(t *testing.T, event, cwd string, edit func(payload, extra map[string]any)) []byte {
	t.Helper()
	payload := decodeHermesJSON(t, hermesInput(t, event, cwd))
	edit(payload, payload["extra"].(map[string]any))
	return []byte(hermesCanonical(t, payload))
}

// withoutNullHermesToolMembers drops the tool_name and tool_input nulls the
// plugin sends on events that are not tool calls: whether the projection
// keeps those nulls is left open, nothing else is.
func withoutNullHermesToolMembers(event string, payload map[string]any) map[string]any {
	if event == "post_tool_call" {
		return payload
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		if (key == "tool_name" || key == "tool_input") && value == nil {
			continue
		}
		out[key] = value
	}
	return out
}

// newHermesFixture maps project, a folder outside any repository, at level
// and enables hermes_agent beside claude_code.
func newHermesFixture(t *testing.T, level string) (*fixture, string) {
	t.Helper()
	f := newFixture(t, hermes.New())
	project := filepath.Join(f.home, "code", "project")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = []string{"claude_code", hermesAgent}
	f.server.Policy.Mappings = append(f.server.Policy.Mappings, policy.Mapping{ID: hermesMapping, WorkspaceID: "w", RootPath: project, Enabled: true, ContentLevel: level})
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	return f, project
}

func (f *fixture) hermesHook(t *testing.T, input []byte) {
	t.Helper()
	if err := f.shim.Handle("hermes", bytes.NewReader(input)); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) inboxItems(t *testing.T) map[string]inbox.Item {
	t.Helper()
	names, err := inbox.List(f.layout.InboxDir())
	if err != nil {
		t.Fatal(err)
	}
	items := map[string]inbox.Item{}
	for _, name := range names {
		item, err := inbox.Read(f.layout.InboxDir(), name)
		if err != nil {
			t.Fatal(err)
		}
		items[name] = item
	}
	return items
}

func hermesCaptureKey(t *testing.T, item inbox.Item) string {
	t.Helper()
	var adapter agent.Agent = hermes.New()
	source, ok := adapter.(agent.CaptureKeySource)
	if !ok {
		t.Fatal("hermes is not a CaptureKeySource")
	}
	key, named := source.CaptureKey(item.Observation, item.Payload)
	if !named || key == "" {
		t.Fatalf("no capture key for %+v", item.Observation)
	}
	return key
}

// durableFiles is every file under the data directory, by relative path.
func (f *fixture) durableFiles(t *testing.T) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	err := filepath.WalkDir(f.layout.Root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(f.layout.Root, path)
		files[relative] = data
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func assertNoHermesContent(t *testing.T, where string, data []byte) {
	t.Helper()
	for _, leaked := range []string{hermesSentinel, hermesFakeAPIKey()} {
		if bytes.Contains(data, []byte(leaked)) {
			t.Fatalf("%s retains %q: %.400s", where, leaked, data)
		}
	}
}

func assertNoHermesDigest(t *testing.T, where string, data []byte) {
	t.Helper()
	for _, digest := range []string{"sha256:", "[omitted", "[REDACTED", `"bytes"`} {
		if bytes.Contains(data, []byte(digest)) {
			t.Fatalf("%s carries %q: %.400s", where, digest, data)
		}
	}
}

func (f *fixture) assertNoHermesContentAnywhere(t *testing.T) {
	t.Helper()
	for path, data := range f.durableFiles(t) {
		assertNoHermesContent(t, path, data)
	}
}
