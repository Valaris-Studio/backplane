// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

type CompletionCheck struct {
	ID             string   `json:"id"`
	Argv           []string `json:"argv"`
	TimeoutSeconds int      `json:"timeout_seconds"`
}

type CompletionPolicy struct {
	Version             int      `json:"version"`
	LandingActor        string   `json:"landing_actor"`
	LandingMethods      []string `json:"landing_methods"`
	SourceReview        string   `json:"source_review"`
	ReviewRole          *string  `json:"review_role"`
	RequireForgeChecks  bool     `json:"require_forge_checks"`
	PostmergeValidation *struct {
		Role   string            `json:"role"`
		Checks []CompletionCheck `json:"checks"`
	} `json:"postmerge_validation"`
	EvidenceOnly struct {
		Enabled    bool    `json:"enabled"`
		Approval   string  `json:"approval"`
		ReviewRole *string `json:"review_role"`
	} `json:"evidence_only"`
	DependencyRelease string `json:"dependency_release"`
	AutoComplete      bool   `json:"auto_complete"`
}

func (c *BoardLoopConfig) ValidateCompletionContract() error {
	if c.CompletionPolicy == nil {
		return nil
	}
	if c.CompletionPolicy.Version != 1 {
		return fmt.Errorf("unsupported completion policy version %d; upgrade the runner", c.CompletionPolicy.Version)
	}
	if c.CompletionPolicyHash == "" || c.CompletionContext == "" {
		return fmt.Errorf("completion policy requires its hash and mandatory context; upgrade the backend")
	}
	return nil
}

type CompletionWorkStatus struct {
	PendingCount    int                  `json:"pending_count"`
	ActionableCount int                  `json:"actionable_count"`
	FailedCount     int                  `json:"failed_count"`
	ReworkCount     int                  `json:"rework_count,omitempty"`
	SupportsRework  bool                 `json:"-"`
	Revision        string               `json:"revision,omitempty"`
	Workflows       []CompletionWorkflow `json:"workflows,omitempty"`
	NextCursor      *string              `json:"next_cursor,omitempty"`
}

type CompletionWorkflow struct {
	CardID      string                     `json:"card_id"`
	CandidateID string                     `json:"candidate_id"`
	Phase       string                     `json:"phase"`
	SourceSHA   string                     `json:"source_sha"`
	MergeSHA    *string                    `json:"merge_sha"`
	PolicyHash  string                     `json:"policy_hash"`
	Attempt     *CompletionWorkflowAttempt `json:"attempt"`
	Failure     *CompletionWorkflowFailure `json:"failure"`
	NextAction  string                     `json:"next_action"`
	Summary     string                     `json:"summary"`
}

type CompletionWorkflowAttempt struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	Kind       string `json:"kind"`
	Role       string `json:"role"`
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	ExpiresAt  string `json:"expires_at"`
	LeaseState string `json:"lease_state"`
}

type CompletionWorkflowFailure struct {
	Code      string `json:"code"`
	Retryable bool   `json:"retryable"`
}

func (s *CompletionWorkStatus) UnmarshalJSON(data []byte) error {
	var wire struct {
		Pending    *int                 `json:"pending_count"`
		Actionable *int                 `json:"actionable_count"`
		Failed     *int                 `json:"failed_count"`
		Rework     *int                 `json:"rework_count"`
		Revision   string               `json:"revision"`
		Workflows  []CompletionWorkflow `json:"workflows"`
		NextCursor *string              `json:"next_cursor"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Pending == nil || wire.Actionable == nil || wire.Failed == nil || *wire.Pending < 0 || *wire.Actionable < 0 || *wire.Failed < 0 || (wire.Rework != nil && *wire.Rework < 0) {
		return fmt.Errorf("completion work status is missing valid pending/actionable/failed counts")
	}
	s.PendingCount, s.ActionableCount, s.FailedCount = *wire.Pending, *wire.Actionable, *wire.Failed
	s.ReworkCount = 0
	s.SupportsRework = wire.Rework != nil
	if wire.Rework != nil {
		s.ReworkCount = *wire.Rework
	}
	s.Revision, s.Workflows, s.NextCursor = wire.Revision, wire.Workflows, wire.NextCursor
	return nil
}

func (s *CompletionWorkStatus) Outstanding() bool {
	return s != nil && (s.PendingCount > 0 || s.ActionableCount > 0 || s.FailedCount > 0)
}

type CompletionCapabilities struct {
	Providers     []string `json:"providers"`
	ExactCheckout bool     `json:"exact_checkout"`
	ArgvChecks    bool     `json:"argv_checks"`
}

type CompletionWork struct {
	ExecutionID  string               `json:"execution_id"`
	AttemptID    string               `json:"attempt_id"`
	LeaseToken   string               `json:"lease_token"`
	CandidateID  string               `json:"candidate_id"`
	CardID       string               `json:"card_id"`
	Kind         string               `json:"kind"`
	Role         string               `json:"role"`
	Provider     string               `json:"provider"`
	Model        string               `json:"model"`
	RepoURL      string               `json:"repo_url"`
	SourceSHA    string               `json:"source_sha"`
	PolicyHash   string               `json:"policy_hash"`
	ContractHash string               `json:"contract_hash"`
	Context      string               `json:"context"`
	Checks       []CompletionCheck    `json:"checks"`
	Artifacts    []CompletionArtifact `json:"artifacts,omitempty"`
	ToolPolicy   struct {
		Deny []string `json:"deny"`
	} `json:"tool_policy"`
	ExpiresAt time.Time `json:"expires_at"`
}

type CompletionArtifact struct {
	Name   string `json:"name"`
	URI    string `json:"uri"`
	SHA256 string `json:"sha256"`
}

type CompletionCheckResult struct {
	ID        string `json:"id"`
	ExitCode  int    `json:"exit_code"`
	Output    string `json:"output"`
	SourceSHA string `json:"source_sha"`
}

type CompletionResult struct {
	TokensUsed      int                     `json:"tokens_used"`
	CostUSD         float64                 `json:"cost_usd"`
	DurationSeconds float64                 `json:"duration_seconds"`
	LeaseToken      string                  `json:"lease_token"`
	CandidateID     string                  `json:"candidate_id"`
	PolicyHash      string                  `json:"policy_hash"`
	ContractHash    string                  `json:"contract_hash"`
	SourceSHA       string                  `json:"source_sha"`
	Outcome         string                  `json:"outcome"`
	FailureClass    string                  `json:"failure_class,omitempty"`
	Checks          []CompletionCheckResult `json:"checks"`
	Summary         string                  `json:"summary"`
	Artifacts       []CompletionArtifact    `json:"artifacts,omitempty"`
}

func (c *Client) completionURL(workspace, board string) string {
	return fmt.Sprintf("%s/api/workspaces/%s/boards/%s/completion/work", c.baseURL, url.PathEscape(workspace), url.PathEscape(board))
}
func (c *Client) GetCompletionWork(ctx context.Context, workspace, board string) (*CompletionWorkStatus, error) {
	return c.GetCompletionWorkPage(ctx, workspace, board, "")
}

func (c *Client) GetCompletionWorkPage(ctx context.Context, workspace, board, cursor string) (*CompletionWorkStatus, error) {
	endpoint := c.completionURL(workspace, board)
	if cursor != "" {
		endpoint += "?cursor=" + url.QueryEscape(cursor)
	}
	status, err := jsonGet[*CompletionWorkStatus](ctx, c, endpoint)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) {
			return nil, fmt.Errorf("completion work unavailable (HTTP %d); verify board access and backend compatibility", apiErr.StatusCode)
		}
		return nil, fmt.Errorf("completion work could not be read; verify backend connectivity and response compatibility")
	}
	if status == nil {
		return nil, fmt.Errorf("completion work response is null")
	}
	return status, nil
}
func (c *Client) ClaimCompletionWork(ctx context.Context, workspace, board string, capabilities CompletionCapabilities) (*CompletionWork, error) {
	var response struct {
		Work *CompletionWork `json:"work"`
	}
	err := c.jsonRequestDecode(ctx, http.MethodPost, c.completionURL(workspace, board)+"/claim", map[string]any{"capabilities": capabilities}, &response)
	if err != nil {
		return nil, fmt.Errorf("claiming completion work: %w", err)
	}
	return response.Work, nil
}
func (c *Client) CompleteCompletionWork(ctx context.Context, workspace, board, attempt string, result CompletionResult) error {
	var response struct {
		Receipt *CompletionResultRejection `json:"result_receipt"`
	}
	if err := c.jsonRequestDecode(ctx, http.MethodPost, c.completionURL(workspace, board)+"/"+url.PathEscape(attempt)+"/result", result, &response); err != nil {
		return err
	}
	if response.Receipt != nil {
		if response.Receipt.AttemptID != attempt || response.Receipt.Status != "rejected" {
			return &CompletionResultRejection{Code: "invalid_receipt"}
		}
		return response.Receipt
	}
	return nil
}

// A rejected receipt acknowledges durable bookkeeping, never acceptance of work.
// It is terminal for this payload; repeating paid work requires explicit retry.
type CompletionResultRejection struct {
	AttemptID  string `json:"attempt_id"`
	Status     string `json:"status"`
	Code       string `json:"code"`
	Retryable  bool   `json:"retryable"`
	NextAction string `json:"next_action"`
}

func (e *CompletionResultRejection) Error() string {
	if e.Retryable && e.NextAction == "retry_completion" {
		return "completion result rejected; the attempt was retired and reported usage recorded. Inspect the card's completion state, resolve changed context or configuration, then explicitly retry completion"
	}
	return "completion result rejected; inspect the card's current candidate and completion attempts before resuming"
}

type CompletionRework struct {
	CandidateID     string `json:"candidate_id"`
	CardID          string `json:"card_id"`
	FailedAttemptID string `json:"failed_attempt_id"`
	ExecutionID     string `json:"execution_id"`
	Context         string `json:"context"`
}

func (c *Client) ClaimCompletionRework(ctx context.Context, workspace, board, card, candidate, failedAttempt, execution string) (*CompletionRework, error) {
	endpoint := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/completion/cards/%s/rework", c.baseURL, url.PathEscape(workspace), url.PathEscape(board), url.PathEscape(card))
	var response struct {
		Work *CompletionRework `json:"work"`
	}
	err := c.jsonRequestDecode(ctx, http.MethodPost, endpoint, map[string]string{"candidate_id": candidate, "failed_attempt_id": failedAttempt, "source_execution_id": execution}, &response)
	if err != nil {
		return nil, fmt.Errorf("claiming completion rework: %w", err)
	}
	return response.Work, nil
}
