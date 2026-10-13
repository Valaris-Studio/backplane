// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package inbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

func TestWriteListReadRemoveInArrivalOrder(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "inbox")
	base := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	for i, event := range []string{"SessionStart", "UserPromptSubmit"} {
		item := Item{Agent: "claude_code", Observation: agent.Observation{Event: event}, ReceivedAt: base.Add(time.Duration(i) * time.Millisecond), Payload: map[string]any{"n": json.Number("9007199254740993")}}
		if err := Write(dir, item); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(dir, "stray.txt"), []byte("x"), 0o600)
	names, err := List(dir)
	if err != nil || len(names) != 2 {
		t.Fatalf("list: %v %v", names, err)
	}
	first, err := Read(dir, names[0])
	if err != nil || first.Observation.Event != "SessionStart" || first.Payload["n"] != json.Number("9007199254740993") {
		t.Fatalf("read: %+v %v", first, err)
	}
	if err := Remove(dir, names[0]); err != nil {
		t.Fatal(err)
	}
	if names, _ := List(dir); len(names) != 1 {
		t.Fatal("remove failed")
	}
}

func TestWriteRejectsOversizedItemsAndFullInbox(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "inbox")
	huge := make([]byte, MaxItemBytes)
	for i := range huge {
		huge[i] = 'a'
	}
	if err := Write(dir, Item{Agent: "a", Payload: map[string]any{"x": string(huge)}}); !errors.Is(err, ErrItemTooBig) {
		t.Fatalf("oversized item accepted: %v", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxItems; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("filler-%d", i)), nil, 0o600)
	}
	if err := Write(dir, Item{Agent: "a", Payload: map[string]any{}}); !errors.Is(err, ErrFull) {
		t.Fatalf("full inbox accepted: %v", err)
	}
}
