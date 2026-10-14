// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package daemon

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
)

// A malformed session line over the record limit is declared too large
// once and read past in bounded passes that survive restarts; while it
// drains, other sessions, uploads and heartbeats go on.
const (
	boundProbeMode  = "BACKPLANE_TEST_DAEMON_BOUND_MODE"
	boundProbeReady = "BACKPLANE_TEST_DAEMON_BOUND_READY"
	sparseTiB       = int64(1) << 40
	// The tick's own work under -race stays well inside this; draining a
	// sparse TiB does not.
	tickDeadline = 30 * time.Second
	readAhead    = 64 << 10
	otherSession = "sess-b"
)

// passCeiling is the most one pass may read: its budget, then one line up
// to the record limit (the valid long line read alone), plus a read buffer.
const passCeiling = int64(maxContentReadBytes + richcapture.MaxLineBytes + readAhead)

func requireSparse(t *testing.T, dir string) {
	t.Helper()
	probe := filepath.Join(dir, "sparse-probe")
	file, err := os.Create(probe)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(probe)
	defer file.Close()
	if err := file.Truncate(8 << 20); err != nil {
		t.Skipf("filesystem cannot create a sparse probe: %v", err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Blocks*512 > 1<<20 {
		t.Skip("filesystem does not support sparse files")
	}
}

// appendSparse appends a hole of hole bytes, then tail, to the session
// file and returns its size.
func appendSparse(t *testing.T, path string, hole int64, tail string) int64 {
	t.Helper()
	appendSession(t, path, "")
	requireSparse(t, filepath.Dir(path))
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	end := info.Size() + hole
	if err := file.Truncate(end); err != nil {
		t.Skipf("filesystem cannot hold the sparse fixture: %v", err)
	}
	if _, err := file.WriteAt([]byte(tail), end); err != nil {
		t.Fatal(err)
	}
	return end + int64(len(tail))
}

// declaredContent splits what the server was declared into the record
// too large and every other content key.
func declaredContent(f *fixture) (tooLarge int, keys []string) {
	for _, declaration := range f.server.Declarations() {
		if declaration["coverage_reason"] == "record_too_large" {
			tooLarge++
			continue
		}
		keys = append(keys, declaration["content_key"].(string))
	}
	return tooLarge, keys
}

// ticksUntilDeclared ticks, each a second on, until key is declared, and
// returns how many ticks that took; restart restarts the daemon before
// every tick.
func ticksUntilDeclared(t *testing.T, f *fixture, key string, restart bool) int {
	t.Helper()
	for ticks := 1; ticks <= 64; ticks++ {
		if restart {
			f.daemon = New(f.daemon.config)
		}
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
		if _, keys := declaredContent(f); slices.Contains(keys, key) {
			return ticks
		}
	}
	tooLarge, keys := declaredContent(f)
	t.Fatalf("no forward progress: %s never declared in 64 passes (declared %v, %d too large)", key, keys, tooLarge)
	return 0
}

func malformedSession(t *testing.T, f *fixture) int64 {
	t.Helper()
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "before the malformed line"))
	return appendSparse(t, f.sessionFile(session), 128<<20, "\n"+textLine("e2", f.stamp(), "after it").Encode())
}

func expectDeclaredOnce(t *testing.T, f *fixture, ticks int, reach int64) {
	t.Helper()
	if earliest := int((reach + passCeiling - 1) / passCeiling); ticks < earliest {
		t.Fatalf("e2 ends %d bytes in; passes of at most %d bytes reach it in pass %d at the earliest, it came in pass %d", reach, passCeiling, earliest, ticks)
	}
	f.tickUntilSettled(t)
	tooLarge, keys := declaredContent(f)
	if tooLarge != 1 || fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("want e1, one record_too_large and e2, each once: %d too large, %v", tooLarge, keys)
	}
	if health := richHealth(t, f); health.RecordTooLarge != 1 || health.ParseErrors != 0 {
		t.Fatalf("the line's rest was read as a line of its own: %+v", health)
	}
}

func TestAMalformedLineIsDeclaredOnceAndReadPastInBoundedPasses(t *testing.T) {
	f := newRichFixture(t)
	reach := malformedSession(t, f)
	expectDeclaredOnce(t, f, ticksUntilDeclared(t, f, itemKey("e2"), false), reach)
}

func TestADrainSurvivesARestartBeforeEveryPass(t *testing.T) {
	f := newRichFixture(t)
	reach := malformedSession(t, f)
	expectDeclaredOnce(t, f, ticksUntilDeclared(t, f, itemKey("e2"), true), reach)
}

// A session file rotated mid-drain is read anew from its first line;
// nothing of the old file's drain carries over to the new one.
func TestASessionFileRotatedMidDrainIsReadAnew(t *testing.T) {
	f := newRichFixture(t)
	malformedSession(t, f)
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	path := f.sessionFile(session)
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	f.appendLines(t, session, textLine("e3", f.stamp(), "the replacement"))
	f.richHook(t, session, f.repo)
	ticksUntilDeclared(t, f, itemKey("e3"), false)
	f.tickUntilSettled(t)
	tooLarge, keys := declaredContent(f)
	if tooLarge != 1 || fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e3")}) {
		t.Fatalf("want e1, one record_too_large and e3: %d too large, %v", tooLarge, keys)
	}
	if richHealth(t, f).SourceReplaced != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}

// One session's malformed line, in its body or as its header, neither
// stalls the tick nor keeps another session, the upload or the heartbeat
// waiting. The tick runs in an owned child process with its temporary
// files under a directory this test owns and removes.
func TestAMalformedLineStarvesNoOtherSessionUploadOrHeartbeat(t *testing.T) {
	for _, mode := range []string{"body", "header"} {
		t.Run(mode, func(t *testing.T) {
			dir, _ := filepath.EvalSymlinks(t.TempDir())
			requireSparse(t, dir)
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			const probe = "TestDaemonBoundProbeChild"
			ready := filepath.Join(dir, "ready")
			child := exec.Command(executable, "-test.run=^"+probe+"$", "-test.count=1", "-test.v")
			child.Env = append(os.Environ(), "TMPDIR="+dir, boundProbeMode+"="+mode, boundProbeReady+"="+ready)
			var output bytes.Buffer
			child.Stdout, child.Stderr = &output, &output
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			var waitErr error
			go func() { waitErr = child.Wait(); close(done) }()
			// The owned child is killed and reaped before TempDir removes
			// the sparse session file it left there.
			t.Cleanup(func() {
				_ = child.Process.Kill()
				<-done
			})
			startup := time.NewTimer(120 * time.Second)
			defer startup.Stop()
			for {
				if _, err := os.Stat(ready); err == nil {
					break
				}
				select {
				case <-done:
					// The child can publish readiness and exit after the stat above.
					if _, err := os.Stat(ready); err != nil {
						t.Fatalf("probe exited before ticking: %v\n%s", waitErr, output.String())
					}
				case <-startup.C:
					t.Fatal("probe never reached the tick")
				case <-time.After(10 * time.Millisecond):
				}
			}
			select {
			case <-done:
				if waitErr != nil || !strings.Contains(output.String(), "--- PASS: "+probe) {
					t.Fatalf("probe failed: %v\n%s", waitErr, output.String())
				}
			case <-time.After(tickDeadline):
				t.Fatal("the tick drained a malformed session line instead of reading it in bounded passes")
			}
		})
	}
}

func TestDaemonBoundProbeChild(t *testing.T) {
	mode := os.Getenv(boundProbeMode)
	if mode == "" {
		t.Skip("owned subprocess probe only")
	}
	f := newRichFixture(t)
	f.richHook(t, otherSession, f.repo)
	f.appendLines(t, otherSession, textLine("b1", f.stamp(), "another session"))
	*f.clock = f.clock.Add(time.Second)
	// Sighted last, the malformed session is read first in every pass.
	f.richHook(t, session, f.repo)
	if mode == "body" {
		f.appendLines(t, session, textLine("e1", f.stamp(), "before the malformed line"))
	}
	appendSparse(t, f.sessionFile(session), sparseTiB, "\n"+textLine("e2", f.stamp(), "after it").Encode())
	beats := len(f.heartbeats())
	*f.clock = f.clock.Add(HeartbeatInterval)
	if err := os.WriteFile(os.Getenv(boundProbeReady), []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
	}
	tooLarge, keys := declaredContent(f)
	other := agent.ContentKey(richAgent, otherSession, "b1", "text:0")
	if !slices.Contains(keys, other) {
		t.Fatalf("the other session waited behind the malformed line: declared %v", keys)
	}
	if mode == "body" && !slices.Contains(keys, itemKey("e1")) || slices.Contains(keys, itemKey("e2")) || tooLarge != 1 {
		t.Fatalf("the malformed session: %d too large, declared %v", tooLarge, keys)
	}
	if len(f.heartbeats()) <= beats {
		t.Fatal("no heartbeat while the malformed line drained")
	}
}
