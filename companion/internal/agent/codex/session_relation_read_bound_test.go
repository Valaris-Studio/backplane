// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package codex

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

const relationProbeHome = "BACKPLANE_TEST_RELATION_BOUND_HOME"

func TestSessionRelationHeaderReadBoundary(t *testing.T) {
	home := newDiscoveryHome(t)
	header := []byte(`{"type":"session_meta","payload":{"id":"` + desktopChild + `","parent_thread_id":"` + desktopMain + `"}}`)
	for _, newline := range []string{"\n", "\r\n"} {
		t.Run(fmt.Sprintf("delimiter-%d-bytes", len(newline)), func(t *testing.T) {
			line := append(append(append([]byte{}, header...), bytes.Repeat([]byte{' '}, maxRolloutLineBytes-len(header)-len(newline))...), newline...)
			path := filepath.Join(home.sessions, "rollout-boundary.jsonl")
			for _, extra := range []int{0, 1} {
				candidate := append(bytes.Repeat([]byte{' '}, extra), line...)
				if err := os.WriteFile(path, candidate, 0600); err != nil {
					t.Fatal(err)
				}
				relation, ok := New().SessionRelation(home.env, path)
				if extra == 0 {
					if !ok || relation.SessionID != desktopChild || relation.ParentSessionID != desktopMain {
						t.Fatalf("valid exact-boundary header rejected: %+v, readable %v", relation, ok)
					}
				} else if ok {
					t.Fatalf("oversized header admitted: %+v", relation)
				}
			}
		})
	}
}

func TestSessionRelationDoesNotDrainAnOversizedHeader(t *testing.T) {
	home := newDiscoveryHome(t)
	path := filepath.Join(home.sessions, "rollout-oversized.jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	// A sparse TiB distinguishes a bounded header read from draining its
	// first line without allocating a TiB or relying on a tight benchmark.
	const sparseSize = int64(1) << 40
	// Check sparse support with a small hole before requesting the large one.
	if err := file.Truncate(8 << 20); err != nil {
		file.Close()
		t.Skipf("filesystem cannot create a sparse probe: %v", err)
	}
	probeInfo, err := file.Stat()
	if err != nil {
		file.Close()
		t.Fatal(err)
	}
	probeStat, ok := probeInfo.Sys().(*syscall.Stat_t)
	if !ok || probeStat.Blocks*512 > 1<<20 {
		file.Close()
		t.Skip("filesystem does not support sparse files")
	}
	if err := file.Truncate(sparseSize); err != nil {
		file.Close()
		t.Skipf("filesystem cannot create the sparse probe: %v", err)
	}
	if _, err := file.WriteAt([]byte{'\n'}, sparseSize-1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Blocks*512 > 1<<20 {
		t.Skip("filesystem does not report a negligible sparse allocation")
	}
	t.Logf("sparse probe: logical %d bytes, allocated %d bytes", info.Size(), stat.Blocks*512)

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^TestSessionRelationBoundProbeChild$", "-test.count=1")
	child.Env = append(os.Environ(), relationProbeHome+"="+home.env.Home)
	var output bytes.Buffer
	child.Stdout, child.Stderr = &output, &output
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = child.Wait(); close(done) }()
	// This exact test-owned process is always killed (if still running)
	// and reaped before TempDir removes its sparse file.
	t.Cleanup(func() {
		_ = child.Process.Kill()
		<-done
	})
	ready := filepath.Join(home.env.Home, "relation-ready")
	startup := time.NewTimer(5 * time.Second)
	defer startup.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		select {
		case <-done:
			// The child can publish readiness and exit after the stat above.
			if _, err := os.Stat(ready); err != nil {
				t.Fatalf("probe exited before reading header: %v\n%s", waitErr, output.String())
			}
		case <-startup.C:
			t.Fatal("probe never reached the header reader")
		case <-tick.C:
		}
	}
	select {
	case <-done:
		if waitErr != nil {
			t.Fatalf("header probe failed: %v\n%s", waitErr, output.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("SessionRelation drained an oversized first line instead of bounding the header read")
	}
}

func TestSessionRelationBoundProbeChild(t *testing.T) {
	home := os.Getenv(relationProbeHome)
	if home == "" {
		t.Skip("owned subprocess probe only")
	}
	if err := os.WriteFile(filepath.Join(home, "relation-ready"), []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".codex", "sessions", "rollout-oversized.jsonl")
	if relation, ok := New().SessionRelation(agent.Env{Home: home, Getenv: func(string) string { return "" }}, path); ok {
		t.Fatalf("malformed oversized header admitted: %+v", relation)
	}
}
