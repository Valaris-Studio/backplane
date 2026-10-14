// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"fmt"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

// Amendment 24: a file naming its own harness is captured for that harness
// however it was found, one adapter serving several harnesses.
const headerHarness = "pi_desktop"

func harnessHeader(f *fixture, harness string) contracttest.Line {
	line := header(f.stamp(), "")
	line.Harness = harness
	return line
}

func contentHarnesses(f *fixture) map[string]bool {
	harnesses := map[string]bool{}
	for _, record := range f.server.Records() {
		if record["contents"] != nil {
			harnesses[record["harness"].(string)] = true
		}
	}
	return harnesses
}

// newHarnessFixture's agent serves headerHarness besides its own.
func newHarnessFixture(t *testing.T, discovered ...func() []agent.ContentFileRef) *fixture {
	t.Helper()
	reader := contracttest.Agent{Name: richAgent, OtherHarnesses: []string{headerHarness}}
	if len(discovered) > 0 {
		reader.Discovered = discovered[0]
	}
	return newRichFixtureOf(t, reader)
}

// enableAgents sets the agents the policy enables; none enables all.
func (f *fixture) enableAgents(t *testing.T, agents ...string) {
	t.Helper()
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = agents
	f.server.Unlock()
	f.forcePolicyRefresh(t)
}

func harnessKey(id string) string { return agent.ContentKey(headerHarness, session, id, "text:0") }

func TestASessionFileNamingItsHarnessIsCapturedForIt(t *testing.T) {
	f := newHarnessFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, harnessHeader(f, headerHarness), textLine("e1", f.stamp(), "said in the other harness"))
	f.tickUntilSettled(t)
	if harnesses := contentHarnesses(f); len(harnesses) != 1 || !harnesses[headerHarness] {
		t.Fatalf("content uploaded under %v", harnesses)
	}
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{harnessKey("e1")}) {
		t.Fatalf("declared %v", keys)
	}
}

// Only a harness its adapter serves is trusted from a file: any other
// name is captured for the adapter itself.
func TestAFileNamingAHarnessItsAdapterDoesNotServeIsCapturedForTheAdapter(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, harnessHeader(f, headerHarness), textLine("e1", f.stamp(), "unserved harness"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1")}) {
		t.Fatalf("declared %v", keys)
	}
	if unserved := richHealth(t, f).UnservedHarness; unserved != 1 {
		t.Fatalf("unserved harness counted %d times, want once", unserved)
	}
}

// A cursor written before it recorded a harness takes the file's own, as
// a first read would.
func TestACursorWithoutAHarnessTakesTheFilesOwn(t *testing.T) {
	f := newHarnessFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, harnessHeader(f, headerHarness), textLine("e1", f.stamp(), "first read"))
	f.tickUntilSettled(t)
	legacy := f.cursorOf(t, session)
	legacy.Harness = ""
	if err := contentCursors(f.layout).Save(legacy); err != nil {
		t.Fatal(err)
	}
	f.appendLines(t, session, textLine("e2", f.stamp(), "after the upgrade"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{harnessKey("e1"), harnessKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A harness disabled and enabled again admits nothing written in between,
// however late the read: its capture is windowed apart from its adapter's.
func TestAHarnessDisabledAndReenabledAdmitsNothingWrittenBetween(t *testing.T) {
	f := newHarnessFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, harnessHeader(f, headerHarness), textLine("e1", f.stamp(), "before"))
	f.tickUntilSettled(t)
	f.enableAgents(t, richAgent)
	f.appendLines(t, session, textLine("gap", f.stamp(), "while disabled"))
	f.enableAgents(t)
	f.appendLines(t, session, textLine("e2", f.stamp(), "after"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{harnessKey("e1"), harnessKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
	if generationOf(t, f, harnessKey("e2")) == generationOf(t, f, harnessKey("e1")) {
		t.Fatal("re-enabling the harness continued its generation")
	}
}

// The same when the gap is read only once the file is due again.
func TestAHarnessGapReadOnceTheFileIsDueAgainAdmitsNothingOfIt(t *testing.T) {
	f := newHarnessFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, harnessHeader(f, headerHarness), textLine("e1", f.stamp(), "before"))
	f.tickUntilSettled(t)
	*f.clock = f.clock.Add(contentPollWindow + time.Hour)
	f.enableAgents(t, richAgent)
	f.appendLines(t, session, textLine("gap", f.stamp(), "while disabled"))
	f.enableAgents(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e2", f.stamp(), "after"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{harnessKey("e1"), harnessKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
}

// The same when the read waits out a transient state across the gap.
func TestAHarnessGapReadAfterATransientStateAdmitsNothingOfIt(t *testing.T) {
	f := newHarnessFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, harnessHeader(f, headerHarness), textLine("e1", f.stamp(), "before"))
	f.tickUntilSettled(t)
	f.enableAgents(t, richAgent)
	f.appendLines(t, session, textLine("gap", f.stamp(), "while disabled"))
	f.server.Lock()
	f.server.Status["/api/companion/policy"] = 503
	f.server.Unlock()
	*f.clock = f.clock.Add(policy.TrustWindow + time.Hour)
	f.tick(t)
	f.server.Lock()
	delete(f.server.Status, "/api/companion/policy")
	f.server.Unlock()
	f.enableAgents(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e2", f.stamp(), "after"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{harnessKey("e1"), harnessKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
}

// Disabling a sibling harness leaves the adapter's own capture, and its
// generation, as they were.
func TestASiblingHarnessDisabledLeavesTheAdaptersCapture(t *testing.T) {
	f := newHarnessFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "before"))
	f.tickUntilSettled(t)
	f.enableAgents(t, richAgent)
	f.appendLines(t, session, textLine("e2", f.stamp(), "while the sibling is disabled"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
	if generationOf(t, f, itemKey("e2")) != generationOf(t, f, itemKey("e1")) {
		t.Fatal("a sibling harness's disable started a new generation for the adapter")
	}
}

// Content's scope is decided for the file's harness: a harness the policy
// disables captures nothing, while its adapter's own harness still does.
func TestAHarnessThePolicyDisablesCapturesNoContent(t *testing.T) {
	f := newHarnessFixture(t)
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = []string{richAgent}
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.richHook(t, "other", f.repo)
	f.appendLines(t, "other", harnessHeader(f, headerHarness), textLine("x", f.stamp(), "disabled harness"))
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "enabled harness"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1")}) {
		t.Fatalf("declared %v", keys)
	}
}

// The harness a session file was first read for sticks: a later sighting
// naming another cannot flip its keys and declare it twice.
func TestALaterSightingCannotFlipASessionsHarness(t *testing.T) {
	var found []agent.ContentFileRef
	f := newHarnessFixture(t, func() []agent.ContentFileRef { return found })
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "first read"))
	f.tickUntilSettled(t)
	found = []agent.ContentFileRef{{Path: f.sessionFile(session), NativeSessionID: session, Cwd: f.repo, Harness: headerHarness}}
	f.appendLines(t, session, textLine("e2", f.stamp(), "after the other sighting"))
	f.tickUntilSettled(t)
	if harnesses := contentHarnesses(f); len(harnesses) != 1 || !harnesses[richAgent] {
		t.Fatalf("content uploaded under %v", harnesses)
	}
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A hook may name a session file nothing ever writes (Claude's
// InstructionsLoaded throwaway ids): it costs the missing-file path alone,
// and ages out without holding anything back.
func TestASessionFileNeverWrittenCapturesNothingAndHoldsNothingBack(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, "throwaway", f.repo)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "the real session"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1")}) {
		t.Fatalf("declared %v", keys)
	}
	for _, record := range f.server.Records() {
		if record["contents"] != nil && record["native_session_id"] == "throwaway" {
			t.Fatalf("a never-written file uploaded %v", record)
		}
	}
	never, named := f.daemon.sources.Sources[f.sessionFile("throwaway")]
	if !named || never.Behind {
		t.Fatalf("a never-written file is held behind or was never named: %+v", never)
	}
	if _, known, _ := contentCursors(f.layout).Load(f.sessionFile("throwaway")); known {
		t.Fatal("a never-written file has a cursor")
	}
	if health := richHealth(t, f); health.StalledSources != 0 || health.MissingBodies != 0 {
		t.Fatalf("health %+v", health)
	}
	if pass := f.daemon.lastContentPass; pass.cursorLoads != pass.opened+1 {
		t.Fatalf("within its window the missing file is looked for, never opened: %+v", pass)
	}
	*f.clock = f.clock.Add(contentPollWindow + time.Minute)
	f.tickUntilSettled(t)
	if f.daemon.lastContentPass.cursorLoads != 0 {
		t.Fatalf("a never-written file is still polled: %+v", f.daemon.lastContentPass)
	}
}
