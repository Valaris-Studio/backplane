// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// Pairing states, as the poll and the pairing event report them.
const (
	PairPending    = "pending"
	PairPersisting = "persisting"
	PairConnected  = "connected"
	PairDenied     = "denied"
	PairExpired    = "expired"
	PairFailed     = "failed"
)

var (
	// ErrPairingNotFound is a pairing id the pairer does not know.
	ErrPairingNotFound = errors.New("pairing_not_found")
	// ErrPairingPersisting refuses to cancel (or sign out under) an approved
	// pairing whose connection is being stored.
	ErrPairingPersisting = errors.New(CodePairingPersisting)
	// ErrSameServer refuses a replace onto the Backplane already connected,
	// by its API endpoint or the web address people open.
	ErrSameServer = errors.New(CodeSameServer)
	// ErrAlreadyConnected refuses to pair a device that is connected.
	ErrAlreadyConnected = errors.New("already_connected")
)

// Pairing is a started device-code flow, answered to the client as is.
type Pairing struct {
	ID                      string    `json:"pairing_id"`
	UserCode                string    `json:"user_code"`
	VerificationURI         string    `json:"verification_uri"`
	VerificationURIComplete string    `json:"verification_uri_complete"`
	ExpiresAt               time.Time `json:"expires_at"`
	Interval                int       `json:"interval"`
	// Endpoint is the API endpoint the pairing runs against; only GET
	// /v1/pair reports it, so a relaunched app can bind the approval page.
	Endpoint string `json:"-"`
}

type PairState struct {
	State string
	// InstallationID is set once State is PairConnected.
	InstallationID string
	// OldServerRevoked is set once a replacing pairing connected: whether the
	// server it switched away from confirmed the old installation's revoke.
	OldServerRevoked *bool
}

// Pairer connects this device by the device-code flow (contract section B).
type Pairer interface {
	// Start with replace pairs while connected: the current connection keeps
	// capturing until the new code is approved, then is retired.
	Start(ctx context.Context, endpoint, name string, replace bool) (Pairing, error)
	Poll(ctx context.Context, id string) (PairState, error)
	Cancel(id string) error
	// Current is the pairing still waiting for approval, if any, so a
	// relaunched app can resume showing its code.
	Current() (Pairing, bool)
}

// maxTrackedPairings bounds the states remembered to publish changes once.
const maxTrackedPairings = 64

type pairingStates struct {
	mu     sync.Mutex
	states map[string]string
}

// changed records state for id and reports whether it differs from the last.
func (p *pairingStates) changed(id, state string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.states == nil || len(p.states) >= maxTrackedPairings {
		p.states = map[string]string{}
	}
	if p.states[id] == state {
		return false
	}
	p.states[id] = state
	return true
}

func pairingUnavailable() *Error {
	return &Error{Status: http.StatusNotImplemented, Code: CodeInvalidRequest, Message: "pairing unavailable"}
}

// validPairingEndpoint applies connect's rule: HTTPS, or plain HTTP to a
// literal loopback IP when the daemon allows insecure loopback.
func validPairingEndpoint(endpoint string, allowInsecureLoopback bool) bool {
	_, err := uplink.New(uplink.Options{Endpoint: endpoint, AllowLoopbackHTTP: allowInsecureLoopback})
	return err == nil
}

func (s *Server) pairStart(w http.ResponseWriter, r *http.Request) error {
	if s.config.Pairer == nil {
		return pairingUnavailable()
	}
	var body struct {
		Endpoint string  `json:"endpoint"`
		Name     *string `json:"name"`
		Replace  bool    `json:"replace"`
	}
	if err := decodeBody(r, &body); err != nil {
		return err
	}
	if !validPairingEndpoint(body.Endpoint, s.config.AllowInsecureLoopback) {
		return invalid("endpoint must be an https:// URL")
	}
	name := ""
	if body.Name != nil {
		valid, ok := ValidDeviceName(*body.Name)
		if !ok {
			return invalid("name must be 1 to %d printable characters", maxDeviceNameRunes)
		}
		name = valid
	}
	if !body.Replace && s.config.Backend.Connected(r.Context()) {
		return ErrAlreadyConnected
	}
	pairing, err := s.config.Pairer.Start(r.Context(), body.Endpoint, name, body.Replace)
	if errors.Is(err, uplink.ErrForeignVerificationPage) {
		return &Error{Status: http.StatusUnprocessableEntity, Code: "pairing_failed", Message: "Backplane answered with an approval page on another site; pairing stopped."}
	}
	if err != nil {
		return err
	}
	s.pairingEvent(pairing.ID, PairPending)
	s.writeJSON(w, http.StatusOK, pairing)
	return nil
}

func (s *Server) pairingEvent(id, state string) {
	if s.pairings.changed(id, state) {
		s.hub.publish("pairing", map[string]string{"pairing_id": id, "state": state})
	}
}

func (s *Server) pairPoll(w http.ResponseWriter, r *http.Request) error {
	if s.config.Pairer == nil {
		return pairingUnavailable()
	}
	id := r.PathValue("id")
	current, err := s.config.Pairer.Poll(r.Context(), id)
	if err != nil {
		return err
	}
	s.pairingEvent(id, current.State)
	switch current.State {
	case PairPending:
		return &Error{Status: http.StatusAccepted, Code: CodePairingPending, Message: "Waiting for approval in Backplane."}
	case PairPersisting:
		return &Error{Status: http.StatusAccepted, Code: CodePairingPersisting, Message: "Approved; connecting."}
	case PairConnected:
		s.mutated()
		answer := map[string]any{"connected": true, "installation_id": current.InstallationID}
		if current.OldServerRevoked != nil {
			answer["old_server_revoked"] = *current.OldServerRevoked
		}
		s.writeJSON(w, http.StatusOK, answer)
		return nil
	case PairDenied:
		return &Error{Status: http.StatusForbidden, Code: "pairing_denied", Message: "The pairing was denied in Backplane."}
	case PairExpired:
		return &Error{Status: http.StatusGone, Code: "pairing_expired", Message: "The pairing code expired; start again."}
	}
	return &Error{Status: http.StatusUnprocessableEntity, Code: "pairing_failed", Message: "The pairing failed; start again."}
}

func (s *Server) pairCurrent(w http.ResponseWriter, _ *http.Request) error {
	if s.config.Pairer == nil {
		return pairingUnavailable()
	}
	pairing, ok := s.config.Pairer.Current()
	if !ok {
		return &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "No pairing is waiting for approval."}
	}
	s.writeJSON(w, http.StatusOK, struct {
		Pairing
		Endpoint string `json:"endpoint"`
	}{pairing, pairing.Endpoint})
	return nil
}

func (s *Server) pairCancel(w http.ResponseWriter, r *http.Request) error {
	if s.config.Pairer == nil {
		return pairingUnavailable()
	}
	if err := s.config.Pairer.Cancel(r.PathValue("id")); err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, map[string]bool{"cancelled": true})
	return nil
}

// PairingSettled publishes a pairing's final state as soon as the pairer
// knows it, so subscribers learn it whether or not a client polls.
func (s *Server) PairingSettled(id, state string) {
	if !s.pairings.changed(id, state) {
		return
	}
	if state == PairConnected {
		s.mutated()
	}
	s.hub.publish("pairing", map[string]string{"pairing_id": id, "state": state})
}
