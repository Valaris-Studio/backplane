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

// CompletionRequirements is resolved by the platform from current policy and
// pending candidate contracts. It is intentionally fetched again at each boundary.
type CompletionRequirements struct {
	PolicyHash   string                  `json:"policy_hash"`
	Requirements []CompletionRequirement `json:"requirements"`
}

type CompletionRequirement struct {
	Kind       string            `json:"kind"`
	Role       string            `json:"role"`
	Provider   string            `json:"provider"`
	Model      string            `json:"model"`
	Checks     []CompletionCheck `json:"checks"`
	ToolPolicy struct {
		Deny []string `json:"deny"`
	} `json:"tool_policy"`
}

func (c *Client) GetCompletionRequirements(ctx context.Context, workspace, board string) (*CompletionRequirements, error) {
	endpoint := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/completion/requirements", c.baseURL, url.PathEscape(workspace), url.PathEscape(board))
	result, err := jsonGet[*CompletionRequirements](ctx, c, endpoint)
	if err != nil {
		// Server errors can contain credential-bearing upstream bodies. Only expose
		// the status and corrective action, never the response body or request URL.
		var apiErr *APIError
		if errors.As(err, &apiErr) {
			var diagnosis struct {
				Code string `json:"error_code"`
			}
			_ = json.Unmarshal([]byte(apiErr.Body), &diagnosis)
			remedies := map[string]string{
				"completion_role_unconfigured":        "configure and enable each role named by the board completion policy",
				"completion_role_model_required":      "configure an exact provider and concrete model for each review role",
				"completion_role_prompt_required":     "configure the mandatory prompt for each review role",
				"completion_role_tool_policy_invalid": "correct the review role tool_policy deny list",
				"completion_prompt_render_invalid":    "correct unsupported variables or invalid syntax in the configured completion role prompt",
			}
			if remedy, known := remedies[diagnosis.Code]; known {
				return nil, fmt.Errorf("completion requirements unavailable (%s): %s before launching", diagnosis.Code, remedy)
			}
			return nil, fmt.Errorf("completion requirements unavailable (HTTP %d); verify board access and deploy a compatible backend before launching", apiErr.StatusCode)
		}
		return nil, fmt.Errorf("completion requirements could not be read; verify backend connectivity and response compatibility before launching")
	}
	if result == nil || result.Requirements == nil {
		return nil, fmt.Errorf("completion requirements response is incomplete; deploy a compatible backend before launching")
	}
	return result, nil
}
