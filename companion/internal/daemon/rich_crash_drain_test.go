// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package daemon

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// A crash after the record_too_large record's intent, before the cursor
// moves past it: the recovered read goes on draining the line, never
// declares it again nor reads its rest as lines.
func TestACrashMidDrainCommitResumesTheDrain(t *testing.T) {
	for _, point := range []string{"committing", "enqueued"} {
		t.Run(point, func(t *testing.T) {
			f := newRichFixture(t)
			malformedSession(t, f)
			setFault(t, point)
			*f.clock = f.clock.Add(time.Second)
			f.daemon.Tick(context.Background())
			clearFault()
			f.daemon = New(f.daemon.config)
			ticksUntilDeclared(t, f, itemKey("e2"), true)
			f.tickUntilSettled(t)
			tooLarge, keys := declaredContent(f)
			if tooLarge != 1 || fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
				t.Fatalf("want e1, one record_too_large and e2, each once: %d too large, %v", tooLarge, keys)
			}
			// A commit that never reached the queue reads the line again from
			// its start, so its report repeats under the same declaration;
			// only a drain resumed at the wrong place declares it twice.
			if health := richHealth(t, f); health.ParseErrors != 0 {
				t.Fatalf("the recovered read read the line's rest as lines: %+v", health)
			}
		})
	}
}
