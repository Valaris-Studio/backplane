// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// The generic contract reader (contracttest.Agent) drives the daemon's
// provider-neutral content path against the fake RC-02 server.
const (
	richAgent   = "pi_cli"
	richMapping = "m1"
	session     = "sess-1"
)

var richGrantedAt = now.Add(-time.Hour)

func offerFor(grants map[string]time.Time) policy.RichCapture {
	offer := &policy.RichCaptureOffer{Version: 1, Limits: policy.DeviceRichLimits, RichMappings: []policy.RichMappingGrant{}}
	for id, since := range grants {
		offer.RichMappings = append(offer.RichMappings, policy.RichMappingGrant{MappingID: id, RichSince: since})
	}
	return policy.RichCapture{Present: true, Offer: offer}
}

func richMappingOf(f *fixture) policy.Mapping {
	return policy.Mapping{ID: richMapping, WorkspaceID: "w", RootPath: f.repo, Enabled: true, ContentLevel: "rich"}
}

// newRichFixture captures the repository rich for the contract reader's
// agent: the mapping is rich and the offer grants it.
func newRichFixture(t *testing.T, discovered ...func() []agent.ContentFileRef) *fixture {
	t.Helper()
	reader := contracttest.Agent{Name: richAgent}
	if len(discovered) > 0 {
		reader.Discovered = discovered[0]
	}
	return newRichFixtureOf(t, reader)
}

func newRichFixtureOf(t *testing.T, reader contracttest.Agent) *fixture {
	t.Helper()
	parsed := &atomic.Int64{}
	reader.Parsed = parsed
	f := newFixture(t, reader)
	f.parsed = parsed
	f.server.Lock()
	f.server.ChunkBytes = 8 << 10
	f.server.Policy.Installation.EnabledAgents = nil
	f.server.Policy.Mappings = []policy.Mapping{richMappingOf(f)}
	f.server.Policy.RichCapture = offerFor(map[string]time.Time{richMapping: richGrantedAt})
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	return f
}

func (f *fixture) setOffer(t *testing.T, offer policy.RichCapture) {
	t.Helper()
	f.server.Lock()
	f.server.Policy.RichCapture = offer
	f.server.Unlock()
}

func sessionsDir(home string) string { return filepath.Join(home, ".pi", "sessions") }

func (f *fixture) sessionFile(id string) string {
	return filepath.Join(sessionsDir(f.home), id+".jsonl")
}

// richHook is the agent's hook naming its session file.
func (f *fixture) richHook(t *testing.T, id, cwd string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]string{"session_id": id, "cwd": cwd, "hook_event_name": "message_end", "session_file": f.sessionFile(id)})
	if err := f.shim.Handle(richAgent, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) appendLines(t *testing.T, id string, lines ...contracttest.Line) {
	t.Helper()
	path := f.sessionFile(id)
	var text strings.Builder
	for _, line := range lines {
		text.WriteString(line.Encode())
	}
	appendSession(t, path, text.String())
}

func appendSession(t *testing.T, path, text string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o700)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

func textLine(id string, at time.Time, body string) contracttest.Line {
	return contracttest.Line{ID: id, At: at, Items: []contracttest.Item{contracttest.TextItem("text:0", "user", "prompt", "text/plain", body)}}
}

func replyLine(id string, at time.Time, body string) contracttest.Line {
	return contracttest.Line{ID: id, At: at, Items: []contracttest.Item{contracttest.TextItem("text:0", "assistant", "reply", "text/markdown", body)}}
}

func itemKey(id string) string { return agent.ContentKey(richAgent, session, id, "text:0") }

// tickUntilSettled runs passes a second apart until nothing waits: no
// record queued, no body spooled, every rich session file read to its end.
func (f *fixture) tickUntilSettled(t *testing.T) {
	t.Helper()
	for range 30 {
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
		stats, _ := f.daemon.spool.Stats()
		if f.queueCount(t) == 0 && stats.PendingBodies == 0 && f.contentRead() {
			return
		}
	}
	stats, _ := f.daemon.spool.Stats()
	t.Fatalf("still pending: %d records, %+v", f.queueCount(t), stats)
}

// contentRead reports whether every session file with a cursor is read to
// its end.
func (f *fixture) contentRead() bool {
	if f.daemon.sources == nil {
		return true
	}
	for path := range f.daemon.sources.Sources {
		cursor, found, _ := richcapture.OpenCursors(filepath.Join(f.layout.RichDir(), "cursors")).Load(path)
		info, err := os.Stat(path)
		if found && err == nil && cursor.Offset < info.Size() {
			return false
		}
	}
	return true
}

func declaredKeys(f *fixture) []string {
	var keys []string
	for _, declaration := range f.server.Declarations() {
		keys = append(keys, declaration["content_key"].(string))
	}
	return keys
}

// generationOf is the capture generation the record declaring key named.
func generationOf(t *testing.T, f *fixture, key string) string {
	t.Helper()
	for _, record := range f.server.Records() {
		contents, _ := record["contents"].([]any)
		for _, content := range contents {
			if content.(map[string]any)["content_key"] == key {
				generation, _ := record["capture_generation"].(map[string]any)
				id, _ := generation["id"].(string)
				return id
			}
		}
	}
	t.Fatalf("%s was never declared", key)
	return ""
}

// windowsOf reads the capture windows as persisted, not as held in memory.
func windowsOf(t *testing.T, f *fixture, mapping string) []captureWindow {
	t.Helper()
	loaded, err := state.Load[captureWindows](f.layout.CaptureWindows())
	if err != nil {
		t.Fatal(err)
	}
	return loaded.Windows[windowKey(richAgent, mapping)]
}

// generation is the persisted generation of the mapping's newest window.
func generation(t *testing.T, f *fixture, mapping string) *captureGeneration {
	t.Helper()
	windows := windowsOf(t, f, mapping)
	if len(windows) == 0 {
		t.Fatalf("no capture window for %s", mapping)
	}
	return windows[len(windows)-1].Generation
}

// mustGeneration is generation for a window that must be rich.
func mustGeneration(t *testing.T, f *fixture, mapping string) captureGeneration {
	t.Helper()
	gen := generation(t, f, mapping)
	if gen == nil {
		t.Fatalf("the newest window of %s has no generation", mapping)
	}
	return *gen
}

func richHealth(t *testing.T, f *fixture) state.RichCaptureHealth {
	t.Helper()
	health, _ := state.Load[state.Health](f.layout.Health())
	if health.RichCapture == nil {
		return state.RichCaptureHealth{}
	}
	return *health.RichCapture
}

func digestOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (f *fixture) cursorOf(t *testing.T, id string) richcapture.Cursor {
	t.Helper()
	cursor, found, err := richcapture.OpenCursors(filepath.Join(f.layout.RichDir(), "cursors")).Load(f.sessionFile(id))
	if err != nil || !found {
		t.Fatalf("no cursor for %s: %v", id, err)
	}
	return cursor
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

// The whole path: admitted lines are declared under the open generation,
// small bodies inline and the rest staged, uploaded in chunks and verified
// by the server; the spool and the queue then empty.
func TestRichContentIsDeclaredStagedAndUploadedWithVerifiedBodies(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	large := strings.Repeat("Zoë→日本語🙂 ", 2500)
	image, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "codex-cli"), "swatch.png"))
	if err != nil {
		t.Fatal(err)
	}
	attachment := contracttest.Line{ID: "e3", At: f.stamp(), Items: []contracttest.Item{{Part: "image:0", Role: "user", Channel: "attachment", MediaType: "image/png", DataBase64: base64.StdEncoding.EncodeToString(image)}}}
	// The contract's own example record, its bodies read back from a line.
	uploaded := strings.Repeat("uploaded body ", 2000)
	wire := contracttest.Line{ID: "wire", At: f.stamp(), Items: contracttest.WireItems(t, "ingest-request-rich-record.json", func(string) string { return uploaded })}
	f.appendLines(t, session, textLine("e1", f.stamp(), "Add a retry."), replyLine("e2", f.stamp(), large), attachment, wire)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 3+len(wire.Items) {
		t.Fatalf("declared %d items: %v", len(keys), keys)
	}
	for _, item := range wire.Items {
		if f.server.Body(agent.ContentKey(richAgent, session, "wire", item.Part)) == nil {
			t.Fatalf("the contract's %s item is not available", item.Channel)
		}
	}
	if got := f.server.Body(itemKey("e1")); string(got) != "Add a retry." {
		t.Fatalf("inline body %q", got)
	}
	if got := f.server.Body(itemKey("e2")); digestOf(got) != digestOf([]byte(large)) {
		t.Fatalf("the >16 KiB body arrived as %d bytes", len(got))
	}
	if got := f.server.Body(agent.ContentKey(richAgent, session, "e3", "image:0")); !bytes.Equal(got, image) {
		t.Fatalf("the binary body arrived as %d bytes, sha %s", len(got), digestOf(got))
	}
	gen := mustGeneration(t, f, richMapping)
	if generationOf(t, f, itemKey("e1")) != gen.ID {
		t.Fatalf("declared under %s, the open generation is %+v", generationOf(t, f, itemKey("e1")), gen)
	}
	for _, record := range f.server.Records() {
		if record["harness"] != richAgent || record["contents"] == nil {
			continue
		}
		events, _ := record["events"].([]any)
		beacon, _ := record["beacon"].(map[string]any)
		if events == nil || len(events) != 0 || beacon["schema_version"] != nil || record["collection_method"] != "poll" || record["mapping_id"] != richMapping || record["native_session_id"] != session {
			t.Fatalf("content record %v", record)
		}
	}
	if cursor := f.cursorOf(t, session); cursor.Offset != fileSize(t, f.sessionFile(session)) {
		t.Fatalf("cursor at %d of %d", cursor.Offset, fileSize(t, f.sessionFile(session)))
	}
	encoded, _ := json.Marshal(f.server.Records())
	if strings.Contains(string(encoded), f.home) {
		t.Fatal("a local path was uploaded")
	}
}

// A rich mapping the offer does not list is captured as full events only.
func TestARichMappingTheOfferDoesNotListCapturesNoContent(t *testing.T) {
	f := newRichFixture(t)
	f.setOffer(t, offerFor(map[string]time.Time{}))
	f.forcePolicyRefresh(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "hello"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 0 {
		t.Fatalf("declared %v", keys)
	}
	if gen := generation(t, f, richMapping); gen != nil {
		t.Fatalf("a window without a grant has generation %+v", gen)
	}
	if len(f.server.Records()) == 0 {
		t.Fatal("the hook's events were not uploaded")
	}
}

// m17: during a pause the cursor advances and nothing is staged; what came
// before and after the pause is declared, and the paused records counted.
func TestDuringAPauseTheCursorAdvancesAndNothingIsStaged(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("before", f.stamp(), "before the pause"))
	f.tickUntilSettled(t)
	f.setPaused(t, true)
	f.tick(t)
	f.appendLines(t, session, textLine("paused", f.stamp(), "while paused"))
	f.tickUntilSettled(t)
	if cursor := f.cursorOf(t, session); cursor.Offset != fileSize(t, f.sessionFile(session)) {
		t.Fatal("the cursor did not advance past the paused record")
	}
	f.setPaused(t, false)
	f.tick(t)
	f.appendLines(t, session, textLine("after", f.stamp(), "after the pause"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("before"), itemKey("after")}) {
		t.Fatalf("declared %v", keys)
	}
	if richHealth(t, f).OutsideWindow != 1 {
		t.Fatalf("outside-window count %+v", richHealth(t, f))
	}
	if generationOf(t, f, itemKey("before")) == generationOf(t, f, itemKey("after")) {
		t.Fatal("a pause must start a new generation")
	}
}

// Backlog that was allowed but not yet read survives a restart and is
// declared under its old generation; the downtime is skipped and counted;
// the restart continues the same generation.
func TestARestartKeepsTheBacklogSkipsTheDowntimeAndContinuesTheGeneration(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	before := mustGeneration(t, f, richMapping)
	allowedAt := f.clock.Add(-time.Second)
	f.at(t, f.clock.Sub(now)+20*time.Minute)
	f.appendLines(t, session, textLine("backlog", allowedAt, "written late, allowed"), textLine("downtime", f.clock.Add(-10*time.Minute), "while the daemon was down"))
	f.daemon = New(f.daemon.config)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("backlog")}) {
		t.Fatalf("declared %v", keys)
	}
	if got := generationOf(t, f, itemKey("backlog")); got != before.ID {
		t.Fatalf("backlog declared under %s, its window's generation is %s", got, before.ID)
	}
	if after := generation(t, f, richMapping); after == nil || after.ID != before.ID || !after.AdmittedFrom.Equal(before.AdmittedFrom) {
		t.Fatalf("a restart with equal settings must continue the generation: %+v → %+v", before, after)
	}
	if richHealth(t, f).OutsideWindow != 1 {
		t.Fatalf("outside-window count %+v", richHealth(t, f))
	}
}

// Generation identity is persisted, never derived: it survives the pruning
// of its chain's first window and more restarts than windows are kept.
func TestGenerationIdentitySurvivesPruningAndHundredsOfRestarts(t *testing.T) {
	f := newRichFixture(t)
	first := mustGeneration(t, f, richMapping)
	if len(first.ID) != 32 || len(first.PolicyRevision) != 64 {
		t.Fatalf("first generation %+v", first)
	}
	for range maxWindowsPerKey + 44 {
		*f.clock = f.clock.Add(time.Second)
		f.daemon = New(f.daemon.config)
		f.tick(t)
	}
	windows := windowsOf(t, f, richMapping)
	if len(windows) > maxWindowsPerKey || !windows[0].From.After(first.AdmittedFrom) {
		t.Fatalf("%d windows, the oldest from %v: the chain's first window should be pruned", len(windows), windows[0].From)
	}
	last := windows[len(windows)-1].Generation
	if last == nil || *last != first {
		t.Fatalf("generation changed across restarts: %+v → %+v", first, last)
	}
}

// Backlog read after a policy change is declared under the generation of the
// window its timestamp lies in, and acknowledged; later records take the new
// generation, each in its own record.
func TestBacklogAfterAPolicyChangeIsDeclaredUnderItsOldGeneration(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e0", f.stamp(), "read before the change"))
	f.tickUntilSettled(t)
	old := mustGeneration(t, f, richMapping)
	f.appendLines(t, session, textLine("backlog", f.clock.Add(-time.Second), "allowed before the change"))
	f.setExcludeGlobs(t, []string{"**/vendor"})
	f.tick(t)
	current := generation(t, f, richMapping)
	if current == nil || current.ID == old.ID {
		t.Fatalf("a settings change must start a new generation: %+v → %+v", old, current)
	}
	f.appendLines(t, session, textLine("after", f.stamp(), "after the change"))
	f.tickUntilSettled(t)
	if got := generationOf(t, f, itemKey("backlog")); got != old.ID {
		t.Fatalf("backlog under %s, want %s", got, old.ID)
	}
	if got := generationOf(t, f, itemKey("after")); got != current.ID {
		t.Fatalf("new record under %s, want %s", got, current.ID)
	}
	f.server.Lock()
	stored := f.server.Contents[itemKey("backlog")]
	f.server.Unlock()
	if stored == nil || stored.State != "available" || stored.Generation != old.ID {
		t.Fatalf("backlog not acknowledged under its generation: %+v", stored)
	}
}

func TestEditingOneMappingLeavesTheOthersGenerationsRunning(t *testing.T) {
	f := newRichFixture(t)
	other := filepath.Join(f.home, "other")
	os.MkdirAll(other, 0o700)
	m1 := richMappingOf(f)
	m1.RepoURLNormalized = "github.com/acme/app"
	m2 := policy.Mapping{ID: "m2", WorkspaceID: "w", RootPath: other, Enabled: true, ContentLevel: "rich"}
	f.setOffer(t, offerFor(map[string]time.Time{richMapping: richGrantedAt, "m2": richGrantedAt}))
	f.setMappings(t, m1, m2)
	before := mustGeneration(t, f, richMapping)
	m2.ContentLevel = "full"
	f.setMappings(t, m1, m2)
	if after := generation(t, f, richMapping); after == nil || after.ID != before.ID {
		t.Fatalf("editing an unrelated mapping changed m1's generation: %+v → %+v", before, after)
	}
	if windows := windowsOf(t, f, richMapping); len(windows) == 0 || !windows[len(windows)-1].Open {
		t.Fatal("editing an unrelated mapping closed m1's window")
	}
	nested := policy.Mapping{ID: "m3", WorkspaceID: "w", RootPath: filepath.Join(f.repo, "secret"), Enabled: true, ContentLevel: "standard"}
	f.setMappings(t, m1, m2, nested)
	afterNested := generation(t, f, richMapping)
	if afterNested == nil || afterNested.ID == before.ID {
		t.Fatal("adding a nested mapping must start a new generation of the one it nests in")
	}
	sameRepo := policy.Mapping{ID: "m4", WorkspaceID: "w", RepoURLNormalized: "github.com/acme/app", Enabled: true, ContentLevel: "standard"}
	f.setMappings(t, m1, m2, nested, sameRepo)
	if afterRepo := generation(t, f, richMapping); afterRepo == nil || afterRepo.ID == afterNested.ID {
		t.Fatal("adding a mapping of the same repository must start a new generation")
	}
}

// Leaving and re-entering rich between two policy fetches still counts: the
// grant's rich_since is part of the settings.
func TestARichStandardRichToggleBetweenFetchesStartsANewGeneration(t *testing.T) {
	f := newRichFixture(t)
	before := mustGeneration(t, f, richMapping)
	f.setOffer(t, offerFor(map[string]time.Time{richMapping: now.Add(5 * time.Minute)}))
	f.forcePolicyRefresh(t)
	if after := generation(t, f, richMapping); after == nil || after.ID == before.ID {
		t.Fatalf("a new rich_since must start a new generation: %+v → %+v", before, after)
	}
}

func (f *fixture) holdUploads(t *testing.T, held bool) {
	t.Helper()
	f.server.Lock()
	defer f.server.Unlock()
	if held {
		f.server.Status["/api/companion/ingest"] = 503
	} else {
		delete(f.server.Status, "/api/companion/ingest")
	}
}

// readQueue returns the queued records by capture id.
func readQueue(t *testing.T, f *fixture) map[string]uplink.Record {
	t.Helper()
	batch, err := queue.Open(f.layout).Next(1024, 128<<20)
	if err != nil {
		t.Fatal(err)
	}
	records := map[string]uplink.Record{}
	for index, raw := range batch.Records {
		var record uplink.Record
		json.Unmarshal(raw, &record)
		records[batch.IDs[index]] = record
	}
	return records
}

// queueMixedRecord queues a record with both events and an inline content,
// the shape the events-only rules must take apart.
func queueMixedRecord(t *testing.T, f *fixture, captureID string) uplink.Record {
	t.Helper()
	gen := mustGeneration(t, f, richMapping)
	text := "inline"
	size, sum := int64(len(text)), digestOf([]byte(text))
	ref := "mixed-" + captureID[:4]
	schema := "1.0"
	record := uplink.Record{
		CaptureID: captureID, MappingID: richMapping, Harness: richAgent, CollectionMethod: "hook", NativeSessionID: session, CapturedAt: f.stamp(),
		Beacon: uplink.BeaconProvenance{Commit: "c", SchemaVersion: &schema},
		Events: []json.RawMessage{json.RawMessage(`{"schema_version":"1.0","event":{"id":"` + captureID + `","action":"prompt.submitted"},"session":{"id":"` + session + `"}}`)},
		Contents: []uplink.ContentDeclaration{{
			ContentKey: agent.ContentKey(richAgent, session, ref, "text:0"), Role: "user", Channel: "prompt",
			Source:     uplink.ContentSource{Kind: "pi_session", NativeRef: &ref, Parser: "p/1", SchemaVersion: "fixture/1"},
			OccurredAt: f.stamp(), ObservedAt: f.stamp(), MediaType: "text/plain", Coverage: "captured", Delivery: uplink.DeliveryInline,
			ByteCount: &size, SHA256: &sum, InlineText: &text, Redaction: uplink.RedactionFact{FilterVersion: richcapture.FilterVersion},
		}},
		CaptureGeneration: &uplink.CaptureGeneration{ID: gen.ID, Profile: "rich", AdmittedFrom: gen.AdmittedFrom, PolicyRevision: gen.PolicyRevision},
	}
	encoded, _ := json.Marshal(record)
	if err := queue.Open(f.layout).Enqueue(captureID, encoded); err != nil {
		t.Fatal(err)
	}
	return record
}

// One offer-less policy response changes nothing; a second, a policy
// interval later, rewrites the queue events-only and purges the spool.
func TestTwoOfferlessPoliciesRewriteTheQueueAndPurgeTheSpool(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tick(t)
	mixed := queueMixedRecord(t, f, strings.Repeat("ab", 16))
	queued := readQueue(t, f)
	if len(queued) != 3 {
		t.Fatalf("setup queued %d records", len(queued))
	}
	before := mustGeneration(t, f, richMapping)
	f.setOffer(t, policy.RichCapture{})
	f.forcePolicyRefresh(t)
	if again := readQueue(t, f); len(again) != len(queued) {
		t.Fatalf("one offer-less response rewrote the queue: %d → %d", len(queued), len(again))
	}
	if after := generation(t, f, richMapping); after == nil || after.ID != before.ID {
		t.Fatalf("one offer-less response ended the generation: %+v → %+v", before, after)
	}
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 {
		t.Fatalf("one offer-less response purged the spool: %+v", stats)
	}
	f.forcePolicyRefresh(t)
	rewritten := readQueue(t, f)
	eventsOnly, _ := mixed.EventsOnly()
	var hookRecords int
	for id, record := range rewritten {
		if record.Contents != nil || record.CaptureGeneration != nil {
			t.Fatalf("a rich record survived the rewrite: %s", id)
		}
		if id != eventsOnly.CaptureID {
			hookRecords++
		}
	}
	if _, ok := rewritten[eventsOnly.CaptureID]; !ok || len(rewritten) != hookRecords+1 {
		t.Fatalf("rewritten queue %v", rewritten)
	}
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 0 {
		t.Fatalf("spool not purged: %+v", stats)
	}
	if gen := generation(t, f, richMapping); gen != nil {
		t.Fatal("no rich window without an offer")
	}
}

// An explicit null stops new rich windows but keeps the queue: this server
// stores the events and answers the contents recorded.
func TestAnExplicitNullStopsRichWindowsAndKeepsTheQueue(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tick(t)
	queued := readQueue(t, f)
	f.setOffer(t, policy.RichCapture{Present: true})
	f.forcePolicyRefresh(t)
	if gen := generation(t, f, richMapping); gen != nil {
		t.Fatalf("a window under null has generation %+v", gen)
	}
	if again := readQueue(t, f); len(again) != len(queued) {
		t.Fatalf("null rewrote the queue: %d → %d", len(queued), len(again))
	}
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 {
		t.Fatalf("null purged the spool: %+v", stats)
	}
	f.appendLines(t, session, textLine("later", f.stamp(), "after null"))
	f.holdUploads(t, false)
	f.tickUntilSettled(t)
	for _, key := range declaredKeys(f) {
		if key == itemKey("later") {
			t.Fatal("content was declared without an offer")
		}
	}
}

// Every invalid rejection of a record carrying rich members is retried once
// events-only, under the derived id, with the same events; also while a
// rollout serves policy from a new revision and ingest from an old one.
func TestAnInvalidRejectionIsRetriedOnceEventsOnly(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.RejectRich = "invalid"
	f.server.Unlock()
	mixed := queueMixedRecord(t, f, strings.Repeat("cd", 16))
	f.tickUntilSettled(t)
	f.tickUntilSettled(t)
	eventsOnly, _ := mixed.EventsOnly()
	sent := map[string]int{}
	for _, record := range f.server.Records() {
		sent[record["capture_id"].(string)]++
		if record["capture_id"] == eventsOnly.CaptureID {
			if events, _ := record["events"].([]any); record["contents"] != nil || len(events) != 1 {
				t.Fatalf("the retry is not events-only: %v", record)
			}
		}
	}
	if sent[mixed.CaptureID] != 1 || sent[eventsOnly.CaptureID] != 1 {
		t.Fatalf("sent %v: the rich record once, its events-only form once", sent)
	}
	if richHealth(t, f).EventsOnlyRetries != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}

// A rejected record settles every declaration it carried: its spooled
// bodies are deleted, and nothing is retried events-only for a reason
// other than invalid, a record with events included.
func TestARejectedRecordSettlesItsSpooledBodies(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.RejectRich = "paused"
	f.server.Unlock()
	mixed := queueMixedRecord(t, f, strings.Repeat("ef", 16))
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 2 {
		t.Fatalf("declared %v", keys)
	}
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 0 {
		t.Fatalf("spool kept a rejected record's body: %+v", stats)
	}
	eventsOnly, _ := mixed.EventsOnly()
	for _, record := range f.server.Records() {
		if record["capture_id"] == eventsOnly.CaptureID {
			t.Fatal("a paused rejection was retried events-only")
		}
	}
	if f.server.ChunkPuts != 0 || richHealth(t, f).EventsOnlyRetries != 0 {
		t.Fatalf("uploads %d, retries %d", f.server.ChunkPuts, richHealth(t, f).EventsOnlyRetries)
	}
}

// recorded, rejected and dropped settle a body without an upload.
func TestSettlingAcksDeleteBodiesWithoutAnUpload(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.server.Lock()
	f.server.ContentOutcome[itemKey("quota")] = map[string]any{"outcome": "recorded", "content_id": "00000000-0000-4000-8000-0000000000aa", "coverage": "withheld_by_policy", "coverage_reason": "quota_exceeded"}
	f.server.ContentOutcome[itemKey("early")] = map[string]any{"outcome": "rejected", "rejection": "before_admission"}
	f.server.Unlock()
	f.appendLines(t, session, replyLine("quota", f.stamp(), strings.Repeat("q", 20<<10)), replyLine("early", f.stamp(), strings.Repeat("e", 20<<10)))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 2 {
		t.Fatalf("declared %v", keys)
	}
	if f.server.ChunkPuts != 0 {
		t.Fatalf("%d chunks uploaded for settled bodies", f.server.ChunkPuts)
	}
	if richHealth(t, f).Rejected["before_admission"] != 1 {
		t.Fatalf("rejections not counted: %+v", richHealth(t, f))
	}
}

func TestADroppedRecordsBodiesAreDeleted(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.DeletedSessions[session] = true
	f.server.Unlock()
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1")}) {
		t.Fatalf("declared %v", keys)
	}
	if f.server.ChunkPuts != 0 {
		t.Fatal("a dropped declaration was uploaded")
	}
}

// 404, 410 and 409 rich_capture_unavailable end an upload for good; 503
// waits and retries.
func TestTerminalUploadAnswersDeleteTheBodyAndTransientOnesRetry(t *testing.T) {
	for _, terminal := range []uplinktest.UploadError{{Status: 404, Code: "content_not_found"}, {Status: 410, Code: "upload_expired"}, {Status: 409, Code: "rich_capture_unavailable"}} {
		t.Run(terminal.Code, func(t *testing.T) {
			f := newRichFixture(t)
			f.server.Lock()
			f.server.UploadErrors["00000000-0000-4000-8000-000000000001"] = terminal
			f.server.Unlock()
			f.richHook(t, session, f.repo)
			f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
			f.tickUntilSettled(t)
			if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 0 || stats.FailedTotal != 1 {
				t.Fatalf("spool %+v", stats)
			}
		})
	}
	t.Run("storage_backend_unavailable", func(t *testing.T) {
		f := newRichFixture(t)
		f.server.Lock()
		f.server.UploadErrors["00000000-0000-4000-8000-000000000001"] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
		f.server.Unlock()
		f.richHook(t, session, f.repo)
		body := strings.Repeat("r", 20<<10)
		f.appendLines(t, session, replyLine("e1", f.stamp(), body))
		for range 3 {
			*f.clock = f.clock.Add(time.Second)
			f.tick(t)
		}
		if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 || stats.FailedTotal != 0 {
			t.Fatalf("a transient failure gave up the body: %+v", stats)
		}
		f.server.Lock()
		delete(f.server.UploadErrors, "00000000-0000-4000-8000-000000000001")
		f.server.Unlock()
		*f.clock = f.clock.Add(10 * time.Minute)
		f.tickUntilSettled(t)
		if got := f.server.Body(itemKey("e1")); string(got) != body {
			t.Fatalf("retried upload arrived as %d bytes", len(got))
		}
	})
}

// A chunk lost on the server between passes is found by finalize; the
// device resyncs and sends what is missing.
func TestAnIncompleteUploadResyncsAndResendsWhatIsMissing(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	body := strings.Repeat("0123456789abcdef", 3<<10)
	f.appendLines(t, session, replyLine("e1", f.stamp(), body))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	f.server.Lock()
	content := f.server.Contents[itemKey("e1")]
	if content == nil || len(content.Chunks) != 4 {
		f.server.Unlock()
		t.Fatalf("first pass uploaded %+v", content)
	}
	delete(content.Chunks, 0)
	f.server.Unlock()
	f.tickUntilSettled(t)
	if got := f.server.Body(itemKey("e1")); string(got) != body {
		t.Fatalf("body arrived as %d bytes", len(got))
	}
}

func setFault(t *testing.T, point string) {
	t.Helper()
	commitFault = func(at string) error {
		if at == point {
			return errors.New("crash at " + point)
		}
		return nil
	}
	t.Cleanup(func() { commitFault = func(string) error { return nil } })
}

func clearFault() { commitFault = func(string) error { return nil } }

// Crash points around stage, cursor and ack, each on the far side of its
// fsync: "staged" after the bodies and sidecars, "committing" after the
// cursor's intent, "enqueued" after the record, before the cursor moves,
// "acked" after the spool took the acks, before the queue settles. Whatever
// was interrupted, a restart declares each item under exactly one capture
// id with no conflict, loses none (a line appended after the crash
// included) and ends with an empty spool.
func TestACrashAtAnyCommitPointDeclaresEachItemOnceAndLosesNone(t *testing.T) {
	for _, point := range []string{"staged", "committing", "enqueued", "acked"} {
		t.Run(point, func(t *testing.T) {
			f := newRichFixture(t)
			f.richHook(t, session, f.repo)
			f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("a", 20<<10)), textLine("e2", f.stamp(), "short"))
			setFault(t, point)
			*f.clock = f.clock.Add(time.Second)
			f.daemon.Tick(context.Background())
			clearFault()
			f.appendLines(t, session, textLine("e3", f.stamp(), "after the crash"))
			f.daemon = New(f.daemon.config)
			f.tickUntilSettled(t)
			declaredUnder := map[string]map[string]bool{}
			for _, record := range f.server.Records() {
				contents, _ := record["contents"].([]any)
				for _, content := range contents {
					key := content.(map[string]any)["content_key"].(string)
					if declaredUnder[key] == nil {
						declaredUnder[key] = map[string]bool{}
					}
					declaredUnder[key][record["capture_id"].(string)] = true
				}
			}
			for _, id := range []string{"e1", "e2", "e3"} {
				if len(declaredUnder[itemKey(id)]) != 1 {
					t.Fatalf("%s declared under %v: want exactly one capture id", id, declaredUnder[itemKey(id)])
				}
			}
			f.server.Lock()
			defer f.server.Unlock()
			if len(f.server.Rejections) != 0 {
				t.Fatalf("the server rejected %v", f.server.Rejections)
			}
			if stored := f.server.Contents[itemKey("e1")]; stored == nil || stored.State != "available" {
				t.Fatalf("the staged body never arrived: %+v", stored)
			}
			if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 0 {
				t.Fatalf("spool left %+v", stats)
			}
		})
	}
}

// A record the agent is still writing is not read until its newline; then
// it is read whole, once.
func TestAPartialRecordIsReplayedWholeOnceComplete(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	whole := textLine("e1", f.stamp(), "written in two parts").Encode()
	appendSession(t, f.sessionFile(session), whole[:20])
	for range 3 {
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
	}
	if keys := declaredKeys(f); len(keys) != 0 {
		t.Fatalf("a partial record was declared: %v", keys)
	}
	appendSession(t, f.sessionFile(session), whole[20:])
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A session file replaced at its path is read anew: what was declared is
// not declared again, nothing before the session's first sighting is
// staged, and the replacement is counted.
func TestAReplacedSessionFileIsReadAnewWithoutBackfill(t *testing.T) {
	f := newRichFixture(t)
	firstSeen := *f.clock
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "first"))
	f.tickUntilSettled(t)
	path := f.sessionFile(session)
	os.Rename(path, path+".old")
	f.appendLines(t, session, textLine("old", firstSeen.Add(-time.Hour), "copied from before"), textLine("e1", f.stamp(), "first"), textLine("e2", f.stamp(), "second"))
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
	if richHealth(t, f).SourceReplaced != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}

// Records copied in from another session, and records older than the
// session's first sighting, are never this session's content.
func TestCopiedAndPreexistingRecordsAreNeverContent(t *testing.T) {
	f := newRichFixture(t)
	firstSeen := *f.clock
	f.richHook(t, session, f.repo)
	copied := textLine("copied", f.stamp(), "a fork's ancestor")
	copied.Copied = true
	f.appendLines(t, session, textLine("older", firstSeen.Add(-time.Minute), "before the session was seen"), copied, textLine("own", f.stamp(), "its own"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("own")}) {
		t.Fatalf("declared %v", keys)
	}
	if richHealth(t, f).Copied != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}

// Backpressure: a full spool holds the read back (cursor held) without
// evicting anything; once uploads drain, the held record is read. A spool
// full for longer than the stall limit declares the body missing instead.
func TestAFullSpoolHoldsTheReadBackAndEvictsNothing(t *testing.T) {
	f := newRichFixture(t)
	f.daemon.spool.WithMaxBytes(30 << 10)
	f.server.Lock()
	f.server.UploadErrors["00000000-0000-4000-8000-000000000001"] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
	f.server.Unlock()
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("1", 20<<10)))
	held := fileSize(t, f.sessionFile(session))
	f.appendLines(t, session, replyLine("e2", f.stamp(), strings.Repeat("2", 20<<10)))
	for range 3 {
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
	}
	if cursor := f.cursorOf(t, session); cursor.Offset != held {
		t.Fatalf("cursor at %d, want held at %d", cursor.Offset, held)
	}
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 || stats.PendingBytes != 20<<10 {
		t.Fatalf("spool %+v", stats)
	}
	if richHealth(t, f).StalledSources != 1 {
		t.Fatalf("a stall must be measurable: %+v", richHealth(t, f))
	}
	f.server.Lock()
	delete(f.server.UploadErrors, "00000000-0000-4000-8000-000000000001")
	f.server.Unlock()
	*f.clock = f.clock.Add(10 * time.Minute)
	f.tickUntilSettled(t)
	if got := f.server.Body(itemKey("e2")); len(got) != 20<<10 {
		t.Fatalf("the held record arrived as %d bytes", len(got))
	}
}

func TestASpoolFullPastTheStallLimitDeclaresTheBodyMissing(t *testing.T) {
	f := newRichFixture(t)
	f.daemon.spool.WithMaxBytes(30 << 10)
	f.server.Lock()
	f.server.UploadErrors["00000000-0000-4000-8000-000000000001"] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
	f.server.Unlock()
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("1", 20<<10)), replyLine("e2", f.stamp(), strings.Repeat("2", 20<<10)))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	*f.clock = f.clock.Add(25 * time.Hour)
	f.tick(t)
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	var missing map[string]any
	for _, declaration := range f.server.Declarations() {
		if declaration["content_key"] == itemKey("e2") {
			missing = declaration
		}
	}
	if missing == nil || missing["coverage"] != "collection_failed" || missing["coverage_reason"] != "spool_full" || missing["delivery"] != "none" {
		t.Fatalf("e2 declared %v", missing)
	}
	if cursor := f.cursorOf(t, session); cursor.Offset != fileSize(t, f.sessionFile(session)) {
		t.Fatal("the cursor did not move past the declared-missing record")
	}
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 {
		t.Fatalf("the spooled body was evicted: %+v", stats)
	}
	if richHealth(t, f).SpoolFull != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}

// Deleting a nested, more private mapping with backlog present starts a new
// generation of the parent and stages none of that backlog at the parent's
// level.
func TestDeletingANestedMorePrivateMappingStagesNoneOfItsBacklog(t *testing.T) {
	f := newRichFixture(t)
	parent := policy.Mapping{ID: "parent", WorkspaceID: "w", RootPath: filepath.Dir(f.repo), Enabled: true, ContentLevel: "rich"}
	child := policy.Mapping{ID: "child", WorkspaceID: "w", RootPath: f.repo, Enabled: true, ContentLevel: "standard"}
	f.setOffer(t, offerFor(map[string]time.Time{"parent": richGrantedAt}))
	f.setMappings(t, parent, child)
	f.richHook(t, session, f.repo)
	f.tick(t)
	parentBefore := generation(t, f, "parent")
	f.appendLines(t, session, textLine("private", f.stamp(), "said under the standard mapping"))
	f.setMappings(t, parent)
	parentAfter := generation(t, f, "parent")
	if parentBefore == nil || parentAfter == nil || parentAfter.ID == parentBefore.ID {
		t.Fatalf("parent generation %+v → %+v", parentBefore, parentAfter)
	}
	f.appendLines(t, session, textLine("public", f.stamp(), "said under the parent"))
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("public")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A policy that stops rich capture before the daemon reads new records
// stages none of them.
func TestPolicyDisabledBeforeTheReadStagesNothing(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	standard := richMappingOf(f)
	standard.ContentLevel = "standard"
	f.setMappings(t, standard)
	f.appendLines(t, session, textLine("e1", f.stamp(), "after rich was turned off"))
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 0 {
		t.Fatalf("declared %v", keys)
	}
	if cursor := f.cursorOf(t, session); cursor.Offset != fileSize(t, f.sessionFile(session)) {
		t.Fatal("records outside every rich window must be read past")
	}
}

// A session of a mapping that was never rich is never parsed: a later
// grant sees the file first and starts at its size.
func TestASessionOfAMappingThatWasNeverRichIsNotRead(t *testing.T) {
	f := newRichFixture(t)
	standard := richMappingOf(f)
	standard.ContentLevel = "standard"
	f.setOffer(t, offerFor(map[string]time.Time{}))
	f.setMappings(t, standard)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "never rich"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 0 {
		t.Fatalf("declared %v", keys)
	}
	if parsed := f.parsed.Load(); parsed != 0 {
		t.Fatalf("parsed %d lines of a never-rich session", parsed)
	}
	if bodies, _ := f.daemon.spool.Bodies(); len(bodies) != 0 {
		t.Fatalf("spooled %d bodies", len(bodies))
	}
}

// A revoked credential ends the run without giving up spooled bodies.
func TestARevokedCredentialKeepsSpooledBodies(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tick(t)
	f.server.RevokeAll()
	f.holdUploads(t, false)
	*f.clock = f.clock.Add(10 * time.Minute)
	f.tickRevoked(t)
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 || stats.FailedTotal != 0 {
		t.Fatalf("spool after revocation %+v", stats)
	}
}

// Drain, as a server switch runs it, also sends pending chunk uploads.
func TestDrainSendsPendingChunkUploads(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	body := strings.Repeat("d", 40<<10)
	f.appendLines(t, session, replyLine("e1", f.stamp(), body))
	f.server.Lock()
	f.server.Status["/api/companion/contents/00000000-0000-4000-8000-000000000001/chunks/0"] = 503
	f.server.Unlock()
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	f.server.Lock()
	delete(f.server.Status, "/api/companion/contents/00000000-0000-4000-8000-000000000001/chunks/0")
	f.server.Unlock()
	New(f.daemon.config).Drain(context.Background())
	if got := f.server.Body(itemKey("e1")); string(got) != body {
		t.Fatalf("drain left the body at %d bytes", len(got))
	}
}

func TestHeartbeatCarriesRichCaptureOnlyWhileOffered(t *testing.T) {
	f := newRichFixture(t)
	beats := f.heartbeats()
	last := beats[len(beats)-1]
	status, ok := last["rich_capture"].(map[string]any)
	if !ok || status["spool"] == nil {
		t.Fatalf("heartbeat under an offer: %v", last)
	}
	f.setOffer(t, policy.RichCapture{Present: true})
	f.forcePolicyRefresh(t)
	beats = f.heartbeats()
	if _, sent := beats[len(beats)-1]["rich_capture"]; sent {
		t.Fatal("rich_capture sent without an offer")
	}
}

// The event filter at the daemon's OTLP and usage site treats rich as full.
func TestTheDaemonsEventFilterTreatsRichAsFull(t *testing.T) {
	line := json.RawMessage(`{"session":{"working_directory":"/home/me/code/app"},"gen_ai":{"output":"the reply"},"command":{"output":"long output"}}`)
	rich, err := applyEventLevel(line, privacy.Rich)
	if err != nil {
		t.Fatal(err)
	}
	full, _ := applyEventLevel(line, privacy.Full)
	if string(rich) != string(full) {
		t.Fatalf("rich %s, full %s", rich, full)
	}
}

// A file read to its end after growing twice is Unchanged on the next pass:
// it is neither reopened past its size nor its cursor written again.
func TestAFileReadToItsEndIsLeftAloneUntilItGrows(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "one"))
	f.tickUntilSettled(t)
	f.appendLines(t, session, textLine("e2", f.stamp(), "two"))
	f.tickUntilSettled(t)
	cursorFile := filepath.Join(f.layout.RichDir(), "cursors")
	entries, _ := os.ReadDir(cursorFile)
	if len(entries) != 1 {
		t.Fatalf("cursors: %d", len(entries))
	}
	before, _ := os.ReadFile(filepath.Join(cursorFile, entries[0].Name()))
	beforeInfo, _ := os.Stat(filepath.Join(cursorFile, entries[0].Name()))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	after, _ := os.ReadFile(filepath.Join(cursorFile, entries[0].Name()))
	afterInfo, _ := os.Stat(filepath.Join(cursorFile, entries[0].Name()))
	if string(before) != string(after) || !afterInfo.ModTime().Equal(beforeInfo.ModTime()) {
		t.Fatal("an unchanged file's cursor was written again")
	}
	if cursor := f.cursorOf(t, session); cursor.Size != fileSize(t, f.sessionFile(session)) {
		t.Fatalf("cursor size %d, file %d: the next pass reopens it", cursor.Size, fileSize(t, f.sessionFile(session)))
	}
}

// Unchanged session files cost a stat: a pass neither loads their cursors
// nor opens them. After a restart the first pass checks each fully once.
func TestUnchangedSessionFilesAreNeitherLoadedNorOpened(t *testing.T) {
	f := newRichFixture(t)
	for index := range 5 {
		id := fmt.Sprintf("u%d", index)
		f.richHook(t, id, f.repo)
		f.appendLines(t, id, textLine("only", f.stamp(), "hello"))
	}
	f.tickUntilSettled(t)
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	if pass := f.daemon.lastContentPass; pass.cursorLoads != 0 || pass.opened != 0 {
		t.Fatalf("a pass over unchanged files loaded %d cursors and opened %d files", pass.cursorLoads, pass.opened)
	}
	f.daemon = New(f.daemon.config)
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	if pass := f.daemon.lastContentPass; pass.cursorLoads != 0 || pass.opened != 0 {
		t.Fatalf("after the restart's full check, a pass loaded %d cursors and opened %d files", pass.cursorLoads, pass.opened)
	}
	f.appendLines(t, "u0", textLine("more", f.stamp(), "grew"))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	if pass := f.daemon.lastContentPass; pass.opened != 1 {
		t.Fatalf("the grown file was opened %d times", pass.opened)
	}
}

// A session rotated into a new file at the same path is read by the new
// file's own header, never the old one's start.
func TestARotatedSessionFileIsReadByItsOwnHeader(t *testing.T) {
	f := newRichFixture(t)
	*f.clock = f.clock.Add(time.Minute)
	f.tick(t)
	first := f.clock.Add(-30 * time.Second)
	f.appendLines(t, session, header(first, ""), textLine("e1", first, "first file"))
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	path := f.sessionFile(session)
	os.Rename(path, path+".old")
	second := f.stamp()
	f.appendLines(t, session, header(second, ""), textLine("between", first.Add(time.Second), "older than this file's session"), textLine("e2", second, "second file"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
}

// Amendment 20: the parser is handed the session file each line comes from.
func TestTheParserIsHandedTheSessionFilePath(t *testing.T) {
	f := newRichFixture(t)
	var paths []string
	reader := contracttest.Agent{Name: richAgent, Root: sessionsDir(f.home), Lines: func(line agent.ContentLine) { paths = append(paths, line.Path) }}
	f.daemon.config.Registry = agent.NewRegistry(reader)
	f.shim.Registry = f.daemon.config.Registry
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e1", f.stamp(), "hello"))
	f.tickUntilSettled(t)
	if len(paths) != 1 || paths[0] != f.sessionFile(session) {
		t.Fatalf("parser saw paths %v, want %s", paths, f.sessionFile(session))
	}
}

// A native record's malformed refs are counted where the device's health
// is read.
func TestMalformedNativeRefsAreCountedInHealth(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	native := contracttest.TextItem("native", "tool", "native_record", "application/json", `{"edit":{"backplane_content_ref":{"part":5}}}`)
	f.appendLines(t, session, contracttest.Line{ID: "n1", At: f.stamp(), Items: []contracttest.Item{native}})
	f.tickUntilSettled(t)
	if richHealth(t, f).MalformedRefs != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}

// A discovered source, and a file replaced at its path, hand the parser
// the path each line is read from.
func TestDiscoveredAndReplacedFilesHandTheParserTheirPath(t *testing.T) {
	var found []agent.ContentFileRef
	f := newRichFixture(t, func() []agent.ContentFileRef { return found })
	var paths []string
	reader := contracttest.Agent{Name: richAgent, Root: sessionsDir(f.home), Discovered: func() []agent.ContentFileRef { return found }, Lines: func(line agent.ContentLine) { paths = append(paths, line.Path) }}
	f.daemon.config.Registry = agent.NewRegistry(reader)
	f.shim.Registry = f.daemon.config.Registry
	path := f.sessionFile("d1")
	f.appendLines(t, "d1", header(f.stamp(), ""), textLine("x", f.stamp(), "first file"))
	found = []agent.ContentFileRef{{Path: path, NativeSessionID: "d1", Cwd: f.repo}}
	f.tickUntilSettled(t)
	os.Rename(path, path+".old")
	f.appendLines(t, "d1", header(f.stamp(), ""), textLine("y", f.stamp(), "replaced file"))
	f.tickUntilSettled(t)
	if len(paths) < 4 {
		t.Fatalf("parser saw %d lines", len(paths))
	}
	for _, seen := range paths {
		if seen != path {
			t.Fatalf("parser saw paths %q, want each %s", paths, path)
		}
	}
}

// A native record is JSON or NDJSON: in any other media type its refs are
// never resolved, so the device refuses it rather than ship a raw path.
func TestANativeRecordThatIsNotJSONIsInvalidOnTheDevice(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	native := contracttest.TextItem("native", "tool", "native_record", "text/plain", `{"edit":{"backplane_content_ref":{"part":"diff:`+f.repo+`/a.go"}}}`)
	f.appendLines(t, session, contracttest.Line{ID: "n1", At: f.stamp(), Items: []contracttest.Item{native}})
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 0 {
		t.Fatalf("declared %v", keys)
	}
	if rejected := richHealth(t, f).Rejected["invalid_on_device"]; rejected != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}

// An uploaded body declared truncated settles: the server's finalize
// answer carries the coverage reason the device declared.
func TestAnUploadedTruncatedBodySettles(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	item := contracttest.TextItem("text:0", "tool", "tool_output", "text/plain", strings.Repeat("x", 20<<10))
	item.SourceTruncated, item.OriginalBytes = true, 40<<10
	f.appendLines(t, session, contracttest.Line{ID: "t1", At: f.stamp(), Items: []contracttest.Item{item}})
	f.tickUntilSettled(t)
	declarations := f.server.Declarations()
	if len(declarations) != 1 || declarations[0]["coverage"] != "truncated" || declarations[0]["coverage_reason"] != "source_limit" {
		t.Fatalf("declared %v", declarations)
	}
}
