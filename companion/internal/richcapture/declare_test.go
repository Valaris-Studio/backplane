// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	repoRoot = "/home/me/code/app"
	homeDir  = "/home/me"
)

var observedAt = time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)

func declarer() Declarer {
	return Declarer{
		Harness: "pi_cli", NativeSessionID: "sess-1", Kind: "pi_session", Parser: "companion-contract-fixture/1",
		Place:  privacy.Place{Roots: []string{repoRoot}, Homes: []string{homeDir}},
		Limits: policy.DeviceRichLimits, ObservedAt: observedAt,
	}
}

func lineAt() agent.ContentRecord {
	return agent.ContentRecord{At: observedAt.Add(-time.Minute), SchemaVersion: "fixture/1"}
}

func text(value string) *string { return &value }

func declare(t *testing.T, d Declarer, item agent.ContentItem) Declared {
	t.Helper()
	declared := d.Declare(lineAt(), item, 128)
	if err := declared.Declaration.Validate(); err != nil {
		encoded, _ := json.Marshal(declared.Declaration)
		t.Fatalf("the device declared what the server refuses: %v\n%s", err, encoded)
	}
	return declared
}

// str and num read optional members, so a missing one fails an assertion
// instead of panicking the package.
func str(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func num(value *int64) int64 {
	if value == nil {
		return -1
	}
	return *value
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestAShortTextTravelsInlineUnderItsNativeKey(t *testing.T) {
	item := agent.ContentItem{NativeRef: "entry-1", Part: "text:0", Role: "user", Channel: "prompt", MediaType: "text/plain", TurnID: "turn-7", Text: text("Add a retry with backoff.")}
	declared := declare(t, declarer(), item)
	got := declared.Declaration
	if got.ContentKey != agent.ContentKey("pi_cli", "sess-1", "entry-1", "text:0") {
		t.Fatalf("content key %s", got.ContentKey)
	}
	if got.Delivery != uplink.DeliveryInline || got.InlineText == nil || str(got.InlineText) != "Add a retry with backoff." || declared.Body != nil {
		t.Fatalf("delivery %s inline %v body %d", got.Delivery, got.InlineText, len(declared.Body))
	}
	if num(got.ByteCount) != 25 || str(got.SHA256) != digest([]byte("Add a retry with backoff.")) || got.Coverage != "captured" {
		t.Fatalf("declaration %+v", got)
	}
	if got.Source.Order != 128 || str(got.Source.NativeRef) != "entry-1" || got.Source.Kind != "pi_session" || got.Source.SchemaVersion != "fixture/1" || str(got.TurnID) != "turn-7" {
		t.Fatalf("source %+v turn %v", got.Source, got.TurnID)
	}
	if !got.ObservedAt.Equal(observedAt) || !got.OccurredAt.Equal(lineAt().At) {
		t.Fatalf("times %v %v", got.OccurredAt, got.ObservedAt)
	}
}

// Over 16 KiB the body is uploaded whole: no preview cap shortens it.
func TestATextOver16KiBIsUploadedWhole(t *testing.T) {
	body := strings.Repeat("Zoë→日本語🙂 ", 6000)
	declared := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "output", Role: "tool", Channel: "tool_output", MediaType: "text/plain", Text: &body})
	got := declared.Declaration
	if got.Delivery != uplink.DeliveryUpload || got.InlineText != nil || !bytes.Equal(declared.Body, []byte(body)) || num(got.ByteCount) != int64(len(body)) || str(got.SHA256) != digest([]byte(body)) {
		t.Fatalf("delivery %s, %d of %d bytes", got.Delivery, len(declared.Body), len(body))
	}
}

func TestAnInlineLimitFromTheOfferIsHonoured(t *testing.T) {
	d := declarer()
	d.Limits.MaxInlineBodyBytes = 8
	if got := declare(t, d, agent.ContentItem{NativeRef: "e", Part: "text:0", Role: "user", Channel: "prompt", MediaType: "text/plain", Text: text("twelve bytes")}); got.Declaration.Delivery != uplink.DeliveryUpload {
		t.Fatalf("delivery %s", got.Declaration.Delivery)
	}
}

// The device's cut (body_limit) keeps a UTF-8 boundary and states the size
// it cut from.
func TestABodyOverTheTextLimitIsTruncatedAtTheBodyLimit(t *testing.T) {
	d := declarer()
	d.Limits.MaxTextBodyBytes = 1 << 20
	body := strings.Repeat("日", 600000)
	got := declare(t, d, agent.ContentItem{NativeRef: "e", Part: "output", Role: "tool", Channel: "tool_output", MediaType: "text/plain", Text: &body})
	declaration := got.Declaration
	if declaration.Coverage != "truncated" || str(declaration.CoverageReason) != "body_limit" || num(declaration.OriginalByteCount) != int64(len(body)) {
		t.Fatalf("declaration %+v", declaration)
	}
	if int64(len(got.Body)) > d.Limits.MaxTextBodyBytes || !utf8.Valid(got.Body) || num(declaration.ByteCount) != int64(len(got.Body)) {
		t.Fatalf("cut to %d bytes, valid UTF-8 %v", len(got.Body), utf8.Valid(got.Body))
	}
}

func TestSecretsAreRedactedAndCounted(t *testing.T) {
	got := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "command", Role: "tool", Channel: "tool_input", MediaType: "text/plain", Text: text("export API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123 && make")})
	declaration := got.Declaration
	if strings.Contains(str(declaration.InlineText), "sk-abcdefghijklmnopqrstuvwxyz0123") {
		t.Fatalf("a secret left the device: %s", str(declaration.InlineText))
	}
	if declaration.Coverage != "partially_redacted" || str(declaration.CoverageReason) != "secret_filter" || declaration.Redaction.Replacements == 0 || declaration.Redaction.FilterVersion != FilterVersion {
		t.Fatalf("declaration %+v", declaration)
	}
}

func TestLocalPathsInBodiesArePlacedInTextAndInJSON(t *testing.T) {
	plain := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "text:0", Role: "assistant", Channel: "reply", MediaType: "text/markdown", Text: text("Fixed " + repoRoot + "/src/main.go; see " + homeDir + "/notes.md")})
	if got := str(plain.Declaration.InlineText); got != "Fixed src/main.go; see ~/notes.md" {
		t.Fatalf("placed text %q", got)
	}
	native := `{"type":"toolResult","path":"` + repoRoot + `/a.go","nested":{"note":"in ` + repoRoot + `/b.go"}}`
	record := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "native", Role: "tool", Channel: "native_record", MediaType: "application/json", Text: &native})
	var decoded map[string]any
	if err := json.Unmarshal([]byte(str(record.Declaration.InlineText)), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["path"] != "a.go" || decoded["nested"].(map[string]any)["note"] != "in b.go" || strings.Contains(str(record.Declaration.InlineText), homeDir) {
		t.Fatalf("placed record %s", str(record.Declaration.InlineText))
	}
}

func TestATextTheAgentStoredCutIsTruncatedAtTheSource(t *testing.T) {
	got := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "output", Role: "tool", Channel: "command_output", MediaType: "text/plain", Text: text("tail of a long log"), SourceTruncated: true, OriginalBytes: 90000})
	if got.Declaration.Coverage != "truncated" || str(got.Declaration.CoverageReason) != "source_limit" || num(got.Declaration.OriginalByteCount) != 90000 {
		t.Fatalf("declaration %+v", got.Declaration)
	}
}

func TestAnItemWithoutABodyDeclaresWhy(t *testing.T) {
	got := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "raw", Role: "assistant", Channel: "reasoning", MediaType: "text/plain", Coverage: "source_unavailable", CoverageReason: "encrypted_at_source"})
	if got.Declaration.Delivery != uplink.DeliveryNone || got.Declaration.ByteCount != nil || got.Body != nil || str(got.Declaration.CoverageReason) != "encrypted_at_source" {
		t.Fatalf("declaration %+v", got.Declaration)
	}
}

func TestAnInstructionOutsideTheRootKeepsOnlyItsPlacedPath(t *testing.T) {
	inside := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "instruction:0", Role: "system", Channel: "instruction", MediaType: "text/markdown", DisplayPath: repoRoot + "/AGENTS.md", Text: text("# Rules")})
	if inside.Declaration.Coverage != "captured" || str(inside.Declaration.DisplayPath) != "AGENTS.md" {
		t.Fatalf("inside the root: %+v", inside.Declaration)
	}
	home := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "instruction:1", Role: "system", Channel: "instruction", MediaType: "text/markdown", DisplayPath: homeDir + "/.claude/CLAUDE.md", Text: text("# Mine")})
	if home.Declaration.Coverage != "withheld_by_policy" || str(home.Declaration.CoverageReason) != "outside_mapped_root" || str(home.Declaration.DisplayPath) != "~/.claude/CLAUDE.md" || home.Declaration.Delivery != uplink.DeliveryNone {
		t.Fatalf("under the home: %+v", home.Declaration)
	}
	elsewhere := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "instruction:2", Role: "system", Channel: "instruction", MediaType: "text/markdown", DisplayPath: "/etc/agent/rules.md", Text: text("# Theirs")})
	if elsewhere.Declaration.Coverage != "withheld_by_policy" || elsewhere.Declaration.DisplayPath != nil {
		t.Fatalf("outside every root: %+v", elsewhere.Declaration)
	}
}

func swatch(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "codex-cli"), "swatch.png"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestAnEmbeddedImageIsSniffedAndUploadedNeverInline(t *testing.T) {
	image := swatch(t)
	got := declare(t, declarer(), agent.ContentItem{NativeRef: "msg_1", Part: "image:0", Role: "user", Channel: "attachment", MediaType: "image/jpeg", Data: image})
	if got.Declaration.MediaType != "image/png" || got.Declaration.Delivery != uplink.DeliveryUpload || !bytes.Equal(got.Body, image) || str(got.Declaration.SHA256) != digest(image) {
		t.Fatalf("declaration %+v", got.Declaration)
	}
}

func TestAnSVGDeclaredAsPNGIsWithheld(t *testing.T) {
	svg := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	got := declare(t, declarer(), agent.ContentItem{NativeRef: "msg_1", Part: "image:0", Role: "user", Channel: "attachment", MediaType: "image/png", Data: svg})
	if got.Declaration.Coverage != "withheld_by_policy" || str(got.Declaration.CoverageReason) != "media_type_not_permitted" || got.Body != nil {
		t.Fatalf("declaration %+v", got.Declaration)
	}
}

func TestAnOversizedAttachmentIsWithheldWithItsSize(t *testing.T) {
	d := declarer()
	d.Limits.MaxAttachmentBytes = 64
	image := swatch(t)
	got := declare(t, d, agent.ContentItem{NativeRef: "msg_1", Part: "image:0", Role: "user", Channel: "attachment", MediaType: "image/png", Data: image})
	if got.Declaration.Coverage != "withheld_by_policy" || str(got.Declaration.CoverageReason) != "attachment_oversized" || num(got.Declaration.OriginalByteCount) != int64(len(image)) || got.Body != nil {
		t.Fatalf("declaration %+v", got.Declaration)
	}
}

// A harness body store is read only when it proves to be the record's body;
// otherwise the record's own cut copy is declared truncated at the source.
func TestAHarnessStoreBodyIsUsedOnlyWhenItMatches(t *testing.T) {
	within := t.TempDir()
	stored := strings.Repeat("B", 70000) + "\n"
	path := filepath.Join(within, "tool-results", "b1.txt")
	os.MkdirAll(filepath.Dir(path), 0o700)
	os.WriteFile(path, []byte(stored), 0o600)
	item := func(head string) agent.ContentItem {
		return agent.ContentItem{NativeRef: "e", Part: "output", Role: "tool", Channel: "tool_output", MediaType: "text/plain", Text: text("BBBB preview"), SourceTruncated: true, OriginalBytes: int64(len(stored)),
			Store: &agent.BodyStore{Path: path, Kind: "harness_session_store", Within: within, Matches: func(body []byte) bool { return strings.HasPrefix(string(body), head) }}}
	}
	matched := declare(t, declarer(), item("BBBB"))
	if matched.Declaration.Coverage != "captured" || matched.Declaration.Source.BodyFrom != "harness_session_store" || !bytes.Equal(matched.Body, []byte(stored)) {
		t.Fatalf("matching store: %+v", matched.Declaration)
	}
	mismatched := declare(t, declarer(), item("CCCC"))
	if mismatched.Declaration.Coverage != "truncated" || str(mismatched.Declaration.CoverageReason) != "source_limit" || mismatched.Declaration.Source.BodyFrom != "" || str(mismatched.Declaration.InlineText) != "BBBB preview" {
		t.Fatalf("mismatching store: %+v", mismatched.Declaration)
	}
}

func TestALineTooLargeToParseIsDeclaredAsSuch(t *testing.T) {
	got := declarer().TooLarge(4096, observedAt)
	if err := got.Declaration.Validate(); err != nil {
		t.Fatal(err)
	}
	if got.Declaration.Coverage != "collection_failed" || str(got.Declaration.CoverageReason) != "record_too_large" || got.Declaration.Source.Order != 4096 || got.Body != nil {
		t.Fatalf("declaration %+v", got.Declaration)
	}
}

func TestABodyTheSpoolCannotHoldIsDeclaredWithoutIt(t *testing.T) {
	body := strings.Repeat("x", 40<<10)
	full := WithoutBody(declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "output", Role: "tool", Channel: "tool_output", MediaType: "text/plain", Text: &body}), "collection_failed", "spool_full")
	if err := full.Declaration.Validate(); err != nil {
		t.Fatal(err)
	}
	if full.Declaration.Delivery != uplink.DeliveryNone || full.Body != nil || str(full.Declaration.CoverageReason) != "spool_full" || num(full.Declaration.OriginalByteCount) != int64(len(body)) {
		t.Fatalf("declaration %+v", full.Declaration)
	}
}

// diff: and file: parts name a placed path, so the key never hashes a
// local path.
func TestAPathPartIsKeyedByItsPlacedPath(t *testing.T) {
	got := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "diff:" + repoRoot + "/src/a.go", Role: "tool", Channel: "diff", MediaType: "text/x-diff", Text: text("@@ -1 +1 @@")})
	if got.Declaration.ContentKey != agent.ContentKey("pi_cli", "sess-1", "e", "diff:src/a.go") {
		t.Fatalf("key %s is not the placed path's", got.Declaration.ContentKey)
	}
}

// A restated context (a compaction summary, a re-attached file) is captured
// only in a session wholly inside its generation.
func TestARestatedContextIsWithheldWhenItsSessionBeganBeforeAdmission(t *testing.T) {
	summary := agent.ContentItem{NativeRef: "e", Part: "summary", Role: "assistant", Channel: "summary", MediaType: "text/markdown", Text: text("so far we..."), RestatesContext: true}
	d := declarer()
	d.AdmittedFrom = observedAt.Add(-time.Hour)
	for name, began := range map[string]time.Time{"began before": d.AdmittedFrom.Add(-time.Minute), "unknown start": {}} {
		d.SessionBegan = began
		if got := declare(t, d, summary); got.Declaration.Coverage != "withheld_by_policy" || str(got.Declaration.CoverageReason) != "pre_admission_context" || got.Body != nil {
			t.Fatalf("%s: %+v", name, got.Declaration)
		}
	}
	d.SessionBegan = d.AdmittedFrom.Add(time.Minute)
	if got := declare(t, d, summary); got.Declaration.Coverage != "captured" {
		t.Fatalf("a session inside its generation: %+v", got.Declaration)
	}
}

func TestADisplayPathTheExcludeGlobsMatchIsWithheld(t *testing.T) {
	d := declarer()
	d.Excluded = func(path string) bool { return strings.HasPrefix(path, "vendor/") }
	got := declare(t, d, agent.ContentItem{NativeRef: "e", Part: "file:0", Role: "user", Channel: "attachment", MediaType: "text/markdown", DisplayPath: repoRoot + "/vendor/notes.md", Data: []byte("# notes")})
	if got.Declaration.Coverage != "withheld_by_policy" || str(got.Declaration.CoverageReason) != "excluded_path" || str(got.Declaration.DisplayPath) != "vendor/notes.md" || got.Body != nil {
		t.Fatalf("declaration %+v", got.Declaration)
	}
}

// Amendment 17: a body the agent stored cut is never declared captured,
// even when the agent does not say how much it cut.
func TestATextTheAgentCutWithoutSayingHowMuchIsStillTruncated(t *testing.T) {
	got := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "output", Role: "tool", Channel: "command_output", MediaType: "text/plain", Text: text("the kept tail"), SourceTruncated: true})
	if got.Declaration.Coverage != "truncated" || str(got.Declaration.CoverageReason) != "source_limit" || got.Declaration.OriginalByteCount != nil {
		t.Fatalf("declaration %+v", got.Declaration)
	}
}

// A diff: or file: part names its path as surely as a display path does:
// the exclude globs and the mapped root apply to it too.
func TestAPathPartIsExcludedAndBoundedLikeADisplayPath(t *testing.T) {
	d := declarer()
	d.Excluded = func(path string) bool { return path == ".env" }
	secret := declare(t, d, agent.ContentItem{NativeRef: "e", Part: "diff:" + repoRoot + "/.env", Role: "tool", Channel: "diff", MediaType: "text/x-diff", Text: text("+TOKEN=1")})
	if secret.Declaration.Coverage != "withheld_by_policy" || str(secret.Declaration.CoverageReason) != "excluded_path" || secret.Body != nil {
		t.Fatalf("excluded diff: %+v", secret.Declaration)
	}
	outside := declare(t, d, agent.ContentItem{NativeRef: "e", Part: "file:/etc/hosts", Role: "tool", Channel: "file_content", MediaType: "text/plain", Text: text("127.0.0.1 localhost")})
	if outside.Declaration.Coverage != "withheld_by_policy" || str(outside.Declaration.CoverageReason) != "outside_mapped_root" || outside.Body != nil {
		t.Fatalf("file outside the root: %+v", outside.Declaration)
	}
}

// nativeWithRef is a native record whose leaf names a path part, as a
// parser writes it (amendment 22).
func nativeWithRef(part string) agent.ContentItem {
	record := `{"type":"toolResult","edit":{"backplane_content_ref":{"part":` + strconvQuote(part) + `}},"text":{"backplane_content_ref":"kept-as-is"}}`
	return agent.ContentItem{NativeRef: "e", Part: "native", Role: "tool", Channel: "native_record", MediaType: "application/json", Text: &record}
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func resolvedRefs(t *testing.T, declared Declared) map[string]any {
	t.Helper()
	var record map[string]any
	if err := json.Unmarshal([]byte(str(declared.Declaration.InlineText)), &record); err != nil {
		t.Fatalf("native record %q: %v", str(declared.Declaration.InlineText), err)
	}
	return record
}

// A path part's ref resolves to the key its own declaration gets; a
// non-path ref is left as the parser wrote it.
func TestANativeRecordsPathRefResolvesToItsPartsKey(t *testing.T) {
	d := declarer()
	diff := declare(t, d, agent.ContentItem{NativeRef: "e", Part: "diff:" + repoRoot + "/src/a.go", Role: "tool", Channel: "diff", MediaType: "text/x-diff", Text: text("@@")})
	record := resolvedRefs(t, declare(t, d, nativeWithRef("diff:"+repoRoot+"/src/a.go")))
	if ref := record["edit"].(map[string]any)["backplane_content_ref"]; ref != diff.Declaration.ContentKey {
		t.Fatalf("ref %v, the diff's key %s", ref, diff.Declaration.ContentKey)
	}
	if ref := record["text"].(map[string]any)["backplane_content_ref"]; ref != "kept-as-is" {
		t.Fatalf("a non-path ref became %v", ref)
	}
}

// An excluded or outside-root part's ref resolves to the key of its
// withheld declaration, and its raw path never reaches the record.
func TestAWithheldPathPartsRefMatchesItsDeclarationAndHidesThePath(t *testing.T) {
	d := declarer()
	d.Excluded = func(path string) bool { return path == ".env" }
	for _, part := range []string{"diff:" + repoRoot + "/.env", "file:/etc/hosts"} {
		withheld := declare(t, d, agent.ContentItem{NativeRef: "e", Part: part, Role: "tool", Channel: "diff", MediaType: "text/x-diff", Text: text("+x")})
		if withheld.Declaration.Coverage != "withheld_by_policy" {
			t.Fatalf("%s: setup coverage %s", part, withheld.Declaration.Coverage)
		}
		native := declare(t, d, nativeWithRef(part))
		raw := strings.TrimPrefix(strings.TrimPrefix(part, "diff:"), "file:")
		if strings.Contains(str(native.Declaration.InlineText), raw) {
			t.Fatalf("%s: the raw path reached the record: %s", part, str(native.Declaration.InlineText))
		}
		if ref := resolvedRefs(t, native)["edit"].(map[string]any)["backplane_content_ref"]; ref != withheld.Declaration.ContentKey {
			t.Fatalf("%s: ref %v, the declaration's key %s", part, ref, withheld.Declaration.ContentKey)
		}
	}
}

// The ref of a path spelled in another case on a case-folding root
// resolves as placement folds it (amendment 9).
func TestAPathRefFoldsAsPlacementDoes(t *testing.T) {
	d := declarer()
	root := "/" + "Users/me/Code/App"
	d.Place.Roots = []string{root}
	folded := "diff:" + "/" + "users/me/code/app/a.go"
	canonical := declare(t, d, agent.ContentItem{NativeRef: "e", Part: "diff:" + root + "/a.go", Role: "tool", Channel: "diff", MediaType: "text/x-diff", Text: text("@@")})
	if ref := resolvedRefs(t, declare(t, d, nativeWithRef(folded)))["edit"].(map[string]any)["backplane_content_ref"]; ref != canonical.Declaration.ContentKey {
		t.Fatalf("ref %v, the canonical spelling's key %s", ref, canonical.Declaration.ContentKey)
	}
}

func nativeRecord(body string, mediaType string) agent.ContentItem {
	return agent.ContentItem{NativeRef: "e", Part: "native", Role: "tool", Channel: "native_record", MediaType: mediaType, Text: &body}
}

// A well-formed ref resolves by the key formula whether or not this pass
// declared the part, path parts placed first; non-path parts as written.
func TestAWellFormedRefResolvesWhetherOrNotThePartWasDeclared(t *testing.T) {
	d := declarer()
	got := declare(t, d, nativeRecord(`{"a":{"backplane_content_ref":{"part":"text:0"}},"b":[{"backplane_content_ref":{"part":"file:`+repoRoot+`/x.go"}}]}`, "application/json"))
	record := resolvedRefs(t, got)
	if ref := record["a"].(map[string]any)["backplane_content_ref"]; ref != d.Key(agent.ContentItem{NativeRef: "e", Part: "text:0"}) {
		t.Fatalf("text part ref %v", ref)
	}
	if ref := record["b"].([]any)[0].(map[string]any)["backplane_content_ref"]; ref != d.Key(agent.ContentItem{NativeRef: "e", Part: "file:x.go"}) {
		t.Fatalf("path ref nested in an array %v", ref)
	}
}

// A malformed object ref is never written as given (it may carry a raw
// path): its leaf becomes null, and it is counted.
func TestAMalformedRefBecomesNullAndIsCounted(t *testing.T) {
	malformed := []string{
		`{"backplane_content_ref":{"part":5}}`,
		`{"backplane_content_ref":{"part":"diff:` + repoRoot + `/a.go","extra":1}}`,
		`{"backplane_content_ref":{"part":"` + repoRoot + `/a.go"}}`,
		`{"backplane_content_ref":{"part":"diff:` + repoRoot + `/a.go"},"raw":"` + repoRoot + `/a.go"}`,
	}
	got := declare(t, declarer(), nativeRecord(`{"leaves":[`+strings.Join(malformed, ",")+`]}`, "application/json"))
	leaves := resolvedRefs(t, got)["leaves"].([]any)
	for index, leaf := range leaves {
		if leaf != nil {
			t.Errorf("malformed ref %d written as %v", index, leaf)
		}
	}
	if got.MalformedRefs != len(malformed) || strings.Contains(str(got.Declaration.InlineText), "a.go") {
		t.Fatalf("counted %d malformed refs; record %s", got.MalformedRefs, str(got.Declaration.InlineText))
	}
}

// Each line of an NDJSON native body resolves its refs.
func TestRefsResolveInEachLineOfAnNDJSONNativeBody(t *testing.T) {
	d := declarer()
	got := declare(t, d, nativeRecord(`{"x":1}`+"\n"+`{"edit":{"backplane_content_ref":{"part":"diff:`+repoRoot+`/a.go"}}}`, "application/x-ndjson"))
	lines := strings.Split(str(got.Declaration.InlineText), "\n")
	var second map[string]any
	json.Unmarshal([]byte(lines[1]), &second)
	if ref := second["edit"].(map[string]any)["backplane_content_ref"]; ref != d.Key(agent.ContentItem{NativeRef: "e", Part: "diff:a.go"}) {
		t.Fatalf("NDJSON ref %v in %q", ref, lines[1])
	}
}

// In a native record large enough for the literal skip, where the root's
// literal appears only inside a ref, the ref still resolves.
func TestARefResolvesInALargeNativeRecord(t *testing.T) {
	d := declarer()
	body := `{"pad":"` + strings.Repeat("x", 70<<10) + `","edit":{"backplane_content_ref":{"part":"diff:` + repoRoot + `/a.go"}}}`
	got := declare(t, d, nativeRecord(body, "application/json"))
	var record map[string]any
	json.Unmarshal(got.Body, &record)
	if ref := record["edit"].(map[string]any)["backplane_content_ref"]; ref != d.Key(agent.ContentItem{NativeRef: "e", Part: "diff:a.go"}) || strings.Contains(string(got.Body), repoRoot) {
		t.Fatalf("large record ref %v", ref)
	}
}

// Refs resolve before the secret filter and placement see the record: a
// raw path the filter would rewrite still resolves to its part's key, and
// is never written out.
func TestARefResolvesBeforeTheRecordIsRedactedOrPlaced(t *testing.T) {
	d := declarer()
	part := "diff:" + repoRoot + "/" + "tok" + "en=abcdefgh12345678/a.go"
	diff := declare(t, d, agent.ContentItem{NativeRef: "e", Part: part, Role: "tool", Channel: "diff", MediaType: "text/x-diff", Text: text("@@")})
	native := declare(t, d, nativeWithRef(part))
	if ref := resolvedRefs(t, native)["edit"].(map[string]any)["backplane_content_ref"]; ref != diff.Declaration.ContentKey {
		t.Fatalf("ref %v, the part's key %s", ref, diff.Declaration.ContentKey)
	}
	if strings.Contains(str(native.Declaration.InlineText), "abcdefgh") {
		t.Fatalf("the raw path reached the record: %s", str(native.Declaration.InlineText))
	}
}

// Amendment 36: a relative path part (cwd unknown) cannot be placed, so it
// is withheld as outside the mapped root, and its ref resolves to that
// withheld declaration's key.
func TestARelativePathPartIsWithheldAndItsRefMatches(t *testing.T) {
	d := declarer()
	withheld := declare(t, d, agent.ContentItem{NativeRef: "e", Part: "diff:calc.py", Role: "tool", Channel: "diff", MediaType: "text/x-diff", Text: text("+x")})
	if withheld.Declaration.Coverage != "withheld_by_policy" || str(withheld.Declaration.CoverageReason) != "outside_mapped_root" {
		t.Fatalf("coverage %s/%s", withheld.Declaration.Coverage, str(withheld.Declaration.CoverageReason))
	}
	if withheld.Declaration.DisplayPath != nil || withheld.Body != nil || withheld.Declaration.InlineText != nil {
		t.Fatalf("a withheld relative part kept a path or body: %+v", withheld.Declaration)
	}
	native := declare(t, d, nativeWithRef("diff:calc.py"))
	if ref := resolvedRefs(t, native)["edit"].(map[string]any)["backplane_content_ref"]; ref != withheld.Declaration.ContentKey {
		t.Fatalf("ref %v, the withheld declaration's key %s", ref, withheld.Declaration.ContentKey)
	}
}

// A parser's relative display path is as unplaceable as a relative part.
func TestARelativeDisplayPathIsWithheld(t *testing.T) {
	declared := declare(t, declarer(), agent.ContentItem{NativeRef: "e", Part: "text:0", Role: "tool", Channel: "file_content", MediaType: "text/plain", DisplayPath: "src/calc.py", Text: text("x")})
	if declared.Declaration.Coverage != "withheld_by_policy" || str(declared.Declaration.CoverageReason) != "outside_mapped_root" || declared.Declaration.DisplayPath != nil || declared.Body != nil {
		t.Fatalf("declared %+v", declared.Declaration)
	}
}
