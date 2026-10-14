// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package uplink is the companion's Backplane API client. It never follows
// redirects or inherits a proxy, and it reads responses tolerantly: unknown
// members are ignored and only the members the companion depends on are
// required, so additive server changes never break installed devices.
package uplink

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

var (
	ErrUnauthorized     = errors.New("unauthorized")
	ErrForbidden        = errors.New("forbidden")
	ErrNotFound         = errors.New("not_found")
	ErrConflict         = errors.New("conflict")
	ErrTooLarge         = errors.New("payload_too_large")
	ErrUnprocessable    = errors.New("unprocessable")
	ErrUnavailable      = errors.New("unavailable")
	ErrUnexpectedStatus = errors.New("unexpected_status")
	ErrInvalidResponse  = errors.New("invalid_response")
	ErrInsecureEndpoint = errors.New("insecure_endpoint")
	ErrInvalidToken     = errors.New("invalid_token")
	// ErrDeviceRevoked is a 401 carrying the backend's invalid_device_token
	// code: the device token is revoked or unknown. A bare 401, e.g. from a
	// proxy in front of the backend, stays ErrUnauthorized.
	ErrDeviceRevoked = errors.New("device_revoked")
)

const revokedDeviceCode = "invalid_device_token"

const maxResponseBytes = 4 << 20

var (
	deviceTokenPattern = regexp.MustCompile(`^bpc_[A-Za-z0-9_-]{16,512}$`)
	apiKeyPattern      = regexp.MustCompile(`^vlr_[A-Za-z0-9_-]{8,512}$`)
	captureIDPattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

type Options struct {
	Endpoint string
	// AllowLoopbackHTTP permits plain HTTP only to a literal loopback IP, for
	// local development servers.
	AllowLoopbackHTTP bool
}

type Client struct {
	endpoint          string
	allowLoopbackHTTP bool
	token             string
	http              *http.Client
}

func New(options Options) (*Client, error) {
	endpoint, err := validateEndpoint(options)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// A host-wide forwarding proxy must never see device credentials.
	transport.Proxy = nil
	// No client-wide timeout: each request carries its own deadline.
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &Client{endpoint: endpoint, allowLoopbackHTTP: options.AllowLoopbackHTTP, http: client}, nil
}

func validateEndpoint(options Options) (string, error) {
	endpoint, err := url.Parse(strings.TrimSpace(options.Endpoint))
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.Opaque != "" {
		return "", fmt.Errorf("%w: invalid endpoint URL", ErrInsecureEndpoint)
	}
	if endpoint.Scheme != "https" {
		address := net.ParseIP(endpoint.Hostname())
		if endpoint.Scheme != "http" || !options.AllowLoopbackHTTP || address == nil || !address.IsLoopback() {
			return "", fmt.Errorf("%w: HTTPS required", ErrInsecureEndpoint)
		}
	}
	return strings.TrimSuffix(endpoint.String(), "/"), nil
}

func (c *Client) Endpoint() string { return c.endpoint }

// WithDeviceToken returns a client that authenticates as the device.
func (c *Client) WithDeviceToken(token string) (*Client, error) {
	if !deviceTokenPattern.MatchString(token) {
		return nil, ErrInvalidToken
	}
	copied := *c
	copied.token = token
	return &copied, nil
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

func (c *Client) do(ctx context.Context, method, path, token string, body any) ([]byte, error) {
	exchange := exchange{method: method, path: path, token: token, deadline: jsonDeadline}
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		exchange.body, exchange.contentType = encoded, "application/json"
	}
	return c.send(ctx, exchange)
}

// exchange is one request and the deadline it must answer within.
type exchange struct {
	method, path, token string
	body                []byte
	contentType         string
	headers             map[string]string
	deadline            time.Duration
}

func (c *Client) send(ctx context.Context, exchange exchange) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, exchange.deadline)
	defer cancel()
	var reader io.Reader
	if exchange.body != nil {
		reader = bytes.NewReader(exchange.body)
	}
	request, err := http.NewRequestWithContext(ctx, exchange.method, c.endpoint+exchange.path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+exchange.token)
	request.Header.Set("Accept", "application/json")
	if exchange.contentType != "" {
		request.Header.Set("Content-Type", exchange.contentType)
	}
	for name, value := range exchange.headers {
		request.Header.Set(name, value)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: %s %s", ErrUnavailable, exchange.method, exchange.path)
	}
	defer response.Body.Close()
	if err := statusError(response.StatusCode); err != nil {
		code := errorCodeOf(response.Body)
		if errors.Is(err, ErrUnauthorized) && code == revokedDeviceCode {
			err = ErrDeviceRevoked
		}
		return nil, &StatusError{Kind: err, Status: response.StatusCode, Code: code, method: exchange.method, path: exchange.path}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes {
		return nil, fmt.Errorf("%w: unreadable or oversized body", ErrInvalidResponse)
	}
	return data, nil
}

// StatusError is a non-2xx answer. Kind is the typed error callers match
// with errors.Is; Code is the backend's error_code, when it sent one.
type StatusError struct {
	Kind   error
	Status int
	Code   string
	method string
	path   string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("%v: %s %s returned %d", e.Kind, e.method, e.path, e.Status)
}

func (e *StatusError) Unwrap() error { return e.Kind }

func statusError(status int) error {
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == http.StatusUnauthorized:
		return ErrUnauthorized
	case status == http.StatusForbidden:
		return ErrForbidden
	case status == http.StatusNotFound:
		return ErrNotFound
	case status == http.StatusConflict:
		return ErrConflict
	case status == http.StatusRequestEntityTooLarge:
		return ErrTooLarge
	case status == http.StatusUnprocessableEntity:
		return ErrUnprocessable
	case status == http.StatusTooManyRequests || status >= 500:
		return ErrUnavailable
	default:
		return ErrUnexpectedStatus
	}
}

// errorCodeOf reads the backend's error envelope; anything else has none.
func errorCodeOf(body io.Reader) string {
	var envelope struct {
		ErrorCode string `json:"error_code"`
	}
	json.NewDecoder(io.LimitReader(body, 64<<10)).Decode(&envelope)
	return envelope.ErrorCode
}

func decode(data []byte, value any) error {
	if err := json.Unmarshal(data, value); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidResponse, err)
	}
	return nil
}

type InstallationRequest struct {
	InstallationID string `json:"installation_id"`
	Name           string `json:"name"`
	Platform       string `json:"platform"`
}

type Installation struct {
	InstallationID string `json:"installation_id"`
	DeviceToken    string `json:"device_token"`
}

// RegisterInstallation exchanges a human API key for a device token. The key
// is used for this one request and never stored.
func (c *Client) RegisterInstallation(ctx context.Context, apiKey string, request InstallationRequest) (Installation, error) {
	if !apiKeyPattern.MatchString(apiKey) {
		return Installation{}, ErrInvalidToken
	}
	data, err := c.do(ctx, http.MethodPost, "/api/me/companion/installations", apiKey, request)
	if err != nil {
		return Installation{}, err
	}
	var installation Installation
	if err := decode(data, &installation); err != nil {
		return Installation{}, err
	}
	// A repeat registration of the same id succeeds without a token (it is
	// shown only on first create); RotateInstallation issues a new one.
	if installation.InstallationID != request.InstallationID || installation.DeviceToken != "" && !deviceTokenPattern.MatchString(installation.DeviceToken) {
		return Installation{}, fmt.Errorf("%w: installation id or device token invalid", ErrInvalidResponse)
	}
	return installation, nil
}

// RotateInstallation issues a fresh device token for an existing
// installation. ErrConflict means the installation was revoked.
func (c *Client) RotateInstallation(ctx context.Context, apiKey, installationID string) (Installation, error) {
	if !apiKeyPattern.MatchString(apiKey) {
		return Installation{}, ErrInvalidToken
	}
	data, err := c.do(ctx, http.MethodPost, "/api/me/companion/installations/"+url.PathEscape(installationID)+"/rotate", apiKey, nil)
	if err != nil {
		return Installation{}, err
	}
	var installation Installation
	if err := decode(data, &installation); err != nil {
		return Installation{}, err
	}
	if installation.InstallationID != installationID || !deviceTokenPattern.MatchString(installation.DeviceToken) {
		return Installation{}, fmt.Errorf("%w: rotation returned no usable token", ErrInvalidResponse)
	}
	return installation, nil
}

// RevokeInstallation revokes this device's own credential on the server.
func (c *Client) RevokeInstallation(ctx context.Context) error {
	_, err := c.do(ctx, http.MethodDelete, "/api/companion/installation", c.token, nil)
	return err
}

// Policy announces rich capture on every request, so a server that knows it
// answers its offer or null.
func (c *Client) Policy(ctx context.Context) (policy.Policy, error) {
	data, err := c.send(ctx, exchange{method: http.MethodGet, path: "/api/companion/policy", token: c.token, deadline: jsonDeadline,
		headers: map[string]string{policy.CapabilitiesHeader: policy.RichCaptureCapability}})
	if err != nil {
		return policy.Policy{}, err
	}
	var result policy.Policy
	if err := decode(data, &result); err != nil {
		return policy.Policy{}, err
	}
	if err := result.Validate(); err != nil {
		return policy.Policy{}, fmt.Errorf("%w: %v", ErrInvalidResponse, err)
	}
	return result, nil
}

// ResolveMapping asks the server to map a repository root. It refuses with
// ErrNotFound (no accessible board), ErrConflict (ambiguous_repo),
// ErrForbidden (auto_match_disabled, not an auth failure) or
// ErrUnprocessable (unparseable URL).
func (c *Client) ResolveMapping(ctx context.Context, repoURL string) (policy.Mapping, error) {
	body := map[string]string{"repo_url": repoURL}
	data, err := c.do(ctx, http.MethodPost, "/api/companion/mappings", c.token, body)
	if err != nil {
		return policy.Mapping{}, err
	}
	var mapping policy.Mapping
	if err := decode(data, &mapping); err != nil {
		return policy.Mapping{}, err
	}
	if mapping.ID == "" || mapping.WorkspaceID == "" {
		return policy.Mapping{}, fmt.Errorf("%w: mapping id missing", ErrInvalidResponse)
	}
	return mapping, nil
}

// StatusReport is the heartbeat body. It carries no local path.
type StatusReport struct {
	CompanionVersion string        `json:"companion_version"`
	BeaconCommit     string        `json:"beacon_commit,omitempty"`
	Agents           []AgentStatus `json:"agents"`
	Queue            QueueStatus   `json:"queue"`
	// RichCapture goes only to a server that offered rich capture.
	RichCapture *RichCaptureStatus `json:"rich_capture,omitempty"`
}

type AgentStatus struct {
	Harness string `json:"harness"`
	// State is capturing, not_installed, disabled or error.
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

type QueueStatus struct {
	Pending         int        `json:"pending"`
	DroppedTotal    uint64     `json:"dropped_total"`
	OldestPendingAt *time.Time `json:"oldest_pending_at,omitempty"`
}

// ReportStatus sends the heartbeat. recorded is false when the server kept
// its previous report (it stores at most one a minute).
func (c *Client) ReportStatus(ctx context.Context, report StatusReport) (bool, error) {
	data, err := c.do(ctx, http.MethodPost, "/api/companion/status", c.token, report)
	if err != nil {
		return false, err
	}
	var result struct {
		Recorded bool `json:"recorded"`
	}
	if err := decode(data, &result); err != nil {
		return false, err
	}
	return result.Recorded, nil
}

type Rejection struct {
	CaptureID string `json:"capture_id"`
	Reason    string `json:"reason"`
}

// Drop is an acknowledged record the server deliberately did not store
// (reason session_deleted: the owner deleted that part of the session).
type Drop struct {
	CaptureID string `json:"capture_id"`
	Reason    string `json:"reason"`
}

// HistoryDeleted names a session of the batch, under one mapping, whose
// history was deleted through DeletedThrough, on this device's clock.
// Reason: owner or retention.
type HistoryDeleted struct {
	MappingID       string    `json:"mapping_id"`
	Harness         string    `json:"harness"`
	NativeSessionID string    `json:"native_session_id"`
	DeletedThrough  time.Time `json:"deleted_through"`
	Reason          string    `json:"reason"`
}

type Ack struct {
	Acknowledged []string
	Rejected     []Rejection
	// Dropped and HistoryDeleted are absent from servers that predate them.
	Dropped        []Drop
	HistoryDeleted []HistoryDeleted
	// Contents answers each content declaration of the acknowledged records.
	Contents []ContentAck
}

func (c *Client) Ingest(ctx context.Context, records []json.RawMessage) (Ack, error) {
	data, err := c.do(ctx, http.MethodPost, "/api/companion/ingest", c.token, map[string]any{"records": records})
	if err != nil {
		return Ack{}, err
	}
	return parseAck(data)
}

func parseAck(data []byte) (Ack, error) {
	var response struct {
		Acknowledged   *[]string        `json:"acknowledged"`
		Rejected       []Rejection      `json:"rejected"`
		Dropped        []Drop           `json:"dropped"`
		HistoryDeleted []HistoryDeleted `json:"history_deleted"`
		Contents       []ContentAck     `json:"contents"`
	}
	if err := decode(data, &response); err != nil {
		return Ack{}, err
	}
	if response.Acknowledged == nil {
		return Ack{}, fmt.Errorf("%w: acknowledged list missing", ErrInvalidResponse)
	}
	for _, id := range *response.Acknowledged {
		if !captureIDPattern.MatchString(id) {
			return Ack{}, fmt.Errorf("%w: malformed capture id", ErrInvalidResponse)
		}
	}
	for _, rejection := range response.Rejected {
		if !captureIDPattern.MatchString(rejection.CaptureID) {
			return Ack{}, fmt.Errorf("%w: malformed capture id", ErrInvalidResponse)
		}
	}
	for _, drop := range response.Dropped {
		if !captureIDPattern.MatchString(drop.CaptureID) {
			return Ack{}, fmt.Errorf("%w: malformed capture id", ErrInvalidResponse)
		}
	}
	for _, history := range response.HistoryDeleted {
		if history.NativeSessionID == "" || history.DeletedThrough.IsZero() {
			return Ack{}, fmt.Errorf("%w: deleted history without a session or cutoff", ErrInvalidResponse)
		}
	}
	ack := Ack{Acknowledged: *response.Acknowledged, Rejected: response.Rejected, Dropped: response.Dropped, HistoryDeleted: response.HistoryDeleted, Contents: response.Contents}
	if err := ack.validateContents(); err != nil {
		return Ack{}, fmt.Errorf("%w: %v", ErrInvalidResponse, err)
	}
	return ack, nil
}
