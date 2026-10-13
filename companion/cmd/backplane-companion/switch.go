// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agentaccess"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	// defaultSwitchFlushTimeout bounds sending the old server what is still
	// queued once a switch is approved; whatever is left is purged with the
	// old connection, which is why the code step says so.
	defaultSwitchFlushTimeout = 15 * time.Second
	// defaultSwitchRevokeTimeout keeps an unreachable old server from holding
	// the switch (and the capture session) for a whole client timeout.
	// Together with the flush they stay well inside pairing's persistTimeout.
	defaultSwitchRevokeTimeout = 10 * time.Second
)

func (a *app) flushTimeout() time.Duration {
	if a.switchFlushTimeout == 0 {
		return defaultSwitchFlushTimeout
	}
	return a.switchFlushTimeout
}

func (a *app) revokeTimeout() time.Duration {
	if a.switchRevokeTimeout == 0 {
		return defaultSwitchRevokeTimeout
	}
	return a.switchRevokeTimeout
}

// switchOutcome is what retiring the replaced connection found; the pairing
// poll reads it once the switch connected.
type switchOutcome struct {
	mu      sync.Mutex
	retired bool
	revoked bool
}

func (o *switchOutcome) record(serverRevoked bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.retired, o.revoked = true, serverRevoked
}

// oldServerRevoked is nil until a connection was retired: a switch that
// replaced nothing, or that another connection superseded, reports nothing.
func (o *switchOutcome) oldServerRevoked() *bool {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.retired {
		return nil
	}
	revoked := o.revoked
	return &revoked
}

// retiringConnection is the connection a switch replaces; device is nil when
// its token is gone, leaving nothing to flush or revoke.
type retiringConnection struct {
	installation state.Installation
	device       *uplink.Client
}

// retiringConnectionMarker is retiring.json: written before a switch adopts
// the new connection and removed once the old one is retired, so a crash in
// between leaves no token, agents key or server installation behind.
type retiringConnectionMarker struct {
	InstallationID    string `json:"installation_id"`
	Endpoint          string `json:"endpoint"`
	AllowLoopbackHTTP bool   `json:"allow_loopback_http"`
}

// connectionToRetire is the current connection when it is not the one being
// adopted (re-pairing the same installation retires nothing).
func (a *app) connectionToRetire(layout store.Layout, adoptedID string) (retiringConnection, bool) {
	installation, device, err := a.connectedClient(layout)
	if err != nil {
		device = nil
	}
	if installation.ID == "" || installation.ID == adoptedID {
		if device != nil {
			device.Close()
		}
		return retiringConnection{}, false
	}
	return retiringConnection{installation: installation, device: device}, true
}

// flushBeforeSwitch sends the old server what it captured; the caller holds
// the session and purges the queue afterwards.
func (a *app) flushBeforeSwitch(ctx context.Context, layout store.Layout, old retiringConnection) {
	if old.device == nil {
		return
	}
	flushing, cancel := context.WithTimeout(ctx, a.flushTimeout())
	defer cancel()
	daemon.New(daemon.Config{Layout: layout, Client: old.device, InstallationID: old.installation.ID, Now: a.now}).Drain(flushing)
}

func markRetiring(layout store.Layout, old retiringConnection) error {
	return store.WriteJSON(layout.Retiring(), retiringConnectionMarker{InstallationID: old.installation.ID, Endpoint: old.installation.Endpoint, AllowLoopbackHTTP: old.installation.AllowLoopbackHTTP})
}

func unmarkRetiring(layout store.Layout) error {
	if err := os.Remove(layout.Retiring()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// adoptReplacing adopts a switch's new connection: the old server first gets
// what is queued for it (bounded), the marker names the old connection, the
// grant is adopted, and only then is the old one retired, so a failed
// adoption leaves it working. outcome receives whether the old server
// confirmed the revoke. stamp sets ConnectedAt just before adoption, so hook
// items written during the flush predate the new connection and are purged.
func (a *app) adoptReplacing(ctx context.Context, layout store.Layout, outcome *switchOutcome, installation *state.Installation, adopt func() error) error {
	old, retiring := a.connectionToRetire(layout, installation.ID)
	if retiring {
		a.flushBeforeSwitch(ctx, layout, old)
		if err := markRetiring(layout, old); err != nil {
			old.abandon()
			return err
		}
	}
	installation.ConnectedAt = a.now().UTC()
	if err := adopt(); err != nil {
		old.abandon()
		if retiring {
			err = errors.Join(err, unmarkRetiring(layout))
		}
		return err
	}
	if !retiring {
		return nil
	}
	revoked := a.retire(ctx, layout, old)
	if outcome != nil {
		outcome.record(revoked)
	}
	// A hook that read the old policy can land an item after adoption's
	// purge, stamped while the old queue flushed: it predates ConnectedAt.
	if err := purgeInboxBefore(layout, installation.ConnectedAt); err != nil {
		a.logError(err)
	}
	return unmarkRetiring(layout)
}

// retire signs the old installation out on its server, best effort, and
// drops what this device held for it. Reports whether the server confirmed.
func (a *app) retire(ctx context.Context, layout store.Layout, old retiringConnection) (serverRevoked bool) {
	if old.device != nil {
		revoking, cancel := context.WithTimeout(ctx, a.revokeTimeout())
		err := old.device.RevokeInstallation(revoking)
		cancel()
		// The revoked-token 401 means the server already revoked it.
		serverRevoked = err == nil || errors.Is(err, uplink.ErrDeviceRevoked)
		old.device.Close()
	}
	// Agents' entries are the old connection's only while the access file
	// still names its server; a later grant for the new one stays.
	access, _ := agentaccess.Load(layout)
	if access.Endpoint == "" || access.Endpoint == old.installation.Endpoint {
		a.removeAgentAccess(layout, old.installation.ID)
	}
	for _, account := range []string{credentials.AgentKeyAccount(old.installation.ID), old.installation.ID} {
		if err := a.keyring.Delete(account); err != nil && !errors.Is(err, credentials.ErrNotFound) {
			a.logError(err)
		}
	}
	return serverRevoked
}

// finishRetirement completes a switch a crash interrupted. A marker naming
// the current connection means adoption never happened: it is dropped and
// nothing is retired.
func (a *app) finishRetirement(ctx context.Context, layout store.Layout) error {
	marker, err := state.Load[retiringConnectionMarker](layout.Retiring())
	if err != nil {
		// Unreadable, it would fail every later session and connect: set it
		// aside once, kept for diagnosis.
		quarantine := fmt.Sprintf("%s.corrupt-%d", layout.Retiring(), a.now().UnixNano())
		if renameErr := os.Rename(layout.Retiring(), quarantine); renameErr != nil {
			return errors.Join(err, renameErr)
		}
		a.logError(fmt.Errorf("%w: retiring.json set aside as %s", err, filepath.Base(quarantine)))
		return nil
	}
	if marker.InstallationID == "" {
		return nil
	}
	current, err := state.Load[state.Installation](layout.Installation())
	if err != nil {
		return err
	}
	if current.ID != marker.InstallationID {
		old := retiringConnection{installation: state.Installation{ID: marker.InstallationID, Endpoint: marker.Endpoint, AllowLoopbackHTTP: marker.AllowLoopbackHTTP}}
		if token, err := a.keyring.Load(marker.InstallationID); err == nil {
			if client, err := uplink.New(uplink.Options{Endpoint: marker.Endpoint, AllowLoopbackHTTP: marker.AllowLoopbackHTTP}); err == nil {
				if device, err := client.WithDeviceToken(token); err == nil {
					old.device = device
				} else {
					client.Close()
				}
			}
		}
		a.retire(ctx, layout, old)
	}
	return unmarkRetiring(layout)
}

// meTimeout bounds asking the current server for its web address before a
// switch; an unreachable server only skips that comparison.
const meTimeout = 5 * time.Second

// sameServerAsCurrent reports whether endpoint names the Backplane this
// device is connected to, by its API endpoint or its web origin.
func (a *app) sameServerAsCurrent(ctx context.Context, layout store.Layout, endpoint string) bool {
	installation, device, err := a.connectedClient(layout)
	if installation.ID == "" {
		return false
	}
	if sameServer(installation.Endpoint, endpoint) {
		if err == nil {
			device.Close()
		}
		return true
	}
	if err != nil {
		return false
	}
	defer device.Close()
	asking, cancel := context.WithTimeout(ctx, meTimeout)
	defer cancel()
	me, err := device.Me(asking)
	return err == nil && me.WebOrigin != nil && sameServer(*me.WebOrigin, endpoint)
}

// abandon releases a retiring connection that stays current after all.
func (old retiringConnection) abandon() {
	if old.device != nil {
		old.device.Close()
	}
}

// sameServer compares Backplane URLs as the user types them: scheme and host
// without regard to case, an explicit default port, and a path without its
// trailing slash.
func sameServer(a, b string) bool {
	normalize := func(raw string) (string, bool) {
		parsed, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || parsed.Host == "" {
			return "", false
		}
		scheme, host := strings.ToLower(parsed.Scheme), strings.ToLower(parsed.Hostname())
		port := parsed.Port()
		if scheme == "https" && port == "443" || scheme == "http" && port == "80" {
			port = ""
		}
		if port != "" {
			host = net.JoinHostPort(host, port)
		}
		return scheme + "://" + host + strings.TrimRight(parsed.Path, "/"), true
	}
	left, okLeft := normalize(a)
	right, okRight := normalize(b)
	return okLeft && okRight && left == right
}
