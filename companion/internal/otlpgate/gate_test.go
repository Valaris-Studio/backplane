// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package otlpgate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/plog/plogotlp"

	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

type fakeResolver struct {
	mu        sync.Mutex
	decisions map[string]Decision
	harnesses []string
}

func (f *fakeResolver) Resolve(_ context.Context, thread, harness string) Decision {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.harnesses = append(f.harnesses, harness)
	return f.decisions[thread]
}

func (f *fakeResolver) set(thread string, decision Decision) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.decisions[thread] = decision
}

type recordingForwarder struct {
	mu     sync.Mutex
	bodies map[Signal][]string
	fail   bool
}

func (r *recordingForwarder) Forward(_ context.Context, signal Signal, body []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail {
		return errors.New("collector down")
	}
	r.bodies[signal] = append(r.bodies[signal], string(body))
	return nil
}

func (r *recordingForwarder) all(signal Signal) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.bodies[signal], "\n")
}

var forward = Decision{Verdict: Forward, ContentLevel: privacy.Standard}

type fixture struct {
	gate      *Gate
	resolver  *fakeResolver
	forwarder *recordingForwarder
	now       time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{resolver: &fakeResolver{decisions: map[string]Decision{}}, forwarder: &recordingForwarder{bodies: map[Signal][]string{}}, now: time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)}
	f.gate = New(Config{
		Resolver:  f.resolver,
		Forwarder: f.forwarder,
		Harness: func(service string) string {
			return map[bool]string{true: "codex_desktop", false: "codex_cli"}[service == "codex-app-server"]
		},
		Now: func() time.Time { return f.now },
	})
	return f
}

func (f *fixture) post(t *testing.T, path, fixture, contentType string) int {
	t.Helper()
	body, err := os.ReadFile("testdata/" + fixture)
	if err != nil {
		t.Fatal(err)
	}
	if contentType == "application/x-protobuf" {
		request := plogotlp.NewExportRequest()
		if err := request.UnmarshalJSON(body); err != nil {
			t.Fatal(err)
		}
		body, _ = request.MarshalProto()
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", contentType)
	f.gate.ServeHTTP(recorder, request)
	return recorder.Code
}

func TestInScopeThreadsForwardAndOutOfScopeDrop(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	f.resolver.set("thread-child", forward)
	f.resolver.set("thread-out", Decision{Verdict: Drop})
	if code := f.post(t, "/v1/logs", "codex-logs.json", "application/json"); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	forwarded := f.forwarder.all(Logs)
	for _, want := range []string{"codex.conversation_starts", "refactor the SECRET module", "call_1"} {
		if !strings.Contains(forwarded, want) {
			t.Errorf("in-scope record missing: %s", want)
		}
	}
	if strings.Contains(forwarded, "OTHER_REPO_PROMPT") {
		t.Fatal("out-of-scope thread forwarded")
	}
	for _, identity := range []string{"person@example.com", "acct-123", "laptop.local"} {
		if strings.Contains(forwarded, identity) {
			t.Fatalf("account or host identity forwarded: %s", identity)
		}
	}
	stats := f.gate.Stats()
	if stats.Forwarded != 3 || stats.Dropped != 1 || stats.Held != 0 {
		t.Fatalf("stats: %+v", stats)
	}
	if f.resolver.harnesses[0] != "codex_cli" {
		t.Fatalf("harness from service.name: %v", f.resolver.harnesses)
	}
}

func TestUndecidedThreadIsHeldThenReleasedWhenTheHookDecisionArrives(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-child", Decision{Verdict: Drop})
	f.resolver.set("thread-out", Decision{Verdict: Drop})
	f.post(t, "/v1/logs", "codex-logs.json", "application/json")
	if f.forwarder.all(Logs) != "" || f.gate.Stats().Held != 2 {
		t.Fatalf("undecided records not held: %+v", f.gate.Stats())
	}
	f.now = f.now.Add(10 * time.Second)
	f.resolver.set("thread-root", forward)
	f.gate.Release(context.Background())
	if forwarded := f.forwarder.all(Logs); !strings.Contains(forwarded, "codex.conversation_starts") || !strings.Contains(forwarded, "refactor the SECRET module") {
		t.Fatalf("held records not released: %s", forwarded)
	}
	if stats := f.gate.Stats(); stats.Held != 0 || stats.Forwarded != 2 {
		t.Fatalf("stats after release: %+v", stats)
	}
}

func TestHeldRecordsExpireAfterTheTTL(t *testing.T) {
	f := newFixture(t)
	f.post(t, "/v1/logs", "codex-logs.json", "application/json")
	f.now = f.now.Add(HoldTTL + time.Second)
	f.resolver.set("thread-root", forward)
	f.gate.Release(context.Background())
	if f.forwarder.all(Logs) != "" {
		t.Fatal("expired records forwarded")
	}
	if stats := f.gate.Stats(); stats.Held != 0 || stats.Expired != 4 {
		t.Fatalf("stats: %+v", stats)
	}
}

func TestChildSpansResolveByTraceID(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	f.post(t, "/v1/traces", "codex-traces.json", "application/json")
	forwarded := f.forwarder.all(Traces)
	if !strings.Contains(forwarded, `"turn"`) || !strings.Contains(forwarded, "handle_responses") {
		t.Fatalf("turn span and its id-less child not forwarded: %s", forwarded)
	}
	if strings.Contains(forwarded, "mcp.tools.call") || f.gate.Stats().Held != 1 {
		t.Fatalf("span of an unknown trace must be held: %+v", f.gate.Stats())
	}
	if f.resolver.harnesses[0] != "codex_desktop" {
		t.Fatalf("desktop not detected: %v", f.resolver.harnesses)
	}
	f.post(t, "/v1/traces", "codex-traces-late.json", "application/json")
	f.gate.Release(context.Background())
	if forwarded := f.forwarder.all(Traces); !strings.Contains(forwarded, "mcp.tools.call") {
		t.Fatalf("held span not released once its trace's thread became known: %s", forwarded)
	}
}

func TestMetadataLevelDigestsContentBeforeForwarding(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", Decision{Verdict: Forward, ContentLevel: privacy.Metadata})
	f.resolver.set("thread-child", Decision{Verdict: Forward, ContentLevel: privacy.Metadata})
	f.resolver.set("thread-out", Decision{Verdict: Drop})
	f.post(t, "/v1/logs", "codex-logs.json", "application/json")
	forwarded := f.forwarder.all(Logs)
	if strings.Contains(forwarded, "SECRET") {
		t.Fatalf("metadata level forwarded content: %s", forwarded)
	}
	for _, kept := range []string{"[omitted ", "codex.user_prompt", "call_1", "exec_command", `"prompt_length"`} {
		if !strings.Contains(forwarded, kept) {
			t.Fatalf("metadata level lost %s: %s", kept, forwarded)
		}
	}
}

func TestProtobufRequestsAreAccepted(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	if code := f.post(t, "/v1/logs", "codex-logs.json", "application/x-protobuf"); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if !strings.Contains(f.forwarder.all(Logs), "codex.conversation_starts") {
		t.Fatal("protobuf request not forwarded")
	}
}

func TestForwardFailureAsksCodexToRetryAndHoldsNothing(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	f.forwarder.fail = true
	if code := f.post(t, "/v1/logs", "codex-logs.json", "application/json"); code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", code)
	}
	if f.gate.Stats().Held != 0 {
		t.Fatal("a retried request would duplicate held records")
	}
}

func TestMetricsAndUnknownPathsAreRejected(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{"/v1/metrics", "/"} {
		recorder := httptest.NewRecorder()
		f.gate.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}")))
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s: %d", path, recorder.Code)
		}
	}
	recorder := httptest.NewRecorder()
	f.gate.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader("not otlp")))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("malformed body: %d", recorder.Code)
	}
}

func TestHeldRecordsAreBounded(t *testing.T) {
	f := newFixture(t)
	f.gate.maxHeldItems = 3
	f.post(t, "/v1/logs", "codex-logs.json", "application/json")
	if stats := f.gate.Stats(); stats.Held != 3 || stats.Evicted != 1 {
		t.Fatalf("hold queue not bounded: %+v", stats)
	}
}

func TestReleaseKeepsHeldRecordsIntactWhenTheCollectorIsDown(t *testing.T) {
	f := newFixture(t)
	f.post(t, "/v1/logs", "codex-logs.json", "application/json")
	f.resolver.set("thread-root", forward)
	f.forwarder.fail = true
	f.gate.Release(context.Background())
	if held := f.gate.Stats().Held; held != 4 {
		t.Fatalf("records lost while the collector was down: held=%d", held)
	}
	f.forwarder.fail = false
	f.gate.Release(context.Background())
	if forwarded := f.forwarder.all(Logs); !strings.Contains(forwarded, "refactor the SECRET module") {
		t.Fatalf("retried records lost their payload: %q", forwarded)
	}
}

func TestBinaryAttributesAreNeverForwarded(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	image := strings.Repeat("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk", 40)
	body := `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"codex_exec"}}]},"scopeLogs":[{"scope":{},"logRecords":[{"body":{"stringValue":"data:image/png;base64,` + image + `"},"attributes":[` +
		`{"key":"event.name","value":{"stringValue":"codex.user_prompt"}},{"key":"conversation.id","value":{"stringValue":"thread-root"}},` +
		`{"key":"image","value":{"stringValue":"` + image + `"}},{"key":"attachment","value":{"stringValue":"data:image/jpeg;base64,` + image + `"}},{"key":"prompt","value":{"stringValue":"describe it"}}]}]}]}]}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	f.gate.ServeHTTP(recorder, request)
	forwarded := f.forwarder.all(Logs)
	if recorder.Code != http.StatusOK || strings.Contains(forwarded, image[:64]) {
		t.Fatalf("binary forwarded at the standard level (status %d)", recorder.Code)
	}
	if !strings.Contains(forwarded, "[binary omitted ") || !strings.Contains(forwarded, "describe it") {
		t.Fatalf("binary not replaced or ordinary content lost: %.400s", forwarded)
	}
}

func TestBackpressureRefusesTelemetryWhileTheBacklogIsFull(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	full := true
	f.gate.config.Backpressure = func() bool { return full }
	if code := f.post(t, "/v1/logs", "codex-logs.json", "application/json"); code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", code)
	}
	if f.forwarder.all(Logs) != "" || f.gate.Stats().Refused != 1 {
		t.Fatalf("backpressure not applied: %+v", f.gate.Stats())
	}
	full = false
	if code := f.post(t, "/v1/logs", "codex-logs.json", "application/json"); code != http.StatusOK {
		t.Fatalf("status after the backlog drained: %d", code)
	}
}

type blockingForwarder struct {
	entered chan struct{}
	release chan struct{}
}

func (b *blockingForwarder) Forward(context.Context, Signal, []byte) error {
	b.entered <- struct{}{}
	<-b.release
	return nil
}

func TestConcurrentRequestsBeyondTheLimitAreRefused(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	blocking := &blockingForwarder{entered: make(chan struct{}, maxInFlight), release: make(chan struct{})}
	f.gate.config.Forwarder = blocking
	body, _ := os.ReadFile("testdata/codex-logs.json")
	var group sync.WaitGroup
	for i := 0; i < maxInFlight; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			request := httptest.NewRequest(http.MethodPost, "/v1/logs", bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			f.gate.ServeHTTP(httptest.NewRecorder(), request)
		}()
	}
	for i := 0; i < maxInFlight; i++ {
		<-blocking.entered
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/logs", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	f.gate.ServeHTTP(recorder, request)
	close(blocking.release)
	group.Wait()
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("request beyond the in-flight limit: %d", recorder.Code)
	}
}

func TestMetadataDigestsEveryStringNotKnownToBeStructural(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", Decision{Verdict: Forward, ContentLevel: privacy.Metadata})
	attribute := func(key, value string) string {
		return `{"key":"` + key + `","value":{"stringValue":"` + value + `"}}`
	}
	body := `{"resourceLogs":[{"resource":{"attributes":[` + attribute("service.name", "codex_exec") + `]},"scopeLogs":[{"scope":{},"logRecords":[{"body":{"stringValue":"codex.tool_result"},"attributes":[` +
		strings.Join([]string{
			attribute("event.name", "codex.tool_result"), attribute("conversation.id", "thread-root"),
			attribute("tool_name", "exec_command"), attribute("call_id", "call_7"), attribute("model", "gpt-5"),
			attribute("duration_ms", "12"), attribute("success", "true"), attribute("codex.turn.token_usage.input_tokens", "5"),
			attribute("service_tier", "priority"), attribute("auth_mode", "Chatgpt"),
			attribute("future_field", "UNKNOWN_SECRET"), attribute("mcp_arguments_preview", "ANOTHER_SECRET"),
		}, ",") + `]}]}]}]}`
	request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	f.gate.ServeHTTP(httptest.NewRecorder(), request)
	forwarded := f.forwarder.all(Logs)
	for _, secret := range []string{"UNKNOWN_SECRET", "ANOTHER_SECRET"} {
		if strings.Contains(forwarded, secret) {
			t.Fatalf("unknown attribute kept at metadata: %s", secret)
		}
	}
	for _, kept := range []string{"exec_command", "call_7", "gpt-5", `"12"`, `"true"`, "thread-root", "codex.tool_result", "priority", "Chatgpt"} {
		if !strings.Contains(forwarded, kept) {
			t.Fatalf("structural value %s digested: %s", kept, forwarded)
		}
	}
}

func TestDataURLsInsidePromptsAreReplacedAtTheGate(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	image := strings.Repeat("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk", 10)
	body := `{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{},"logRecords":[{"attributes":[` +
		`{"key":"event.name","value":{"stringValue":"codex.user_prompt"}},{"key":"conversation.id","value":{"stringValue":"thread-root"}},` +
		`{"key":"prompt","value":{"stringValue":"see ![x](data:image/png;base64,` + image + `) now"}}]}]}]}]}`
	request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	f.gate.ServeHTTP(httptest.NewRecorder(), request)
	forwarded := f.forwarder.all(Logs)
	if strings.Contains(forwarded, image[:40]) || !strings.Contains(forwarded, "see ![x](") || !strings.Contains(forwarded, ") now") {
		t.Fatalf("embedded data URL not replaced in place: %.300s", forwarded)
	}
}

func TestRecordsResolvedThroughTheirTraceCarryTheirThread(t *testing.T) {
	f := newFixture(t)
	f.resolver.set("thread-root", forward)
	f.post(t, "/v1/traces", "codex-traces.json", "application/json")
	forwarded := f.forwarder.all(Traces)
	child := forwarded[strings.Index(forwarded, "handle_responses"):]
	if !strings.Contains(child, `"key":"thread.id","value":{"stringValue":"thread-root"}`) || !strings.Contains(child, `"key":"conversation.id","value":{"stringValue":"thread-root"}`) {
		t.Fatalf("child span not stamped with its thread: %s", forwarded)
	}
	if strings.Count(forwarded, `"key":"conversation.id"`) != 1 {
		t.Fatalf("spans carrying their own thread id must not be stamped: %s", forwarded)
	}
}

func TestToolOutputAttributesFollowTheContentLevel(t *testing.T) {
	long := strings.Repeat("CODEX_OUTPUT ", 3000)
	for _, level := range []privacy.ContentLevel{privacy.Metadata, privacy.Standard, privacy.Full} {
		t.Run(string(level), func(t *testing.T) {
			f := newFixture(t)
			f.resolver.set("thread-root", Decision{Verdict: Forward, ContentLevel: level})
			body := `{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{},"logRecords":[{"attributes":[` +
				`{"key":"event.name","value":{"stringValue":"codex.tool_result"}},{"key":"conversation.id","value":{"stringValue":"thread-root"}},` +
				`{"key":"arguments","value":{"stringValue":"{\"cmd\":\"make test\"}"}},{"key":"output","value":{"stringValue":"` + long + `"}}]}]}]}]}`
			request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			f.gate.ServeHTTP(httptest.NewRecorder(), request)
			forwarded := f.forwarder.all(Logs)
			kept, command := strings.Contains(forwarded, "CODEX_OUTPUT"), strings.Contains(forwarded, "make test")
			switch level {
			case privacy.Full:
				if !kept || !command || len(forwarded) > 4*privacy.MaxFullToolOutputBytes || !strings.Contains(forwarded, "[truncated]") {
					t.Fatalf("full: kept=%v command=%v %d bytes", kept, command, len(forwarded))
				}
			case privacy.Standard:
				if kept || !command || !strings.Contains(forwarded, `\"sha256\":`) {
					t.Fatalf("standard: kept=%v command=%v %.300s", kept, command, forwarded)
				}
			default:
				if kept || command {
					t.Fatalf("metadata: kept=%v command=%v", kept, command)
				}
			}
		})
	}
}

func TestHeldRecordsKeepToolOutputUntilTheirLevelIsKnown(t *testing.T) {
	f := newFixture(t)
	body := `{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{},"logRecords":[{"attributes":[` +
		`{"key":"event.name","value":{"stringValue":"codex.tool_result"}},{"key":"conversation.id","value":{"stringValue":"thread-late"}},` +
		`{"key":"output","value":{"stringValue":"HELD_OUTPUT"}}]}]}]}]}`
	request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	f.gate.ServeHTTP(httptest.NewRecorder(), request)
	f.resolver.set("thread-late", Decision{Verdict: Forward, ContentLevel: privacy.Full})
	f.gate.Release(context.Background())
	if !strings.Contains(f.forwarder.all(Logs), "HELD_OUTPUT") {
		t.Fatal("a held record released at the full level lost its tool output")
	}
}

func TestPatchArgumentsAreWithheldAtStandard(t *testing.T) {
	patch := `*** Begin Patch\n*** Update File: a.py\n+CODEX_PATCH_CONTENT\n*** End Patch`
	tool := func(name, arguments string) string {
		return `{"attributes":[{"key":"event.name","value":{"stringValue":"codex.tool_result"}},{"key":"conversation.id","value":{"stringValue":"thread-root"}},` +
			`{"key":"tool_name","value":{"stringValue":"` + name + `"}},{"key":"arguments","value":{"stringValue":"` + arguments + `"}}]}`
	}
	body := `{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{},"logRecords":[` + tool("apply_patch", patch) + `,` + tool("exec_command", `{\"cmd\":\"make test\"}`) + `]}]}]}`
	for _, level := range []privacy.ContentLevel{privacy.Standard, privacy.Full} {
		f := newFixture(t)
		f.resolver.set("thread-root", Decision{Verdict: Forward, ContentLevel: level})
		request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		f.gate.ServeHTTP(httptest.NewRecorder(), request)
		forwarded := f.forwarder.all(Logs)
		if !strings.Contains(forwarded, "make test") || !strings.Contains(forwarded, "apply_patch") {
			t.Fatalf("%s: commands and tool names are sent: %.400s", level, forwarded)
		}
		if sent := strings.Contains(forwarded, "CODEX_PATCH_CONTENT"); sent != (level == privacy.Full) {
			t.Fatalf("%s sent the patch: %v", level, sent)
		}
	}
}

func TestPatchesInsideCodexWrappersAreWithheldAtStandard(t *testing.T) {
	tool := func(name, arguments string) string {
		encoded, _ := json.Marshal(arguments)
		return `{"attributes":[{"key":"event.name","value":{"stringValue":"codex.tool_result"}},{"key":"conversation.id","value":{"stringValue":"thread-root"}},` +
			`{"key":"tool_name","value":{"stringValue":"` + name + `"}},{"key":"arguments","value":{"stringValue":` + string(encoded) + `}}]}`
	}
	exec := `text(await tools.apply_patch("*** Begin Patch\n*** Update File: a.txt\n+CODEX_WRAPPED_PATCH\n*** End Patch"));`
	shell := `{"cmd":"apply_patch <<'P'\n*** Begin Patch\n*** Add File: b.txt\n+CODEX_WRAPPED_PATCH\n*** End Patch\nP"}`
	body := `{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{},"logRecords":[` + tool("exec", exec) + `,` + tool("exec_command", shell) + `,` + tool("exec_command", `{"cmd":"make test"}`) + `]}]}]}`
	for _, level := range []privacy.ContentLevel{privacy.Standard, privacy.Full} {
		f := newFixture(t)
		f.resolver.set("thread-root", Decision{Verdict: Forward, ContentLevel: level})
		request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		f.gate.ServeHTTP(httptest.NewRecorder(), request)
		forwarded := f.forwarder.all(Logs)
		if !strings.Contains(forwarded, "make test") || !strings.Contains(forwarded, "tools.apply_patch(") {
			t.Fatalf("%s: commands are sent: %.600s", level, forwarded)
		}
		if sent := strings.Contains(forwarded, "CODEX_WRAPPED_PATCH"); sent != (level == privacy.Full) {
			t.Fatalf("%s sent the wrapped patch: %v", level, sent)
		}
	}
}

func TestFileContentInCodexCommandsIsWithheldAtStandard(t *testing.T) {
	command, _ := json.Marshal(map[string]string{"cmd": "cat > notes.md <<'EOF'\nCODEX_FILE_CONTENT\nEOF"})
	arguments, _ := json.Marshal(string(command))
	body := `{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{},"logRecords":[{"attributes":[` +
		`{"key":"event.name","value":{"stringValue":"codex.tool_result"}},{"key":"conversation.id","value":{"stringValue":"thread-root"}},` +
		`{"key":"tool_name","value":{"stringValue":"exec_command"}},{"key":"arguments","value":{"stringValue":` + string(arguments) + `}}]}]}]}]}`
	for _, level := range []privacy.ContentLevel{privacy.Standard, privacy.Full} {
		f := newFixture(t)
		f.resolver.set("thread-root", Decision{Verdict: Forward, ContentLevel: level})
		request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		f.gate.ServeHTTP(httptest.NewRecorder(), request)
		forwarded := f.forwarder.all(Logs)
		if !strings.Contains(forwarded, "notes.md") {
			t.Fatalf("%s: the command is sent: %.400s", level, forwarded)
		}
		if sent := strings.Contains(forwarded, "CODEX_FILE_CONTENT"); sent != (level == privacy.Full) {
			t.Fatalf("%s sent the file content: %v", level, sent)
		}
	}
}
