// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package codex

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

const discoveryProbeHome = "BACKPLANE_TEST_DISCOVERY_BOUND_HOME"

// Discovery reads each recent rollout's first line to find Desktop
// sessions; a sparse TiB first line must be judged from its bounded prefix,
// not drained. The read runs in an owned subprocess killed after 3s.
func TestDiscoveryDoesNotDrainAnOversizedHeader(t *testing.T) {
	home := newDiscoveryHome(t)
	day := filepath.Join(home.sessions, "2026", "10", "12")
	if err := os.MkdirAll(day, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(day, "rollout-2026-10-12T09-00-00-"+desktopChild+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	const sparseSize = int64(1) << 40
	if err := file.Truncate(8 << 20); err != nil {
		file.Close()
		t.Skipf("filesystem cannot create a sparse probe: %v", err)
	}
	if info, err := file.Stat(); err != nil {
		file.Close()
		t.Fatal(err)
	} else if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Blocks*512 > 1<<20 {
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
	if info, err := os.Stat(path); err != nil {
		t.Fatal(err)
	} else if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Blocks*512 > 1<<20 {
		t.Skip("filesystem does not report a negligible sparse allocation")
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^TestDiscoveryBoundProbeChild$", "-test.count=1")
	child.Env = append(os.Environ(), discoveryProbeHome+"="+home.env.Home)
	var output bytes.Buffer
	child.Stdout, child.Stderr = &output, &output
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = child.Wait(); close(done) }()
	// The owned process is killed if still running and reaped before
	// TempDir removes its sparse file.
	t.Cleanup(func() {
		_ = child.Process.Kill()
		<-done
	})
	ready := filepath.Join(home.env.Home, "discovery-ready")
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
				t.Fatalf("probe exited before discovering: %v\n%s", waitErr, output.String())
			}
		case <-startup.C:
			t.Fatal("probe never reached discovery")
		case <-tick.C:
		}
	}
	select {
	case <-done:
		if waitErr != nil {
			t.Fatalf("discovery probe failed: %v\n%s", waitErr, output.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("discovery drained an oversized first line instead of bounding the header read")
	}
}

func TestDiscoveryBoundProbeChild(t *testing.T) {
	home := os.Getenv(discoveryProbeHome)
	if home == "" {
		t.Skip("owned subprocess probe only")
	}
	if err := os.WriteFile(filepath.Join(home, "discovery-ready"), []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	if found := New().DiscoverContent(agent.Env{Home: home, Getenv: func(string) string { return "" }}, 64); len(found) != 0 {
		t.Fatalf("an oversized header was offered: %+v", found)
	}
}
