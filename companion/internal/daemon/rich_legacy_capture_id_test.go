// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"
)

func TestALegacyCommitKeepsItsCaptureIDAfterRestart(t *testing.T) {
	for _, point := range []string{"committing", "enqueued"} {
		t.Run(point, func(t *testing.T) {
			f := newRichFixture(t)
			f.richHook(t, session, f.repo)
			f.appendLines(t, session, textLine("e1", f.stamp(), "legacy pending work"))
			setFault(t, point)
			*f.clock = f.clock.Add(time.Second)
			f.daemon.Tick(context.Background())
			clearFault()
			cursor := f.cursorOf(t, session)
			generation := mustGeneration(t, f, richMapping)
			sum := sha256.Sum256([]byte(richAgent + "\x00content\x00" + generation.ID + "\x00" + cursor.Identity + "\x000"))
			legacyID := hex.EncodeToString(sum[:])[:32]
			encoded, err := json.Marshal(cursor)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &fields); err != nil {
				t.Fatal(err)
			}
			if _, present := fields["source_incarnation"]; present || cursor.Committing == nil || cursor.Committing.CaptureID != legacyID {
				t.Fatalf("initial capture changed legacy cursor or ID: %s, expected %s", encoded, legacyID)
			}
			f.daemon = New(f.daemon.config)
			f.tickUntilSettled(t)
			if got := string(f.server.Body(itemKey("e1"))); got != "legacy pending work" {
				t.Fatalf("legacy pending work lost: %q", got)
			}
			seen := 0
			for _, record := range f.server.Records() {
				contents, _ := record["contents"].([]any)
				for _, content := range contents {
					if content.(map[string]any)["content_key"] == itemKey("e1") {
						seen++
						if record["capture_id"] != legacyID {
							t.Fatalf("legacy commit rekeyed: %v, expected %s", record["capture_id"], legacyID)
						}
					}
				}
			}
			if seen != 1 {
				t.Fatalf("legacy item declared %d times", seen)
			}
		})
	}
}
