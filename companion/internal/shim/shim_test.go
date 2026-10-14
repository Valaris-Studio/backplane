// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package shim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

type fixture struct {
	shim    Shim
	layout  store.Layout
	home    string
	project string
	cached  policy.Cached
}

var now = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)

func newFixture(t testing.TB, connected bool) *fixture {
	t.Helper()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(root, "home")
	project := filepath.Join(home, "code", "app")
	for _, dir := range []string{project, filepath.Join(root, "tmp")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	f := &fixture{home: home, project: project, layout: store.Layout{Root: filepath.Join(root, "data")}}
	if connected {
		layout, err := store.Open(f.layout.Root)
		if err != nil {
			t.Fatal(err)
		}
		f.layout = layout
		f.cached = policy.Cached{RefreshedAt: now.Add(-time.Minute), Policy: policy.Policy{
			Installation: policy.Installation{ID: "i", EnabledAgents: []string{"claude_code"}},
			Mappings:     []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: project, Enabled: true, ContentLevel: "standard"}},
		}}
		f.savePolicy(t)
	}
	f.shim = Shim{Layout: f.layout, Registry: agent.NewRegistry(claudecode.New(), pi.New(), codex.New()), Home: home, TempDirs: []string{filepath.Join(root, "tmp")}, Now: func() time.Time { return now }}
	return f
}

func (f *fixture) savePolicy(t testing.TB) {
	t.Helper()
	if err := policy.Save(f.layout.Policy(), f.cached); err != nil {
		t.Fatal(err)
	}
}

func hook(cwd, event, extra string) string {
	return `{"cwd":"` + cwd + `","session_id":"sess-1","hook_event_name":"` + event + `"` + extra + `}`
}

func files(t *testing.T, root string) []string {
	t.Helper()
	var found []string
	filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			found = append(found, strings.TrimPrefix(path, root))
		}
		return nil
	})
	sort.Strings(found)
	return found
}

func TestInScopeHookWritesOneSanitizedInboxItem(t *testing.T) {
	f := newFixture(t, true)
	input := hook(f.project, "UserPromptSubmit", `,"prompt":"fix it token=supersecretvalue","transcript_path":"/private/t.jsonl"`)
	if err := f.shim.Handle("claude-code", strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	names, _ := inbox.List(f.layout.InboxDir())
	if len(names) != 1 {
		t.Fatalf("expected one inbox item, got %d", len(names))
	}
	raw, _ := os.ReadFile(filepath.Join(f.layout.InboxDir(), names[0]))
	if bytes.Contains(raw, []byte("supersecretvalue")) || bytes.Contains(raw, []byte("/private/t.jsonl")) {
		t.Fatalf("unsanitized content retained: %s", raw)
	}
	item, err := inbox.Read(f.layout.InboxDir(), names[0])
	if err != nil {
		t.Fatal(err)
	}
	if item.Agent != "claude_code" || item.MappingID != "m1" || item.ContentLevel != privacy.Standard || item.Observation.NativeSessionID != "sess-1" || !item.ReceivedAt.Equal(now) || item.Payload["cwd"] != f.project {
		t.Fatalf("unexpected item: %+v", item)
	}
}

// A response boundary hands the daemon the transcript to read usage from;
// the shim itself never opens it, so it stays fast however large it is.
func TestBoundaryHandsTheTranscriptToTheDaemonWithoutOpeningIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("named pipes stand in for an unopenable transcript")
	}
	f := newFixture(t, true)
	transcript := filepath.Join(f.home, ".claude", "projects", "app", "sess-1.jsonl")
	os.MkdirAll(filepath.Dir(transcript), 0o700)
	// Opening a FIFO with no writer blocks: a shim that opened it would hang.
	if err := exec.Command("mkfifo", transcript).Run(); err != nil {
		t.Skip("mkfifo unavailable")
	}
	for _, event := range []string{"Stop", "SessionEnd", "UserPromptSubmit"} {
		if err := f.shim.Handle("claude_code", strings.NewReader(hook(f.project, event, `,"transcript_path":"`+transcript+`"`))); err != nil {
			t.Fatal(err)
		}
	}
	names, _ := inbox.List(f.layout.InboxDir())
	if len(names) != 3 {
		t.Fatalf("got %d items", len(names))
	}
	want := map[string]string{"Stop": transcript, "SessionEnd": transcript, "UserPromptSubmit": ""}
	for _, name := range names {
		item, err := inbox.Read(f.layout.InboxDir(), name)
		if err != nil {
			t.Fatal(err)
		}
		if want := want[item.Observation.Event]; item.UsageTranscript != want {
			t.Fatalf("%s: usage transcript %q, want %q", item.Observation.Event, item.UsageTranscript, want)
		}
		if _, kept := item.Payload["transcript_path"]; kept {
			t.Fatalf("%s: the path stayed in the payload: %v", item.Observation.Event, item.Payload)
		}
	}
}

func TestOutOfScopeBoundaryHandsNothingOver(t *testing.T) {
	f := newFixture(t, true)
	other := filepath.Join(f.home, "code", "other")
	os.MkdirAll(other, 0o700)
	if err := f.shim.Handle("claude_code", strings.NewReader(hook(other, "Stop", `,"transcript_path":"/t/sess-1.jsonl"`))); err != nil {
		t.Fatal(err)
	}
	if names, _ := inbox.List(f.layout.InboxDir()); len(names) != 0 {
		t.Fatalf("out-of-scope boundary retained: %v", names)
	}
}

func TestMetadataLevelStripsContentBeforeRetention(t *testing.T) {
	f := newFixture(t, true)
	f.cached.Policy.Mappings[0].ContentLevel = "metadata"
	f.savePolicy(t)
	input := hook(f.project, "UserPromptSubmit", `,"prompt":"a confidential roadmap"`)
	if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	names, _ := inbox.List(f.layout.InboxDir())
	raw, _ := os.ReadFile(filepath.Join(f.layout.InboxDir(), names[0]))
	if bytes.Contains(raw, []byte("confidential")) || !bytes.Contains(raw, []byte(`"content_level":"metadata"`)) {
		t.Fatalf("metadata level retained content: %s", raw)
	}
}

func TestOutOfScopeLeavesNoFilesBeyondDiscovered(t *testing.T) {
	f := newFixture(t, true)
	repo := filepath.Join(f.home, "code", "other")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o700)
	os.WriteFile(filepath.Join(repo, ".git", "config"), []byte("[remote \"origin\"]\n\turl = git@github.com:acme/other.git\n"), 0o600)
	before := files(t, f.layout.Root)
	input := hook(repo, "UserPromptSubmit", `,"prompt":"UNSELECTED_MUST_NOT_PERSIST"`)
	for i := 0; i < 2; i++ {
		if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
			t.Fatal(err)
		}
	}
	after := files(t, f.layout.Root)
	if len(after) != len(before)+1 || !contains(after, "/discovered.json") {
		t.Fatalf("out-of-scope hook wrote %v (before %v)", after, before)
	}
	data, _ := os.ReadFile(f.layout.Discovered())
	if bytes.Contains(data, []byte("UNSELECTED")) || !bytes.Contains(data, []byte("github.com/acme/other")) {
		t.Fatalf("discovered entry wrong: %s", data)
	}
	discovered, _ := state.Load[state.Discovered](f.layout.Discovered())
	if len(discovered.Projects) != 1 {
		t.Fatal("discovered project not deduplicated")
	}
}

func TestNeverConnectedCapturesNothing(t *testing.T) {
	f := newFixture(t, false)
	if err := f.shim.Handle("claude_code", strings.NewReader(hook(f.project, "SessionStart", ""))); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(f.layout.Root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unconnected shim created state")
	}
}

func TestLocalPauseAndUnauthorizedApplyImmediately(t *testing.T) {
	for name, prepare := range map[string]func(*fixture){
		"paused": func(f *fixture) { store.WriteJSON(f.layout.Preferences(), state.Preferences{Paused: true}) },
		"revoked": func(f *fixture) {
			store.WriteJSON(f.layout.Installation(), state.Installation{ID: "i"})
			store.WriteJSON(f.layout.Admission(), state.Admission{Unauthorized: true, InstallationID: "i"})
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, true)
			prepare(f)
			if err := f.shim.Handle("claude_code", strings.NewReader(hook(f.project, "SessionStart", ""))); err != nil {
				t.Fatal(err)
			}
			if names, _ := inbox.List(f.layout.InboxDir()); len(names) != 0 {
				t.Fatal("captured while not admitted")
			}
		})
	}
}

func TestARevocationOfAnotherOrNoInstallationDoesNotBlockCapture(t *testing.T) {
	for name, admission := range map[string]state.Admission{
		"replaced installation": {Unauthorized: true, InstallationID: "replaced"},
		// Written by a daemon predating installation ids, on any 401.
		"legacy flag": {Unauthorized: true},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, true)
			store.WriteJSON(f.layout.Installation(), state.Installation{ID: "i"})
			store.WriteJSON(f.layout.Admission(), admission)
			if err := f.shim.Handle("claude_code", strings.NewReader(hook(f.project, "SessionStart", ""))); err != nil {
				t.Fatal(err)
			}
			if names, _ := inbox.List(f.layout.InboxDir()); len(names) != 1 {
				t.Fatal("a revocation that is not this installation's blocked capture")
			}
		})
	}
}

func TestRejectedInputsWriteNothingAndReportTypedErrors(t *testing.T) {
	f := newFixture(t, true)
	cases := map[string]struct {
		agent, input string
		want         error
	}{
		"unknown agent":    {"cursor", hook(f.project, "SessionStart", ""), agent.ErrUnknownAgent},
		"oversized":        {"claude_code", strings.Repeat(" ", maxHookBytes+1), ErrHookTooLarge},
		"invalid json":     {"claude_code", `{"cwd":`, agent.ErrInvalidHook},
		"redacted call id": {"claude_code", hook(f.project, "PreToolUse", `,"tool_name":"Read","tool_use_id":"sk-ABCDEFGHIJKLMNOPQRSTUVWX"`), ErrIdentityRedacted},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := f.shim.Handle(c.agent, strings.NewReader(c.input)); !errors.Is(err, c.want) {
				t.Fatalf("got %v want %v", err, c.want)
			}
			if names, _ := inbox.List(f.layout.InboxDir()); len(names) != 0 {
				t.Fatal("rejected input was retained")
			}
		})
	}
	f.shim.HandleAndRecord("claude_code", strings.NewReader(`{"cwd":`))
	health, _ := state.Load[state.Health](f.layout.Health())
	if health.HookErrors != 1 || health.HookLastError != agent.ErrInvalidHook.Error() {
		t.Fatalf("hook error not counted: %+v", health)
	}
}

// The hot path must never run Beacon, hash binaries or touch the network.
func TestShimDoesNotDependOnBeaconOrNetwork(t *testing.T) {
	output, err := exec.Command("go", "list", "-deps", ".").Output()
	if err != nil {
		t.Skipf("go list unavailable: %v", err)
	}
	for _, forbidden := range []string{"internal/beacon", "internal/uplink", "internal/credentials", "internal/daemon", "net/http", "os/exec", "crypto/tls"} {
		for _, dependency := range strings.Fields(string(output)) {
			if dependency == forbidden || strings.HasSuffix(dependency, "/"+forbidden) {
				t.Errorf("shim depends on %s", dependency)
			}
		}
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func BenchmarkInScopeHook(b *testing.B) {
	f := newFixture(b, true)
	input := hook(f.project, "PreToolUse", `,"tool_name":"Read","tool_use_id":"toolu_1","tool_input":{"file_path":"README.md"}`)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
			b.Fatal(err)
		}
		if i%512 == 511 {
			b.StopTimer()
			os.RemoveAll(f.layout.InboxDir())
			b.StartTimer()
		}
	}
}

// BenchmarkBoundaryHook is a Stop hook naming a 64 MiB transcript: the
// shim's cost must not depend on the transcript.
func BenchmarkBoundaryHook(b *testing.B) {
	f := newFixture(b, true)
	transcript := filepath.Join(f.home, "sess-1.jsonl")
	if err := os.WriteFile(transcript, bytes.Repeat([]byte(`{"type":"assistant","message":{"usage":{"input_tokens":1}}}`+"\n"), 1<<20), 0o600); err != nil {
		b.Fatal(err)
	}
	input := hook(f.project, "Stop", `,"transcript_path":"`+transcript+`","stop_hook_active":false`)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
			b.Fatal(err)
		}
		if i%512 == 511 {
			b.StopTimer()
			os.RemoveAll(f.layout.InboxDir())
			b.StartTimer()
		}
	}
}

func TestIgnoredEventsAreNeitherRetainedNorCountedAsErrors(t *testing.T) {
	f := newFixture(t, true)
	f.cached.Policy.Installation.EnabledAgents = []string{"claude_code", "pi_cli"}
	f.savePolicy(t)
	userMessage := `{"type":"message_end","message":{"role":"user","content":"private words"},"sessionId":"pi-sess-1","cwd":"` + f.project + `"}`
	f.shim.HandleAndRecord("pi", strings.NewReader(userMessage))
	health, _ := state.Load[state.Health](f.layout.Health())
	if names, _ := inbox.List(f.layout.InboxDir()); len(names) != 0 || health.HookErrors != 0 {
		t.Fatalf("ignored event retained or counted: %+v", health)
	}
	prompt := `{"type":"input","text":"hello","sessionId":"pi-sess-1","cwd":"` + f.project + `"}`
	if err := f.shim.Handle("pi", strings.NewReader(prompt)); err != nil {
		t.Fatal(err)
	}
	names, _ := inbox.List(f.layout.InboxDir())
	if len(names) != 1 {
		t.Fatal("Pi prompt not captured")
	}
	item, _ := inbox.Read(f.layout.InboxDir(), names[0])
	if item.Agent != "pi_cli" || item.Observation.NativeSessionID != "pi-sess-1" || item.Payload["cwd"] != f.project {
		t.Fatalf("Pi item: %+v", item)
	}
}

func TestCodexHooksRecordThreadScopeWithoutRetainingContent(t *testing.T) {
	f := newFixture(t, true)
	sub := filepath.Join(f.project, "sub")
	os.MkdirAll(sub, 0o700)
	start := `{"session_id":"thread-root","transcript_path":null,"cwd":"` + f.project + `","hook_event_name":"SessionStart","model":"gpt-5","permission_mode":"default","source":"startup"}`
	child := `{"session_id":"thread-root","turn_id":"t1","transcript_path":null,"cwd":"` + sub + `","hook_event_name":"SubagentStart","model":"gpt-5","permission_mode":"default","agent_id":"thread-child","agent_type":"worker"}`
	prompt := `{"session_id":"thread-root","turn_id":"t1","transcript_path":null,"cwd":"` + f.project + `","hook_event_name":"UserPromptSubmit","model":"gpt-5","permission_mode":"default","prompt":"SECRET_PROMPT"}`
	for _, input := range []string{start, child, prompt} {
		if err := f.shim.Handle("codex", strings.NewReader(input)); err != nil {
			t.Fatal(err)
		}
	}
	if names, _ := inbox.List(f.layout.InboxDir()); len(names) != 0 {
		t.Fatal("Codex hook payloads must not become inbox items")
	}
	threads, _ := state.Load[state.Threads](f.layout.Threads())
	if threads.Threads["thread-root"].Cwd != f.project || threads.Threads["thread-child"].Cwd != sub || threads.Threads["thread-child"].SessionID != "thread-root" {
		t.Fatalf("thread scope not recorded: %+v", threads)
	}
	data, _ := os.ReadFile(f.layout.Threads())
	if strings.Contains(string(data), "SECRET_PROMPT") {
		t.Fatal("prompt content retained in the thread table")
	}
	info, _ := os.Stat(f.layout.Threads())
	f.shim.Handle("codex", strings.NewReader(prompt))
	if again, _ := os.Stat(f.layout.Threads()); !again.ModTime().Equal(info.ModTime()) {
		t.Fatal("an unchanged thread rewrote the table on the hot path")
	}
	moved := filepath.Join(f.home, "elsewhere")
	os.MkdirAll(moved, 0o700)
	f.shim.Handle("codex", strings.NewReader(strings.Replace(prompt, `"cwd":"`+f.project+`"`, `"cwd":"`+moved+`"`, 1)))
	threads, _ = state.Load[state.Threads](f.layout.Threads())
	if threads.Threads["thread-root"].Cwd != moved {
		t.Fatal("a changed cwd was not re-recorded")
	}
}

func TestToolOutputIsRetainedOnlyAtTheFullLevel(t *testing.T) {
	output := strings.Repeat("TOOL_OUTPUT ", 3000)
	cases := []struct {
		agent, payload, member string
	}{
		{"claude_code", `{"cwd":"CWD","session_id":"s1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"make test"},"tool_response":{"stdout":"` + output + `"}}`, "tool_response"},
		{"pi", `{"type":"tool_result","toolName":"bash","toolCallId":"c1","input":{"command":"make test"},"content":[{"type":"text","text":"` + output + `"}],"details":{"patch":"` + output + `"},"isError":false,"sessionId":"s1","cwd":"CWD"}`, "content"},
	}
	for _, c := range cases {
		for _, level := range []string{"metadata", "standard", "full"} {
			t.Run(c.agent+"/"+level, func(t *testing.T) {
				f := newFixture(t, true)
				f.cached.Policy.Installation.EnabledAgents = nil
				f.cached.Policy.Mappings[0].ContentLevel = level
				f.savePolicy(t)
				if err := f.shim.Handle(c.agent, strings.NewReader(strings.ReplaceAll(c.payload, "CWD", f.project))); err != nil {
					t.Fatal(err)
				}
				names, _ := inbox.List(f.layout.InboxDir())
				item, _ := inbox.Read(f.layout.InboxDir(), names[0])
				encoded, _ := json.Marshal(item.Payload)
				kept := strings.Contains(string(encoded), "TOOL_OUTPUT")
				switch level {
				case "full":
					if !kept || len(encoded) > 3*privacy.MaxFullToolOutputBytes || !strings.Contains(string(encoded), "[truncated]") {
						t.Fatalf("full must keep bounded tool output (%d bytes)", len(encoded))
					}
				case "standard":
					descriptor, _ := item.Payload[c.member].(map[string]any)
					if kept || descriptor["sha256"] == nil || !strings.Contains(string(encoded), "make test") {
						t.Fatalf("standard must replace tool output and keep the command: %.300s", encoded)
					}
				default:
					if kept || strings.Contains(string(encoded), "make test") {
						t.Fatalf("metadata kept content: %.300s", encoded)
					}
				}
			})
		}
	}
}

func (f *fixture) unmappedRepo(t *testing.T, name string) string {
	t.Helper()
	repo := filepath.Join(f.home, "code", name)
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	return repo
}

func setOrigin(t *testing.T, repo, remote string) {
	t.Helper()
	config := ""
	if remote != "" {
		config = "[remote \"origin\"]\n\turl = " + remote + "\n"
	}
	if err := os.WriteFile(filepath.Join(repo, ".git", "config"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) discoveredRemote(t *testing.T, repo string) string {
	t.Helper()
	discovered, _ := state.Load[state.Discovered](f.layout.Discovered())
	for _, project := range discovered.Projects {
		if project.Root == repo {
			return project.RepoURL
		}
	}
	t.Fatalf("%s not discovered", repo)
	return ""
}

func TestDiscoveredRepo_FollowsItsRemoteAcrossHooks(t *testing.T) {
	f := newFixture(t, true)
	repo := f.unmappedRepo(t, "skate")
	input := hook(repo, "UserPromptSubmit", `,"prompt":"x"`)
	steps := []struct{ origin, want string }{
		{"", ""},
		// A credentialed remote is stored exactly as a first discovery would store it.
		{"https://owner:ghp_SECRET@github.com/Acme-Labs/skate.git", "github.com/acme-labs/skate"},
		{"git@gitlab.com:acme/skate.git", "gitlab.com/acme/skate"},
		{"", ""},
	}
	for _, step := range steps {
		setOrigin(t, repo, step.origin)
		if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
			t.Fatal(err)
		}
		if got := f.discoveredRemote(t, repo); got != step.want {
			t.Fatalf("origin %q: discovered remote %q, want %q", step.origin, got, step.want)
		}
		if data, _ := os.ReadFile(f.layout.Discovered()); bytes.Contains(data, []byte("SECRET")) || bytes.Contains(data, []byte("owner")) {
			t.Fatalf("remote userinfo persisted: %s", data)
		}
	}
}

func TestDiscoveredRepo_AChangedRemoteIsOfferedForAutoMatchAgain(t *testing.T) {
	f := newFixture(t, true)
	repo := f.unmappedRepo(t, "app2")
	setOrigin(t, repo, "git@github.com:acme/old.git")
	f.cached.Policy.Installation.AutoMatchRepos = true
	f.cached.Policy.RepoCatalog = []policy.CatalogRepo{{WorkspaceID: "w", BoardID: "b", RepoURLNormalized: "github.com/acme/new"}}
	f.savePolicy(t)
	// The server refused the old remote.
	state.MarkUnmatched(context.Background(), f.layout, scope.Project{Root: repo, RepoURL: "github.com/acme/old"}, now)
	setOrigin(t, repo, "git@github.com:acme/new.git")
	input := hook(repo, "UserPromptSubmit", `,"prompt":"x"`)
	for range 2 {
		if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
			t.Fatal(err)
		}
	}
	items, _ := inbox.List(f.layout.InboxDir())
	if len(items) != 1 {
		t.Fatalf("a new remote in the catalog was not offered for auto-match: %d inbox items", len(items))
	}
	item, _ := inbox.Read(f.layout.InboxDir(), items[0])
	if item.PendingAutoMatch == nil || item.PendingAutoMatch.RepoURL != "github.com/acme/new" {
		t.Fatalf("pending auto-match %+v", item.PendingAutoMatch)
	}
}

// The hot path only reads when nothing changed: a lock held elsewhere
// never delays it, while a real change does wait for the lock.
func TestDiscoveredRepo_AnUnchangedRemoteTakesNoLock(t *testing.T) {
	f := newFixture(t, true)
	repo := f.unmappedRepo(t, "steady")
	setOrigin(t, repo, "git@github.com:acme/steady.git")
	input := hook(repo, "UserPromptSubmit", `,"prompt":"x"`)
	if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	lock, err := store.Lock(context.Background(), f.layout.StateLock())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Unlock()
	if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
		t.Fatalf("an unchanged discovery waited for the lock: %v", err)
	}
	setOrigin(t, repo, "git@github.com:acme/moved.git")
	if err := f.shim.Handle("claude_code", strings.NewReader(input)); err == nil {
		t.Fatal("a changed remote was not written under the lock")
	}
}

func TestDiscoveredRepo_RestoringARefusedRemoteIsNotOfferedAgain(t *testing.T) {
	f := newFixture(t, true)
	repo := f.unmappedRepo(t, "refused")
	f.cached.Policy.Installation.AutoMatchRepos = true
	f.cached.Policy.RepoCatalog = []policy.CatalogRepo{{WorkspaceID: "w", BoardID: "b", RepoURLNormalized: "github.com/acme/refused"}}
	f.savePolicy(t)
	state.MarkUnmatched(context.Background(), f.layout, scope.Project{Root: repo, RepoURL: "github.com/acme/refused"}, now)
	input := hook(repo, "UserPromptSubmit", `,"prompt":"x"`)
	for _, origin := range []string{"", "git@github.com:acme/refused.git", "git@github.com:acme/refused.git"} {
		setOrigin(t, repo, origin)
		if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
			t.Fatal(err)
		}
	}
	if items, _ := inbox.List(f.layout.InboxDir()); len(items) != 0 {
		t.Fatalf("a refused remote was offered for auto-match again: %d inbox items", len(items))
	}
}
