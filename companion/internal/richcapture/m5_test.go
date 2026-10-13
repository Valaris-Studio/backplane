// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
)

// TestLargestLineMemory is the m5 measurement: one line at the 32 MiB
// limit through read, parse, declare (secret filter, placement, digest) and
// stage. It runs only with RICH_CAPTURE_M5 set, under `/usr/bin/time -l`
// for the process's peak resident set; RICH_CAPTURE_M5=dense fills the line
// with what every secret and placement pattern looks for.
func TestLargestLineMemory(t *testing.T) {
	mode := os.Getenv("RICH_CAPTURE_M5")
	if mode == "" {
		t.Skip("set RICH_CAPTURE_M5=1 (or dense) to measure")
	}
	filler := "x"
	if mode == "dense" {
		filler = "token: see /home/me/code/app/a.go and /" + "Users/al/b "
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	envelope := len(contracttest.Line{ID: "big", At: time.Now(), Items: []contracttest.Item{contracttest.TextItem("text:0", "assistant", "reply", "text/plain", "")}}.Encode())
	line := contracttest.Line{ID: "big", At: time.Now(), Items: []contracttest.Item{contracttest.TextItem("text:0", "assistant", "reply", "text/plain", strings.Repeat(filler, (MaxLineBytes-envelope)/len(filler)))}}.Encode()
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	line = ""
	runtime.GC()
	started := time.Now()
	source, _, err := OpenSource(path, Cursor{}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	read, state := source.Next(MaxLineBytes)
	if state != LineComplete {
		t.Fatalf("line state %v (%d bytes)", state, read.End)
	}
	parser := contracttest.Agent{Name: "pi_cli"}.ContentParser()
	record, _, err := parser.Parse(agent.ContentLine{Bytes: read.Bytes, Offset: read.Offset}, nil)
	if err != nil {
		t.Fatal(err)
	}
	read.Bytes = nil
	declared := declarer().Declare(record, record.Items[0], 0)
	record.Items = nil
	body, err := OpenSpool(filepath.Join(dir, "spool")).Stage(Body{ContentKey: declared.Declaration.ContentKey}, declared.Body)
	if err != nil {
		t.Fatal(err)
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	t.Logf("line %d bytes, body %d bytes staged, coverage %s; %v; heap sys %d MiB, total alloc %d MiB",
		read.End, body.ByteCount, declared.Declaration.Coverage, time.Since(started), stats.HeapSys>>20, stats.TotalAlloc>>20)
}
