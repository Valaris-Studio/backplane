// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	gitops "github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

const lifecycleApprovalID = "00000000-0000-4000-8000-000000000178"
const lifecycleSessionID = "owned-session-before-approval-58"
const lifecycleSummary = "Approval summary é🧪\n```sql\nDROP <literal>&{{.CardID}};\n```"
const lifecycleActionPlan = "Repair é🧪\n```go\nfmt.Println(\"<literal>&{{.ExecutionID}}\")\n```"

// This wrapper supplies only existing HTTP routes; production call sites choose
// the invocation slot, bind the execution and invoke the observed providers.
type lifecycleDispatchHTTP struct {
	*invocationHTTP
	approvalStatus       string
	refreshAfterApproval bool
	warnings             []map[string]any
	updates              []map[string]any
	starts               []map[string]any
	labels               []string
	labelWrites          int
	startStatus          int
	claims               int
}

func (f *lifecycleDispatchHTTP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cardPath := "/api/workspaces/workspace/boards/" + runnerDispatchBoard + "/cards/" + runnerDispatchCard
	execPath := "/api/agents/" + runnerDispatchAgent + "/executions/" + runnerDispatchExecution
	switch {
	case strings.HasSuffix(r.URL.Path, "/dispatch-context"):
		slot := r.URL.Query().Get("prompt_slot")
		kinds := map[string]string{"main": "stage", "mediate_rework": "mediation", "rework_implement": "stage", "implement_after_approval": "post_approval"}
		kind, ok := kinds[slot]
		if !ok {
			http.Error(w, "unsupported invocation slot", 422)
			return
		}
		f.mu.Lock()
		f.snapshot["invocation"] = map[string]any{"kind": kind, "step_name": nil, "prompt_slot": slot}
		dispatch := f.snapshot["dispatch"].(map[string]any)
		template := slot + " {{ index .Card \"title\" }}\n{{.ExecutionID}}\n{{ index .ContextSources \"approved\" }}"
		if slot == "rework_implement" {
			template += "\nPLAN\n{{.ActionPlan}}"
		}
		if slot == "implement_after_approval" {
			template += "\nAPPROVAL\n{{.ApprovalSummary}}"
		}
		dispatch["input_template"] = template
		dispatch["prompt_target"] = map[string]any{"role": "operator-auxiliary-owner-58", "stage": slot}
		if slot == "main" {
			dispatch["prompt_target"] = map[string]any{"role": runnerDispatchRole, "stage": "continue_project"}
		}
		f.mu.Unlock()
	case strings.HasSuffix(r.URL.Path, "/executions") && r.Method == http.MethodPost:
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		r.Body = io.NopCloser(bytes.NewReader(body))
		f.mu.Lock()
		f.starts = append(f.starts, payload)
		f.events = append(f.events, "start")
		f.mu.Unlock()
		if f.startStatus != 0 {
			http.Error(w, "bound start refused", f.startStatus)
			return
		}
	case strings.HasSuffix(r.URL.Path, "/claim"):
		f.mu.Lock()
		f.claims++
		f.mu.Unlock()
	case r.URL.Path == "/api/workspaces/workspace/approvals/"+lifecycleApprovalID:
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.refreshAfterApproval {
			f.snapshot["card"].(map[string]any)["title"] = "Changed during approval é"
			f.snapshot["context_revision"], f.snapshot["dispatch_revision"] = strings.Repeat("f", 64), strings.Repeat("b", 64)
			source := invocationSource + "Approved while first call ran 🧪\n"
			f.snapshot["context"].(map[string]string)["approved"] = source
			manifest := f.snapshot["context_manifest"].(map[string]any)["sources"].([]any)[0].(map[string]any)
			manifest["rendered_bytes"], manifest["rendered_sha256"] = len(source), invocationDigest(source)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": lifecycleApprovalID, "status": f.approvalStatus, "decision_reason": "Do not substitute this reason for the execution summary"})
		return
	case r.URL.Path == execPath+"/warnings" && r.Method == http.MethodPost:
		var warning map[string]any
		_ = json.NewDecoder(r.Body).Decode(&warning)
		f.mu.Lock()
		f.warnings = append(f.warnings, warning)
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{})
		return
	case r.URL.Path == execPath && r.Method == http.MethodPatch:
		body, _ := io.ReadAll(r.Body)
		var update map[string]any
		_ = json.Unmarshal(body, &update)
		r.Body = io.NopCloser(bytes.NewReader(body))
		f.mu.Lock()
		f.updates = append(f.updates, update)
		f.mu.Unlock()
	case r.URL.Path == cardPath && r.Method == http.MethodGet:
		f.mu.Lock()
		defer f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"id": runnerDispatchCard, "labels": f.labels, "participants": []any{}})
		return
	case r.URL.Path == cardPath && r.Method == http.MethodPatch:
		var update struct {
			Labels []string `json:"labels"`
		}
		_ = json.NewDecoder(r.Body).Decode(&update)
		f.mu.Lock()
		f.labels = update.Labels
		f.labelWrites++
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"id": runnerDispatchCard})
		return
	case r.URL.Path == cardPath+"/participants/"+runnerDispatchAgent && r.Method == http.MethodDelete:
		_ = json.NewEncoder(w).Encode(map[string]any{})
		return
	case strings.HasSuffix(r.URL.Path, "/notes") && r.Method == http.MethodPost:
		_ = json.NewEncoder(w).Encode(map[string]any{})
		return
	case r.URL.Path == "/api/workspaces/workspace/boards/"+runnerDispatchBoard && r.Method == http.MethodGet:
		_ = json.NewEncoder(w).Encode(map[string]any{"id": runnerDispatchBoard, "columns": []any{}})
		return
	}
	f.invocationHTTP.ServeHTTP(w, r)
}

func newLifecycleDispatchCase(t *testing.T, legacy, bind bool, responses ...string) (*invocationCase, *lifecycleDispatchHTTP) {
	t.Helper()
	f := &lifecycleDispatchHTTP{invocationHTTP: newInvocationHTTP(), approvalStatus: "approved"}
	if legacy {
		f.base.contract["mode"], f.base.contract["minimum_version"] = "legacy", 0
		f.base.assignment["context_dispatch"].(map[string]any)["mode"] = "legacy"
		f.base.start["context_binding"].(map[string]any)["context_dispatch"].(map[string]any)["mode"] = "legacy"
	}
	dispatch := f.snapshot["dispatch"].(map[string]any)
	dispatch["output_schema"] = ""
	dispatch["flags"].(map[string]any)["approval_enabled"] = true
	dispatch["flags"].(map[string]any)["post_process_kind"] = "writes_code"
	f.ackMutate = func(ack map[string]any) {
		ack["ordinal"] = len(f.payloads)
		ack["receipt_id"] = fmt.Sprintf("00000000-0000-4000-8000-%012d", 178+len(f.payloads))
	}
	l, s, _ := runnerDispatchLoop(t, f.base, false, false, "hero")
	server := httptest.NewServer(f)
	t.Cleanup(server.Close)
	client := valaris.NewClient(server.URL, "synthetic-key")
	client.Agent = l.client.Agent
	l.client = client
	l.cfg.WorkLoop.CardTimeout = 3 * time.Second
	l.cfg.Git.BaseDir = t.TempDir()
	l.git = &gitops.Manager{BaseDir: l.cfg.Git.BaseDir, DefaultRemote: "origin", BranchPrefix: "runner/"}
	s.config.Git.Action = "none"
	s.config.LLM.Enabled, s.config.LLM.Stage, s.config.LLM.PostProcessKind, s.config.LLM.ApprovalEnabled = true, "implement", "writes_code", true
	l.sessions = NewSessionStore()
	l.cardFailures = make(map[string]cardFailure)
	l.parkedApprovals = make(map[string]*parkedApproval)
	l.promptCache = make(map[string]string)
	for _, slot := range []string{"implement", "mediate_rework", "rework_implement", "implement_after_approval"} {
		l.promptCache[runnerDispatchRole+":"+slot] = "STALE " + slot + " {{.ActionPlan}} {{.ApprovalSummary}}"
	}
	provider := func(name string) *invocationProviderRecorder {
		mock := llm.NewMockProvider(responses...)
		mock.NameOverride = name
		mock.Caps.PromptChannels = llm.PromptChannels{Version: 1, FreshInput: true, FreshSystem: true, ResumeInput: true, ResumeSystem: true}
		return &invocationProviderRecorder{MockProvider: mock, fixture: f.invocationHTTP}
	}
	current, stale := provider(invocationProvider), provider("operator-provider-47")
	l.provider = stale
	l.providers = map[string]llm.Provider{current.Name(): current, stale.Name(): stale}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	card, err := s.discoverWithConfig(ctx, l)
	if err != nil || card == nil {
		t.Fatalf("real negotiated discovery: card=%v err=%v", card, err)
	}
	l.SetAssignmentLLM(card.AssignmentLLM)
	execution := ""
	if bind {
		execution, err = s.claimWithConfig(ctx, l, card)
		if err != nil || execution != runnerDispatchExecution {
			t.Fatalf("real bound start: execution=%q err=%v", execution, err)
		}
	}
	return &invocationCase{http: f.invocationHTTP, loop: l, strategy: s, card: card, execution: execution, current: current, stale: stale, repoDir: t.TempDir()}, f
}

func assertLifecyclePreparedCalls(t *testing.T, c *invocationCase, f *lifecycleDispatchHTTP, slots, kinds, prompts []string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if c.stale.CallCount() != 0 || c.current.CallCount() != len(slots) || len(f.payloads) != len(slots) || len(f.queries) != len(slots) {
		t.Fatalf("lifecycle bypassed required preparation: current=%d stale=%d preparations=%d events=%v", c.current.CallCount(), c.stale.CallCount(), len(f.payloads), f.events)
	}
	keys := map[string]bool{}
	for i, slot := range slots {
		call, payload := c.current.Calls[i], f.payloads[i]
		key, _ := payload["client_request_id"].(string)
		if key == "" || keys[key] {
			t.Errorf("invocations reused/omitted request UUID: %q", key)
		}
		keys[key] = true
		if call.Prompt != prompts[i] || payload["input_prompt"] != call.Prompt || call.Options.SystemPrompt != "" || payload["system_prompt"] != "" {
			t.Errorf("%s prepared/provider input differs: payload=%v call=%q want=%q", slot, payload["input_prompt"], call.Prompt, prompts[i])
		}
		expected := map[string]any{"kind": kinds[i], "step_name": nil, "prompt_slot": slot}
		if !reflect.DeepEqual(payload["invocation"], expected) || f.queries[i].Get("invocation_kind") != kinds[i] || f.queries[i].Get("prompt_slot") != slot {
			t.Errorf("wrong invocation slot: payload=%v query=%v", payload["invocation"], f.queries[i])
		}
		if call.Options.ContextDispatchVersion != 1 || call.Options.Model != invocationModel || call.Options.SourceExecutionID != "" {
			t.Errorf("required options changed: %+v", call.Options)
		}
	}
}
