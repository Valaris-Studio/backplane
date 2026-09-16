// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGetMe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/me" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test_key" {
			t.Error("missing or incorrect Authorization header")
		}
		json.NewEncoder(w).Encode(User{
			ID:    "user-123",
			Email: "runner@valaris.studio",
			Name:  "Runner Agent",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test_key")
	user, err := client.GetMe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if user.ID != "user-123" {
		t.Errorf("user.ID = %q, want %q", user.ID, "user-123")
	}
	if user.Email != "runner@valaris.studio" {
		t.Errorf("user.Email = %q, want %q", user.Email, "runner@valaris.studio")
	}
}

func TestInit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/me":
			json.NewEncoder(w).Encode(User{ID: "user-456", Email: "bot@valaris.dev", Name: "Bot"})
		case "/api/agents/me":
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"detail": "No agent linked"}`))
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test_key")
	if err := client.Init(context.Background()); err != nil {
		t.Fatal(err)
	}
	if client.UserID != "user-456" {
		t.Errorf("UserID = %q, want %q", client.UserID, "user-456")
	}
}

func TestAPIErrorHandling(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"detail": "Invalid API key"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_bad_key")
	_, err := client.GetMe(context.Background())
	if err == nil {
		t.Fatal("expected error for 403 response")
	}

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 403 {
		t.Errorf("status code = %d, want 403", apiErr.StatusCode)
	}
}

func TestGetAgentConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/me" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test" {
			t.Error("missing or incorrect Authorization header")
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id":                     "agent-001",
			"name":                   "test-runner",
			"agent_type":             "coding",
			"description":            "Test agent",
			"is_active":              true,
			"allowed_workspaces":     []string{"internal"},
			"allowed_actions":        nil,
			"max_requests_per_minute": 100,
			"created_at":             "2026-01-01T00:00:00Z",
			"updated_at":             "2026-01-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	agent, err := client.GetAgentConfig(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agent == nil {
		t.Fatal("expected non-nil agent")
	}
	if agent.ID != "agent-001" {
		t.Errorf("agent.ID = %q, want %q", agent.ID, "agent-001")
	}
	if agent.Name != "test-runner" {
		t.Errorf("agent.Name = %q, want %q", agent.Name, "test-runner")
	}
	if agent.AgentType != "coding" {
		t.Errorf("agent.AgentType = %q, want %q", agent.AgentType, "coding")
	}
	if !agent.IsActive {
		t.Error("agent.IsActive = false, want true")
	}
	if len(agent.AllowedWorkspaces) != 1 || agent.AllowedWorkspaces[0] != "internal" {
		t.Errorf("agent.AllowedWorkspaces = %v, want [internal]", agent.AllowedWorkspaces)
	}
	if agent.MaxRequestsPerMinute != 100 {
		t.Errorf("agent.MaxRequestsPerMinute = %d, want 100", agent.MaxRequestsPerMinute)
	}
}

func TestGetAgentConfigNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me" {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"detail": "No agent linked"}`))
			return
		}
		t.Errorf("unexpected path: %s", r.URL.Path)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	agent, err := client.GetAgentConfig(context.Background())
	if err != nil {
		t.Fatalf("404 should not produce an error, got: %v", err)
	}
	if agent != nil {
		t.Errorf("expected nil agent for 404, got: %+v", agent)
	}
}

func TestGetAgentConfigServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"detail": "internal server error"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.GetAgentConfig(context.Background())
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("status code = %d, want 500", apiErr.StatusCode)
	}
}

func TestInitWithAgent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/me":
			json.NewEncoder(w).Encode(User{ID: "user-789", Email: "bot@valaris.dev", Name: "Bot"})
		case "/api/agents/me":
			json.NewEncoder(w).Encode(map[string]any{
				"id": "agent-001", "name": "runner", "agent_type": "coding",
				"description": "CI agent", "is_active": true,
				"allowed_workspaces": []string{"internal"},
				"max_requests_per_minute": 60,
				"created_at": "2026-01-01T00:00:00Z",
				"updated_at": "2026-01-01T00:00:00Z",
			})
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if err := client.Init(context.Background()); err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	if client.UserID != "user-789" {
		t.Errorf("UserID = %q, want %q", client.UserID, "user-789")
	}
	if client.Agent == nil {
		t.Fatal("expected client.Agent to be populated")
	}
	if client.Agent.ID != "agent-001" {
		t.Errorf("Agent.ID = %q, want %q", client.Agent.ID, "agent-001")
	}
}

func TestInitWithoutAgent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/me":
			json.NewEncoder(w).Encode(User{ID: "user-100", Email: "human@valaris.dev", Name: "Human"})
		case "/api/agents/me":
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"detail": "No agent linked"}`))
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if err := client.Init(context.Background()); err != nil {
		t.Fatalf("Init should succeed even without agent: %v", err)
	}
	if client.UserID != "user-100" {
		t.Errorf("UserID = %q, want %q", client.UserID, "user-100")
	}
	if client.Agent != nil {
		t.Errorf("expected nil Agent for plain user, got: %+v", client.Agent)
	}
}

func TestHeartbeat(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/me/heartbeat" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test" {
			t.Error("missing or incorrect Authorization header")
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id": "agent-001", "name": "runner", "agent_type": "coding",
			"description": "CI agent", "is_active": true,
			"allowed_workspaces": []string{"internal"},
			"max_requests_per_minute": 60,
			"created_at": "2026-01-01T00:00:00Z",
			"updated_at": "2026-01-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	client.Agent = &AgentConfig{ID: "agent-001", Name: "runner", IsActive: true}

	if err := client.Heartbeat(context.Background()); err != nil {
		t.Fatalf("Heartbeat failed: %v", err)
	}
}

func TestHeartbeatNoAgent(t *testing.T) {
	var called atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		t.Error("should not make HTTP call when Agent is nil")
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	// Agent is nil — heartbeat should be a no-op
	if err := client.Heartbeat(context.Background()); err != nil {
		t.Fatalf("Heartbeat with nil Agent should return nil: %v", err)
	}
	if called.Load() {
		t.Error("HTTP call was made despite nil Agent")
	}
}

func TestHeartbeatUpdatesAgent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"id": "agent-001", "name": "runner", "agent_type": "coding",
			"description": "CI agent", "is_active": false,
			"allowed_workspaces": []string{"internal", "staging"},
			"max_requests_per_minute": 30,
			"created_at": "2026-01-01T00:00:00Z",
			"updated_at": "2026-04-11T12:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	client.Agent = &AgentConfig{
		ID: "agent-001", Name: "runner", IsActive: true,
		MaxRequestsPerMinute: 60,
	}

	if err := client.Heartbeat(context.Background()); err != nil {
		t.Fatalf("Heartbeat failed: %v", err)
	}
	if client.Agent.IsActive {
		t.Error("expected IsActive to be updated to false")
	}
	if client.Agent.MaxRequestsPerMinute != 30 {
		t.Errorf("MaxRequestsPerMinute = %d, want 30", client.Agent.MaxRequestsPerMinute)
	}
	if len(client.Agent.AllowedWorkspaces) != 2 {
		t.Errorf("AllowedWorkspaces = %v, want [internal staging]", client.Agent.AllowedWorkspaces)
	}
}

func TestGetApprovalStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/test-ws/approvals/appr-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test" {
			t.Error("missing or incorrect Authorization header")
		}
		w.Write([]byte(`{"id":"appr-1","status":"pending","category":"deletion","risk_score":60,"action_description":"Delete old tables","expires_at":"2026-04-12T00:00:00Z"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	approval, err := client.GetApprovalStatus(context.Background(), "test-ws", "appr-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.ID != "appr-1" {
		t.Errorf("ID = %q, want %q", approval.ID, "appr-1")
	}
	if approval.Status != "pending" {
		t.Errorf("Status = %q, want %q", approval.Status, "pending")
	}
	if approval.Category != "deletion" {
		t.Errorf("Category = %q, want %q", approval.Category, "deletion")
	}
	if approval.RiskScore != 60 {
		t.Errorf("RiskScore = %d, want 60", approval.RiskScore)
	}
	if approval.ActionDescription != "Delete old tables" {
		t.Errorf("ActionDescription = %q, want %q", approval.ActionDescription, "Delete old tables")
	}
	if approval.DecisionReason != nil {
		t.Errorf("DecisionReason = %v, want nil", approval.DecisionReason)
	}
	if approval.ExpiresAt != "2026-04-12T00:00:00Z" {
		t.Errorf("ExpiresAt = %q, want %q", approval.ExpiresAt, "2026-04-12T00:00:00Z")
	}
}

func TestGetApprovalStatus_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"detail":"Approval not found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.GetApprovalStatus(context.Background(), "test-ws", "appr-missing")
	if err == nil {
		t.Fatal("expected error for 404 response")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 404 {
		t.Errorf("status code = %d, want 404", apiErr.StatusCode)
	}
}

func TestPollApproval_Approved(t *testing.T) {
	var callCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n == 1 {
			w.Write([]byte(`{"id":"appr-1","status":"pending","category":"deletion","risk_score":60,"action_description":"Delete old tables","expires_at":"2026-04-12T00:00:00Z"}`))
		} else {
			reason := "looks good"
			resp := ApprovalStatus{
				ID: "appr-1", Status: "approved", Category: "deletion",
				RiskScore: 60, ActionDescription: "Delete old tables",
				DecisionReason: &reason, ExpiresAt: "2026-04-12T00:00:00Z",
			}
			json.NewEncoder(w).Encode(resp)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	approval, err := client.PollApproval(context.Background(), "test-ws", "appr-1", 10*time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != "approved" {
		t.Errorf("Status = %q, want %q", approval.Status, "approved")
	}
	if approval.DecisionReason == nil || *approval.DecisionReason != "looks good" {
		t.Errorf("DecisionReason = %v, want %q", approval.DecisionReason, "looks good")
	}
	if count := callCount.Load(); count != 2 {
		t.Errorf("HTTP calls = %d, want 2", count)
	}
}

func TestPollApproval_Rejected(t *testing.T) {
	var callCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		reason := "too risky"
		resp := ApprovalStatus{
			ID: "appr-2", Status: "rejected", Category: "deletion",
			RiskScore: 90, ActionDescription: "Drop production DB",
			DecisionReason: &reason, ExpiresAt: "2026-04-12T00:00:00Z",
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	approval, err := client.PollApproval(context.Background(), "test-ws", "appr-2", 10*time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != "rejected" {
		t.Errorf("Status = %q, want %q", approval.Status, "rejected")
	}
	if count := callCount.Load(); count != 1 {
		t.Errorf("HTTP calls = %d, want 1", count)
	}
}

func TestPollApproval_ContextTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"appr-3","status":"pending","category":"deletion","risk_score":50,"action_description":"Slow approval","expires_at":"2026-04-12T00:00:00Z"}`))
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.PollApproval(ctx, "test-ws", "appr-3", 20*time.Millisecond)
	if err == nil {
		t.Fatal("expected error from context timeout")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error = %v, want context.DeadlineExceeded", err)
	}
}

func TestHeartbeat_WithReport(t *testing.T) {
	var receivedBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/me/heartbeat" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		ct := r.Header.Get("Content-Type")
		if ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		var err error
		receivedBody, err = io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id": "agent-001", "name": "runner", "agent_type": "coding",
			"is_active": true, "max_requests_per_minute": 60,
			"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	client.Agent = &AgentConfig{ID: "agent-001", IsActive: true}

	report := &HealthReport{
		Version:        "1.0.0",
		Status:         "idle",
		UptimeSeconds:  3600,
		CardsProcessed: 5,
	}
	if err := client.Heartbeat(context.Background(), report); err != nil {
		t.Fatalf("Heartbeat with report failed: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(receivedBody, &parsed); err != nil {
		t.Fatalf("failed to parse request body: %v", err)
	}
	if parsed["version"] != "1.0.0" {
		t.Errorf("version = %v, want 1.0.0", parsed["version"])
	}
	if parsed["status"] != "idle" {
		t.Errorf("status = %v, want idle", parsed["status"])
	}
	if parsed["cards_processed"] != float64(5) {
		t.Errorf("cards_processed = %v, want 5", parsed["cards_processed"])
	}
}

func TestHeartbeat_WithoutReport(t *testing.T) {
	var contentType string
	var bodyLen int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentType = r.Header.Get("Content-Type")
		body, _ := io.ReadAll(r.Body)
		bodyLen = len(body)
		json.NewEncoder(w).Encode(map[string]any{
			"id": "agent-001", "name": "runner", "agent_type": "coding",
			"is_active": true, "max_requests_per_minute": 60,
			"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	client.Agent = &AgentConfig{ID: "agent-001", IsActive: true}

	// Call without report — backward compatible.
	if err := client.Heartbeat(context.Background()); err != nil {
		t.Fatalf("Heartbeat without report failed: %v", err)
	}

	if contentType != "" {
		t.Errorf("Content-Type should be empty for no body, got %q", contentType)
	}
	if bodyLen != 0 {
		t.Errorf("body should be empty, got %d bytes", bodyLen)
	}
}

func TestAgentConfig_TeamMembership(t *testing.T) {
	raw := `{
		"id": "agent-001",
		"name": "test-runner",
		"agent_type": "coding",
		"description": "Test agent",
		"is_active": true,
		"allowed_workspaces": ["internal"],
		"allowed_actions": null,
		"max_requests_per_minute": 100,
		"created_at": "2026-01-01T00:00:00Z",
		"updated_at": "2026-01-01T00:00:00Z",
		"team_membership": {
			"team_id": "team-42",
			"team_name": "backend-crew",
			"role": "reviewer"
		}
	}`

	var agent AgentConfig
	if err := json.Unmarshal([]byte(raw), &agent); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if agent.TeamMembership == nil {
		t.Fatal("expected non-nil TeamMembership")
	}
	if agent.TeamMembership.TeamID != "team-42" {
		t.Errorf("TeamID = %q, want %q", agent.TeamMembership.TeamID, "team-42")
	}
	if agent.TeamMembership.TeamName != "backend-crew" {
		t.Errorf("TeamName = %q, want %q", agent.TeamMembership.TeamName, "backend-crew")
	}
	if agent.TeamMembership.Role != "reviewer" {
		t.Errorf("Role = %q, want %q", agent.TeamMembership.Role, "reviewer")
	}
}

func TestAgentConfig_TeamMembership_Nil(t *testing.T) {
	raw := `{
		"id": "agent-002",
		"name": "solo-agent",
		"agent_type": "coding",
		"is_active": true,
		"created_at": "2026-01-01T00:00:00Z",
		"updated_at": "2026-01-01T00:00:00Z"
	}`

	var agent AgentConfig
	if err := json.Unmarshal([]byte(raw), &agent); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if agent.TeamMembership != nil {
		t.Errorf("expected nil TeamMembership, got %+v", agent.TeamMembership)
	}
}

func TestPollApproval_AutoApproved(t *testing.T) {
	var callCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.Write([]byte(`{"id":"appr-4","status":"auto_approved","category":"formatting","risk_score":10,"action_description":"Format code","expires_at":"2026-04-12T00:00:00Z"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	approval, err := client.PollApproval(context.Background(), "test-ws", "appr-4", 10*time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != "auto_approved" {
		t.Errorf("Status = %q, want %q", approval.Status, "auto_approved")
	}
	if count := callCount.Load(); count != 1 {
		t.Errorf("HTTP calls = %d, want 1", count)
	}
}

func TestPollApprovalWithEvents_EventDrivenResolution(t *testing.T) {
	var callCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n == 1 {
			// Immediate check returns pending
			w.Write([]byte(`{"id":"appr-ws","status":"pending","category":"deletion","risk_score":50,"action_description":"WS test","expires_at":"2026-04-12T00:00:00Z"}`))
		} else {
			// Event-triggered check returns approved
			reason := "ws approved"
			resp := ApprovalStatus{
				ID: "appr-ws", Status: "approved", Category: "deletion",
				RiskScore: 50, ActionDescription: "WS test",
				DecisionReason: &reason, ExpiresAt: "2026-04-12T00:00:00Z",
			}
			json.NewEncoder(w).Encode(resp)
		}
	}))
	defer server.Close()

	eventCh := make(chan struct{}, 1)
	client := NewClient(server.URL, "vlr_test")

	// Signal the event channel after a short delay (before the ticker fires).
	go func() {
		time.Sleep(50 * time.Millisecond)
		eventCh <- struct{}{}
	}()

	approval, err := client.PollApprovalWithEvents(
		context.Background(), "test-ws", "appr-ws",
		10*time.Second, // Long poll interval — should NOT be reached
		eventCh,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != "approved" {
		t.Errorf("Status = %q, want %q", approval.Status, "approved")
	}
	if count := callCount.Load(); count != 2 {
		t.Errorf("HTTP calls = %d, want 2 (initial + event-triggered)", count)
	}
}

func TestPollApprovalWithEvents_NilEventsFallsBackToPolling(t *testing.T) {
	var callCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n <= 2 {
			w.Write([]byte(`{"id":"appr-nil","status":"pending","category":"deletion","risk_score":50,"action_description":"nil test","expires_at":"2026-04-12T00:00:00Z"}`))
		} else {
			w.Write([]byte(`{"id":"appr-nil","status":"approved","category":"deletion","risk_score":50,"action_description":"nil test","expires_at":"2026-04-12T00:00:00Z"}`))
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	approval, err := client.PollApprovalWithEvents(
		context.Background(), "test-ws", "appr-nil",
		10*time.Millisecond, // Short interval for fast test
		nil,                 // nil events — pure HTTP polling
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != "approved" {
		t.Errorf("Status = %q, want %q", approval.Status, "approved")
	}
}

func TestPollApprovalWithEvents_ContextCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"appr-ctx","status":"pending","category":"deletion","risk_score":50,"action_description":"ctx test","expires_at":"2026-04-12T00:00:00Z"}`))
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	eventCh := make(chan struct{}, 1) // Never signaled
	client := NewClient(server.URL, "vlr_test")
	_, err := client.PollApprovalWithEvents(ctx, "test-ws", "appr-ctx", 5*time.Second, eventCh)
	if err == nil {
		t.Fatal("expected error from context timeout")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error = %v, want context.DeadlineExceeded", err)
	}
}

func TestGetPromptConfigs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/test-ws/prompt-configs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		if r.URL.Query().Get("team_role") != "orchestrator" {
			t.Errorf("team_role = %q, want %q", r.URL.Query().Get("team_role"), "orchestrator")
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test" {
			t.Error("missing or incorrect Authorization header")
		}
		json.NewEncoder(w).Encode([]PromptConfig{
			{ID: "cfg-1", Slug: "discover", Stage: "discover", AgentType: "coding", TeamRole: "orchestrator", Content: "Find work", Version: 1},
			{ID: "cfg-2", Slug: "claim", Stage: "claim", AgentType: "coding", TeamRole: "orchestrator", Content: "Claim card", Version: 3},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	configs, err := client.GetPromptConfigs(context.Background(), "test-ws", "orchestrator")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(configs) != 2 {
		t.Fatalf("got %d configs, want 2", len(configs))
	}
	if configs[0].Slug != "discover" {
		t.Errorf("configs[0].Slug = %q, want %q", configs[0].Slug, "discover")
	}
	if configs[0].Content != "Find work" {
		t.Errorf("configs[0].Content = %q, want %q", configs[0].Content, "Find work")
	}
	if configs[1].Version != 3 {
		t.Errorf("configs[1].Version = %d, want 3", configs[1].Version)
	}
}

func TestGetPromptConfigs_EmptyRole(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("team_role") != "" {
			t.Errorf("team_role should be empty, got %q", r.URL.Query().Get("team_role"))
		}
		json.NewEncoder(w).Encode([]PromptConfig{})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	configs, err := client.GetPromptConfigs(context.Background(), "test-ws", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(configs) != 0 {
		t.Errorf("got %d configs, want 0", len(configs))
	}
}

func TestGetPromptConfigs_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"detail":"internal error"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.GetPromptConfigs(context.Background(), "test-ws", "orchestrator")
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("status code = %d, want 500", apiErr.StatusCode)
	}
}

func TestGetBudgetStatus(t *testing.T) {
	budget := 50.0
	remaining := 30.0
	pctUsed := 40.0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/me/budget-status" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test" {
			t.Error("missing or incorrect Authorization header")
		}
		json.NewEncoder(w).Encode(BudgetStatus{
			BudgetUSD:      &budget,
			SpentUSD:       20.0,
			RemainingUSD:   &remaining,
			PercentageUsed: &pctUsed,
			IsExceeded:     false,
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	client.Agent = &AgentConfig{ID: "agent-001", IsActive: true}
	status, err := client.GetBudgetStatus(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status.BudgetUSD == nil || *status.BudgetUSD != 50.0 {
		t.Errorf("BudgetUSD = %v, want 50.0", status.BudgetUSD)
	}
	if status.SpentUSD != 20.0 {
		t.Errorf("SpentUSD = %f, want 20.0", status.SpentUSD)
	}
	if status.RemainingUSD == nil || *status.RemainingUSD != 30.0 {
		t.Errorf("RemainingUSD = %v, want 30.0", status.RemainingUSD)
	}
	if status.PercentageUsed == nil || *status.PercentageUsed != 40.0 {
		t.Errorf("PercentageUsed = %v, want 40.0", status.PercentageUsed)
	}
	if status.IsExceeded {
		t.Error("IsExceeded = true, want false")
	}
}

func TestGetBudgetStatus_NoBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(BudgetStatus{
			BudgetUSD:      nil,
			SpentUSD:       5.0,
			RemainingUSD:   nil,
			PercentageUsed: nil,
			IsExceeded:     false,
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	client.Agent = &AgentConfig{ID: "agent-001", IsActive: true}
	status, err := client.GetBudgetStatus(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status.BudgetUSD != nil {
		t.Errorf("BudgetUSD = %v, want nil", status.BudgetUSD)
	}
	if status.RemainingUSD != nil {
		t.Errorf("RemainingUSD = %v, want nil", status.RemainingUSD)
	}
	if status.IsExceeded {
		t.Error("IsExceeded = true, want false")
	}
}

func TestGetBudgetStatus_Exceeded(t *testing.T) {
	budget := 10.0
	remaining := 0.0
	pctUsed := 150.0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(BudgetStatus{
			BudgetUSD:      &budget,
			SpentUSD:       15.0,
			RemainingUSD:   &remaining,
			PercentageUsed: &pctUsed,
			IsExceeded:     true,
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	client.Agent = &AgentConfig{ID: "agent-001", IsActive: true}
	status, err := client.GetBudgetStatus(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !status.IsExceeded {
		t.Error("IsExceeded = false, want true")
	}
	if status.SpentUSD != 15.0 {
		t.Errorf("SpentUSD = %f, want 15.0", status.SpentUSD)
	}
}

func TestGetBudgetStatus_NoAgent(t *testing.T) {
	client := NewClient("http://test", "vlr_test")
	// Agent is nil
	_, err := client.GetBudgetStatus(context.Background())
	if err == nil {
		t.Fatal("expected error when Agent is nil")
	}
}

func TestGetBudgetStatus_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"detail":"internal error"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	client.Agent = &AgentConfig{ID: "agent-001", IsActive: true}
	_, err := client.GetBudgetStatus(context.Background())
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("status code = %d, want 500", apiErr.StatusCode)
	}
}

func TestPollApprovalWithEvents_AlreadyTerminal(t *testing.T) {
	var callCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.Write([]byte(`{"id":"appr-done","status":"rejected","category":"deletion","risk_score":90,"action_description":"already done","expires_at":"2026-04-12T00:00:00Z"}`))
	}))
	defer server.Close()

	eventCh := make(chan struct{}, 1)
	client := NewClient(server.URL, "vlr_test")
	approval, err := client.PollApprovalWithEvents(
		context.Background(), "test-ws", "appr-done",
		10*time.Second, eventCh,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != "rejected" {
		t.Errorf("Status = %q, want %q", approval.Status, "rejected")
	}
	// Only the immediate check should fire — no polling needed
	if count := callCount.Load(); count != 1 {
		t.Errorf("HTTP calls = %d, want 1", count)
	}
}

func TestGetPlatformConfig(t *testing.T) {
	budgetUSD := 50.0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/me/config" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("unexpected method: %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test" {
			t.Error("missing or incorrect Authorization header")
		}
		json.NewEncoder(w).Encode(map[string]any{
			"agent_id":               "agent-001",
			"name":                   "test-runner",
			"agent_type":             "coding",
			"is_active":              true,
			"max_requests_per_minute": 60,
			"budget_usd":             budgetUSD,
			"spent_usd":              12.50,
			"remaining_usd":          37.50,
			"budget_exceeded":        false,
			"prompt_configs":         []map[string]any{},
			"workspace_config": map[string]any{
				"max_rework_attempts":       5,
				"card_cooldown_hours":       2.0,
				"commit_message_template":   "fix({{.CardID}}): {{.Title}}",
				"pr_description_template":   "PR for {{.CardID}}",
				"version":                   3,
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	cfg, err := client.GetPlatformConfig(context.Background(), "internal-projects")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.AgentID != "agent-001" {
		t.Errorf("AgentID = %q, want %q", cfg.AgentID, "agent-001")
	}
	if cfg.Name != "test-runner" {
		t.Errorf("Name = %q, want %q", cfg.Name, "test-runner")
	}
	if !cfg.IsActive {
		t.Error("IsActive = false, want true")
	}
	if cfg.SpentUSD != 12.50 {
		t.Errorf("SpentUSD = %f, want 12.50", cfg.SpentUSD)
	}
	if cfg.BudgetExceeded {
		t.Error("BudgetExceeded = true, want false")
	}
	if cfg.WorkspaceConfig.MaxReworkAttempts != 5 {
		t.Errorf("MaxReworkAttempts = %d, want 5", cfg.WorkspaceConfig.MaxReworkAttempts)
	}
	if cfg.WorkspaceConfig.CardCooldownHours != 2.0 {
		t.Errorf("CardCooldownHours = %f, want 2.0", cfg.WorkspaceConfig.CardCooldownHours)
	}
	if cfg.WorkspaceConfig.CommitMessageTemplate != "fix({{.CardID}}): {{.Title}}" {
		t.Errorf("CommitMessageTemplate = %q, want %q", cfg.WorkspaceConfig.CommitMessageTemplate, "fix({{.CardID}}): {{.Title}}")
	}
	if cfg.WorkspaceConfig.PRDescriptionTemplate != "PR for {{.CardID}}" {
		t.Errorf("PRDescriptionTemplate = %q, want %q", cfg.WorkspaceConfig.PRDescriptionTemplate, "PR for {{.CardID}}")
	}
	if cfg.WorkspaceConfig.Version != 3 {
		t.Errorf("Version = %d, want 3", cfg.WorkspaceConfig.Version)
	}
}

func TestGetPlatformConfig_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"detail": "internal error"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.GetPlatformConfig(context.Background(), "internal-projects")
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("status code = %d, want 500", apiErr.StatusCode)
	}
}

func TestGetProjectDirectives(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/workspaces/ws/boards/b1/context":
			json.NewEncoder(w).Encode(map[string]any{
				"board":      map[string]any{"id": "b1", "name": "test"},
				"definition": map[string]any{"content": map[string]string{"coding_standards": "Use snake_case. Always add tests."}},
			})
		case r.URL.Path == "/api/workspaces/ws/boards/b1/notes":
			json.NewEncoder(w).Encode([]map[string]any{
				{"id": "n1", "title": "ADR-001", "content": "Use PostgreSQL for all data", "pinned": true},
				{"id": "n2", "title": "Draft idea", "content": "Maybe use Redis", "pinned": false},
				{"id": "n3", "title": "ADR-002", "content": "REST over GraphQL", "pinned": true},
			})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	directives, err := client.GetProjectDirectives(context.Background(), "ws", "b1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if directives.CodingStandards != "Use snake_case. Always add tests." {
		t.Errorf("coding standards = %q, want 'Use snake_case. Always add tests.'", directives.CodingStandards)
	}
	if len(directives.PinnedNotes) != 2 {
		t.Fatalf("pinned notes count = %d, want 2", len(directives.PinnedNotes))
	}
	if directives.PinnedNotes[0].Title != "ADR-001" {
		t.Errorf("first note title = %q, want ADR-001", directives.PinnedNotes[0].Title)
	}

	formatted := directives.Format()
	if !strings.Contains(formatted, "CODING STANDARDS:") {
		t.Error("formatted output should contain CODING STANDARDS header")
	}
	if !strings.Contains(formatted, "NOTE — ADR-001:") {
		t.Error("formatted output should contain pinned note title")
	}
	if strings.Contains(formatted, "Draft idea") {
		t.Error("formatted output should NOT contain unpinned note")
	}
}

func TestGetProjectDirectives_RichDefinition(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workspaces/ws/boards/b1/context":
			json.NewEncoder(w).Encode(map[string]any{
				"board": map[string]any{"id": "b1", "name": "test"},
				"definition": map[string]any{
					"scope": "Ship the billing service.",
					"content": map[string]any{
						"coding_standards": "Use snake_case. Always add tests.",
						"objectives": []map[string]any{
							{"text": "MVP checkout", "priority": "high"},
							{"text": "Audit log"},
						},
						"constraints": []string{"No new dependencies", "Stay under 200ms p95"},
						"exclusions":  []string{"No mobile app"},
						"tech_stack":  []string{"Go", "Postgres"},
						"decisions": []map[string]any{
							{"decision": "Use Stripe", "rationale": "PCI scope reduction"},
							{"decision": "Monorepo"},
						},
						"milestones": []map[string]any{
							{"title": "Alpha", "date": "2026-06-01", "type": "release"},
							{"title": "GA", "date": "2026-07-01"},
						},
						"stakeholders": []map[string]any{
							{"name": "Ana", "role": "PM"},
							{"name": "Bob"},
						},
						"references": []map[string]any{
							{"label": "Design", "url": "https://example.com/design"},
							{"url": "https://example.com/raw"},
						},
					},
				},
			})
		case "/api/workspaces/ws/boards/b1/notes":
			json.NewEncoder(w).Encode([]map[string]any{
				{"id": "n1", "title": "ADR-001", "content": "Use PostgreSQL", "pinned": true},
			})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	d, err := client.GetProjectDirectives(context.Background(), "ws", "b1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if d.Scope != "Ship the billing service." {
		t.Errorf("scope = %q", d.Scope)
	}
	if len(d.Objectives) != 2 || d.Objectives[0].Text != "MVP checkout" || d.Objectives[0].Priority != "high" {
		t.Errorf("objectives = %+v", d.Objectives)
	}
	if len(d.Constraints) != 2 || d.Constraints[1] != "Stay under 200ms p95" {
		t.Errorf("constraints = %+v", d.Constraints)
	}
	if len(d.Exclusions) != 1 || d.Exclusions[0] != "No mobile app" {
		t.Errorf("exclusions = %+v", d.Exclusions)
	}
	if len(d.TechStack) != 2 || d.TechStack[0] != "Go" {
		t.Errorf("tech_stack = %+v", d.TechStack)
	}
	if len(d.Decisions) != 2 || d.Decisions[0].Decision != "Use Stripe" || d.Decisions[0].Rationale != "PCI scope reduction" {
		t.Errorf("decisions = %+v", d.Decisions)
	}
	if len(d.Milestones) != 2 || d.Milestones[0].Title != "Alpha" || d.Milestones[0].Date != "2026-06-01" || d.Milestones[0].Type != "release" {
		t.Errorf("milestones = %+v", d.Milestones)
	}
	if len(d.Stakeholders) != 2 || d.Stakeholders[0].Name != "Ana" || d.Stakeholders[0].Role != "PM" {
		t.Errorf("stakeholders = %+v", d.Stakeholders)
	}
	if len(d.References) != 2 || d.References[0].Label != "Design" || d.References[0].URL != "https://example.com/design" {
		t.Errorf("references = %+v", d.References)
	}

	out := d.Format()
	// MANDATORY tier
	for _, want := range []string{
		"PROJECT SCOPE:\nShip the billing service.",
		"## MANDATORY",
		"OBJECTIVES:\n- MVP checkout [high]\n- Audit log",
		"CONSTRAINTS:\n- No new dependencies\n- Stay under 200ms p95",
		"EXCLUSIONS:\n- No mobile app",
		"CODING STANDARDS:\nUse snake_case. Always add tests.",
		"## PROJECT CONTEXT",
		"TECH STACK:\n- Go\n- Postgres",
		"KEY DECISIONS:\n- Use Stripe — PCI scope reduction\n- Monorepo",
		"MILESTONES:\n- Alpha (2026-06-01) [release]\n- GA (2026-07-01)",
		"STAKEHOLDERS:\n- Ana — PM\n- Bob",
		"REFERENCES:\n- Design: https://example.com/design\n- https://example.com/raw",
		"NOTE — ADR-001:\nUse PostgreSQL",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("Format() missing %q\n--- full ---\n%s", want, out)
		}
	}
}

// Backward compat: an old backend that returns only coding_standards (no
// scope, no structured content) must render exactly the legacy single block.
func TestGetProjectDirectives_CodingStandardsOnly_BackwardCompat(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workspaces/ws/boards/b1/context":
			json.NewEncoder(w).Encode(map[string]any{
				"definition": map[string]any{
					"content": map[string]string{"coding_standards": "Use snake_case."},
				},
			})
		case "/api/workspaces/ws/boards/b1/notes":
			json.NewEncoder(w).Encode([]map[string]any{})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	d, err := client.GetProjectDirectives(context.Background(), "ws", "b1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := d.Format()
	want := "## MANDATORY\n\nCODING STANDARDS:\nUse snake_case."
	if got != want {
		t.Errorf("Format() = %q, want %q", got, want)
	}
}

func TestGetProjectDirectives_GracefulOnErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	directives, err := client.GetProjectDirectives(context.Background(), "ws", "b1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Should return empty directives, not fail.
	if directives.CodingStandards != "" {
		t.Errorf("expected empty coding standards, got %q", directives.CodingStandards)
	}
	if len(directives.PinnedNotes) != 0 {
		t.Errorf("expected no pinned notes, got %d", len(directives.PinnedNotes))
	}
}

func TestNextAssignment(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/default/agents/agent-1/next-assignment" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		var req NextAssignmentRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("unmarshal req: %v", err)
		}
		if req.RoleOverride != "reviewer" {
			t.Errorf("role_override = %q, want reviewer", req.RoleOverride)
		}
		json.NewEncoder(w).Encode(NextAssignmentResponse{
			Card:        Card{ID: "card-7", Title: "Review work"},
			Board:       AssignmentBoard{ID: "b1", Slug: "main", Name: "Main"},
			Column:      AssignmentColumn{ID: "col1", Name: "In Review", ColumnType: "review"},
			Repo:        &AssignmentRepo{ID: "r1", URL: "https://github.com/x/y", DefaultBranch: "main"},
			Role:        "reviewer",
			StageAction: "review_card",
			Reservation: Reservation{ID: "res-1", ExpiresAt: "2026-04-24T10:00:00"},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test_key")
	resp, err := client.NextAssignment(context.Background(), "default", "agent-1", NextAssignmentRequest{
		RoleOverride: "reviewer",
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp == nil {
		t.Fatal("expected non-nil response")
	}
	if resp.Card.ID != "card-7" {
		t.Errorf("card.id = %q", resp.Card.ID)
	}
	if resp.Role != "reviewer" {
		t.Errorf("role = %q", resp.Role)
	}
	if resp.StageAction != "review_card" {
		t.Errorf("stage_action = %q", resp.StageAction)
	}
	if resp.Reservation.ID != "res-1" {
		t.Errorf("reservation.id = %q", resp.Reservation.ID)
	}
}

// CTX-2: backend now bundles a context map (kind → rendered string) on
// /next-assignment. The runner must round-trip it verbatim so the work loop
// can hand each entry to PromptContext.ContextSources.
func TestNextAssignment_ContextMapRoundTrip(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"card":         map[string]any{"id": "card-x", "title": "with context"},
			"board":        map[string]any{"id": "b1", "slug": "main", "name": "Main"},
			"column":       map[string]any{"id": "c1", "name": "In Progress", "column_type": "in_progress"},
			"role":         "implementer",
			"stage_action": "implement_card",
			"reservation":  map[string]any{"id": "r1", "expires_at": "2026-04-26T00:00:00Z"},
			"context": map[string]string{
				"board_definition": "STANDARDS X\n\nNOTE — pinned: stuff",
				"review_history":   "review 1\nreview 2",
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	resp, err := client.NextAssignment(context.Background(), "default", "agent-1", NextAssignmentRequest{})
	if err != nil {
		t.Fatalf("NextAssignment: %v", err)
	}
	if resp == nil {
		t.Fatal("expected non-nil response")
	}
	if got := resp.Context["board_definition"]; got != "STANDARDS X\n\nNOTE — pinned: stuff" {
		t.Errorf("Context[board_definition] = %q, want backend-rendered directives string", got)
	}
	if got := resp.Context["review_history"]; got != "review 1\nreview 2" {
		t.Errorf("Context[review_history] = %q, want backend-rendered review string", got)
	}
}

func TestNextAssignment_AbsentContextIsEmpty(t *testing.T) {
	// Older backends (pre-CTX-1) won't emit `context`. The runner must
	// tolerate the missing field — Context stays nil/empty, no error.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"card":         map[string]any{"id": "card-y", "title": "no ctx"},
			"board":        map[string]any{"id": "b1", "slug": "main", "name": "Main"},
			"column":       map[string]any{"id": "c1", "name": "In Progress", "column_type": "in_progress"},
			"role":         "implementer",
			"stage_action": "implement_card",
			"reservation":  map[string]any{"id": "r1", "expires_at": "2026-04-26T00:00:00Z"},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	resp, err := client.NextAssignment(context.Background(), "default", "agent-1", NextAssignmentRequest{})
	if err != nil {
		t.Fatalf("NextAssignment: %v", err)
	}
	if len(resp.Context) != 0 {
		t.Errorf("expected empty Context on legacy payload, got %v", resp.Context)
	}
}

func TestNextAssignmentNoWork(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test_key")
	resp, err := client.NextAssignment(context.Background(), "default", "agent-1", NextAssignmentRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if resp != nil {
		t.Errorf("expected nil response on 204, got %+v", resp)
	}
}

func TestNextAssignmentBusy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"error_code":"agent_busy","detail":"...","active_card_id":"abc"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test_key")
	_, err := client.NextAssignment(context.Background(), "default", "agent-1", NextAssignmentRequest{})
	if err == nil {
		t.Fatal("expected error for 409")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 409 {
		t.Errorf("status = %d", apiErr.StatusCode)
	}
	if !strings.Contains(apiErr.Body, "agent_busy") {
		t.Errorf("body should mention agent_busy: %s", apiErr.Body)
	}
}

// CreateReviewNote must send kind="review_verdict" so the backend stores the
// note as immutable verdict-of-record (cb652017). Without this kind, anyone
// can DELETE the verdict and the orchestrator's Done-gate sees no objection.
func TestCreateReviewNote_SendsReviewVerdictKind(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if err := client.CreateReviewNote(context.Background(), "ws", "board-1", "card-1", "approve", "LGTM"); err != nil {
		t.Fatalf("CreateReviewNote: %v", err)
	}

	if captured["kind"] != "review_verdict" {
		t.Errorf("kind = %v, want %q", captured["kind"], "review_verdict")
	}
	if captured["card_id"] != "card-1" {
		t.Errorf("card_id = %v, want %q", captured["card_id"], "card-1")
	}
	if title, ok := captured["title"].(string); !ok || !strings.Contains(title, "approve") {
		t.Errorf("title = %v, want to contain 'approve'", captured["title"])
	}
}

func TestGetCardVerdict_ApproveResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/ws/boards/board-1/cards/card-1/verdict" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(CardVerdict{
			Decision:  "approve",
			NoteID:    "note-1",
			CreatedAt: "2026-04-25T10:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	v, err := client.GetCardVerdict(context.Background(), "ws", "board-1", "card-1")
	if err != nil {
		t.Fatalf("GetCardVerdict: %v", err)
	}
	if v == nil {
		t.Fatal("expected non-nil verdict")
	}
	if v.Decision != "approve" {
		t.Errorf("Decision = %q, want %q", v.Decision, "approve")
	}
}

// pipelineRole must round-trip into the POST body when non-empty so the backend
// can attribute the claim to the correct pipeline stage (e.g. "reviewer" vs
// "implementer" — both may share participant_role="helper").
func TestAddCardDependency_PostsToDependenciesEndpoint(t *testing.T) {
	var capturedPath string
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if err := client.AddCardDependency(context.Background(), "ws", "b1", "source", "blocker"); err != nil {
		t.Fatalf("AddCardDependency: %v", err)
	}
	wantPath := "/api/workspaces/ws/boards/b1/cards/source/dependencies"
	if capturedPath != wantPath {
		t.Errorf("path = %q, want %q", capturedPath, wantPath)
	}
	if captured["depends_on_card_id"] != "blocker" {
		t.Errorf("depends_on_card_id = %v, want %q", captured["depends_on_card_id"], "blocker")
	}
}

func TestAddCardParticipant_IncludesPipelineRoleWhenSet(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if err := client.AddCardParticipant(context.Background(), "ws", "b1", "c1", "user-1", "helper", "agent-1", "reviewer"); err != nil {
		t.Fatalf("AddCardParticipant: %v", err)
	}
	if captured["pipeline_role"] != "reviewer" {
		t.Errorf("pipeline_role = %v, want %q", captured["pipeline_role"], "reviewer")
	}
	if captured["user_id"] != "user-1" {
		t.Errorf("user_id = %v, want %q", captured["user_id"], "user-1")
	}
	if captured["role"] != "helper" {
		t.Errorf("role = %v, want %q", captured["role"], "helper")
	}
	if captured["agent_id"] != "agent-1" {
		t.Errorf("agent_id = %v, want %q", captured["agent_id"], "agent-1")
	}
}

// Empty pipelineRole must be omitted from the body — keeps the wire format
// clean for callers (MCP tool, legacy paths) that have no stage attribution.
func TestAddCardParticipant_OmitsPipelineRoleWhenEmpty(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if err := client.AddCardParticipant(context.Background(), "ws", "b1", "c1", "user-1", "helper", "", ""); err != nil {
		t.Fatalf("AddCardParticipant: %v", err)
	}
	if _, present := captured["pipeline_role"]; present {
		t.Errorf("pipeline_role should be omitted when empty, got %v", captured["pipeline_role"])
	}
	if _, present := captured["agent_id"]; present {
		t.Errorf("agent_id should be omitted when empty, got %v", captured["agent_id"])
	}
}

func TestGetCardVerdict_NotFoundReturnsNilNil(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"No verdict found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	v, err := client.GetCardVerdict(context.Background(), "ws", "board-1", "card-1")
	if err != nil {
		t.Fatalf("GetCardVerdict on 404 must not error, got: %v", err)
	}
	if v != nil {
		t.Errorf("expected nil verdict on 404, got %+v", v)
	}
}
