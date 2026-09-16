// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
)

type CompletionReadiness struct {
	PolicyHash string                     `json:"policy_hash"`
	Ready      bool                       `json:"ready"`
	Checks     []CompletionReadinessCheck `json:"checks"`
}

type CompletionReadinessCheck struct {
	Operation        string `json:"operation"`
	RepoID           string `json:"repo_id"`
	CandidateID      string `json:"candidate_id"`
	Required         bool   `json:"required"`
	Status           string `json:"status"`
	Code             string `json:"code"`
	CredentialSource string `json:"credential_source"`
	ConnectionID     string `json:"connection_id"`
}

func (r *CompletionReadiness) UnmarshalJSON(data []byte) error {
	var wire struct {
		PolicyHash json.RawMessage            `json:"policy_hash"`
		Ready      *bool                      `json:"ready"`
		Checks     []CompletionReadinessCheck `json:"checks"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if len(wire.PolicyHash) == 0 || wire.Ready == nil || wire.Checks == nil {
		return fmt.Errorf("incomplete completion readiness response")
	}
	if string(wire.PolicyHash) != "null" {
		if err := json.Unmarshal(wire.PolicyHash, &r.PolicyHash); err != nil {
			return err
		}
	}
	r.Ready = *wire.Ready
	r.Checks = wire.Checks
	return nil
}

func (c *CompletionReadinessCheck) UnmarshalJSON(data []byte) error {
	type plain CompletionReadinessCheck
	var wire struct {
		plain
		Required *bool `json:"required"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Required == nil || wire.Status == "" || wire.Code == "" {
		return fmt.Errorf("incomplete completion readiness check")
	}
	switch wire.Operation {
	case "repository_binding", "repository_read", "pull_requests_read", "candidate_pr_read", "forge_write":
	default:
		return fmt.Errorf("unsupported completion readiness operation")
	}
	switch wire.Status {
	case "verified", "failed", "unverified":
	default:
		return fmt.Errorf("unsupported completion readiness status")
	}
	switch wire.CredentialSource {
	case "", "workspace_connection", "platform":
	default:
		return fmt.Errorf("unsupported completion credential source")
	}
	if wire.Status == "verified" && (wire.Operation == "repository_read" || wire.Operation == "pull_requests_read" || wire.Operation == "candidate_pr_read") {
		if wire.RepoID == "" || wire.CredentialSource == "" || (wire.CredentialSource == "workspace_connection" && wire.ConnectionID == "") {
			return fmt.Errorf("verified completion read check omits repository or credential identity")
		}
	}
	if wire.Operation == "candidate_pr_read" && wire.CandidateID == "" {
		return fmt.Errorf("completion candidate read check omits candidate identity")
	}
	*c = CompletionReadinessCheck(wire.plain)
	c.Required = *wire.Required
	return nil
}

func (c *Client) GetCompletionReadiness(ctx context.Context, workspace, board string) (*CompletionReadiness, error) {
	endpoint := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/completion/readiness", c.baseURL, url.PathEscape(workspace), url.PathEscape(board))
	result, err := jsonGet[*CompletionReadiness](ctx, c, endpoint)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) {
			return nil, fmt.Errorf("completion readiness unavailable (HTTP %d); verify runner board access and backend compatibility before launching", apiErr.StatusCode)
		}
		return nil, fmt.Errorf("completion readiness could not be verified; check backend connectivity, timeout and response compatibility before launching")
	}
	if result == nil {
		return nil, fmt.Errorf("completion readiness response is null; deploy a compatible backend before launching")
	}
	return result, nil
}
