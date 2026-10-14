// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package shim

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
)

// The hook only names the session file rich capture reads; reading it is
// the daemon's.
func TestHookNamesTheContentFileWithoutReadingIt(t *testing.T) {
	f := newFixture(t, true)
	f.shim.Registry = agent.NewRegistry(contracttest.Agent{Name: "pi_cli"})
	f.cached.Policy.Installation.EnabledAgents = nil
	f.savePolicy(t)
	sessionFile := filepath.Join(f.home, ".pi", "sessions", "never-created.jsonl")
	payload, _ := json.Marshal(map[string]string{"session_id": "s1", "cwd": f.project, "hook_event_name": "message_end", "session_file": sessionFile})
	if err := f.shim.Handle("pi_cli", strings.NewReader(string(payload))); err != nil {
		t.Fatal(err)
	}
	names, _ := inbox.List(f.layout.InboxDir())
	if len(names) != 1 {
		t.Fatalf("inbox holds %d items", len(names))
	}
	item, err := inbox.Read(f.layout.InboxDir(), names[0])
	if err != nil || item.ContentFile != sessionFile {
		t.Fatalf("content file %q, %v", item.ContentFile, err)
	}
}

// BenchmarkContentSourceHook is an in-scope hook of an agent whose session
// file rich capture reads: naming the file must cost the hook nothing.
func BenchmarkContentSourceHook(b *testing.B) {
	f := newFixture(b, true)
	f.shim.Registry = agent.NewRegistry(contracttest.Agent{Name: "pi_cli"})
	f.cached.Policy.Installation.EnabledAgents = nil
	f.savePolicy(b)
	payload, _ := json.Marshal(map[string]string{"session_id": "s1", "cwd": f.project, "hook_event_name": "message_end", "session_file": filepath.Join(f.home, ".pi", "sessions", "s1.jsonl")})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := f.shim.Handle("pi_cli", strings.NewReader(string(payload))); err != nil {
			b.Fatal(err)
		}
		if i%512 == 511 {
			b.StopTimer()
			os.RemoveAll(f.layout.InboxDir())
			b.StartTimer()
		}
	}
}
