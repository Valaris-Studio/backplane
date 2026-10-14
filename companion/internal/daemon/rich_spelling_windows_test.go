// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package daemon

import (
	"fmt"
	"path/filepath"
	"testing"
)

// codex-cli names a resumed session's rollout verbatim (\\?\C:\...).
func TestAVerbatimNamedSessionFileUnderItsRootIsRead(t *testing.T) {
	f := newRichFixture(t)
	f.writeSessionAt(t, f.sessionFile(session), "e1")
	f.richHookNaming(t, session, `\\?\`+f.sessionFile(session))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1")}) {
		t.Fatalf("declared %v, health %+v", keys, richHealth(t, f))
	}
}

func TestASessionFileNamedPlainThenVerbatimIsReadOnce(t *testing.T) {
	f := newRichFixture(t)
	f.writeSessionAt(t, f.sessionFile(session), "e1")
	f.richHookNaming(t, session, f.sessionFile(session))
	f.tickUntilSettled(t)
	appendSession(t, f.sessionFile(session), textLine("e2", f.stamp(), "said e2").Encode())
	f.richHookNaming(t, session, `\\?\`+f.sessionFile(session))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
	if parsed := f.parsed.Load(); parsed != 2 || len(f.daemon.sources.Sources) != 1 {
		t.Fatalf("parsed %d lines from %d sources, want each line once from one", parsed, len(f.daemon.sources.Sources))
	}
}

// A verbatim spelling never widens the roots: it is judged where it lands.
func TestAVerbatimPathOutOfItsRootIsNeverRead(t *testing.T) {
	t.Run("through ..", func(t *testing.T) {
		f := newRichFixture(t)
		sibling := filepath.Join(filepath.Dir(sessionsDir(f.home)), "other", "x.jsonl")
		f.writeSessionAt(t, sibling, "e1")
		f.richHookNaming(t, session, `\\?\`+sessionsDir(f.home)+`\..\other\x.jsonl`)
		f.tickUntilSettled(t)
		assertRefused(t, f)
	})
	t.Run("another drive", func(t *testing.T) {
		f := newRichFixture(t)
		f.richHookNaming(t, session, `\\?\Z:\elsewhere\x.jsonl`)
		f.tickUntilSettled(t)
		if keys := declaredKeys(f); len(keys) != 0 || f.parsed.Load() != 0 {
			t.Fatalf("declared %v, parsed %d", keys, f.parsed.Load())
		}
	})
	t.Run("device namespace", func(t *testing.T) {
		f := newRichFixture(t)
		f.writeSessionAt(t, f.sessionFile(session), "e1")
		f.richHookNaming(t, session, `\\.\`+f.sessionFile(session))
		f.tickUntilSettled(t)
		if keys := declaredKeys(f); len(keys) != 0 || f.parsed.Load() != 0 {
			t.Fatalf("declared %v, parsed %d", keys, f.parsed.Load())
		}
	})
}
