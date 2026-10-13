// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package collector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestConfigRoutesLogsAndTracesToBeaconJSONOnLoopback(t *testing.T) {
	config := ConfigYAML(43210, "/data/otel/runtime.jsonl")
	for _, want := range []string{
		"endpoint: 127.0.0.1:43210",
		`path: "/data/otel/runtime.jsonl"`,
		"redact_secrets: true",
		"rotate_archives: 2",
		"logs:\n      receivers: [otlp]",
		"traces:\n      receivers: [otlp]",
		"level: none",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("config missing %q:\n%s", want, config)
		}
	}
	if strings.Contains(config, "metrics:\n      receivers") || strings.Contains(config, "grpc") || strings.Contains(config, "0.0.0.0") {
		t.Fatalf("config exposes metrics, gRPC or a non-loopback address:\n%s", config)
	}
}

type line struct {
	text   string
	offset int64
}

func tailAll(t *testing.T, tailer *Tailer) []line {
	t.Helper()
	var lines []line
	err := tailer.Next(func(text []byte, position Position) error {
		lines = append(lines, line{string(text), position.Offset})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return lines
}

func TestTailerReadsCompleteLinesAndResumesAfterRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	os.WriteFile(path, []byte("{\"a\":1}\n{\"b\":2}\n{\"partial\":"), 0o600)
	tailer := NewTailer(path, filepath.Join(dir, "tail.json"))
	lines := tailAll(t, tailer)
	if len(lines) != 2 || lines[0].text != `{"a":1}` || lines[1].offset != 8 {
		t.Fatalf("lines: %+v", lines)
	}
	appendFile(t, path, "3}\n")
	restarted := NewTailer(path, filepath.Join(dir, "tail.json"))
	if lines := tailAll(t, restarted); len(lines) != 1 || lines[0].text != `{"partial":3}` {
		t.Fatalf("resume after restart: %+v", lines)
	}
	if lines := tailAll(t, restarted); len(lines) != 0 {
		t.Fatal("lines delivered twice")
	}
}

func TestTailerFinishesARotatedFileBeforeTheNewOne(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	os.WriteFile(path, []byte("{\"old\":1}\n"), 0o600)
	tailer := NewTailer(path, filepath.Join(dir, "tail.json"))
	tailAll(t, tailer)
	appendFile(t, path, "{\"old\":2}\n")
	os.Rename(path, path+".1")
	os.WriteFile(path, []byte("{\"new\":1}\n"), 0o600)
	lines := tailAll(t, tailer)
	if len(lines) != 2 || lines[0].text != `{"old":2}` || lines[1].text != `{"new":1}` {
		t.Fatalf("rotation: %+v", lines)
	}
	first, second := lines[0], lines[1]
	if first.offset == second.offset && first.text == second.text {
		t.Fatal("positions must identify lines across files")
	}
}

func TestTailerKeepsItsPositionWhenTheConsumerStops(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	os.WriteFile(path, []byte("{\"a\":1}\n{\"b\":2}\n"), 0o600)
	tailer := NewTailer(path, filepath.Join(dir, "tail.json"))
	stop := errors.New("queue full")
	calls := 0
	err := tailer.Next(func([]byte, Position) error {
		calls++
		if calls == 2 {
			return stop
		}
		return nil
	})
	if !errors.Is(err, stop) {
		t.Fatalf("consumer error not returned: %v", err)
	}
	if lines := tailAll(t, tailer); len(lines) != 1 || lines[0].text != `{"b":2}` {
		t.Fatalf("stopped line not redelivered: %+v", lines)
	}
}

func TestPositionsAreStableIdentities(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	os.WriteFile(path, []byte("{\"a\":1}\n"), 0o600)
	first := tailAll(t, NewTailer(path, filepath.Join(dir, "one.json")))
	var positions []Position
	NewTailer(path, filepath.Join(dir, "two.json")).Next(func(_ []byte, position Position) error {
		positions = append(positions, position)
		return nil
	})
	if len(first) != 1 || positions[0].Key() == "" || positions[0].Offset != first[0].offset {
		t.Fatal("positions not stable")
	}
}

func TestSupervisorRestartsTheCollectorAndStopsOnCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake collector is a shell script")
	}
	dir := t.TempDir()
	starts := filepath.Join(dir, "starts")
	fake := filepath.Join(dir, "fake-otelcol")
	os.WriteFile(fake, []byte("#!/bin/sh\necho started >> '"+starts+"'\nexit 1\n"), 0o700)
	supervisor := &Supervisor{Executable: fake, Dir: filepath.Join(dir, "otel"), restartDelay: 20 * time.Millisecond}
	stop := runSupervisor(t, supervisor)
	restarted := waitUntil(func() bool {
		data, _ := os.ReadFile(starts)
		return strings.Count(string(data), "started") >= 2
	})
	stop()
	if !restarted {
		data, _ := os.ReadFile(starts)
		t.Fatalf("collector not restarted: %q", data)
	}
	config, err := os.ReadFile(filepath.Join(dir, "otel", "collector.yaml"))
	if err != nil || !strings.Contains(string(config), "runtime.jsonl") {
		t.Fatal("collector config not written")
	}
}

func TestCollectorRunsWithTheRestrictedBeaconEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake collector is a shell script")
	}
	t.Setenv("BACKPLANE_TEST_OPERATOR_SECRET", "must-not-reach-the-collector")
	dir := t.TempDir()
	captured := filepath.Join(dir, "environment")
	fake := filepath.Join(dir, "fake-otelcol")
	// Published by rename, so the test never reads a partial file.
	os.WriteFile(fake, []byte("#!/bin/sh\nenv > '"+captured+".partial'\nmv '"+captured+".partial' '"+captured+"'\nexit 1\n"), 0o700)
	supervisor := &Supervisor{Executable: fake, Dir: filepath.Join(dir, "otel"), restartDelay: time.Hour}
	stop := runSupervisor(t, supervisor)
	waitUntil(func() bool { _, err := os.Stat(captured); return err == nil })
	stop()
	data, err := os.ReadFile(captured)
	if err != nil {
		t.Fatal(err)
	}
	environment := string(data)
	if strings.Contains(environment, "BACKPLANE_TEST_OPERATOR_SECRET") || !strings.Contains(environment, "HOME="+filepath.Join(dir, "otel")+"\n") || !strings.Contains(environment, "BEACON_ENDPOINT_MODE=1") {
		t.Fatalf("collector environment not restricted:\n%s", environment)
	}
}

func appendFile(t *testing.T, path, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	file.WriteString(text)
	file.Close()
}

func writeLines(t *testing.T, path, prefix string, count int) {
	t.Helper()
	var builder strings.Builder
	for i := 0; i < count; i++ {
		builder.WriteString(`{"` + prefix + `":` + strconv.Itoa(i) + "}\n")
	}
	appendOrCreate(t, path, builder.String())
}

func appendOrCreate(t *testing.T, path, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	file.WriteString(text)
	file.Close()
}

func drain(t *testing.T, tailer *Tailer) []string {
	t.Helper()
	var all []string
	for pass := 0; pass < 100; pass++ {
		lines := tailAll(t, tailer)
		if len(lines) == 0 {
			return all
		}
		for _, entry := range lines {
			all = append(all, entry.text)
		}
	}
	t.Fatal("tailer never caught up")
	return nil
}

func TestTailerDeliversAWholeRotatedBacklogInOrder(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	state := filepath.Join(dir, "tail.json")
	writeLines(t, path, "old", 1)
	tailAll(t, NewTailer(path, state))
	writeLines(t, path, "old", 999)
	os.Rename(path, path+".1")
	writeLines(t, path, "new", 2)
	// A restart in the middle of the rotated file must resume inside it.
	first := tailAll(t, NewTailer(path, state))
	rest := drain(t, NewTailer(path, state))
	total := len(first) + len(rest)
	if total != 1001 {
		t.Fatalf("delivered %d of 1001 lines", total)
	}
	if rest[len(rest)-1] != `{"new":1}` || first[0].text != `{"old":0}` {
		t.Fatalf("order: first %s last %s", first[0].text, rest[len(rest)-1])
	}
}

func TestTailerFollowsItsFileThroughTwoRotations(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	tailer := NewTailer(path, filepath.Join(dir, "tail.json"))
	writeLines(t, path, "a", 3)
	tailAll(t, tailer)
	writeLines(t, path, "a", 2)
	os.Rename(path, path+".1")
	writeLines(t, path, "b", 2)
	os.Rename(path+".1", path+".2")
	os.Rename(path, path+".1")
	writeLines(t, path, "c", 2)
	got := drain(t, tailer)
	want := []string{`{"a":0}`, `{"a":1}`, `{"b":0}`, `{"b":1}`, `{"c":0}`, `{"c":1}`}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v", got)
	}
}

func TestBacklogCountsUnreadBytesAcrossFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	tailer := NewTailer(path, filepath.Join(dir, "tail.json"))
	if backlog, _ := tailer.Backlog(); backlog != 0 {
		t.Fatalf("empty backlog %d", backlog)
	}
	writeLines(t, path, "x", 10)
	tailAll(t, tailer)
	os.Rename(path, path+".1")
	writeLines(t, path, "y", 10)
	backlog, err := tailer.Backlog()
	if err != nil || backlog != 80 {
		t.Fatalf("backlog %d %v", backlog, err)
	}
}

func fakeCollector(t *testing.T, dir, marker string) string {
	t.Helper()
	fake := filepath.Join(dir, "fake-otelcol")
	script := "#!/bin/sh\ntrap 'echo terminated >> \"" + marker + "\"; exit 0' TERM\necho ready > \"" + marker + ".ready\"\nwhile true; do sleep 0.05; done\n"
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return fake
}

func waitForCollectorReady(t *testing.T, marker string) {
	t.Helper()
	// Process.Start returns before the shell has installed its TERM trap.
	if !waitUntil(func() bool {
		data, err := os.ReadFile(marker + ".ready")
		return err == nil && string(data) == "ready\n"
	}) {
		t.Fatal("fake collector did not install its TERM trap")
	}
}

func TestCollectorIsStoppedWithSIGTERM(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX signals")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "terminated")
	supervisor := &Supervisor{Executable: fakeCollector(t, dir, marker), Dir: filepath.Join(dir, "otel")}
	stop := runSupervisor(t, supervisor)
	t.Cleanup(stop)
	waitForCollectorReady(t, marker)
	stop()
	if data, _ := os.ReadFile(marker); !strings.Contains(string(data), "terminated") {
		t.Fatal("collector was killed instead of terminated")
	}
	if _, err := os.Stat(filepath.Join(dir, "otel", "collector.pid")); !os.IsNotExist(err) {
		t.Fatal("pid file left after a clean stop")
	}
}

func TestStaleCollectorFromAPreviousRunIsReapedOnlyIfOurs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX processes")
	}
	dir := t.TempDir()
	otelDir := filepath.Join(dir, "otel")
	os.MkdirAll(otelDir, 0o700)
	marker := filepath.Join(dir, "terminated")
	fake := fakeCollector(t, dir, marker)
	orphan := exec.Command(fake, "--config", filepath.Join(otelDir, "collector.yaml"))
	if err := orphan.Start(); err != nil {
		t.Fatal(err)
	}
	defer orphan.Process.Kill()
	waitForCollectorReady(t, marker)
	unrelated := exec.Command("sleep", "30")
	unrelated.Start()
	defer unrelated.Process.Kill()

	writePid(t, otelDir, unrelated.Process.Pid, fake)
	supervisor := &Supervisor{Executable: fake, Dir: otelDir}
	supervisor.reapOrphan()
	if err := unrelated.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("a process that is not our collector was signalled")
	}

	writePid(t, otelDir, orphan.Process.Pid, fake)
	supervisor.reapOrphan()
	orphan.Wait()
	if data, _ := os.ReadFile(marker); !strings.Contains(string(data), "terminated") {
		t.Fatal("stale collector not terminated")
	}
}

func writePid(t *testing.T, dir string, pid int, executable string) {
	t.Helper()
	data, _ := json.Marshal(pidFile{PID: pid, Executable: executable, Config: filepath.Join(dir, "collector.yaml")})
	if err := os.WriteFile(filepath.Join(dir, "collector.pid"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAFailedBindingToTheDaemonIsReported(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake collector is a shell script")
	}
	defer func(original func(*os.Process) error) { bindCollector = original }(bindCollector)
	bindCollector = func(*os.Process) error { return errors.New("access denied") }
	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-otelcol")
	os.WriteFile(fake, []byte("#!/bin/sh\nexit 1\n"), 0o700)
	var reported atomic.Value
	supervisor := &Supervisor{Executable: fake, Dir: filepath.Join(dir, "otel"), restartDelay: time.Hour, ReportError: func(code string) { reported.Store(code) }}
	stop := runSupervisor(t, supervisor)
	waitUntil(func() bool { return reported.Load() != nil })
	stop()
	if reported.Load() != "collector_not_bound_to_daemon" {
		t.Fatalf("binding failure not reported: %v", reported.Load())
	}
}

// runSupervisor runs s until the returned stop is called and returns; a
// supervisor that does not stop fails the test instead of hanging it.
func runSupervisor(t *testing.T, s *Supervisor) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	return func() {
		t.Helper()
		cancel()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Fatal("supervisor did not stop after cancel")
		}
	}
}

// waitUntil polls condition with a deadline generous enough for -race
// under parallel load.
func waitUntil(condition func() bool) bool {
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if condition() {
			return true
		}
	}
	return condition()
}
