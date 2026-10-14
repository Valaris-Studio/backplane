// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
)

// Codex Desktop runs the companion's hooks once they are trusted, so a
// Desktop rollout is named by a hook's thread (which carries no harness)
// as well as by discovery. Its content belongs to one harness, the one its
// own session_meta names, however it was found: content keys and the
// server session both depend on it.
func TestADesktopRolloutNamedByAHookAndByDiscoveryKeepsDesktopsHarness(t *testing.T) {
	f := codexContentFixture(t, "rich")
	began := f.since(t, 10*time.Second)
	writeLines(t, f.codexRollout(codexDesktopThread), f.fixtureRolloutLines(t, "codex-desktop", "rollout-main.jsonl.gz", began))
	// The hook and discovery see the file within the same minute, so
	// neither sighting is stale when the other comes.
	f.since(t, 2*time.Minute)
	f.codexHook(t, codexDesktopThread, "UserPromptSubmit", "")
	f.tickUntilSettled(t)
	for _, record := range contentRecords(f) {
		if record["harness"] != codex.DesktopID {
			t.Fatalf("Desktop content uploaded under %v", record["harness"])
		}
	}
	prompt := agent.ContentKey(codex.DesktopID, codexDesktopThread, "01a11e78-61dc-7d63-8fcd-ad7574631429", "text:1")
	if len(declarationsByKey(f)[prompt]) != 1 {
		t.Fatalf("the Desktop prompt under Desktop's harness: %d declared", len(declarationsByKey(f)[prompt]))
	}
}
