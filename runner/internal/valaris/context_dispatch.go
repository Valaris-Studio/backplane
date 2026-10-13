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
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Context dispatch v1: the runner negotiates the workspace's dispatch policy
// before each assignment and start, and the server acknowledges each with this
// header and a typed stamp. A missing or mismatched acknowledgement is never
// taken for success.
const (
	ContextDispatchHeader   = "X-Backplane-Context-Dispatch-Version"
	ContextDispatchVersion  = 1
	ContextDispatchRequired = "required"
	ContextDispatchLegacy   = "legacy"
	// ScheduledActiveExecution is the only flow v1 dispatches.
	ScheduledActiveExecution = "scheduled_active_execution"
)

var (
	policyRevisionPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	uuidPattern           = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// ContextDispatchContract is the server's dispatch policy for one agent in one
// workspace, from GET .../agents/{agent_id}/context-dispatch-contract.
type ContextDispatchContract struct {
	Protocol          string   `json:"protocol"`
	SupportedVersions []int    `json:"supported_versions"`
	MinimumVersion    int      `json:"minimum_version"`
	Mode              string   `json:"mode"`
	AgentID           string   `json:"agent_id"`
	WorkspaceID       string   `json:"workspace_id"`
	PolicyRevision    string   `json:"policy_revision"`
	SupportedFlows    []string `json:"supported_flows"`
}

// UnmarshalJSON requires minimum_version: its zero value is a floor, so a
// contract that omits it or sends null must not read as floor 0. Every
// other field's zero value is already refused by Validate.
func (k *ContextDispatchContract) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if minimum, ok := fields["minimum_version"]; !ok || string(minimum) == "null" {
		return errors.New("context dispatch contract: no minimum_version")
	}
	type plain ContextDispatchContract
	return json.Unmarshal(data, (*plain)(k))
}

// ContextDispatchStamp is the negotiated floor an assignment carries and a
// bound start retains.
type ContextDispatchStamp struct {
	Version        int    `json:"version"`
	Mode           string `json:"mode"`
	PolicyRevision string `json:"policy_revision"`
}

// ContextBinding is what a bound start ties the execution to: the hold, its
// identity and the negotiated floor.
type ContextBinding struct {
	ReservationID   string               `json:"reservation_id"`
	AgentID         string               `json:"agent_id"`
	WorkspaceID     string               `json:"workspace_id"`
	BoardID         string               `json:"board_id"`
	CardID          string               `json:"card_id"`
	Role            string               `json:"role"`
	ContextDispatch ContextDispatchStamp `json:"context_dispatch"`
}

// Validate reports whether the contract is a v1 contract for agentID in
// workspaceID whose floor this runner can honor.
func (k ContextDispatchContract) Validate(agentID, workspaceID string) error {
	switch {
	case k.Protocol != "context-dispatch":
		return fmt.Errorf("context dispatch contract: protocol %q", k.Protocol)
	case !slices.Contains(k.SupportedVersions, ContextDispatchVersion):
		return fmt.Errorf("context dispatch contract: versions %v do not include %d", k.SupportedVersions, ContextDispatchVersion)
	case !sameUUID(k.AgentID, agentID):
		return errors.New("context dispatch contract: for another agent")
	case !sameUUID(k.WorkspaceID, workspaceID):
		return errors.New("context dispatch contract: for another workspace")
	case !policyRevisionPattern.MatchString(k.PolicyRevision):
		return errors.New("context dispatch contract: malformed policy revision")
	case !slices.Contains(k.SupportedFlows, ScheduledActiveExecution):
		return fmt.Errorf("context dispatch contract: flows %v do not include %s", k.SupportedFlows, ScheduledActiveExecution)
	}
	switch {
	case k.Mode == ContextDispatchRequired && k.MinimumVersion == ContextDispatchVersion:
	case k.Mode == ContextDispatchLegacy && k.MinimumVersion == 0:
	default:
		return fmt.Errorf("context dispatch contract: mode %q with minimum version %d", k.Mode, k.MinimumVersion)
	}
	return nil
}

// Stamp is the floor an assignment negotiated under k must carry.
func (k ContextDispatchContract) Stamp() ContextDispatchStamp {
	return ContextDispatchStamp{Version: ContextDispatchVersion, Mode: k.Mode, PolicyRevision: k.PolicyRevision}
}

// sameUUID compares two canonical UUIDs, case aside.
func sameUUID(a, b string) bool {
	return uuidPattern.MatchString(a) && strings.EqualFold(a, b)
}

func validMode(mode string) bool {
	return mode == ContextDispatchRequired || mode == ContextDispatchLegacy
}

// RouteMissing reports a 404 for the route itself, as a server without the
// route answers it. A server with the route explains its 404s in its error
// envelope: an error_code naming what is missing, or not_found with a detail
// other than the framework's bare "Not Found"; those are not route-missing.
func (e *APIError) RouteMissing() bool {
	if e.StatusCode != http.StatusNotFound {
		return false
	}
	var envelope struct {
		Detail    any    `json:"detail"`
		ErrorCode string `json:"error_code"`
	}
	if json.Unmarshal([]byte(e.Body), &envelope) != nil || envelope.ErrorCode == "" {
		return true
	}
	return envelope.ErrorCode == "not_found" && envelope.Detail == "Not Found"
}

// ContextDispatchContract fetches the agent's dispatch contract. A response
// without the v1 acknowledgement is an error; an old server's 404 comes back
// as an *APIError for the caller to judge.
func (c *Client) ContextDispatchContract(ctx context.Context, workspaceSlug, agentID string) (*ContextDispatchContract, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/agents/%s/context-dispatch-contract", c.baseURL, workspaceSlug, agentID)
	req, err := c.newRequest(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(ContextDispatchHeader, strconv.Itoa(ContextDispatchVersion))
	var contract ContextDispatchContract
	if err := c.doAcknowledged(req, &contract); err != nil {
		return nil, err
	}
	return &contract, nil
}

// validateAssignment reports whether a v1 assignment answers req: the floor it
// asked for, its role and board, and a hold to bind the start to.
func validateAssignment(req NextAssignmentRequest, a *NextAssignmentResponse) error {
	stamp := a.ContextDispatch
	switch {
	case stamp == nil:
		return errors.New("next-assignment: no context dispatch stamp")
	case stamp.Version != ContextDispatchVersion || stamp.PolicyRevision != req.ContextDispatchPolicyRevision || !validMode(stamp.Mode):
		return fmt.Errorf("next-assignment: stamp %+v does not answer the negotiated policy", *stamp)
	case a.Card.ID == "" || a.Reservation.ID == "":
		return errors.New("next-assignment: no card hold")
	case req.RoleOverride != "" && a.Role != req.RoleOverride:
		return fmt.Errorf("next-assignment: role %q, asked for %q", a.Role, req.RoleOverride)
	case req.BoardID != "" && !strings.EqualFold(a.Board.ID, req.BoardID):
		return errors.New("next-assignment: another board than asked for")
	}
	return nil
}

// ExecutionStart is the content of an execution start; empty optional fields
// are left out of the payload.
type ExecutionStart struct {
	WorkspaceSlug string
	Action        string
	BoardID       string
	CardID        string
	InputSummary  string
	Role          string
	PromptSlug    string
	Model         string
	Provider      string
	Skills        []AssignmentSkill
}

func (s ExecutionStart) payload() map[string]any {
	payload := map[string]any{
		"workspace_slug": s.WorkspaceSlug,
		"action":         s.Action,
		"input_summary":  s.InputSummary,
	}
	for key, value := range map[string]string{
		"board_id": s.BoardID, "card_id": s.CardID, "role": s.Role,
		"prompt_slug": s.PromptSlug, "model": s.Model, "provider": s.Provider,
	} {
		if value != "" {
			payload[key] = value
		}
	}
	if len(s.Skills) > 0 {
		payload["skills"] = s.Skills
	}
	return payload
}

// StartBoundExecution starts an execution bound to a negotiated hold and
// returns its ID only once the server acknowledged exactly that binding.
func (c *Client) StartBoundExecution(ctx context.Context, agentID string, start ExecutionStart, binding ContextBinding) (string, error) {
	payload := start.payload()
	payload["reservation_id"] = binding.ReservationID
	payload["context_dispatch_version"] = binding.ContextDispatch.Version
	payload["context_dispatch_policy_revision"] = binding.ContextDispatch.PolicyRevision
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshaling execution start: %w", err)
	}
	url := fmt.Sprintf("%s/api/agents/%s/executions", c.baseURL, agentID)
	req, err := c.newRequest(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ContextDispatchHeader, strconv.Itoa(ContextDispatchVersion))
	var started struct {
		ID             string          `json:"id"`
		ContextBinding *ContextBinding `json:"context_binding"`
	}
	if err := c.doAcknowledged(req, &started); err != nil {
		return "", err
	}
	switch {
	case started.ID == "":
		return "", errors.New("execution start: no execution id")
	case started.ContextBinding == nil:
		return "", errors.New("execution start: no context binding")
	case !sameBinding(*started.ContextBinding, binding):
		return "", fmt.Errorf("execution start: bound %+v, not the negotiated %+v", *started.ContextBinding, binding)
	}
	return started.ID, nil
}

func sameBinding(got, want ContextBinding) bool {
	return strings.EqualFold(got.ReservationID, want.ReservationID) && sameUUID(got.AgentID, want.AgentID) &&
		sameUUID(got.WorkspaceID, want.WorkspaceID) && strings.EqualFold(got.BoardID, want.BoardID) &&
		strings.EqualFold(got.CardID, want.CardID) && got.Role == want.Role && got.ContextDispatch == want.ContextDispatch
}

// doAcknowledged sends req and decodes a success into out, which must carry
// the v1 acknowledgement; an error status comes back as an *APIError.
func (c *Client) doAcknowledged(req *http.Request, out any) error {
	resp, err := c.noFollow().Do(req)
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()
	if redirected(resp) {
		return fmt.Errorf("context dispatch: refused a redirect (HTTP %d)", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response body: %w", err)
	}
	if resp.StatusCode >= 400 {
		return &APIError{StatusCode: resp.StatusCode, Body: string(body)}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("context dispatch: HTTP %d", resp.StatusCode)
	}
	if !acknowledged(resp) {
		return errors.New("context dispatch: response without the v1 acknowledgement")
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("context dispatch: decoding response: %w", err)
	}
	return nil
}

// noFollow is the client for a negotiated dispatch request: a redirect comes
// back as the response itself, so it is refused before anything is sent again
// or elsewhere. The shared client is left as it is.
func (c *Client) noFollow() *http.Client {
	client := *c.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &client
}

func redirected(resp *http.Response) bool {
	return resp.StatusCode >= 300 && resp.StatusCode < 400
}

func acknowledged(resp *http.Response) bool {
	return resp.Header.Get(ContextDispatchHeader) == strconv.Itoa(ContextDispatchVersion)
}
