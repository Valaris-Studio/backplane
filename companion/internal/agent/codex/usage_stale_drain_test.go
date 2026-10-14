// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package codex

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// A rollout rewritten in place, no shorter, is not told from one that grew,
// so its read position is trusted, as it always was. A drain persisted
// there must not be: the line it was draining is gone, and a record now
// starting where the drain stood is read, as the reader read it before
// bounded draining.
func TestRolloutUsage_AStaleDrainNeverSkipsARecordARewritePutAtItsPosition(t *testing.T) {
	withReadBudget(t, 256<<10)
	head := encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)))
	f := newRollout(t, head)
	// A line growing past the limit, drained to what is written.
	written := appendSparse(t, f.path, 2<<20, "")
	var emitted []int
	for reads := 0; reads < 64; reads++ {
		emitted = append(emitted, outputs(f.read(t))...)
		if f.last.DeferredFiles == 0 && reads > int(written/readCeiling()) {
			break
		}
	}
	if fmt.Sprint(emitted) != "[1]" {
		t.Fatalf("while the line grows: %v", emitted)
	}
	// The rewrite ends that line just before where the drain stood, and a
	// record begins there.
	rewritten := head + strings.Repeat(" ", int(written)-len(head)-1) + "\n" +
		encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_07", codexTokens(100, 0, 0, 7, 0)), usageRecord(5*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0)))
	write(t, f.path, rewritten)
	for reads := 0; reads < 64; reads++ {
		emitted = append(emitted, outputs(f.read(t))...)
		if f.last.DeferredFiles == 0 {
			break
		}
	}
	if fmt.Sprint(emitted) != "[1 7 2]" {
		t.Fatalf("the record at the stale drain's position was lost: %v, want [1 7 2]", emitted)
	}
}
