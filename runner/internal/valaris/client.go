// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	neturl "net/url"
	"strings"
	"time"
)

// Client provides REST access to the Valaris backend.
//
// Deterministic operations (discover, claim, ship, move, fail, cost, review
// notes, heartbeat, identity, approval) use direct REST calls. Creative work
// (implement, review, mediate, document) flows through the LLM via MCP tools.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client

	// Resolved on Init.
	UserID string
	Agent  *AgentConfig
}

// NewClient creates a minimal Valaris API client for identity resolution.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: baseURL,
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// Init resolves the user identity behind the API key, and optionally
// the agent config if the key is linked to an agent record.
func (c *Client) Init(ctx context.Context) error {
	user, err := c.GetMe(ctx)
	if err != nil {
		return fmt.Errorf("resolving identity: %w", err)
	}
	c.UserID = user.ID

	agent, err := c.GetAgentConfig(ctx)
	if err != nil {
		return fmt.Errorf("resolving agent config: %w", err)
	}
	c.Agent = agent // nil when no agent is linked (404)
	return nil
}

// GetMe returns the user profile linked to the API key.
func (c *Client) GetMe(ctx context.Context) (*User, error) {
	req, err := c.newRequest(ctx, http.MethodGet, c.baseURL+"/api/me", nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var user User
	if err := json.Unmarshal(body, &user); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}
	return &user, nil
}

// GetAgentConfig returns the agent config linked to the API key.
// Returns (nil, nil) if the server responds with 404 (no agent linked).
func (c *Client) GetAgentConfig(ctx context.Context) (*AgentConfig, error) {
	req, err := c.newRequest(ctx, http.MethodGet, c.baseURL+"/api/agents/me", nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}

	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var agent AgentConfig
	if err := json.Unmarshal(body, &agent); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}
	return &agent, nil
}

// Heartbeat sends a heartbeat to the platform and updates the local agent config
// with the server's response. No-op if no agent is linked.
// An optional HealthReport is sent as the JSON body when provided.
func (c *Client) Heartbeat(ctx context.Context, report ...*HealthReport) error {
	if c.Agent == nil {
		return nil
	}

	var body io.Reader
	if len(report) > 0 && report[0] != nil {
		data, err := json.Marshal(report[0])
		if err != nil {
			return fmt.Errorf("marshaling health report: %w", err)
		}
		body = bytes.NewReader(data)
	}

	req, err := c.newRequest(ctx, http.MethodPost, c.baseURL+"/api/agents/me/heartbeat", body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return &APIError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	var updated AgentConfig
	if err := json.Unmarshal(respBody, &updated); err != nil {
		return fmt.Errorf("decoding heartbeat response: %w", err)
	}
	c.Agent = &updated
	return nil
}

// GetApprovalStatus fetches the current status of an approval request.
func (c *Client) GetApprovalStatus(ctx context.Context, workspaceSlug, approvalID string) (*ApprovalStatus, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/approvals/%s", c.baseURL, workspaceSlug, approvalID)
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var approval ApprovalStatus
	if err := json.Unmarshal(body, &approval); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}
	return &approval, nil
}

// PollApproval polls an approval until it reaches a terminal status or the
// context is cancelled. The first check happens immediately (no initial wait).
func (c *Client) PollApproval(ctx context.Context, workspaceSlug, approvalID string, interval time.Duration) (*ApprovalStatus, error) {
	// Check immediately before starting the ticker.
	approval, err := c.GetApprovalStatus(ctx, workspaceSlug, approvalID)
	if err != nil {
		return nil, err
	}
	if isTerminalApprovalStatus(approval.Status) {
		return approval, nil
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			approval, err = c.GetApprovalStatus(ctx, workspaceSlug, approvalID)
			if err != nil {
				return nil, err
			}
			if isTerminalApprovalStatus(approval.Status) {
				return approval, nil
			}
		}
	}
}

// PollApprovalWithEvents polls approval status using both HTTP polling and an
// optional WebSocket signal channel. The signal channel provides near-instant
// notification when an approval is decided; HTTP polling serves as fallback.
// Pass nil for events to use pure HTTP polling (identical to PollApproval).
func (c *Client) PollApprovalWithEvents(ctx context.Context, workspaceSlug, approvalID string, interval time.Duration, events <-chan struct{}) (*ApprovalStatus, error) {
	// Immediate check — approval may already be decided.
	approval, err := c.GetApprovalStatus(ctx, workspaceSlug, approvalID)
	if err != nil {
		return nil, err
	}
	if isTerminalApprovalStatus(approval.Status) {
		return approval, nil
	}

	// Fall back to pure polling when no event channel is provided.
	if events == nil {
		return c.PollApproval(ctx, workspaceSlug, approvalID, interval)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			approval, err = c.GetApprovalStatus(ctx, workspaceSlug, approvalID)
			if err != nil {
				return nil, err
			}
			if isTerminalApprovalStatus(approval.Status) {
				return approval, nil
			}
		case <-events:
			// WS event received — confirming HTTP fetch for canonical state.
			approval, err = c.GetApprovalStatus(ctx, workspaceSlug, approvalID)
			if err != nil {
				return nil, err
			}
			if isTerminalApprovalStatus(approval.Status) {
				return approval, nil
			}
		}
	}
}

func isTerminalApprovalStatus(status string) bool {
	switch status {
	case "approved", "auto_approved", "rejected", "expired":
		return true
	}
	return false
}

// GetPlatformConfig fetches the composite config from GET /api/agents/me/config.
//
// workspaceSlug selects which workspace's pipeline_config the platform serves.
// Omitting it lets the backend guess from team membership, which served the
// wrong workspace's config in the 2026-05-19 incident; an empty slug falls back
// to that legacy behavior rather than asking for the empty-named workspace.
func (c *Client) GetPlatformConfig(ctx context.Context, workspaceSlug string) (*PlatformConfig, error) {
	url := fmt.Sprintf("%s/api/agents/me/config", c.baseURL)
	if workspaceSlug != "" {
		url += "?workspace_slug=" + neturl.QueryEscape(workspaceSlug)
	}
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var config PlatformConfig
	if err := json.Unmarshal(body, &config); err != nil {
		return nil, fmt.Errorf("decoding config response: %w", err)
	}
	return &config, nil
}

// ErrLoopNotConfigured is the legacy, conflated sentinel for any HTTP 404
// from GetBoardLoop — kept so existing callers that only check
// errors.Is(err, ErrLoopNotConfigured) keep working unchanged. New callers
// should check the more specific ErrBoardLoopNotConfigured /
// ErrLoopEndpointUnsupported below, which GetBoardLoop always joins this
// sentinel with (via errors.Join, so errors.Is still matches either way).
var ErrLoopNotConfigured = errors.New("board has no loop config / backend does not support loop mode yet")

// ErrBoardLoopNotConfigured means the backend served an application-level 404
// (a ValarisError, identifiable by the response body carrying "error_code")
// for this exact board: a real board that was never PUT a loop config, a
// wrong/deleted board ID, or a workspace/board mismatch. Actionable fix:
// check -loop-board and the workspace slug.
var ErrBoardLoopNotConfigured = errors.New("board has no loop config configured — check -loop-board and the workspace slug, or PUT a loop config for this board")

// ErrLoopEndpointUnsupported means the 404 never reached application code —
// no "error_code" in the body — i.e. FastAPI's own catch-all for a path with
// no matching route. This is a pre-rollout backend that doesn't serve the
// board loop endpoint at all. Actionable fix: upgrade the backend.
var ErrLoopEndpointUnsupported = errors.New("backend does not support the board loop endpoint — upgrade the backend")

// GetBoardLoop fetches the board's loop mode config. On HTTP 404 it returns
// (nil, err) where err always matches errors.Is(err, ErrLoopNotConfigured)
// (legacy compatibility) AND exactly one of ErrBoardLoopNotConfigured /
// ErrLoopEndpointUnsupported, distinguished by whether the 404 body carries
// "error_code" (application ValarisError) or not (FastAPI's unrouted-path
// catch-all — see client_loop_404_split_test.go for the backend evidence).
// Other failures wrap with context like every other client method.
func (c *Client) GetBoardLoop(ctx context.Context, workspaceSlug, boardID string) (*BoardLoopConfig, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/loop", c.baseURL, workspaceSlug, boardID)
	cfg, err := jsonGet[*BoardLoopConfig](ctx, c, url)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound {
			if strings.Contains(apiErr.Body, "error_code") {
				return nil, errors.Join(ErrBoardLoopNotConfigured, ErrLoopNotConfigured)
			}
			return nil, errors.Join(ErrLoopEndpointUnsupported, ErrLoopNotConfigured)
		}
		return nil, fmt.Errorf("fetching board loop config: %w", err)
	}
	if cfg == nil {
		return nil, fmt.Errorf("board loop config is null")
	}
	if err := cfg.ValidateCompletionContract(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// ErrLoopReadinessUnsupported means GET .../loop/readiness 404'd. The
// endpoint is a pure board read served for ANY existing board (configured
// loop or not), so once GetBoardLoop has succeeded for the same board a 404
// here can only mean a pre-rollout backend without the route. Callers fall
// back to always_run behavior.
var ErrLoopReadinessUnsupported = errors.New("backend does not serve the loop readiness probe — upgrade the backend (falling back to always_run)")

// GetLoopReadiness fetches the board-level starvation probe.
func (c *Client) GetLoopReadiness(ctx context.Context, workspaceSlug, boardID string) (*LoopReadiness, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/loop/readiness", c.baseURL, workspaceSlug, boardID)
	readiness, err := jsonGet[*LoopReadiness](ctx, c, url)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound {
			return nil, ErrLoopReadinessUnsupported
		}
		return nil, fmt.Errorf("fetching loop readiness: %w", err)
	}
	return readiness, nil
}

// GetLoopStatus fetches the loop truth layer — the same payload the web chip
// renders, so both surfaces name a board's loop state with one vocabulary.
// Like GetBoardLoop, a 404 with no "error_code" is FastAPI's unrouted-path
// catch-all (a backend predating the endpoint) and maps to
// ErrLoopEndpointUnsupported so callers can fail soft; a 404 WITH error_code
// can only be board-not-found here, since an unconfigured loop serves
// state="off" rather than 404ing, and it stays a plain wrapped error.
func (c *Client) GetLoopStatus(ctx context.Context, workspaceSlug, boardID string) (*LoopStatus, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/loop/status", c.baseURL, workspaceSlug, boardID)
	status, err := jsonGet[*LoopStatus](ctx, c, url)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound &&
			!strings.Contains(apiErr.Body, "error_code") {
			return nil, ErrLoopEndpointUnsupported
		}
		return nil, fmt.Errorf("fetching loop status: %w", err)
	}
	return status, nil
}

// ErrLoopHistoryUnsupported means GET .../loop/history 404'd — a pre-rollout
// backend. Budget-dependent execution must stop until history is available.
var ErrLoopHistoryUnsupported = errors.New("backend does not serve required loop spending history — upgrade the backend before launching")

// GetLoopHistory fetches the cross-run continuity aggregate.
func (c *Client) GetLoopHistory(ctx context.Context, workspaceSlug, boardID string) (*LoopHistory, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/loop/history", c.baseURL, workspaceSlug, boardID)
	history, err := jsonGet[*LoopHistory](ctx, c, url)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound {
			return nil, ErrLoopHistoryUnsupported
		}
		return nil, fmt.Errorf("required loop spending history is unavailable or incompatible; restore backend access before launching")
	}
	if history == nil {
		return nil, fmt.Errorf("required loop spending history is missing; restore backend compatibility before launching")
	}
	return history, nil
}

// SetBoardLoopState flips the loop's enabled flag via PATCH .../loop/state.
// Any member or agent key may call this — agents must be able to turn a loop
// off autonomously when the operator-authored loop_prompt tells them to.
func (c *Client) SetBoardLoopState(ctx context.Context, workspaceSlug, boardID string, enabled bool, reason string) error {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/loop/state", c.baseURL, workspaceSlug, boardID)
	body := map[string]any{
		"enabled": enabled,
		"reason":  reason,
	}
	return c.jsonRequest(ctx, http.MethodPatch, url, body)
}

// SetBoardLoopStateWithStructuredReason only disables: it intentionally has
// no enabled input, and both the structured request and its legacy fallback
// always send enabled=false. It sends an automatic stop's stable code and
// technical context alongside the byte-compatible legacy reason. A 422
// from a pre-structured server is safe to retry once with the exact legacy
// body because its extra=forbid validation rejects the first request before
// applying state. No other status is retried.
func (c *Client) SetBoardLoopStateWithStructuredReason(
	ctx context.Context,
	workspaceSlug, boardID string,
	reason string,
	structuredReason BoardLoopStructuredReason,
) error {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/loop/state", c.baseURL, workspaceSlug, boardID)
	body := struct {
		Enabled      bool                `json:"enabled"`
		Reason       string              `json:"reason"`
		ReasonCode   BoardLoopReasonCode `json:"reason_code,omitempty"`
		ReasonParams map[string]any      `json:"reason_params,omitempty"`
		Diagnostic   string              `json:"diagnostic,omitempty"`
	}{
		Enabled:      false,
		Reason:       reason,
		ReasonCode:   structuredReason.Code,
		ReasonParams: structuredReason.Params,
		Diagnostic:   structuredReason.Diagnostic,
	}

	structuredErr := c.jsonRequest(ctx, http.MethodPatch, url, body)
	if structuredErr == nil {
		return nil
	}

	var apiErr *APIError
	if !errors.As(structuredErr, &apiErr) || apiErr.StatusCode != http.StatusUnprocessableEntity {
		return structuredErr
	}

	legacyErr := c.SetBoardLoopState(ctx, workspaceSlug, boardID, false, reason)
	if legacyErr == nil {
		return nil
	}
	return errors.Join(
		fmt.Errorf("structured loop-state request rejected: %w", structuredErr),
		fmt.Errorf("legacy loop-state fallback failed: %w", legacyErr),
	)
}

// GetBudgetStatus fetches the current budget status for this agent.
// Returns (nil, error) on HTTP failure, (*BudgetStatus, nil) on success.
func (c *Client) GetBudgetStatus(ctx context.Context) (*BudgetStatus, error) {
	if c.Agent == nil {
		return nil, fmt.Errorf("no agent linked")
	}
	url := fmt.Sprintf("%s/api/agents/me/budget-status", c.baseURL)
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var status BudgetStatus
	if err := json.Unmarshal(body, &status); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}
	return &status, nil
}

// FailExecution marks an execution as failed via direct REST.
// This avoids an expensive LLM call on the error path.
func (c *Client) FailExecution(ctx context.Context, agentID, executionID, errorMsg string) error {
	body := map[string]any{
		"status":        "failed",
		"error_message": errorMsg,
	}
	url := fmt.Sprintf("%s/api/agents/%s/executions/%s", c.baseURL, agentID, executionID)
	return c.jsonRequest(ctx, http.MethodPatch, url, body)
}

// MoveCard moves a card to a target column via direct REST.
func (c *Client) MoveCard(ctx context.Context, workspaceSlug, boardID, cardID, columnID string, position float64) error {
	body := map[string]any{
		"column_id": columnID,
		"position":  position,
	}
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s/move", c.baseURL, workspaceSlug, boardID, cardID)
	return c.jsonRequest(ctx, http.MethodPatch, url, body)
}

// RemoveCardParticipant removes a user from a card via direct REST.
func (c *Client) RemoveCardParticipant(ctx context.Context, workspaceSlug, boardID, cardID, userID string) error {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s/participants/%s", c.baseURL, workspaceSlug, boardID, cardID, userID)
	return c.jsonRequest(ctx, http.MethodDelete, url, nil)
}

// RemoveCardParticipantsByRole drops every participant carrying the given
// pipeline_role — used to clear a stale owner (e.g. the prior implementer's
// hero) when a card is handed back for rework in a multi-agent deployment,
// where that owner is a different user than the caller (so $self can't reach
// it). Idempotent server-side: zero matches is a success.
func (c *Client) RemoveCardParticipantsByRole(ctx context.Context, workspaceSlug, boardID, cardID, pipelineRole string) error {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s/participants/by-pipeline-role/%s", c.baseURL, workspaceSlug, boardID, cardID, pipelineRole)
	return c.jsonRequest(ctx, http.MethodDelete, url, nil)
}

// UpdateExecutionCost reports cost and token usage for an execution via direct REST.
func (c *Client) UpdateExecutionCost(ctx context.Context, agentID, executionID string, tokensUsed int, costUSD float64) error {
	body := map[string]any{}
	if tokensUsed > 0 {
		body["tokens_used"] = tokensUsed
	}
	if costUSD > 0 {
		body["cost_usd"] = costUSD
	}
	if len(body) == 0 {
		return nil
	}
	url := fmt.Sprintf("%s/api/agents/%s/executions/%s", c.baseURL, agentID, executionID)
	return c.jsonRequest(ctx, http.MethodPatch, url, body)
}

// ClaimCard atomically claims a card for an agent. Returns nil on success,
// APIError with StatusCode 409 if already claimed.
func (c *Client) ClaimCard(ctx context.Context, workspaceSlug, boardID, cardID, agentID string) error {
	body := map[string]any{"agent_id": agentID}
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s/claim", c.baseURL, workspaceSlug, boardID, cardID)
	return c.jsonRequest(ctx, http.MethodPost, url, body)
}

// EnqueueForMerge posts an approved PR onto the backend merge queue (PAR-2).
// Idempotent: re-enqueue of the same card_id returns the existing entry. The
// runner only calls this when pipeline_config.merge_via_queue is true; the
// default-false path stays on applyApproveMergeGate.
func (c *Client) EnqueueForMerge(ctx context.Context, workspaceSlug, cardID, repoID, prURL, prBranch, integrationBranch string) error {
	body := map[string]any{
		"card_id":   cardID,
		"repo_id":   repoID,
		"pr_url":    prURL,
		"pr_branch": prBranch,
	}
	if integrationBranch != "" {
		body["integration_branch"] = integrationBranch
	}
	url := fmt.Sprintf("%s/api/workspaces/%s/merge-queue/enqueue", c.baseURL, workspaceSlug)
	return c.jsonRequest(ctx, http.MethodPost, url, body)
}

// GetBoard fetches board details including columns. Returns columns as a list of maps.
func (c *Client) GetBoard(ctx context.Context, workspaceSlug, boardID string) ([]BoardColumn, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s", c.baseURL, workspaceSlug, boardID)
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var board struct {
		Columns []BoardColumn `json:"columns"`
	}
	if err := json.Unmarshal(body, &board); err != nil {
		return nil, fmt.Errorf("decoding board: %w", err)
	}
	return board.Columns, nil
}

// GetPromptConfigs fetches prompt configs for a workspace, optionally filtered by team role.
func (c *Client) GetPromptConfigs(ctx context.Context, workspaceSlug, teamRole string) ([]PromptConfig, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/prompt-configs", c.baseURL, workspaceSlug)
	if teamRole != "" {
		url += "?team_role=" + teamRole
	}

	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var configs []PromptConfig
	if err := json.Unmarshal(body, &configs); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}
	return configs, nil
}

// GetProjectDirectives fetches the definition coding standards and pinned board
// notes via REST. These are injected directly into the implement prompt so the
// LLM treats them as mandatory instructions rather than optional tool-call context.
func (c *Client) GetProjectDirectives(ctx context.Context, workspaceSlug, boardID string) (*ProjectDirectives, error) {
	directives := &ProjectDirectives{}

	// 1. Fetch board context for definition.
	ctxURL := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/context", c.baseURL, workspaceSlug, boardID)
	req, err := c.newRequest(ctx, http.MethodGet, ctxURL, nil)
	if err != nil {
		return directives, fmt.Errorf("building context request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return directives, fmt.Errorf("fetching board context: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return directives, fmt.Errorf("reading context body: %w", err)
	}

	if resp.StatusCode < 400 {
		var ctxResp boardContextResponse
		if err := json.Unmarshal(body, &ctxResp); err == nil && ctxResp.Definition != nil {
			directives.Scope = strings.TrimSpace(ctxResp.Definition.Scope)
			fillDirectivesFromContent(directives, ctxResp.Definition.Content)
		}
	}

	// 2. Fetch pinned notes.
	notesURL := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/notes", c.baseURL, workspaceSlug, boardID)
	req2, err := c.newRequest(ctx, http.MethodGet, notesURL, nil)
	if err != nil {
		return directives, fmt.Errorf("building notes request: %w", err)
	}

	resp2, err := c.httpClient.Do(req2)
	if err != nil {
		return directives, fmt.Errorf("fetching notes: %w", err)
	}
	defer resp2.Body.Close()

	body2, err := io.ReadAll(resp2.Body)
	if err != nil {
		return directives, fmt.Errorf("reading notes body: %w", err)
	}

	if resp2.StatusCode < 400 {
		var notes []noteResponse
		if err := json.Unmarshal(body2, &notes); err == nil {
			for _, n := range notes {
				if n.Pinned && n.Content != "" {
					directives.PinnedNotes = append(directives.PinnedNotes, PinnedNote{
						Title:   n.Title,
						Content: n.Content,
					})
				}
			}
		}
	}

	return directives, nil
}

// CreateNote writes a typed note on a card. kind picks the closed-set kind
// from backend `app.models.notes.kinds`. failureClass is omitted from the
// wire payload when empty so non-rejection notes don't serialize a null
// (the backend distinguishes absent-vs-null).
func (c *Client) CreateNote(ctx context.Context, workspaceSlug, boardID, cardID, kind, title, body, failureClass string, pinned bool) error {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/notes", c.baseURL, workspaceSlug, boardID)
	payload := map[string]any{
		"title":   title,
		"content": body,
		"pinned":  pinned,
		"card_id": cardID,
		"kind":    kind,
	}
	if failureClass != "" {
		payload["failure_class"] = failureClass
	}
	return c.jsonRequest(ctx, http.MethodPost, url, payload)
}

// CreateCard creates a board card in the given column. Used by the
// create_fix_cards lifecycle kind so an auditor role (e.g. ui_validator) can
// file follow-up work without an LLM tool call — the runner controls the
// title/labels/priority/column so routing labels are deterministic. Returns the
// new card's id (best-effort: empty string if the response can't be decoded,
// which does not fail the create — the card exists server-side regardless).
//
// gitRepoSlug routes the card to a REGISTERED repo on multi-repo boards;
// empty omits the key so the backend applies its own primary-repo default
// (never send "" or a repo display name — an unknown slug misroutes).
func (c *Client) CreateCard(ctx context.Context, workspaceSlug, boardID, columnID, title, description, cardType, priority, gitRepoSlug string, labels []string) (string, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards", c.baseURL, workspaceSlug, boardID)
	payload := map[string]any{
		"column_id":   columnID,
		"title":       title,
		"description": description,
	}
	if gitRepoSlug != "" {
		payload["git_repo_slug"] = gitRepoSlug
	}
	if cardType != "" {
		payload["card_type"] = cardType
	}
	if priority != "" {
		payload["priority"] = priority
	}
	if labels != nil {
		payload["labels"] = labels
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := c.jsonRequestDecode(ctx, http.MethodPost, url, payload, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

// AddCardDependency declares that cardID depends on dependsOnCardID. The
// scheduler's all_dependencies_done discover filter then refuses to assign
// cardID until dependsOnCardID lives in a done column. Idempotent server-side
// (re-adding an existing edge is a 200, not an error). Used by create_fix_cards
// so a validator's spawned fix cards BLOCK the card under validation — the card
// can't be re-validated until every fix merges.
func (c *Client) AddCardDependency(ctx context.Context, workspaceSlug, boardID, cardID, dependsOnCardID string) error {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s/dependencies", c.baseURL, workspaceSlug, boardID, cardID)
	return c.jsonRequest(ctx, http.MethodPost, url, map[string]any{
		"depends_on_card_id": dependsOnCardID,
	})
}

// CreateReviewNote creates a board note with deterministic title format for review findings.
// This bypasses the LLM — the Go agent controls the note structure, title, and card_id FK.
//
// kind="review_verdict" makes the note immutable on the backend (cb652017): once
// written, neither the reviewer nor any other workspace member may PATCH or
// DELETE it. The orchestrator's Done-gate parses the latest verdict's title
// for the decision token and refuses the merged-PR shortcut on a missing or
// non-approve verdict.
//
// Thin delegate over CreateNote; the wire payload is byte-identical to what
// callers wrote before the refactor.
func (c *Client) CreateReviewNote(ctx context.Context, workspaceSlug, boardID, cardID, decision, findings string) error {
	title := fmt.Sprintf("Review: %s — %s", cardID, decision)
	return c.CreateNote(ctx, workspaceSlug, boardID, cardID, "review_verdict", title, findings, "", false)
}

// GetCardVerdict returns the latest immutable review_verdict for a card, or
// (nil, nil) if none exists. The orchestrator's Done-gate uses this to refuse
// the merged-PR shortcut when the reviewer has not approved (or has filed
// request_changes).
func (c *Client) GetCardVerdict(ctx context.Context, workspaceSlug, boardID, cardID string) (*CardVerdict, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s/verdict", c.baseURL, workspaceSlug, boardID, cardID)
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building verdict request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching verdict: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading verdict body: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var v CardVerdict
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, fmt.Errorf("decoding verdict: %w", err)
	}
	return &v, nil
}

// GetCardReviewNotes fetches notes associated with a specific card.
// Used by the mediator to retrieve review history without LLM involvement.
func (c *Client) GetCardReviewNotes(ctx context.Context, workspaceSlug, boardID, cardID string) ([]ReviewNote, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/notes?card_id=%s", c.baseURL, workspaceSlug, boardID, cardID)
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building review notes request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching review notes: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading review notes body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var notes []ReviewNote
	if err := json.Unmarshal(body, &notes); err != nil {
		return nil, fmt.Errorf("parsing review notes: %w", err)
	}
	return notes, nil
}

// DeleteCardReviewNotes deletes all review notes for a card (by fetching then deleting each).
// Called when a reviewer approves a card to clean up stale review history.
func (c *Client) DeleteCardReviewNotes(ctx context.Context, workspaceSlug, boardID, cardID string) error {
	notes, err := c.GetCardReviewNotes(ctx, workspaceSlug, boardID, cardID)
	if err != nil {
		return fmt.Errorf("listing review notes for cleanup: %w", err)
	}
	// kind=review_verdict notes are immutable on the backend (cb652017) and
	// will return 403. That's intentional — verdicts are the audit trail
	// the Done-gate consults. We log the warning, skip the verdict, and
	// continue cleaning up any user-kind review notes that pre-dated the
	// immutability enforcement.
	for _, n := range notes {
		url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/notes/%s", c.baseURL, workspaceSlug, boardID, n.ID)
		if err := c.jsonRequest(ctx, http.MethodDelete, url, nil); err != nil {
			slog.Warn("failed to delete review note", "note_id", n.ID, "error", err)
		}
	}
	return nil
}

// SearchCards searches for cards on a board with optional filters.
func (c *Client) SearchCards(ctx context.Context, workspaceSlug, boardID string, params SearchCardsParams) ([]Card, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/search", c.baseURL, workspaceSlug, boardID)

	// Build query string from non-zero params.
	sep := "?"
	addParam := func(key, val string) {
		url += sep + key + "=" + neturl.QueryEscape(val)
		sep = "&"
	}
	if params.AssigneeID != "" {
		addParam("assignee_id", params.AssigneeID)
	}
	if params.ColumnType != "" {
		addParam("column_type", params.ColumnType)
	}
	if params.ExcludeColumnType != "" {
		addParam("exclude_column_type", params.ExcludeColumnType)
	}
	if params.HasAssignee != nil {
		if *params.HasAssignee {
			addParam("has_assignee", "true")
		} else {
			addParam("has_assignee", "false")
		}
	}
	if params.Label != "" {
		addParam("label", params.Label)
	}
	if params.Priority != "" {
		addParam("priority", params.Priority)
	}
	if params.Limit > 0 {
		addParam("limit", fmt.Sprintf("%d", params.Limit))
	}
	if params.AllDependenciesDone {
		addParam("all_dependencies_done", "true")
	}

	return jsonGet[[]Card](ctx, c, url)
}

// GetCard fetches a single card by ID.
func (c *Client) GetCard(ctx context.Context, workspaceSlug, boardID, cardID string) (*Card, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s", c.baseURL, workspaceSlug, boardID, cardID)
	return jsonGet[*Card](ctx, c, url)
}

// ListGitRepos returns git repos linked to a board.
func (c *Client) ListGitRepos(ctx context.Context, workspaceSlug, boardID string) ([]GitRepo, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/git-repos", c.baseURL, workspaceSlug, boardID)
	return jsonGet[[]GitRepo](ctx, c, url)
}

// ListWorkspaces returns the workspaces the caller belongs to. The endpoint is
// guarded by get_current_user alone (NOT forbid_agent_callers), so an agent key
// resolves to its creating user and sees that user's workspaces — which may be
// a wider set than the key's own allowed_workspaces.
func (c *Client) ListWorkspaces(ctx context.Context) ([]Workspace, error) {
	return jsonGet[[]Workspace](ctx, c, c.baseURL+"/api/workspaces")
}

// ListBoards returns all boards in a workspace.
func (c *Client) ListBoards(ctx context.Context, workspaceSlug string) ([]Board, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards", c.baseURL, workspaceSlug)
	return jsonGet[[]Board](ctx, c, url)
}

// LogExecutionStart creates a new execution record and returns the execution ID.
func (c *Client) LogExecutionStart(ctx context.Context, agentID, workspaceSlug, action, boardID, cardID, inputSummary, role string) (string, error) {
	return c.LogExecutionStartWithLLM(ctx, agentID, workspaceSlug, action, boardID, cardID, inputSummary, role, "", "", "")
}

// LogExecutionStartWithLLM is the extended form that also stamps the prompt
// slug + RESOLVED LLM provider+model on the execution row. The provider+model
// are what the runner ACTUALLY ran (after the tier_providers remap), not the
// backend's tier suggestion — so the activity feed shows the truth. Empty
// promptSlug/model/provider omits each field (NULL in storage) so older
// backends still accept the payload — Wave 2 / CRIT-2.
//
// cardID binds the execution to the card it's working FROM THE START, so the
// backend records it as cards_affected[0] and agent_presence flips to 'active'
// the moment work begins — the board no longer waits on the LLM to remember a
// log_execution_update(cards_affected=...) call. Empty cardID omits the field
// (non-card stages, older backends).
func (c *Client) LogExecutionStartWithLLM(
	ctx context.Context,
	agentID, workspaceSlug, action, boardID, cardID, inputSummary, role, promptSlug, model, provider string,
) (string, error) {
	return c.LogExecutionStartWithSkills(ctx, agentID, workspaceSlug, action, boardID, cardID,
		inputSummary, role, promptSlug, model, provider, nil)
}

// LogExecutionStartWithSkills is the widest form: it additionally records which
// workspace skills were materialized into the working tree for this execution,
// so the activity feed can answer "what was this agent working with?". An empty
// manifest omits the field entirely, keeping the payload byte-identical to the
// pre-registry shape for backends without the column.
func (c *Client) LogExecutionStartWithSkills(
	ctx context.Context,
	agentID, workspaceSlug, action, boardID, cardID, inputSummary, role, promptSlug, model, provider string,
	skills []AssignmentSkill,
) (string, error) {
	url := fmt.Sprintf("%s/api/agents/%s/executions", c.baseURL, agentID)
	payload := map[string]any{
		"workspace_slug": workspaceSlug,
		"action":         action,
		"input_summary":  inputSummary,
	}
	if boardID != "" {
		payload["board_id"] = boardID
	}
	if cardID != "" {
		payload["card_id"] = cardID
	}
	if role != "" {
		payload["role"] = role
	}
	if promptSlug != "" {
		payload["prompt_slug"] = promptSlug
	}
	if model != "" {
		payload["model"] = model
	}
	if provider != "" {
		payload["provider"] = provider
	}
	if len(skills) > 0 {
		payload["skills"] = skills
	}

	var exec Execution
	if err := c.jsonRequestDecode(ctx, http.MethodPost, url, payload, &exec); err != nil {
		return "", err
	}
	return exec.ID, nil
}

// LogExecutionUpdate updates an existing execution record.
func (c *Client) LogExecutionUpdate(ctx context.Context, agentID, executionID, status, outputSummary string) error {
	body := map[string]any{
		"status":         status,
		"output_summary": outputSummary,
	}
	url := fmt.Sprintf("%s/api/agents/%s/executions/%s", c.baseURL, agentID, executionID)
	return c.jsonRequest(ctx, http.MethodPatch, url, body)
}

// LogExecutionUpdateWithMetrics is loop mode's completion call: it carries the
// same status+outputSummary every completion sends, plus the structured
// tokens_used/cost_usd/duration_seconds the runner already computes via
// resultCost/resultDuration. The human-readable summary stays for older
// frontends that don't render the structured columns yet. Zero-valued
// metrics are omitted (same omit-zero style as UpdateExecutionCost) so a
// pre-provider failure — which has no real Result to report from — can't
// have its "we don't know" silently fabricated into a "this cost nothing" 0.
func (c *Client) LogExecutionUpdateWithMetrics(ctx context.Context, agentID, executionID, status, outputSummary string, tokensUsed int, costUSD float64, durationSeconds float64) error {
	body := map[string]any{
		"status":         status,
		"output_summary": outputSummary,
	}
	if tokensUsed > 0 {
		body["tokens_used"] = tokensUsed
	}
	if costUSD > 0 {
		body["cost_usd"] = costUSD
	}
	if durationSeconds > 0 {
		body["duration_seconds"] = durationSeconds
	}
	url := fmt.Sprintf("%s/api/agents/%s/executions/%s", c.baseURL, agentID, executionID)
	return c.jsonRequest(ctx, http.MethodPatch, url, body)
}

// LogExecutionUpdateWithShipWarnings updates an execution and forwards any
// non-fatal stage warnings (e.g. "auto-merge arming failed: Protected branch
// rules not configured"). Empty/nil warnings omits the field entirely so
// backend storage keeps the null-vs-empty distinction intact. Used by the
// ship path; other completion paths stick with LogExecutionUpdate.
func (c *Client) LogExecutionUpdateWithShipWarnings(ctx context.Context, agentID, executionID, status, outputSummary string, shipWarnings []string) error {
	body := map[string]any{
		"status":         status,
		"output_summary": outputSummary,
	}
	if len(shipWarnings) > 0 {
		body["ship_warnings"] = shipWarnings
	}
	url := fmt.Sprintf("%s/api/agents/%s/executions/%s", c.baseURL, agentID, executionID)
	return c.jsonRequest(ctx, http.MethodPatch, url, body)
}

// PostExecutionWarning surfaces a non-fatal, in-flight condition (e.g. an
// approval-poll deadline that's about to retry) to the backend so it can
// broadcast a typed `execution.warning` WebSocket event AND append to the
// execution row's ship_warnings. Best-effort: a failed POST must not block
// the underlying retry — callers log and continue.
//
// kind is a stable enum string (e.g. "approval_poll_deadline"); message is
// the human-readable line shown in HealthCard/AgentStatusBar; cardID lets
// the operator jump straight to the offending card.
func (c *Client) PostExecutionWarning(ctx context.Context, agentID, executionID, kind, message, cardID string) error {
	body := map[string]any{
		"kind":    kind,
		"message": message,
	}
	if cardID != "" {
		body["card_id"] = cardID
	}
	url := fmt.Sprintf("%s/api/agents/%s/executions/%s/warnings", c.baseURL, agentID, executionID)
	return c.jsonRequest(ctx, http.MethodPost, url, body)
}

// UpdateExecutionPrompt persists the rendered prompt on an execution record.
// Best-effort: callers should log warnings on failure but not abort the tick.
func (c *Client) UpdateExecutionPrompt(ctx context.Context, agentID, executionID, prompt string) error {
	body := map[string]any{
		"input_prompt": prompt,
	}
	url := fmt.Sprintf("%s/api/agents/%s/executions/%s", c.baseURL, agentID, executionID)
	return c.jsonRequest(ctx, http.MethodPatch, url, body)
}

// AppendDefinitionLearning adds a reviewer learning to the board definition's
// "reviewer_learnings" content key. Fetches current definition, appends the
// new entry, and PUTs the merged content. Best-effort — callers should log
// warnings on failure but not abort the tick.
func (c *Client) AppendDefinitionLearning(ctx context.Context, workspaceSlug, boardID, learning string) error {
	defURL := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/definitions", c.baseURL, workspaceSlug, boardID)

	// GET current definition.
	var defResp struct {
		Content map[string]any `json:"content"`
	}
	req, err := c.newRequest(ctx, http.MethodGet, defURL, nil)
	if err != nil {
		return fmt.Errorf("building definition GET: %w", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("fetching definition: %w", err)
	}
	defer resp.Body.Close()

	content := make(map[string]any)
	if resp.StatusCode < 400 {
		body, _ := io.ReadAll(resp.Body)
		json.Unmarshal(body, &defResp)
		if defResp.Content != nil {
			content = defResp.Content
		}
	}

	// Append the learning to the reviewer_learnings list.
	var learnings []any
	if existing, ok := content["reviewer_learnings"]; ok {
		if arr, ok := existing.([]any); ok {
			learnings = arr
		}
	}
	learnings = append(learnings, learning)
	content["reviewer_learnings"] = learnings

	// PUT the updated content.
	return c.jsonRequest(ctx, http.MethodPut, defURL, map[string]any{
		"content": content,
	})
}

// UpdateCard updates card fields via PATCH.
func (c *Client) UpdateCard(ctx context.Context, workspaceSlug, boardID, cardID string, fields map[string]any) error {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s", c.baseURL, workspaceSlug, boardID, cardID)
	return c.jsonRequest(ctx, http.MethodPatch, url, fields)
}

// AddCardParticipant adds a user as a participant on a card.
//
// pipelineRole attributes the claim to a specific pipeline stage (e.g.
// "reviewer", "implementer") for backends that distinguish stage-of-claim from
// participant_role. Empty string omits the field; this is fine for legacy
// hand-authored stages and for the MCP add_card_participant tool.
func (c *Client) AddCardParticipant(ctx context.Context, workspaceSlug, boardID, cardID, userID, role, agentID, pipelineRole string) error {
	body := map[string]any{
		"user_id": userID,
		"role":    role,
	}
	if agentID != "" {
		body["agent_id"] = agentID
	}
	if pipelineRole != "" {
		body["pipeline_role"] = pipelineRole
	}
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/cards/%s/participants", c.baseURL, workspaceSlug, boardID, cardID)
	return c.jsonRequest(ctx, http.MethodPost, url, body)
}

// refuseEmptyPathSegment guards every request this client makes against a
// caller-supplied ID that resolved to "" (e.g. an agentID from an unlinked
// API key) silently producing a URL like ".../agents//executions/..." —
// which 405s/404s server-side instead of failing at the call site with an
// actionable message. Enforced from newRequest, the single construction
// point, so a new client method gets the guard whether or not it remembers.
func refuseEmptyPathSegment(rawURL string) error {
	parsed, err := neturl.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("parsing request URL: %w", err)
	}
	// Split rather than scan for "//": a single TrimSuffix would let a
	// trailing empty segment (".../boards//", from a blank final ID) pass
	// while still rejecting the interior case. Only ONE trailing "" is
	// legitimate — that is the ordinary ".../boards/" trailing slash.
	segments := strings.Split(parsed.Path, "/")
	if len(segments) > 0 && segments[len(segments)-1] == "" {
		segments = segments[:len(segments)-1]
	}
	// segments[0] is always "" for a rooted path — skip it.
	for _, segment := range segments[1:] {
		if segment == "" {
			return fmt.Errorf("refusing request: URL path %q contains an empty segment (a caller-supplied ID is likely blank)", parsed.Path)
		}
	}
	return nil
}

// newRequest is the ONLY place this client constructs an HTTP request, so
// refuseEmptyPathSegment cannot be bypassed by a method that hand-rolls its
// own request — the guard is structural, not a convention a new method has
// to remember. It also owns the Authorization header for the same reason.
func (c *Client) newRequest(
	ctx context.Context, method, url string, body io.Reader,
) (*http.Request, error) {
	if err := refuseEmptyPathSegment(url); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if method == http.MethodGet && strings.HasSuffix(req.URL.Path, "/loop") {
		req.Header.Set("X-Backplane-Completion-Version", "1")
	}
	return req, nil
}

// jsonGet performs an authenticated GET and decodes the response into T.
func jsonGet[T any](ctx context.Context, c *Client, url string) (T, error) {
	var zero T
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return zero, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return zero, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return zero, fmt.Errorf("reading response body: %w", err)
	}
	if resp.StatusCode >= 400 {
		return zero, &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}

	var result T
	if err := json.Unmarshal(body, &result); err != nil {
		return zero, fmt.Errorf("decoding response: %w", err)
	}
	return result, nil
}

// jsonRequestDecode sends a JSON request and decodes the response into out.
func (c *Client) jsonRequestDecode(ctx context.Context, method, url string, payload, out any) error {
	if err := refuseEmptyPathSegment(url); err != nil {
		return err
	}
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("marshaling request body: %w", err)
		}
		body = bytes.NewReader(data)
	}

	req, err := c.newRequest(ctx, method, url, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response body: %w", err)
	}
	if resp.StatusCode >= 400 {
		return &APIError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}
	return json.Unmarshal(respBody, out)
}

// jsonRequest sends a JSON request and checks the status code.
// Body is optional (nil for DELETE without body).
func (c *Client) jsonRequest(ctx context.Context, method, url string, payload any) error {
	if err := refuseEmptyPathSegment(url); err != nil {
		return err
	}
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("marshaling request body: %w", err)
		}
		body = bytes.NewReader(data)
	}

	req, err := c.newRequest(ctx, method, url, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return &APIError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}
	return nil
}

// APIError represents a non-2xx response from the Valaris API.
type APIError struct {
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("valaris API error (HTTP %d): %s", e.StatusCode, e.Body)
}

// NextAssignmentRequest is the optional body for POST .../next-assignment.
type NextAssignmentRequest struct {
	RoleOverride string `json:"role_override,omitempty"`
	BoardID      string `json:"board_id,omitempty"`
}

// AssignmentBoard / AssignmentColumn / AssignmentRepo / Reservation mirror
// the backend response shape in app/schemas/agents/assignment.py. Keep
// JSON tags in sync.
type AssignmentBoard struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type AssignmentColumn struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ColumnType string `json:"column_type"`
}

type AssignmentRepo struct {
	ID                string `json:"id"`
	Slug              string `json:"slug"`
	Name              string `json:"name"`
	URL               string `json:"url"`
	DefaultBranch     string `json:"default_branch"`
	IntegrationBranch string `json:"integration_branch,omitempty"`
}

type Reservation struct {
	ID        string `json:"id"`
	ExpiresAt string `json:"expires_at"`
}

// AssignmentLLM is the per-stage LLM dispatch info the backend pins on each
// assignment. Provider+Model are backend-authoritative — the runner must use
// them in preference to its local cfg.LLM yaml. PromptSlug names the prompt
// template the runner should render for this stage; falls back to the stage
// name when no operator-authored override exists in the workspace. Empty
// fields signal a pre-rollout backend that didn't ship this block — the
// runner WARNs and falls back to yaml for one deploy cycle (two-deploy
// migration, see feedback_backend_authoritative_config.md).
// ToolPolicy carries the backend-authoritative per-stage tool deny-list. Deny
// is ALWAYS PRESENT in the payload (empty []string when unconfigured) so the
// runner can distinguish "configured empty" from a pre-rollout backend. The
// runner passes it to the LLM via --disallowedTools; an empty list triggers the
// SafeToolDenyFloor fallback so an old/misconfigured backend still can't bypass
// the review gate.
type AssignmentLLM struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	// Tier carries the RAW backend tier name (premium/mid/low) when the stage's
	// model is an abstract tier — empty for a concrete/literal model. It is the
	// provider-agnostic intent: the runner may remap it to a locally-available
	// coding agent via cfg.LLM.tier_providers, treating Provider+Model as the
	// resolved hint/fallback. Empty from a pre-rollout backend (field absent).
	Tier       string `json:"tier"`
	PromptSlug string `json:"prompt_slug"`
	ToolPolicy struct {
		Deny []string `json:"deny"`
	} `json:"tool_policy"`
	// OutputSchema is the backend-authored per-stage JSON Schema for a
	// produces_decision stage whose decision set differs from the default
	// approve/request_changes (e.g. board_reconciler's supersede/no_action/
	// repair/park). Empty for every other stage and for a pre-rollout backend
	// (field absent) → the produces_decision dispatch falls back to the default
	// decisionOutputSchema. Mirrors ToolPolicy.Deny's backend-first resolution.
	OutputSchema string `json:"output_schema"`
}

// NextAssignmentResponse is the 200 body returned by .../next-assignment.
// A 204 (no work) is signaled by NextAssignment returning (nil, nil).
//
// Context (CTX-1/CTX-2) is the backend-rendered context_sources bundle keyed
// by the operator-chosen `as` alias. The runner is a dumb consumer: each
// entry is a fully-rendered string the work loop hands to PromptContext
// without any additional fetches.
type NextAssignmentResponse struct {
	Card        Card              `json:"card"`
	Board       AssignmentBoard   `json:"board"`
	Column      AssignmentColumn  `json:"column"`
	Repo        *AssignmentRepo   `json:"repo,omitempty"`
	Role        string            `json:"role"`
	StageAction string            `json:"stage_action"`
	Reservation Reservation       `json:"reservation"`
	Context     map[string]string `json:"context"`
	LLM         AssignmentLLM     `json:"llm"`
	// Skills is the board's effective skill set, resolved backend-side. Purely
	// additive: backends predating the skills registry omit the field, which
	// decodes to nil and makes the skills_setup step a no-op.
	Skills []AssignmentSkill `json:"skills"`
}

// NextAssignment asks the backend scheduler for one card to work on.
// Returns (nil, nil) on 204 (no eligible card right now). On 409 (the
// agent has an active execution on another card) the returned APIError
// carries the conflict body. On 404 (older backend without this
// endpoint) callers may fall back to legacy discover+claim.
func (c *Client) NextAssignment(ctx context.Context, workspaceSlug, agentID string, req NextAssignmentRequest) (*NextAssignmentResponse, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/agents/%s/next-assignment", c.baseURL, workspaceSlug, agentID)

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshaling next-assignment request: %w", err)
	}

	httpReq, err := c.newRequest(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	var out NextAssignmentResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, fmt.Errorf("unmarshaling next-assignment response: %w", err)
	}
	if out.Card.ID != "" {
		slog.Info("next-assignment reserved",
			"card_id", out.Card.ID, "title", out.Card.Title,
			"priority", out.Card.Priority, "column", out.Column.ColumnType,
			"role", out.Role, "stage_action", out.StageAction, "model", out.LLM.Model)
	}
	return &out, nil
}
