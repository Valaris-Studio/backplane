// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

const invocationProvider = "operator-exact-provider-58"
const invocationModel = "operator-current-model-58"
const invocationSource = "NOTE — Approved evidence:\nApproved é🧪\n```go\nfmt.Println(\"<literal>&{{.ExecutionID}}\")\n```\n"
const invocationTemplate = "Current 🧪 {{ index .Card \"title\" }}\n{{ index .Card \"description\" }}\n{{ index (index .Card \"extra\") \"flag\" }}|{{ index .Card \"position\" }}|{{if eq (index .Card \"due_date\") nil}}null{{end}}\n{{.ExecutionID}}\n{{ index .ContextSources \"approved\" }}{{if index .ContextSources \"stale_only\"}}STALE MERGE{{end}}"
const invocationDescription = `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"é🧪"}]}]}`
const invocationSchema = `{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}`

func invocationDigest(value string) string {
	h := sha256.Sum256([]byte(value))
	return hex.EncodeToString(h[:])
}

type invocationHTTP struct {
	base            *runnerDispatchHTTP
	mu              sync.Mutex
	snapshot        map[string]any
	queries         []url.Values
	refreshHeaders  []string
	prepareHeaders  []string
	payloads        []map[string]any
	events          []string
	responses       []string
	ackMutate       func(map[string]any)
	ackHeader       string
	snapshotStatus  int
	onRefresh       func()
	beforeAck       func()
	legacyAfterBind bool
}

func newInvocationHTTP() *invocationHTTP {
	base := newRunnerDispatchHTTP()
	base.assignment["context"].(map[string]string)["stale_only"] = "STALE ASSIGNMENT SOURCE"
	return &invocationHTTP{base: base, snapshot: invocationSnapshot(), ackHeader: "1", snapshotStatus: 200}
}

func invocationSnapshot() map[string]any {
	return map[string]any{
		"protocol_version": 1, "mode": "required", "execution_id": runnerDispatchExecution,
		"context_binding":  runnerDispatchStart()["context_binding"],
		"invocation":       map[string]any{"kind": "stage", "step_name": nil, "prompt_slot": "main"},
		"context":          map[string]string{"approved": invocationSource},
		"context_revision": strings.Repeat("d", 64), "dispatch_revision": strings.Repeat("e", 64),
		"context_manifest": map[string]any{"schema_version": 1, "renderer_version": "context-v1", "sources": []any{
			map[string]any{"source_index": 0, "kind": "pinned_notes", "alias": "approved", "filter": map[string]any{}, "coverage": "source_only", "rendered_sha256": invocationDigest(invocationSource), "rendered_bytes": len(invocationSource), "records": []any{}},
		}},
		"card": map[string]any{"id": runnerDispatchCard, "board_id": runnerDispatchBoard, "title": "Fresh card é", "description": invocationDescription, "position": 1041.25, "due_date": nil, "extra": map[string]any{"flag": true}},
		"dispatch": map[string]any{
			"provider": invocationProvider, "model": invocationModel, "tier": "", "prompt_slug": "operator-current-prompt-58",
			"prompt_target":  map[string]any{"role": runnerDispatchRole, "stage": "continue_project"},
			"input_template": invocationTemplate, "system_template": "", "tool_policy": map[string]any{"deny": []string{"Bash(never-current:*)"}},
			"tools": []string{"Read", "mcp__operator__inspect"}, "output_schema": invocationSchema,
			"flags":                   map[string]any{"post_process_kind": "produces_note", "approval_enabled": false, "inject_directives": false, "use_minimal_prompt_when_unauthored": false},
			"required_source_indices": []int{0},
		},
	}
}

func (f *invocationHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/context-dispatch-contract") && f.legacyAfterBind {
		f.base.mu.Lock()
		if f.base.startCalls > 0 {
			f.base.contract["mode"] = "legacy"
			f.base.contract["minimum_version"] = 0
		}
		f.base.mu.Unlock()
	}
	switch {
	case strings.HasSuffix(r.URL.Path, "/dispatch-context"):
		f.mu.Lock()
		defer f.mu.Unlock()
		f.queries = append(f.queries, r.URL.Query())
		f.refreshHeaders = append(f.refreshHeaders, r.Header.Get(runnerDispatchHeader))
		f.events = append(f.events, "refresh")
		if f.onRefresh != nil {
			f.onRefresh()
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set(runnerDispatchHeader, "1")
		w.WriteHeader(f.snapshotStatus)
		_ = json.NewEncoder(w).Encode(f.snapshot)
	case strings.HasSuffix(r.URL.Path, "/dispatch-preparations"):
		f.mu.Lock()
		defer f.mu.Unlock()
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		f.payloads = append(f.payloads, payload)
		f.prepareHeaders = append(f.prepareHeaders, r.Header.Get(runnerDispatchHeader))
		f.events = append(f.events, "prepare")
		step := len(f.payloads) - 1
		if step < len(f.responses) {
			switch f.responses[step] {
			case "close":
				connection, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					_ = connection.Close()
				}
				return
			case "502", "403", "422":
				status := map[string]int{"502": 502, "403": 403, "422": 422}[f.responses[step]]
				http.Error(w, "synthetic refusal", status)
				return
			case "context_changed", "dispatch_changed", "other_conflict":
				code := map[string]string{"context_changed": "execution_context_changed", "dispatch_changed": "execution_dispatch_changed", "other_conflict": "unrelated_conflict"}[f.responses[step]]
				f.snapshot["context_revision"] = strings.Repeat("f", 64)
				f.snapshot["dispatch_revision"] = strings.Repeat("b", 64)
				f.snapshot["card"].(map[string]any)["title"] = "Changed after conflict é"
				if code == "execution_context_changed" {
					changed := invocationSource + "Changed approved source 🧪\n"
					f.snapshot["context"].(map[string]string)["approved"] = changed
					source := f.snapshot["context_manifest"].(map[string]any)["sources"].([]any)[0].(map[string]any)
					source["rendered_bytes"], source["rendered_sha256"] = len(changed), invocationDigest(changed)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(409)
				_ = json.NewEncoder(w).Encode(map[string]any{"error_code": code, "detail": "Refresh this invocation"})
				return
			}
		}
		ack := invocationAck(payload)
		if f.ackMutate != nil {
			f.ackMutate(ack)
		}
		if f.beforeAck != nil {
			f.beforeAck()
		}
		w.Header().Set("Content-Type", "application/json")
		if f.ackHeader != "" {
			w.Header().Set(runnerDispatchHeader, f.ackHeader)
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(ack)
	case strings.HasSuffix(r.URL.Path, "/definitions") && r.Method == http.MethodGet:
		_ = json.NewEncoder(w).Encode(map[string]any{"content": map[string]any{"coding_standards": "STALE ANCILLARY DIRECTIVES"}})
	case strings.HasSuffix(r.URL.Path, "/notes") && r.Method == http.MethodGet:
		_ = json.NewEncoder(w).Encode([]any{})
	case r.Method == http.MethodPatch && r.URL.Path == "/api/agents/"+runnerDispatchAgent+"/executions/"+runnerDispatchExecution:
		_ = json.NewEncoder(w).Encode(map[string]any{"id": runnerDispatchExecution})
	default:
		f.base.ServeHTTP(w, r)
	}
}

func invocationAck(payload map[string]any) map[string]any {
	input, _ := payload["input_prompt"].(string)
	system, _ := payload["system_prompt"].(string)
	return map[string]any{
		"protocol_version": 1, "acknowledged": "prepared", "receipt_id": "00000000-0000-4000-8000-000000000158",
		"execution_id": runnerDispatchExecution, "client_request_id": payload["client_request_id"], "ordinal": 1,
		"context_revision": payload["context_revision"], "dispatch_revision": payload["dispatch_revision"],
		"prompt_sha256": invocationDigest(input), "prompt_bytes": len(input),
		"system_prompt_sha256": invocationDigest(system), "system_prompt_bytes": len(system),
		"inclusion_verification": "required_blocks_exact", "use_verification": "not_verified",
	}
}

type invocationProviderRecorder struct {
	*llm.MockProvider
	fixture *invocationHTTP
}

func (p *invocationProviderRecorder) Execute(ctx context.Context, prompt string, opts llm.Options) (*llm.Result, error) {
	p.fixture.mu.Lock()
	p.fixture.events = append(p.fixture.events, "provider:"+p.Name())
	p.fixture.mu.Unlock()
	return p.MockProvider.Execute(ctx, prompt, opts)
}

type invocationCase struct {
	http      *invocationHTTP
	loop      *Loop
	strategy  *DataDrivenStrategy
	card      *discoverResult
	execution string
	current   *invocationProviderRecorder
	stale     *invocationProviderRecorder
	repoDir   string
}

func newInvocationCase(t *testing.T, f *invocationHTTP, stage string) *invocationCase {
	t.Helper()
	server := httptest.NewServer(f)
	t.Cleanup(server.Close)
	cfg := &config.Config{Valaris: config.ValarisConfig{WorkspaceSlug: "workspace", BoardIDs: []string{runnerDispatchBoard}}, LLM: config.LLMConfig{Provider: "operator-provider-47", Model: "stale-yaml-model"}}
	client := valaris.NewClient(server.URL, "synthetic-key")
	client.Agent = &valaris.AgentConfig{ID: runnerDispatchAgent, AllowedWorkspaces: []string{runnerDispatchWorkspace}, IsActive: true}
	strategy := NewDataDrivenStrategy(valaris.StageConfig{
		Role: runnerDispatchRole, Discover: valaris.DiscoverDef{Strategy: "column_scan", ColumnType: "todo"},
		Claim: valaris.ClaimDef{ParticipantRole: "hero", PipelineRole: runnerDispatchRole, ExecutionAction: "continue_project"}, Git: valaris.GitDef{Action: "none"},
		LLM: valaris.LLMDef{Enabled: true, Stage: stage, PostProcessKind: "produces_note", Provider: "operator-provider-47", Model: "stale-stage-model"},
	}, nil)
	provider := func(name string) *invocationProviderRecorder {
		mock := llm.NewMockProvider(`{"status":"done","decision":"approve","summary":"Synthetic result"}`)
		mock.NameOverride = name
		mock.Caps.PromptChannels = llm.PromptChannels{Version: 1, FreshInput: true, FreshSystem: true, ResumeInput: true, ResumeSystem: true}
		return &invocationProviderRecorder{MockProvider: mock, fixture: f}
	}
	current, stale := provider(invocationProvider), provider("operator-provider-47")
	loop := &Loop{cfg: cfg, client: client, provider: stale, providers: map[string]llm.Provider{current.Name(): current, stale.Name(): stale}, strategy: strategy,
		promptCache: map[string]string{runnerDispatchRole + ":" + stage: "STALE CACHED TEMPLATE {{ index .ContextSources \"approved\" }}"}, sessions: NewSessionStore()}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	card, err := strategy.discoverWithConfig(ctx, loop)
	if err != nil || card == nil {
		t.Fatalf("real negotiated discovery setup: card=%v err=%v", card, err)
	}
	execution, err := strategy.claimWithConfig(ctx, loop, card)
	if err != nil || execution != runnerDispatchExecution {
		t.Fatalf("real bound start setup: execution=%q err=%v", execution, err)
	}
	loop.SetAssignmentLLM(card.AssignmentLLM)
	return &invocationCase{http: f, loop: loop, strategy: strategy, card: card, execution: execution, current: current, stale: stale, repoDir: t.TempDir()}
}

func (c *invocationCase) run(ctx context.Context) error {
	_, err := c.strategy.executeLLM(ctx, ctx, c.loop, c.card, c.execution, c.repoDir)
	return err
}

func invocationExpectedPrompt(title string) string {
	return "Current 🧪 " + title + "\n" + invocationDescription + "\ntrue|1041.25|null\n" + runnerDispatchExecution + "\n" + invocationSource
}

func (c *invocationCase) assertPreparedCall(t *testing.T, expected string) {
	t.Helper()
	if c.stale.CallCount() != 0 || c.current.CallCount() != 1 {
		t.Fatalf("current packet provider was not used exactly once: current=%d stale=%d", c.current.CallCount(), c.stale.CallCount())
	}
	call := c.current.LastCall()
	if call.Prompt != expected || call.Options.SystemPrompt != "" {
		t.Errorf("exact prompt channels: input=%q system=%q; want input=%q and empty system", call.Prompt, call.Options.SystemPrompt, expected)
	}
	if call.Options.Model != invocationModel || call.Options.OutputSchema != invocationSchema || call.Options.ContextDispatchVersion != 1 {
		t.Errorf("current required provider options were not preserved: %+v", call.Options)
	}
	if call.Options.SourceExecutionID != "" {
		t.Error("scheduled binding was incorrectly reused as completion-source authorization")
	}
	if !reflect.DeepEqual(call.Options.DisallowedTools, []string{"Bash(never-current:*)"}) || !reflect.DeepEqual(call.Options.AllowedTools, []string{"Read", "mcp__operator__inspect"}) {
		t.Errorf("current packet tools were lost: allow=%v deny=%v", call.Options.AllowedTools, call.Options.DisallowedTools)
	}
	f := c.http
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.payloads) != 1 {
		t.Fatalf("expected one preparation before inference, got %d; events=%v", len(f.payloads), f.events)
	}
	payload := f.payloads[0]
	if payload["input_prompt"] != call.Prompt || payload["system_prompt"] != call.Options.SystemPrompt || payload["provider"] != invocationProvider || payload["adapter"] != invocationProvider || payload["model"] != invocationModel || payload["resolution_kind"] != "pinned" {
		t.Errorf("acknowledged payload differs from actual provider invocation: %#v", payload)
	}
	wantKeys := []string{"protocol_version", "client_request_id", "context_revision", "dispatch_revision", "invocation", "input_prompt", "system_prompt", "provider", "adapter", "model", "resolution_kind", "resume_session_id", "channel_contract"}
	if len(payload) != len(wantKeys) {
		t.Errorf("strict preparation wire has %d fields, want %d: %v", len(payload), len(wantKeys), payload)
	}
	for _, key := range wantKeys {
		if _, ok := payload[key]; !ok {
			t.Errorf("preparation omitted required wire member %q", key)
		}
	}
	if fmt.Sprint(payload["protocol_version"]) != "1" || payload["context_revision"] != f.snapshot["context_revision"] || payload["dispatch_revision"] != f.snapshot["dispatch_revision"] {
		t.Errorf("prepared revisions/version do not match refreshed snapshot: %v", payload)
	}
	key, _ := payload["client_request_id"].(string)
	if !regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`).MatchString(key) {
		t.Errorf("new preparation key is not a request UUID: %q", key)
	}
	wantChannels := map[string]any{"version": float64(1), "input": "verbatim", "system": "empty", "resume": call.Options.ResumeSessionID != ""}
	if !reflect.DeepEqual(payload["channel_contract"], wantChannels) || !reflect.DeepEqual(payload["invocation"], f.snapshot["invocation"]) {
		t.Errorf("prepared channels/invocation do not describe this call: %v / %v", payload["channel_contract"], payload["invocation"])
	}
	invocation := f.snapshot["invocation"].(map[string]any)
	if len(f.queries) != 1 || f.queries[0].Get("invocation_kind") != invocation["kind"] || f.queries[0].Get("prompt_slot") != invocation["prompt_slot"] {
		t.Errorf("snapshot query does not select this invocation: %v", f.queries)
	}
	if !reflect.DeepEqual(f.events, []string{"refresh", "prepare", "provider:" + invocationProvider}) {
		t.Errorf("dispatch order = %v", f.events)
	}
	if !reflect.DeepEqual(f.refreshHeaders, []string{"1"}) || !reflect.DeepEqual(f.prepareHeaders, []string{"1"}) {
		t.Errorf("refresh/preparation version headers = %v / %v", f.refreshHeaders, f.prepareHeaders)
	}
}
