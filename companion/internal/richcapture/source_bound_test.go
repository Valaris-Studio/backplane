// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package richcapture

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A malformed session file must never make one call read without bound:
// a line over the limit is reported once, then read past in bounded steps
// that persist across calls and restarts, and a replaced file starts over.
const (
	boundProbeFile  = "BACKPLANE_TEST_SOURCE_BOUND_FILE"
	boundProbeReady = "BACKPLANE_TEST_SOURCE_BOUND_READY"
	// A sparse TiB tells a bounded read from a drain without allocating it:
	// draining it takes minutes, a bounded read well under the deadline.
	sparseTiB     = int64(1) << 40
	probeDeadline = 10 * time.Second
	// readAhead is one read buffer, what a call may consume past its need.
	readAhead = 64 << 10
)

// stepCeiling is the most one Next call may consume of a line: up to its
// limit, to tell it oversized, plus one read buffer.
func stepCeiling(limit int) int64 { return int64(limit) + readAhead }

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

// writeSparse writes head, a hole of hole bytes, then tail.
func writeSparse(t *testing.T, path string, head []byte, hole int64, tail []byte) {
	t.Helper()
	requireSparse(t, filepath.Dir(path))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write(head); err != nil {
		t.Fatal(err)
	}
	end := int64(len(head)) + hole
	if err := file.Truncate(end); err != nil {
		t.Skipf("filesystem cannot hold the sparse fixture: %v", err)
	}
	if _, err := file.WriteAt(tail, end); err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Blocks*512 > int64(len(head)+len(tail))+8<<20 {
		t.Skip("filesystem allocated the sparse fixture")
	}
}

// probeWithin runs the named test in an owned child process and fails
// unless, once ready, it passes within the deadline.
func probeWithin(t *testing.T, probe string, env []string, drained string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(t.TempDir(), "ready")
	child := exec.Command(executable, "-test.run=^"+probe+"$", "-test.count=1", "-test.v")
	child.Env = append(append(os.Environ(), env...), boundProbeReady+"="+ready)
	var output bytes.Buffer
	child.Stdout, child.Stderr = &output, &output
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = child.Wait(); close(done) }()
	// The owned child is killed and reaped before TempDir removes the
	// sparse file it reads.
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

func probeReady(t *testing.T) string {
	t.Helper()
	path := os.Getenv(boundProbeFile)
	if path == "" {
		t.Skip("owned subprocess probe only")
	}
	if err := os.WriteFile(os.Getenv(boundProbeReady), []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFirstLineDoesNotDrainAnOversizedHeader(t *testing.T) {
	for name, tail := range map[string]string{"ended": "\n{\"n\":1}\n", "still being written": ""} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "session.jsonl")
			writeSparse(t, path, []byte(`{"type":"session"`), sparseTiB, []byte(tail))
			probeWithin(t, "TestSourceBoundProbeFirstLineChild", []string{boundProbeFile + "=" + path},
				"FirstLine drained an oversized first line instead of bounding the header read")
		})
	}
}

func TestSourceBoundProbeFirstLineChild(t *testing.T) {
	path := probeReady(t)
	source, _ := open(t, path, Cursor{}, false)
	if first, ok := source.FirstLine(MaxLineBytes); ok {
		t.Fatalf("an oversized header was read as one: %d bytes", len(first))
	}
}

// The header limit holds to the byte, the newline included, for LF and
// CRLF alike, and a header over it is no header.
func TestFirstLineHeaderBoundary(t *testing.T) {
	header := `{"type":"session"}`
	for _, newline := range []string{"\n", "\r\n"} {
		for _, limit := range []int{4096, MaxLineBytes} {
			for _, extra := range []int{0, 1} {
				path := filepath.Join(t.TempDir(), "session.jsonl")
				padding := limit - len(header) - len(newline) + extra
				if limit == MaxLineBytes {
					// A sparse NUL run keeps the 32 MiB header off the heap
					// until FirstLine itself returns it.
					writeSparse(t, path, []byte(header), int64(padding), []byte(newline+"{\"n\":1}\n"))
				} else {
					writeSession(t, path, header+strings.Repeat(" ", padding)+newline+"{\"n\":1}\n")
				}
				source, _ := open(t, path, Cursor{}, false)
				first, ok := source.FirstLine(limit)
				switch {
				case extra == 0 && (!ok || len(first) != limit-len(newline) || !bytes.HasPrefix(first, []byte(header))):
					t.Fatalf("limit %d, %q: the exact-limit header was refused: %d bytes, %v", limit, newline, len(first), ok)
				case extra == 1 && ok:
					t.Fatalf("limit %d, %q: a header one byte over the limit was read", limit, newline)
				}
				source.Close()
			}
		}
	}
}

func TestFirstLineWaitsForAnIncompleteHeader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeSession(t, path, `{"type":"session"`)
	source, _ := open(t, path, Cursor{}, false)
	if first, ok := source.FirstLine(MaxLineBytes); ok {
		t.Fatalf("an unfinished header was read: %q", first)
	}
	source.Close()
	writeSession(t, path, "}\n")
	again, _ := open(t, path, Cursor{}, false)
	if first, ok := again.FirstLine(MaxLineBytes); !ok || string(first) != `{"type":"session"}` {
		t.Fatalf("the finished header: %q %v", first, ok)
	}
}

func TestNextDoesNotDrainAnOversizedLine(t *testing.T) {
	for name, tail := range map[string]string{"ended": "\n{\"n\":2}\n", "still being written": ""} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "session.jsonl")
			writeSparse(t, path, []byte("{\"n\":1}\n"), sparseTiB, []byte(tail))
			probeWithin(t, "TestSourceBoundProbeNextChild", []string{boundProbeFile + "=" + path},
				"Next drained an oversized line in one call instead of reading it in bounded steps")
		})
	}
}

func TestSourceBoundProbeNextChild(t *testing.T) {
	path := probeReady(t)
	source, _ := open(t, path, Cursor{}, false)
	if line, state := source.Next(MaxLineBytes); state != LineComplete || string(line.Bytes) != `{"n":1}` {
		t.Fatalf("first line %q %v", line.Bytes, state)
	}
	line, state := source.Next(MaxLineBytes)
	if state != LineOversized || line.Bytes != nil || line.Offset != 8 || line.End-line.Offset > stepCeiling(MaxLineBytes) {
		t.Fatalf("an oversized line is reported once it passes the limit, within one step: %v %d..%d", state, line.Offset, line.End)
	}
}

// drainStep is one Next call that must read past part of an oversized
// line: no bytes, no new report, contiguous, bounded and progressing.
func drainStep(t *testing.T, source *SourceFile, limit int, from int64) Line {
	t.Helper()
	line, state := source.Next(limit)
	switch {
	case state == LineComplete || state == LineOversized:
		t.Fatalf("a line being drained was reported again (%v) at %d..%d", state, line.Offset, line.End)
	case state == LineIncomplete:
		t.Fatalf("draining stopped at %d with the line's rest already written", from)
	case line.Bytes != nil:
		t.Fatalf("a drain step carried %d bytes of the oversized line", len(line.Bytes))
	case line.Offset != from || line.End <= from:
		t.Fatalf("a drain step spans %d..%d, want progress from %d", line.Offset, line.End, from)
	case line.End-line.Offset > stepCeiling(limit):
		t.Fatalf("a drain step read %d bytes, over %d", line.End-line.Offset, stepCeiling(limit))
	}
	return line
}

// firstOversized is the one report of an oversized line, within one step.
func firstOversized(t *testing.T, source *SourceFile, limit int, at int64) Line {
	t.Helper()
	line, state := source.Next(limit)
	if state != LineOversized || line.Bytes != nil || line.Offset != at {
		t.Fatalf("want the oversized line reported at %d, got %v %d..%d", at, state, line.Offset, line.End)
	}
	if line.End-line.Offset > stepCeiling(limit) {
		t.Fatalf("one Next call read %d bytes of an oversized line, over %d", line.End-line.Offset, stepCeiling(limit))
	}
	return line
}

func drainTo(t *testing.T, source *SourceFile, limit int, from, end int64) {
	t.Helper()
	for steps := int64(0); from < end; steps++ {
		if steps > end/int64(limit)+16 {
			t.Fatalf("draining stalled at %d of %d", from, end)
		}
		from = drainStep(t, source, limit, from).End
	}
	if from != end {
		t.Fatalf("draining ended at %d, the line at %d", from, end)
	}
}

func expectRecordAfter(t *testing.T, source *SourceFile, limit int, at int64) {
	t.Helper()
	next, state := source.Next(limit)
	if state != LineComplete || string(next.Bytes) != `{"n":2}` || next.Offset != at {
		t.Fatalf("after the drained line: %q %v at %d, want {\"n\":2} at %d", next.Bytes, state, next.Offset, at)
	}
	if rest, state := source.Next(limit); state != LineIncomplete || rest.Bytes != nil {
		t.Fatalf("read past the end: %q %v", rest.Bytes, state)
	}
}

func TestAHugeOversizedLineIsReportedOnceAndDrainedInBoundedSteps(t *testing.T) {
	const limit = 1024
	path := filepath.Join(t.TempDir(), "session.jsonl")
	hole := int64(512 << 20)
	writeSparse(t, path, nil, hole, []byte("\n{\"n\":2}\n"))
	source, _ := open(t, path, Cursor{}, false)
	first := firstOversized(t, source, limit, 0)
	drainTo(t, source, limit, first.End, hole+1)
	expectRecordAfter(t, source, limit, hole+1)
}

// A line growing past the limit is read past while it is written, so its
// newline is reached in one step, not by re-reading it from its start.
func TestAGrowingOversizedLineIsDrainedBeforeItsNewline(t *testing.T) {
	const limit = 1024
	path := filepath.Join(t.TempDir(), "session.jsonl")
	hole := int64(256 << 20)
	writeSparse(t, path, nil, hole, nil)
	source, _ := open(t, path, Cursor{}, false)
	line, state := source.Next(limit)
	if state == LineIncomplete {
		t.Fatal("no forward progress: a growing line already over the limit was rewound to its start")
	}
	if state != LineOversized || line.Offset != 0 || line.End-line.Offset > stepCeiling(limit) {
		t.Fatalf("want the growing line reported oversized within one step, got %v %d..%d", state, line.Offset, line.End)
	}
	position := line.End
	for steps := 0; ; steps++ {
		if steps > int(hole/limit)+16 {
			t.Fatalf("draining stalled at %d of %d", position, hole)
		}
		next, state := source.Next(limit)
		if state == LineIncomplete {
			if next.Bytes != nil {
				t.Fatalf("an unfinished drain returned %d bytes", len(next.Bytes))
			}
			break
		}
		if state == LineComplete || state == LineOversized || next.Bytes != nil || next.Offset != position || next.End <= position || next.End-next.Offset > stepCeiling(limit) {
			t.Fatalf("a drain step while the line grows: %v %d..%d from %d", state, next.Offset, next.End, position)
		}
		position = next.End
	}
	if position != hole {
		t.Fatalf("draining a growing line stopped at %d, %d bytes are written", position, hole)
	}
	cursor := source.Mark(position)
	source.Close()
	writeSession(t, path, "\n{\"n\":2}\n")
	again, change := open(t, path, cursor, true)
	if change != Grown {
		t.Fatalf("change = %v", change)
	}
	if err := again.SeekTo(cursor.Offset); err != nil {
		t.Fatal(err)
	}
	end := drainStep(t, again, limit, position)
	if end.End != hole+1 {
		t.Fatalf("the newline ends the drain in one step: %d..%d, want end %d", end.Offset, end.End, hole+1)
	}
	expectRecordAfter(t, again, limit, hole+1)
}

// A drain resumes from its saved cursor after a restart: the rest of the
// line is neither reported again nor read as a line of its own.
func TestADrainResumesFromItsCursorAfterARestart(t *testing.T) {
	const limit = 1024
	path := filepath.Join(t.TempDir(), "session.jsonl")
	hole := int64(512 << 20)
	writeSparse(t, path, nil, hole, []byte("\n{\"n\":2}\n"))
	cursors := OpenCursors(filepath.Join(t.TempDir(), "cursors"))
	source, _ := open(t, path, Cursor{}, false)
	first := firstOversized(t, source, limit, 0)
	step := drainStep(t, source, limit, first.End)
	if err := cursors.Save(source.Mark(step.End)); err != nil {
		t.Fatal(err)
	}
	source.Close()
	loaded, found, err := cursors.Load(path)
	if err != nil || !found {
		t.Fatalf("cursor %v %v", found, err)
	}
	again, change := open(t, path, loaded, true)
	if change != Grown {
		t.Fatalf("change = %v", change)
	}
	if err := again.SeekTo(loaded.Offset); err != nil {
		t.Fatal(err)
	}
	drainTo(t, again, limit, step.End, hole+1)
	expectRecordAfter(t, again, limit, hole+1)
}

// A file replaced or truncated mid-drain is another file: it is read from
// its first line, and a cursor marked on it carries no drain.
func TestAReplacedFileForgetsAPartialDrain(t *testing.T) {
	cases := map[string]func(t *testing.T, path string){
		"rotated": func(t *testing.T, path string) {
			if err := os.Rename(path, path+".1"); err != nil {
				t.Fatal(err)
			}
			writeSession(t, path, "{\"m\":1}\n{\"m\":2}\n")
		},
		"truncated": func(t *testing.T, path string) {
			if err := os.Truncate(path, 0); err != nil {
				t.Fatal(err)
			}
			writeSession(t, path, "{\"m\":1}\n{\"m\":2}\n")
		},
	}
	for name, replace := range cases {
		t.Run(name, func(t *testing.T) {
			const limit = 1024
			path := filepath.Join(t.TempDir(), "session.jsonl")
			writeSparse(t, path, nil, 512<<20, []byte("\n{\"n\":2}\n"))
			source, _ := open(t, path, Cursor{}, false)
			first := firstOversized(t, source, limit, 0)
			step := drainStep(t, source, limit, first.End)
			draining := source.Mark(step.End)
			source.Close()
			replace(t, path)
			replaced, change := open(t, path, draining, true)
			if change != Replaced {
				t.Fatalf("change = %v", change)
			}
			if err := replaced.SeekTo(0); err != nil {
				t.Fatal(err)
			}
			if line, state := replaced.Next(limit); state != LineComplete || string(line.Bytes) != `{"m":1}` {
				t.Fatalf("the replacement's first line: %q %v", line.Bytes, state)
			}
			// The daemon re-marks a replaced file from its start.
			fresh := replaced.Mark(0)
			replaced.Close()
			reopened, change := open(t, path, fresh, true)
			if change != Grown {
				t.Fatalf("change = %v", change)
			}
			if err := reopened.SeekTo(fresh.Offset); err != nil {
				t.Fatal(err)
			}
			if line, state := reopened.Next(limit); state != LineComplete || string(line.Bytes) != `{"m":1}` {
				t.Fatalf("a cursor marked on the replacement still drained: %q %v", line.Bytes, state)
			}
		})
	}
}
