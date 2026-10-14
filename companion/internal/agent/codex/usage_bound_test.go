// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package codex

import (
	"bytes"
	"encoding/json"
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

// A rollout line over the limit is read past in bounded reads that resume
// where the last one stopped: no read consumes more than its budget and one
// line, a budget boundary is never mistaken for the end of what is written,
// and nothing of the line's body is read as a line of its own.
const (
	usageProbeFile  = "BACKPLANE_TEST_USAGE_BOUND_FILE"
	usageProbeHome  = "BACKPLANE_TEST_USAGE_BOUND_HOME"
	usageProbeReady = "BACKPLANE_TEST_USAGE_BOUND_READY"
	sparseTiB       = int64(1) << 40
	probeDeadline   = 10 * time.Second
	readAhead       = 64 << 10
)

// readCeiling is the most one read may consume: its budget, then one line
// up to the limit to tell it oversized, plus one read buffer.
func readCeiling() int64 { return maxRolloutReadBytes + maxRolloutLineBytes + readAhead }

func withReadBudget(t *testing.T, budget int64) {
	t.Helper()
	previous := maxRolloutReadBytes
	maxRolloutReadBytes = budget
	t.Cleanup(func() { maxRolloutReadBytes = previous })
}

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

type drainedReads struct {
	outputs []int
	// arrived is the 1-based read that first emitted each output.
	arrived map[int]int
}

// readsUntilSettled polls until a read leaves nothing for later; every
// read before it must say the rollout was left for later.
func (f *rolloutFixture) readsUntilSettled(t *testing.T, maxReads int) drainedReads {
	t.Helper()
	drained := drainedReads{arrived: map[int]int{}}
	for reads := 1; reads <= maxReads; reads++ {
		for _, output := range outputs(f.read(t)) {
			drained.outputs = append(drained.outputs, output)
			if _, seen := drained.arrived[output]; !seen {
				drained.arrived[output] = reads
			}
		}
		if f.last.DeferredFiles == 0 {
			if again := outputs(f.read(t)); len(again) != 0 {
				t.Fatalf("a settled rollout emitted again: %v", again)
			}
			return drained
		}
	}
	t.Fatalf("still deferred after %d reads, emitted %v", maxReads, drained.outputs)
	return drained
}

// notBefore fails when output arrived sooner than reads bounded by
// readCeiling can reach the end of its line at reach.
func (d drainedReads) notBefore(t *testing.T, output int, reach int64) {
	t.Helper()
	earliest := int((reach + readCeiling() - 1) / readCeiling())
	if got, ok := d.arrived[output]; !ok || got < earliest {
		t.Fatalf("output %d ends %d bytes in; reads of at most %d bytes reach it in read %d at the earliest, it came in read %d (emitted: %t)",
			output, reach, readCeiling(), earliest, got, ok)
	}
}

func TestRolloutUsage_DrainsAHugeLineInBoundedReads(t *testing.T) {
	withReadBudget(t, 256<<10)
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	reach := appendSparse(t, f.path, 64<<20, "\n"+encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0))))
	drained := f.readsUntilSettled(t, int(reach/readAhead)+16)
	if fmt.Sprint(drained.outputs) != "[1 2]" {
		t.Fatalf("each record once, around the oversized line: %v", drained.outputs)
	}
	drained.notBefore(t, 2, reach)
}

// The oversized line ends in a record of its own shape; read from inside
// the line, as if a drain boundary were a line start, it would count.
func TestRolloutUsage_ADrainNeverReadsTheTailOfAnOversizedLine(t *testing.T) {
	withReadBudget(t, 256<<10)
	tail := encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_leak", codexTokens(100, 0, 0, 777, 0)))
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)))+
		strings.Repeat(" ", 3<<20)+tail+
		encodeRollout(t, usageRecord(5*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0))))
	info, err := os.Stat(f.path)
	if err != nil {
		t.Fatal(err)
	}
	drained := f.readsUntilSettled(t, int(info.Size()/readAhead)+16)
	if fmt.Sprint(drained.outputs) != "[1 2]" {
		t.Fatalf("the oversized line's tail was read as a record: %v", drained.outputs)
	}
	drained.notBefore(t, 2, info.Size())
}

// Token counts wait while a drain is cut short by its budget: a record for
// the same response may still follow, and here one does.
func TestRolloutUsage_TokenCountsWaitThroughADrain(t *testing.T) {
	withReadBudget(t, 256<<10)
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), tokenCount(2*time.Second, codexTokens(1000, 0, 0, 50, 0), nil)))
	reach := appendSparse(t, f.path, 16<<20, "\n"+encodeRollout(t, usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(1000, 0, 0, 50, 0))))
	drained := f.readsUntilSettled(t, int(reach/readAhead)+16)
	if fmt.Sprint(drained.outputs) != "[50]" {
		t.Fatalf("a budget boundary settled the token count early: %v", drained.outputs)
	}
	drained.notBefore(t, 50, reach)
}

// A line growing past the limit is read past while it is written, so once
// its newline lands the record after it is one read away.
func TestRolloutUsage_AGrowingOversizedLineIsDrainedBeforeItsNewline(t *testing.T) {
	withReadBudget(t, 256<<10)
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	hole := int64(8 << 20)
	appendSparse(t, f.path, hole, "")
	var emitted []int
	for range int(hole/readAhead) + 8 {
		emitted = append(emitted, outputs(f.read(t))...)
	}
	if fmt.Sprint(emitted) != "[1]" {
		t.Fatalf("while the line grows: %v", emitted)
	}
	f.appendText(t, "\n"+encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0))))
	for range 2 {
		emitted = append(emitted, outputs(f.read(t))...)
	}
	if fmt.Sprint(emitted) != "[1 2]" {
		t.Fatalf("the record after a drained line comes within two reads, once: %v", emitted)
	}
}

// A rollout rewritten shorter mid-drain is read anew from its first line.
func TestRolloutUsage_ARewrittenRolloutForgetsAPartialDrain(t *testing.T) {
	withReadBudget(t, 256<<10)
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	appendSparse(t, f.path, 64<<20, "\n"+encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0))))
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[1]" {
		t.Fatalf("first read: %v", outputs(events))
	}
	write(t, f.path, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(5*time.Second, rolloutThread, "resp_10", codexTokens(100, 0, 0, 10, 0))))
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[10]" {
		t.Fatalf("the rewritten rollout is read from its start: %v", outputs(events))
	}
	if events := f.read(t); len(events) != 0 {
		t.Fatalf("read again: %v", outputs(events))
	}
}

func TestRolloutUsage_DoesNotDrainAnOversizedLine(t *testing.T) {
	for name, tail := range map[string]string{"ended": "\n" + encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0))), "still being written": ""} {
		t.Run(name, func(t *testing.T) {
			f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
			appendSparse(t, f.path, sparseTiB, tail)
			probeUsageWithin(t, []string{usageProbeFile + "=" + f.path, usageProbeHome + "=" + f.env.Home},
				"ReadUsage drained an oversized rollout line instead of bounding the read")
		})
	}
}

func TestRolloutUsageBoundProbeChild(t *testing.T) {
	path := os.Getenv(usageProbeFile)
	if path == "" {
		t.Skip("owned subprocess probe only")
	}
	if err := os.WriteFile(os.Getenv(usageProbeReady), []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := agent.Env{Home: os.Getenv(usageProbeHome), Getenv: func(string) string { return "" }}
	result, err := New().ReadUsage(agent.UsageRead{Transcript: path, SessionID: rolloutThread, Now: rolloutNow, Env: env}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var emitted []int
	for _, raw := range result.Events {
		var event map[string]any
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		emitted = append(emitted, outputs([]map[string]any{event})...)
	}
	if fmt.Sprint(emitted) != "[1]" {
		t.Fatalf("one bounded read: %v", emitted)
	}
}

func probeUsageWithin(t *testing.T, env []string, drained string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	const probe = "TestRolloutUsageBoundProbeChild"
	ready := filepath.Join(t.TempDir(), "ready")
	child := exec.Command(executable, "-test.run=^"+probe+"$", "-test.count=1", "-test.v")
	child.Env = append(append(os.Environ(), env...), usageProbeReady+"="+ready)
	var output bytes.Buffer
	child.Stdout, child.Stderr = &output, &output
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = child.Wait(); close(done) }()
	// The owned child is killed and reaped before TempDir removes the
	// sparse rollout it reads.
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
