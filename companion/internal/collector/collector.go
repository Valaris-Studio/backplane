// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package collector supervises the pinned beacon-otelcol, which normalizes
// in-scope OTLP from the gate into Beacon events, and tails the events it
// writes.
package collector

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	orphanStopWait      = 2 * time.Second
	defaultRestartDelay = 5 * time.Second
	maxRestartDelay     = 5 * time.Minute
	// A small rotation bound keeps normalized content on disk only briefly.
	// Two archives give the tailer slack: the gate refuses new telemetry once
	// one rotation's worth is unread (BacklogLimit), so unread data is never
	// rotated away.
	rotateBytes    = 4 << 20
	rotateArchives = 2
	// BacklogLimit is the unread size at which producers must be refused.
	BacklogLimit = rotateBytes
)

// ConfigYAML is the collector configuration: loopback OTLP/HTTP in, the
// beaconjson exporter out, logs and traces only, no self-telemetry.
func ConfigYAML(port int, runtimePath string) string {
	return fmt.Sprintf(`receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:%d

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 128
  batch:
    timeout: 1s
    send_batch_size: 128

exporters:
  beaconjson:
    path: %q
    max_event_bytes: 65536
    rotate_bytes: %d
    rotate_archives: %d
    redact_secrets: true

service:
  telemetry:
    metrics:
      level: none
  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [beaconjson]
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [beaconjson]
`, port, runtimePath, rotateBytes, rotateArchives)
}

func RuntimePath(dir string) string { return filepath.Join(dir, "runtime.jsonl") }

type Supervisor struct {
	Executable string
	Dir        string
	// ReportError receives a stable code for a condition worth surfacing in
	// health; nil discards it.
	ReportError  func(code string)
	restartDelay time.Duration
	port         atomic.Int32
}

// URL is the collector's OTLP/HTTP base URL, or "" while it is not running.
func (s *Supervisor) URL() string {
	if port := s.port.Load(); port != 0 {
		return fmt.Sprintf("http://127.0.0.1:%d", port)
	}
	return ""
}

// Run keeps the collector running until ctx ends, restarting it with a
// capped backoff after any exit.
func (s *Supervisor) Run(ctx context.Context) error {
	s.reapOrphan()
	delay := s.restartDelay
	if delay == 0 {
		delay = defaultRestartDelay
	}
	for ctx.Err() == nil {
		started := time.Now()
		s.runOnce(ctx)
		if ctx.Err() != nil {
			break
		}
		if time.Since(started) > maxRestartDelay {
			delay = s.restartDelay
			if delay == 0 {
				delay = defaultRestartDelay
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(delay):
		}
		delay = min(delay*2, maxRestartDelay)
	}
	return nil
}

func (s *Supervisor) runOnce(ctx context.Context) error {
	defer s.port.Store(0)
	if err := store.EnsurePrivateDir(s.Dir); err != nil {
		return err
	}
	port, err := freeLoopbackPort()
	if err != nil {
		return err
	}
	configPath := filepath.Join(s.Dir, "collector.yaml")
	if err := store.WriteFileAtomic(configPath, []byte(ConfigYAML(port, RuntimePath(s.Dir)))); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(s.Dir, "collector.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	process := exec.CommandContext(ctx, s.Executable, "--config", configPath)
	process.Dir = s.Dir
	process.Env = beacon.RestrictedEnvironment(s.Dir)
	process.Stdout, process.Stderr = log, log
	// Stop gracefully so the exporter flushes; kill only after WaitDelay.
	process.Cancel = func() error { return terminate(process.Process) }
	process.WaitDelay = 5 * time.Second
	configure(process)
	if err := process.Start(); err != nil {
		return err
	}
	// Without the binding a killed daemon can orphan the collector, which the
	// next start still reaps from the pid file where it can.
	if err := bindCollector(process.Process); err != nil && s.ReportError != nil {
		s.ReportError("collector_not_bound_to_daemon")
	}
	pidPath := filepath.Join(s.Dir, "collector.pid")
	store.WriteJSON(pidPath, pidFile{PID: process.Process.Pid, Executable: s.Executable, Config: configPath})
	defer os.Remove(pidPath)
	s.port.Store(int32(port))
	return process.Wait()
}

// bindCollector is swapped by tests; only Windows can fail it.
var bindCollector = bindToDaemon

type pidFile struct {
	PID        int    `json:"pid"`
	Executable string `json:"executable"`
	Config     string `json:"config"`
}

// reapOrphan stops a collector left running by a daemon that crashed. The
// recorded process is signalled only when its command line shows it is our
// collector with our configuration, so a reused pid is never touched.
func (s *Supervisor) reapOrphan() {
	pidPath := filepath.Join(s.Dir, "collector.pid")
	var recorded pidFile
	if err := store.ReadJSON(pidPath, 4096, &recorded); err != nil {
		return
	}
	defer os.Remove(pidPath)
	if recorded.PID <= 0 || !alive(recorded.PID) {
		return
	}
	command, err := commandLine(recorded.PID)
	if err != nil || recorded.Executable != s.Executable || !strings.Contains(command, recorded.Executable) || !strings.Contains(command, recorded.Config) {
		return
	}
	process, err := os.FindProcess(recorded.PID)
	if err != nil {
		return
	}
	terminate(process)
	for deadline := time.Now().Add(orphanStopWait); alive(recorded.PID) && time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
	}
	if alive(recorded.PID) {
		process.Kill()
	}
}

func freeLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}
