// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package pairing connects the companion by browser code (RFC 8628): it asks
// the server for a code, a signed-in person approves it in Backplane, and a
// background poller collects the device token and hands it to Persist. It
// needs no loopback redirect or deep link, so it works behind IAP and proxies.
package pairing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

var ErrUnknownPairing = errors.New("unknown_pairing")

// ErrPersisting refuses to cancel a pairing whose grant is being stored: the
// token was collected and cannot be collected again, so storing finishes.
var ErrPersisting = errors.New("pairing_persisting")

type State string

const (
	StatePending State = "pending"
	// StatePersisting: approved and collected, the grant is being stored
	// (for a switch: flushing and retiring the old connection).
	StatePersisting State = "persisting"
	StateConnected  State = "connected"
	StateDenied     State = "denied"
	StateExpired    State = "expired"
	StateFailed     State = "failed"
)

type Pairing struct {
	ID                      string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	ExpiresAt               time.Time
	Interval                int
	// Endpoint is the normalized API endpoint the approval page belongs to.
	Endpoint string
}

type PairState struct {
	State          State
	InstallationID string
	Err            error
}

// Grant is what a successful pairing must store: the device token exists
// nowhere else, and the server delivers it only once.
type Grant struct {
	Endpoint          string
	AllowLoopbackHTTP bool
	InstallationID    string
	DeviceToken       string
	// Name is the requested name; empty means the server's neutral default.
	Name string
}

// Persist stores a grant as this device's connection. On error it must leave
// nothing behind (no keyring entry, the server installation revoked).
type Persist func(ctx context.Context, grant Grant) error

type Config struct {
	Persist Persist
	// Persisting, when set, learns that a pairing's grant is being stored.
	Persisting func(id string)
	// Preflight, when set, runs before a pairing starts, e.g. to refuse while
	// already connected.
	Preflight         func(ctx context.Context) error
	Platform          string
	Arch              string
	CompanionVersion  string
	AllowLoopbackHTTP bool
	// IntervalUnit is what one server "second" lasts; zero means time.Second.
	IntervalUnit time.Duration
}

const (
	// RFC 8628 §3.5: each slow_down adds 5 seconds to the interval.
	slowDownIncrement = 5
	// Persisting must finish even when the pairing is cancelled meanwhile: the
	// token cannot be collected again.
	persistTimeout = time.Minute
	// abandonRevokeTimeout bounds revoking a token collected for a pairing
	// that was cancelled before it could be stored.
	abandonRevokeTimeout = 10 * time.Second
)

type Manager struct {
	root     context.Context
	stop     context.CancelFunc
	config   Config
	mu       sync.Mutex
	pairings map[string]*session
	// afterCollect is a test seam: it runs between collecting a grant and
	// marking the pairing persisting.
	afterCollect func()
}

type session struct {
	id     string
	cancel context.CancelFunc
	done   chan struct{}
	state  PairState
}

// New returns a manager whose pollers stop when ctx ends or on Close.
func New(ctx context.Context, config Config) *Manager {
	if config.IntervalUnit == 0 {
		config.IntervalUnit = time.Second
	}
	root, stop := context.WithCancel(ctx)
	return &Manager{root: root, stop: stop, config: config, pairings: map[string]*session{}}
}

func (m *Manager) Close() { m.stop() }

// Idle waits until every pairing's poller has finished. A poller waiting for
// approval ends with the manager's context; one storing a grant runs to the
// end (bounded by persistTimeout), since the token exists nowhere else.
func (m *Manager) Idle() {
	m.mu.Lock()
	running := make([]*session, 0, len(m.pairings))
	for _, current := range m.pairings {
		running = append(running, current)
	}
	m.mu.Unlock()
	for _, current := range running {
		<-current.done
	}
}

// MaxExpiresIn caps the server's expires_in (seconds): a code, and the
// desktop's allowance to open its approval page, never outlive 15 minutes.
const MaxExpiresIn = 15 * 60

// Start asks endpoint for a pairing code and polls for approval in the
// background. ctx bounds only the request that starts it.
func (m *Manager) Start(ctx context.Context, endpoint, name string) (Pairing, error) {
	if m.config.Preflight != nil {
		if err := m.config.Preflight(ctx); err != nil {
			return Pairing{}, err
		}
	}
	client, err := uplink.New(uplink.Options{Endpoint: endpoint, AllowLoopbackHTTP: m.config.AllowLoopbackHTTP})
	if err != nil {
		return Pairing{}, err
	}
	started, err := client.StartPairing(ctx, uplink.PairingRequest{Name: name, Platform: m.config.Platform, Arch: m.config.Arch, CompanionVersion: m.config.CompanionVersion})
	if err != nil {
		client.Close()
		return Pairing{}, err
	}
	id, err := newPairingID()
	if err != nil {
		client.Close()
		return Pairing{}, err
	}
	expiresAt := time.Now().Add(time.Duration(min(started.ExpiresIn, MaxExpiresIn)) * m.config.IntervalUnit)
	pollCtx, cancel := context.WithDeadline(m.root, expiresAt)
	current := &session{id: id, cancel: cancel, done: make(chan struct{}), state: PairState{State: StatePending}}
	m.mu.Lock()
	m.pairings[id] = current
	m.mu.Unlock()
	grant := Grant{Endpoint: client.Endpoint(), AllowLoopbackHTTP: m.config.AllowLoopbackHTTP, Name: name}
	go m.poll(pollCtx, current, client, started, grant)
	return Pairing{
		ID:                      id,
		UserCode:                started.UserCode,
		VerificationURI:         started.VerificationURI,
		VerificationURIComplete: started.VerificationURIComplete,
		ExpiresAt:               expiresAt,
		Interval:                max(started.Interval, 1),
		Endpoint:                client.Endpoint(),
	}, nil
}

// Poll reports a pairing's state without waiting.
func (m *Manager) Poll(_ context.Context, id string) (PairState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.pairings[id]
	if !ok {
		return PairState{}, ErrUnknownPairing
	}
	return current.state, nil
}

// Wait blocks until the pairing ends or ctx does.
func (m *Manager) Wait(ctx context.Context, id string) (PairState, error) {
	m.mu.Lock()
	current, ok := m.pairings[id]
	m.mu.Unlock()
	if !ok {
		return PairState{}, ErrUnknownPairing
	}
	select {
	case <-current.done:
		return m.Poll(ctx, id)
	case <-ctx.Done():
		return PairState{}, ctx.Err()
	}
}

// Cancel stops polling and forgets the pairing. Unknown ids are ignored; a
// pairing whose grant is being stored refuses with ErrPersisting.
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	current, ok := m.pairings[id]
	if ok && current.state.State == StatePersisting {
		m.mu.Unlock()
		return ErrPersisting
	}
	delete(m.pairings, id)
	m.mu.Unlock()
	if ok {
		current.cancel()
	}
	return nil
}

func (m *Manager) finish(current *session, state PairState) {
	m.mu.Lock()
	current.state = state
	m.mu.Unlock()
	close(current.done)
}

func (m *Manager) poll(ctx context.Context, current *session, client *uplink.Client, started uplink.PairingStart, grant Grant) {
	defer client.Close()
	defer current.cancel()
	interval := time.Duration(max(started.Interval, 1)) * m.config.IntervalUnit
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				m.finish(current, PairState{State: StateExpired})
			} else {
				m.finish(current, PairState{State: StateFailed, Err: ctx.Err()})
			}
			return
		case <-timer.C:
		}
		collected, err := client.CollectPairing(ctx, started.DeviceCode)
		switch {
		case errors.Is(err, uplink.ErrSlowDown):
			interval += slowDownIncrement * m.config.IntervalUnit
		case errors.Is(err, uplink.ErrAuthorizationPending), errors.Is(err, uplink.ErrUnavailable), ctx.Err() != nil:
			// Keep polling: the network or the server may be back next time,
			// and a cancelled context ends the loop at the select.
		case errors.Is(err, uplink.ErrAccessDenied):
			m.finish(current, PairState{State: StateDenied})
			return
		case errors.Is(err, uplink.ErrExpiredToken):
			m.finish(current, PairState{State: StateExpired})
			return
		case err != nil:
			m.finish(current, PairState{State: StateFailed, Err: err})
			return
		default:
			grant.InstallationID, grant.DeviceToken = collected.InstallationID, collected.DeviceToken
			if m.afterCollect != nil {
				m.afterCollect()
			}
			m.mu.Lock()
			if m.pairings[current.id] != current {
				m.mu.Unlock()
				// Cancelled after the token was collected: nobody will ever
				// hold it, so the installation it opened must not stay active.
				revoking, done := context.WithTimeout(context.WithoutCancel(ctx), abandonRevokeTimeout)
				if device, err := client.WithDeviceToken(grant.DeviceToken); err == nil {
					device.RevokeInstallation(revoking)
				}
				done()
				m.finish(current, PairState{State: StateFailed, Err: context.Canceled})
				return
			}
			current.state = PairState{State: StatePersisting}
			m.mu.Unlock()
			if m.config.Persisting != nil {
				m.config.Persisting(current.id)
			}
			persistCtx, done := context.WithTimeout(context.WithoutCancel(ctx), persistTimeout)
			err := m.config.Persist(persistCtx, grant)
			done()
			if err != nil {
				m.finish(current, PairState{State: StateFailed, Err: fmt.Errorf("store the device credential: %w", err)})
				return
			}
			m.finish(current, PairState{State: StateConnected, InstallationID: collected.InstallationID})
			return
		}
		timer.Reset(interval)
	}
}

// newPairingID is the local handle for a pairing, never the device code.
func newPairingID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return hex.EncodeToString(random), nil
}
