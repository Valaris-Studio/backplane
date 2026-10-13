// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// canonicalUUID is a UUID as the server writes it: lowercase and hyphenated.
var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// A required invocation refreshes its execution's current dispatch-context,
// renders it, and prepares the exact final call before invoking a provider.
// Both the snapshot and the acknowledgement are taken only when complete:
// a missing or null member is never read as its zero value.

// DispatchInvocation names the call a snapshot and its preparation are for.
type DispatchInvocation struct {
	Kind       string  `json:"kind"`
	StepName   *string `json:"step_name"`
	PromptSlot string  `json:"prompt_slot"`
}

func (i DispatchInvocation) equal(other DispatchInvocation) bool {
	sameStep := i.StepName == nil && other.StepName == nil ||
		i.StepName != nil && other.StepName != nil && *i.StepName == *other.StepName
	return i.Kind == other.Kind && i.PromptSlot == other.PromptSlot && sameStep
}

// DispatchPolicy is the server's effective policy for one invocation: what
// it renders and with which provider, model, tools and schema.
type DispatchPolicy struct {
	Provider       string `json:"provider"`
	Model          string `json:"model"`
	Tier           string `json:"tier"`
	PromptSlug     string `json:"prompt_slug"`
	InputTemplate  string `json:"input_template"`
	SystemTemplate string `json:"system_template"`
	ToolPolicy     struct {
		Deny []string `json:"deny"`
	} `json:"tool_policy"`
	// Tools, when the snapshot names them, replace the stage's local list.
	Tools                 []string `json:"tools"`
	OutputSchema          string   `json:"output_schema"`
	RequiredSourceIndices []int    `json:"required_source_indices"`
	// Flags are the server's current call-semantic flags, kept raw: the
	// runner reads only the ones its call consumed, with their exact types.
	Flags json.RawMessage `json:"flags"`
}

// DispatchSnapshot is an execution's current dispatch-context for one
// invocation.
type DispatchSnapshot struct {
	ProtocolVersion  int                `json:"protocol_version"`
	Mode             string             `json:"mode"`
	ExecutionID      string             `json:"execution_id"`
	ContextBinding   ContextBinding     `json:"context_binding"`
	Invocation       DispatchInvocation `json:"invocation"`
	Context          map[string]string  `json:"context"`
	ContextManifest  json.RawMessage    `json:"context_manifest"`
	ContextRevision  string             `json:"context_revision"`
	DispatchRevision string             `json:"dispatch_revision"`
	// Card is the current CardRead object with its own keys and JSON values
	// (numbers kept as written), for templates' {{ index .Card "key" }}.
	Card     map[string]any `json:"-"`
	Dispatch DispatchPolicy `json:"dispatch"`
}

func requireMembers(data []byte, what string, names ...string) (map[string]json.RawMessage, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(data, &members); err != nil {
		return nil, fmt.Errorf("%s: %w", what, err)
	}
	for _, name := range names {
		if raw, ok := members[name]; !ok || string(raw) == "null" {
			return nil, fmt.Errorf("%s: no %s", what, name)
		}
	}
	return members, nil
}

func (s *DispatchSnapshot) UnmarshalJSON(data []byte) error {
	members, err := requireMembers(data, "dispatch-context",
		"protocol_version", "mode", "execution_id", "context_binding", "invocation", "context",
		"context_manifest", "context_revision", "dispatch_revision", "card", "dispatch")
	if err != nil {
		return err
	}
	dispatch, err := requireMembers(members["dispatch"], "dispatch-context dispatch",
		"provider", "model", "input_template", "system_template", "tool_policy", "output_schema", "required_source_indices")
	if err != nil {
		return err
	}
	if err := requireShapes(members["context"], dispatch); err != nil {
		return err
	}
	type plain DispatchSnapshot
	if err := json.Unmarshal(data, (*plain)(s)); err != nil {
		return fmt.Errorf("dispatch-context: %w", err)
	}
	card := json.NewDecoder(bytes.NewReader(members["card"]))
	card.UseNumber()
	if err := card.Decode(&s.Card); err != nil || s.Card == nil {
		return errors.New("dispatch-context: card is not an object")
	}
	return nil
}

var integerToken = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)

func isStringToken(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '"'
}

// isStringArray reports whether raw is a JSON array of strings, any string.
func isStringArray(raw json.RawMessage) bool {
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil || items == nil {
		return false
	}
	for _, item := range items {
		if !isStringToken(item) {
			return false
		}
	}
	return true
}

// requireShapes refuses nested members the typed decode would coerce: a null
// or non-string deny entry, tool or context value, or a non-integer required
// index never becomes "" or 0.
func requireShapes(contextValues json.RawMessage, dispatch map[string]json.RawMessage) error {
	policy, err := requireMembers(dispatch["tool_policy"], "dispatch-context tool_policy", "deny")
	if err != nil {
		return err
	}
	if !isStringArray(policy["deny"]) {
		return errors.New("dispatch-context: tool_policy.deny is not a list of strings")
	}
	if tools, ok := dispatch["tools"]; ok && string(bytes.TrimSpace(tools)) != "null" && !isStringArray(tools) {
		return errors.New("dispatch-context: tools is not a list of strings")
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(contextValues, &values); err != nil {
		return fmt.Errorf("dispatch-context: context: %w", err)
	}
	for alias, value := range values {
		if !isStringToken(value) {
			return fmt.Errorf("dispatch-context: context %q is not a string", alias)
		}
	}
	var indices []json.RawMessage
	if err := json.Unmarshal(dispatch["required_source_indices"], &indices); err != nil {
		return fmt.Errorf("dispatch-context: required_source_indices: %w", err)
	}
	for _, index := range indices {
		if !integerToken.Match(bytes.TrimSpace(index)) {
			return errors.New("dispatch-context: a required source index is not an integer")
		}
	}
	return nil
}

// Validate reports whether the snapshot is the current v1 dispatch-context of
// executionID, bound exactly as binding, for invocation.
func (s *DispatchSnapshot) Validate(executionID string, binding ContextBinding, invocation DispatchInvocation) error {
	cardID, _ := s.Card["id"].(string)
	switch {
	case s.ProtocolVersion != ContextDispatchVersion:
		return fmt.Errorf("dispatch-context: protocol version %d", s.ProtocolVersion)
	case s.Mode != ContextDispatchRequired:
		return fmt.Errorf("dispatch-context: mode %q for a required binding", s.Mode)
	case !sameUUID(s.ExecutionID, executionID):
		return errors.New("dispatch-context: for another execution")
	case !sameBinding(s.ContextBinding, binding):
		return errors.New("dispatch-context: bound otherwise than this execution")
	case !s.Invocation.equal(invocation):
		return errors.New("dispatch-context: for another invocation")
	case !policyRevisionPattern.MatchString(s.ContextRevision) || !policyRevisionPattern.MatchString(s.DispatchRevision):
		return errors.New("dispatch-context: malformed revision")
	case !sameUUID(cardID, binding.CardID):
		return errors.New("dispatch-context: for another card")
	case s.Dispatch.Provider == "" || s.Dispatch.Model == "" || s.Dispatch.InputTemplate == "":
		return errors.New("dispatch-context: no provider, model or input template")
	}
	return s.validateRequiredSources()
}

// validateRequiredSources reports whether every required source index names
// a distinct source of the manifest.
func (s *DispatchSnapshot) validateRequiredSources() error {
	var manifest struct {
		Sources []json.RawMessage `json:"sources"`
	}
	if err := json.Unmarshal(s.ContextManifest, &manifest); err != nil {
		return fmt.Errorf("dispatch-context: manifest: %w", err)
	}
	seen := map[int]bool{}
	for _, index := range s.Dispatch.RequiredSourceIndices {
		if index < 0 || index >= len(manifest.Sources) || seen[index] {
			return fmt.Errorf("dispatch-context: required source %d is not a distinct manifest source", index)
		}
		seen[index] = true
	}
	return nil
}

// DispatchContext fetches executionID's current dispatch-context for
// invocation. A response without the v1 acknowledgement is an error.
func (c *Client) DispatchContext(ctx context.Context, workspaceSlug, executionID string, invocation DispatchInvocation) (*DispatchSnapshot, error) {
	query := url.Values{"invocation_kind": {invocation.Kind}, "prompt_slot": {invocation.PromptSlot}}
	if invocation.StepName != nil {
		query.Set("step_name", *invocation.StepName)
	}
	endpoint := fmt.Sprintf("%s/api/workspaces/%s/executions/%s/dispatch-context?%s", c.baseURL, workspaceSlug, executionID, query.Encode())
	req, err := c.newRequest(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(ContextDispatchHeader, strconv.Itoa(ContextDispatchVersion))
	var snapshot DispatchSnapshot
	if err := c.doAcknowledged(req, &snapshot); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// ChannelContract declares how the actual call carries each prompt channel.
type ChannelContract struct {
	Version int    `json:"version"`
	Input   string `json:"input"`
	System  string `json:"system"`
	Resume  bool   `json:"resume"`
}

// DispatchPreparation is the exact final call a provider is about to receive.
type DispatchPreparation struct {
	ProtocolVersion  int                `json:"protocol_version"`
	ClientRequestID  string             `json:"client_request_id"`
	ContextRevision  string             `json:"context_revision"`
	DispatchRevision string             `json:"dispatch_revision"`
	Invocation       DispatchInvocation `json:"invocation"`
	InputPrompt      string             `json:"input_prompt"`
	SystemPrompt     string             `json:"system_prompt"`
	Provider         string             `json:"provider"`
	Adapter          string             `json:"adapter"`
	Model            string             `json:"model"`
	ResolutionKind   string             `json:"resolution_kind"`
	ResumeSessionID  *string            `json:"resume_session_id"`
	ChannelContract  ChannelContract    `json:"channel_contract"`
}

// NewRequestID is a random (v4) UUID for one preparation's idempotency key.
func NewRequestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], nil
}

// PreparationAck is the server's committed acknowledgement of a preparation.
// It records that the call was prepared, never that a model used it.
type PreparationAck struct {
	ProtocolVersion       int    `json:"protocol_version"`
	Acknowledged          string `json:"acknowledged"`
	ReceiptID             string `json:"receipt_id"`
	ExecutionID           string `json:"execution_id"`
	ClientRequestID       string `json:"client_request_id"`
	Ordinal               int    `json:"ordinal"`
	ContextRevision       string `json:"context_revision"`
	DispatchRevision      string `json:"dispatch_revision"`
	PromptSHA256          string `json:"prompt_sha256"`
	PromptBytes           int    `json:"prompt_bytes"`
	SystemPromptSHA256    string `json:"system_prompt_sha256"`
	SystemPromptBytes     int    `json:"system_prompt_bytes"`
	InclusionVerification string `json:"inclusion_verification"`
	UseVerification       string `json:"use_verification"`
}

func (a *PreparationAck) UnmarshalJSON(data []byte) error {
	if _, err := requireMembers(data, "preparation acknowledgement",
		"protocol_version", "acknowledged", "receipt_id", "execution_id", "client_request_id", "ordinal",
		"context_revision", "dispatch_revision", "prompt_sha256", "prompt_bytes",
		"system_prompt_sha256", "system_prompt_bytes", "inclusion_verification", "use_verification"); err != nil {
		return err
	}
	type plain PreparationAck
	return json.Unmarshal(data, (*plain)(a))
}

func digestHex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// Validate reports whether the acknowledgement commits exactly p, for
// executionID, with required source blocks verified when there are any.
func (a *PreparationAck) Validate(p DispatchPreparation, executionID string, requiredSources bool) error {
	inclusion := "no_required_sources"
	if requiredSources {
		inclusion = "required_blocks_exact"
	}
	switch {
	case a.ProtocolVersion != ContextDispatchVersion || a.Acknowledged != "prepared":
		return fmt.Errorf("preparation: acknowledged %q under version %d", a.Acknowledged, a.ProtocolVersion)
	case !canonicalUUID.MatchString(a.ReceiptID) || a.Ordinal < 1:
		return errors.New("preparation: no valid receipt")
	case !canonicalUUID.MatchString(a.ExecutionID) || !strings.EqualFold(a.ExecutionID, executionID) || a.ClientRequestID != p.ClientRequestID:
		return errors.New("preparation: acknowledged another execution or request")
	case a.ContextRevision != p.ContextRevision || a.DispatchRevision != p.DispatchRevision:
		return errors.New("preparation: acknowledged other revisions")
	case a.PromptSHA256 != digestHex(p.InputPrompt) || a.PromptBytes != len(p.InputPrompt):
		return errors.New("preparation: acknowledged another input")
	case a.SystemPromptSHA256 != digestHex(p.SystemPrompt) || a.SystemPromptBytes != len(p.SystemPrompt):
		return errors.New("preparation: acknowledged another system prompt")
	case a.InclusionVerification != inclusion:
		return fmt.Errorf("preparation: inclusion %q, want %q", a.InclusionVerification, inclusion)
	case a.UseVerification != "not_verified":
		return fmt.Errorf("preparation: use verification %q", a.UseVerification)
	}
	return nil
}

// ErrAmbiguousPreparation wraps a preparation whose outcome is unknown: the
// request may or may not have reached the server.
var ErrAmbiguousPreparation = errors.New("preparation outcome unknown")

// PrepareDispatch submits p for executionID and returns the server's
// acknowledgement, unvalidated. An error status comes back as an *APIError;
// a failed exchange wraps ErrAmbiguousPreparation.
func (c *Client) PrepareDispatch(ctx context.Context, workspaceSlug, executionID string, p DispatchPreparation) (*PreparationAck, error) {
	body, err := json.Marshal(p)
	if err != nil {
		return nil, fmt.Errorf("marshaling preparation: %w", err)
	}
	endpoint := fmt.Sprintf("%s/api/workspaces/%s/executions/%s/dispatch-preparations", c.baseURL, workspaceSlug, executionID)
	req, err := c.newRequest(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ContextDispatchHeader, strconv.Itoa(ContextDispatchVersion))
	resp, err := c.noFollow().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAmbiguousPreparation, err)
	}
	defer resp.Body.Close()
	if redirected(resp) {
		return nil, fmt.Errorf("preparation: refused a redirect (HTTP %d)", resp.StatusCode)
	}
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("%w: reading acknowledgement: %v", ErrAmbiguousPreparation, err)
	}
	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("preparation: HTTP %d", resp.StatusCode)
	}
	if !acknowledged(resp) {
		return nil, errors.New("preparation: response without the v1 acknowledgement")
	}
	var ack PreparationAck
	if err := json.Unmarshal(respBody, &ack); err != nil {
		return nil, err
	}
	return &ack, nil
}

// ErrorCode is the error_code of an error envelope, or "".
func (e *APIError) ErrorCode() string {
	var envelope struct {
		ErrorCode string `json:"error_code"`
	}
	_ = json.Unmarshal([]byte(e.Body), &envelope)
	return envelope.ErrorCode
}
