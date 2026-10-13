// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

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
)

// RFC 8628 §3.5 token-endpoint errors.
var (
	ErrAuthorizationPending = errors.New("authorization_pending")
	ErrSlowDown             = errors.New("slow_down")
	ErrExpiredToken         = errors.New("expired_token")
	ErrAccessDenied         = errors.New("access_denied")
)

var (
	pairingErrors = map[string]error{
		"authorization_pending": ErrAuthorizationPending,
		"slow_down":             ErrSlowDown,
		"expired_token":         ErrExpiredToken,
		"access_denied":         ErrAccessDenied,
	}
	userCodePattern       = regexp.MustCompile(`^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$`)
	installationIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type PairingRequest struct {
	// Name is omitted when empty so the server applies its neutral default.
	Name             string `json:"name,omitempty"`
	Platform         string `json:"platform"`
	Arch             string `json:"arch"`
	CompanionVersion string `json:"companion_version"`
}

type PairingStart struct {
	// DeviceCode is the polling secret; it never leaves this process.
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expires_in"`
}

type PairingGrant struct {
	InstallationID string `json:"installation_id"`
	DeviceToken    string `json:"device_token"`
}

// StartPairing begins browser-code pairing. It sends no credential.
func (c *Client) StartPairing(ctx context.Context, request PairingRequest) (PairingStart, error) {
	data, err := c.doAnonymous(ctx, "/api/companion/pairing", request)
	if err != nil {
		return PairingStart{}, err
	}
	var started PairingStart
	if err := decode(data, &started); err != nil {
		return PairingStart{}, err
	}
	if started.DeviceCode == "" || len(started.DeviceCode) > 256 || !userCodePattern.MatchString(started.UserCode) || started.ExpiresIn <= 0 {
		return PairingStart{}, fmt.Errorf("%w: pairing codes missing or malformed", ErrInvalidResponse)
	}
	// The companion opens these in a browser: only a web page, under the same
	// transport rule as the API itself, will do.
	if !VerificationPageAllowed(started.VerificationURI, c.allowLoopbackHTTP) || !VerificationPageAllowed(started.VerificationURIComplete, c.allowLoopbackHTTP) || !strings.HasPrefix(started.VerificationURIComplete, started.VerificationURI) {
		return PairingStart{}, fmt.Errorf("%w: verification URI is not a web page", ErrInvalidResponse)
	}
	// The desktop app may open this page before any connection exists, so a
	// hostile endpoint must not be able to point it at another site.
	if !sameOrigin(started.VerificationURI, c.endpoint) || !sameOrigin(started.VerificationURIComplete, c.endpoint) {
		return PairingStart{}, ErrForeignVerificationPage
	}
	return started, nil
}

// CollectPairing polls for the device token. Until the person decides it
// fails with ErrAuthorizationPending or ErrSlowDown; ErrAccessDenied and
// ErrExpiredToken are final.
func (c *Client) CollectPairing(ctx context.Context, deviceCode string) (PairingGrant, error) {
	data, err := c.doAnonymous(ctx, "/api/companion/pairing/token", map[string]string{"device_code": deviceCode})
	if err != nil {
		return PairingGrant{}, err
	}
	var grant PairingGrant
	if err := decode(data, &grant); err != nil {
		return PairingGrant{}, err
	}
	if !installationIDPattern.MatchString(grant.InstallationID) || !deviceTokenPattern.MatchString(grant.DeviceToken) {
		return PairingGrant{}, fmt.Errorf("%w: pairing returned no usable token", ErrInvalidResponse)
	}
	return grant, nil
}

// ErrForeignVerificationPage is a pairing whose approval page is not on the
// pairing endpoint's origin.
var ErrForeignVerificationPage = fmt.Errorf("%w: verification page is not on the endpoint's origin", ErrInvalidResponse)

// VerificationPageFor is VerificationPageAllowed plus the endpoint's origin.
func VerificationPageFor(raw, endpoint string, allowLoopbackHTTP bool) bool {
	return VerificationPageAllowed(raw, allowLoopbackHTTP) && sameOrigin(raw, endpoint)
}

// sameOrigin compares scheme, host (case-insensitively) and port, with the
// scheme's default port made explicit.
func sameOrigin(a, b string) bool {
	left, errLeft := url.Parse(a)
	right, errRight := url.Parse(b)
	if errLeft != nil || errRight != nil || left.Host == "" || right.Host == "" {
		return false
	}
	port := func(parsed *url.URL) string {
		if explicit := parsed.Port(); explicit != "" {
			return explicit
		}
		if strings.EqualFold(parsed.Scheme, "https") {
			return "443"
		}
		return "80"
	}
	return strings.EqualFold(left.Scheme, right.Scheme) && strings.EqualFold(left.Hostname(), right.Hostname()) && port(left) == port(right)
}

// VerificationPageAllowed accepts an HTTPS page, or plain HTTP to a literal
// loopback IP when the caller opted into that for development.
func VerificationPageAllowed(raw string, allowLoopbackHTTP bool) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	address := net.ParseIP(parsed.Hostname())
	return parsed.Scheme == "http" && allowLoopbackHTTP && address != nil && address.IsLoopback()
}

// doAnonymous is `do` for the pairing endpoints, which take no Authorization
// header and answer 400 with an RFC 8628 error code.
func (c *Client) doAnonymous(ctx context.Context, path string, body any) ([]byte, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: POST %s", ErrUnavailable, path)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusBadRequest {
		if known, ok := pairingErrors[errorCodeOf(response.Body)]; ok {
			return nil, known
		}
	}
	if err := statusError(response.StatusCode); err != nil {
		return nil, fmt.Errorf("%w: POST %s returned %d", err, path, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes {
		return nil, fmt.Errorf("%w: unreadable or oversized body", ErrInvalidResponse)
	}
	return data, nil
}
