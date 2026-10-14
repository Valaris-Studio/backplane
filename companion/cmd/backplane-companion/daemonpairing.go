// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"sync"

	"github.com/Valaris-Studio/backplane/companion/internal/buildinfo"
	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/pairing"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// daemonPairer serves the control API's pairing with connect --browser's
// own preflight and persistence, so a connection paired through the daemon
// is stored exactly as the CLI stores one.
//
// Persisting ends the daemon's capture session like disconnect does: it
// runs on the pairing's own goroutine while the session loop, which is not
// blocked on it, releases the session lock. A plain pairing is only allowed
// while no session captures, so that lock is normally free already; a
// replacing one (switch server) keeps the session capturing until approval.
type daemonPairer struct {
	app    *app
	layout store.Layout
	// root bounds every pairing's polling: the daemon's lifetime.
	root context.Context
	// settled publishes a pairing's final state; connected wakes the daemon's
	// wait for a connection.
	settled   func(id, state string)
	connected func()

	mu sync.Mutex
	// managers holds the one current pairing: only one can become this
	// device's connection, so a newer start supersedes an older one.
	managers map[string]*pairing.Manager
	// pending is the current pairing's answer to start, until it settles.
	pending control.Pairing
	// switches holds the current replacing pairing's outcome, by pairing id.
	switches map[string]*switchOutcome
}

func (a *app) newDaemonPairer(root context.Context, layout store.Layout) *daemonPairer {
	return &daemonPairer{app: a, layout: layout, root: root, managers: map[string]*pairing.Manager{}, switches: map[string]*switchOutcome{}, settled: func(string, string) {}, connected: a.wakeForConnection}
}

func (p *daemonPairer) Start(ctx context.Context, endpoint, name string, replace bool) (control.Pairing, error) {
	if p.persisting() {
		// The approved pairing is becoming this device's connection; a new
		// one would only race it.
		return control.Pairing{}, control.ErrPairingPersisting
	}
	if replace && p.app.sameServerAsCurrent(ctx, p.layout, endpoint) {
		return control.Pairing{}, control.ErrSameServer
	}
	revokedTokenID, err := p.app.connectPreflight(ctx, p.layout, replace)
	if err != nil {
		return control.Pairing{}, err
	}
	persist := p.app.persistPairing(p.layout, revokedTokenID, p.app.now().UTC())
	var outcome *switchOutcome
	if replace {
		outcome = &switchOutcome{}
		persist = p.app.persistSwitch(p.layout, revokedTokenID, p.app.now().UTC(), outcome)
	}
	manager := pairing.New(p.root, pairing.Config{
		Persist: func(ctx context.Context, grant pairing.Grant) error {
			if err := persist(ctx, grant); err != nil {
				return err
			}
			p.connected()
			return nil
		},
		Persisting:        func(id string) { p.settled(id, control.PairPersisting) },
		Platform:          p.app.goos,
		Arch:              p.app.goarch,
		CompanionVersion:  buildinfo.Current(p.app.goos, p.app.goarch).Version,
		AllowLoopbackHTTP: p.app.getenv(envAllowInsecureLoopback) == "1",
		IntervalUnit:      p.app.pairingIntervalOrDefault(),
	})
	started, err := manager.Start(ctx, endpoint, name)
	if err != nil {
		manager.Close()
		return control.Pairing{}, err
	}
	answer := control.Pairing{
		ID:                      started.ID,
		UserCode:                started.UserCode,
		VerificationURI:         started.VerificationURI,
		VerificationURIComplete: started.VerificationURIComplete,
		ExpiresAt:               started.ExpiresAt,
		Interval:                started.Interval,
		Endpoint:                started.Endpoint,
	}
	p.mu.Lock()
	superseded := p.managers
	p.managers = map[string]*pairing.Manager{started.ID: manager}
	p.switches = map[string]*switchOutcome{}
	if outcome != nil {
		p.switches[started.ID] = outcome
	}
	p.pending = answer
	p.mu.Unlock()
	for id, older := range superseded {
		// A persisting one was refused above; this pairing replaces the rest.
		_ = older.Cancel(id)
		older.Close()
	}
	go p.publishWhenSettled(manager, started.ID)
	return answer, nil
}

func (p *daemonPairer) Current() (control.Pairing, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pending.ID == "" || !p.app.now().Before(p.pending.ExpiresAt) {
		return control.Pairing{}, false
	}
	return p.pending, true
}

func (p *daemonPairer) forgetPending(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pending.ID == id {
		p.pending = control.Pairing{}
	}
}

// publishWhenSettled reports the final state without waiting for a poll; a
// cancelled pairing is forgotten and reports nothing.
func (p *daemonPairer) publishWhenSettled(manager *pairing.Manager, id string) {
	result, err := manager.Wait(p.root, id)
	p.forgetPending(id)
	if err != nil {
		return
	}
	if result.Err != nil {
		p.app.logError(result.Err)
	}
	p.settled(id, string(result.State))
}

func (p *daemonPairer) manager(id string) (*pairing.Manager, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	manager, ok := p.managers[id]
	return manager, ok
}

// idle stops every pairing still waiting for approval and waits for a grant
// being stored, so the daemon exits promptly but never leaves a persist
// behind (bounded by pairing's persist timeout). The daemon may stop with its
// context still live (a failed capture session), so waiting codes are closed
// here rather than left to expire.
func (p *daemonPairer) idle() {
	if p == nil {
		return
	}
	p.mu.Lock()
	managers := make([]*pairing.Manager, 0, len(p.managers))
	for _, manager := range p.managers {
		managers = append(managers, manager)
	}
	p.mu.Unlock()
	for _, manager := range managers {
		// Close ends the pollers' context; a persist runs on its own.
		manager.Close()
		manager.Idle()
	}
}

// persisting reports whether the current pairing's grant is being stored.
func (p *daemonPairer) persisting() bool {
	p.mu.Lock()
	managers := p.managers
	p.mu.Unlock()
	for id, manager := range managers {
		if state, err := manager.Poll(p.root, id); err == nil && state.State == pairing.StatePersisting {
			return true
		}
	}
	return false
}

func (p *daemonPairer) switchOutcome(id string) *switchOutcome {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.switches[id]
}

func (p *daemonPairer) Poll(ctx context.Context, id string) (control.PairState, error) {
	manager, ok := p.manager(id)
	if !ok {
		return control.PairState{}, control.ErrPairingNotFound
	}
	current, err := manager.Poll(ctx, id)
	if errors.Is(err, pairing.ErrUnknownPairing) {
		return control.PairState{}, control.ErrPairingNotFound
	}
	if err != nil {
		return control.PairState{}, err
	}
	answer := control.PairState{State: string(current.State), InstallationID: current.InstallationID}
	if current.State == pairing.StateConnected {
		answer.OldServerRevoked = p.switchOutcome(id).oldServerRevoked()
	}
	return answer, nil
}

// Cancel stops a pairing still waiting for approval. One whose grant is being
// stored finishes, and keeps its outcome for the poll that reports it.
func (p *daemonPairer) Cancel(id string) error {
	p.mu.Lock()
	manager, ok := p.managers[id]
	if ok && manager.Cancel(id) != nil {
		p.mu.Unlock()
		return control.ErrPairingPersisting
	}
	delete(p.managers, id)
	delete(p.switches, id)
	if p.pending.ID == id {
		p.pending = control.Pairing{}
	}
	p.mu.Unlock()
	if !ok {
		return control.ErrPairingNotFound
	}
	manager.Close()
	return nil
}
