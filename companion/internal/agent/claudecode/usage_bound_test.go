// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package claudecode

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// A transcript line over the limit is read past in bounded reads that
// resume where the last one stopped, so a request held back before it
// cannot pin every read to the line's start.
const (
	usageProbeFile  = "BACKPLANE_TEST_CLAUDE_USAGE_BOUND_FILE"
	usageProbeReady = "BACKPLANE_TEST_CLAUDE_USAGE_BOUND_READY"
	sparseTiB       = int64(1) << 40
	probeDeadline   = 10 * time.Second
	readAhead       = 64 << 10
	// hugeLine outruns any one read: more than two read ceilings.
	hugeLine = int64(640 << 20)
)

// readCeiling is the most one read may consume: its budget, then one line
// up to the limit to tell it oversized, plus one read buffer.
const readCeiling = int64(maxUsageReadBytes + maxUsageLineBytes + readAhead)

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

// appendSparse appends a hole of hole bytes, then tail, and returns the
// file's size.
func appendSparse(t *testing.T, path string, hole int64, tail string) int64 {
	t.Helper()
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

// stopReads runs Stop boundary reads, noting the 1-based read that first
// emitted each output count and how often each was emitted.
func (f *transcriptFixture) stopReads(t *testing.T, reads int, arrived, emitted map[int]int, offset int) {
	t.Helper()
	for read := 1; read <= reads; read++ {
		for _, event := range f.read(t, "Stop", usageNow) {
			output := number(usageOf(t, event)["output_tokens"])
			emitted[output]++
			if _, seen := arrived[output]; !seen {
				arrived[output] = offset + read
			}
		}
	}
}

func requestLine(t *testing.T, id string, second, output int) string {
	return encodeLines(t, assistant("msg_"+id, "req_"+id, fmt.Sprintf("2026-09-25T11:00:%02dZ", second), tokens(3, 0, 0, output)))
}

func TestUsageDrainsAHugeLineInBoundedReads(t *testing.T) {
	f := newTranscript(t, requestLine(t, "A", 1, 1))
	reach := appendSparse(t, f.path, hugeLine, "\n"+requestLine(t, "B", 2, 2))
	arrived, emitted := map[int]int{}, map[int]int{}
	f.stopReads(t, int(reach/maxUsageReadBytes)+4, arrived, emitted, 0)
	if emitted[1] != 1 || emitted[2] != 1 || len(emitted) != 2 {
		t.Fatalf("no forward progress past the oversized line: each request once, got %v", emitted)
	}
	if earliest := int((reach + readCeiling - 1) / readCeiling); arrived[2] < earliest {
		t.Fatalf("the request after the line ends %d bytes in; reads of at most %d bytes reach it in read %d at the earliest, it came in read %d",
			reach, readCeiling, earliest, arrived[2])
	}
}

// The request before a growing oversized line may be held while the line
// is written; the line is still read past meanwhile, so its newline puts
// the next request within reach.
func TestUsageAHeldRequestDoesNotPinAGrowingDrain(t *testing.T) {
	f := newTranscript(t, requestLine(t, "A", 1, 1))
	appendSparse(t, f.path, hugeLine, "")
	arrived, emitted := map[int]int{}, map[int]int{}
	growing := int(hugeLine/maxUsageReadBytes) + 1
	f.stopReads(t, growing, arrived, emitted, 0)
	f.appendText(t, "\n"+requestLine(t, "B", 2, 2))
	f.stopReads(t, 2, arrived, emitted, growing)
	if emitted[1] != 1 || emitted[2] != 1 || len(emitted) != 2 {
		t.Fatalf("no forward progress while the line grew: each request once within two reads of its newline, got %v", emitted)
	}
}

// A transcript rewritten shorter mid-drain is read anew from its start.
func TestUsageARewrittenTranscriptForgetsAPartialDrain(t *testing.T) {
	f := newTranscript(t, requestLine(t, "A", 1, 1))
	appendSparse(t, f.path, hugeLine, "\n"+requestLine(t, "B", 2, 2))
	arrived, emitted := map[int]int{}, map[int]int{}
	f.stopReads(t, 1, arrived, emitted, 0)
	writeFile(t, f.path, requestLine(t, "C", 3, 3))
	f.stopReads(t, 2, arrived, emitted, 1)
	if emitted[3] != 1 || emitted[2] != 0 || emitted[1] > 1 {
		t.Fatalf("the rewritten transcript is read from its start, once: %v", emitted)
	}
}

func TestUsageDoesNotDrainAnOversizedLine(t *testing.T) {
	for name, tail := range map[string]string{"ended": "\n" + requestLine(t, "B", 2, 2), "still being written": ""} {
		t.Run(name, func(t *testing.T) {
			f := newTranscript(t, requestLine(t, "A", 1, 1))
			appendSparse(t, f.path, sparseTiB, tail)
			probeUsageWithin(t, f.path, "ReadUsage drained an oversized transcript line instead of bounding the read")
		})
	}
}

func TestClaudeUsageBoundProbeChild(t *testing.T) {
	path := os.Getenv(usageProbeFile)
	if path == "" {
		t.Skip("owned subprocess probe only")
	}
	if err := os.WriteFile(os.Getenv(usageProbeReady), []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New().ReadUsage(agent.UsageRead{Transcript: path, SessionID: usageSession, Event: "Stop", Now: usageNow}, nil); err != nil {
		t.Fatal(err)
	}
}

func probeUsageWithin(t *testing.T, path, drained string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	const probe = "TestClaudeUsageBoundProbeChild"
	ready := filepath.Join(t.TempDir(), "ready")
	child := exec.Command(executable, "-test.run=^"+probe+"$", "-test.count=1", "-test.v")
	child.Env = append(os.Environ(), usageProbeFile+"="+path, usageProbeReady+"="+ready)
	var output bytes.Buffer
	child.Stdout, child.Stderr = &output, &output
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = child.Wait(); close(done) }()
	// The owned child is killed and reaped before TempDir removes the
	// sparse transcript it reads.
	t.Cleanup(func() {
		_ = child.Process.Kill()
		<-done
	})
	startup := time.NewTimer(60 * time.Second)
	defer startup.Stop()
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		select {
		case <-done:
			// The child can publish readiness and exit after the stat above.
			if _, err := os.Stat(ready); err != nil {
				t.Fatalf("probe exited before reading: %v\n%s", waitErr, output.String())
			}
		case <-startup.C:
			t.Fatal("probe never reached the read")
		case <-time.After(10 * time.Millisecond):
		}
	}
	select {
	case <-done:
		if waitErr != nil || !strings.Contains(output.String(), "--- PASS: "+probe) {
			t.Fatalf("probe failed: %v\n%s", waitErr, output.String())
		}
	case <-time.After(probeDeadline):
		t.Fatal(drained)
	}
}
