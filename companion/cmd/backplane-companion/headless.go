// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/binding"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/hook"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/shim"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// Headless (operator-managed) mode: an operator's config file names the one
// identity a data root captures for, and the device token is a file the
// operator provisions. The companion never enrolls, pairs, rotates, revokes
// or deletes a credential here, and never uses a keyring.

// headlessConfig is the operator's config: the only authority that picks,
// or switches, the identity the data root captures for.
type headlessConfig struct {
	identity          binding.Identity
	token             credentials.TokenFileSpec
	allowLoopbackHTTP bool
	// hookSocket, when set, is where a coding agent running as hookPeerUID
	// hands this daemon hook records while a verified session captures.
	hookSocket  string
	hookPeerUID int
}

const maxHeadlessConfigBytes = 64 << 10

func headlessConfigRefused(what string) error {
	return fmt.Errorf("%w: %s", errHeadlessConfigInvalid, what)
}

// loadHeadlessConfig never repeats a value it refuses: a token pasted into
// the wrong field must not reach a log.
func loadHeadlessConfig(path string) (headlessConfig, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return headlessConfig{}, headlessConfigRefused("path")
	}
	data, err := readOperatorConfig(path)
	if err != nil {
		return headlessConfig{}, err
	}
	var fields struct {
		Endpoint          string `json:"endpoint"`
		TokenFile         string `json:"token_file"`
		InstallationID    string `json:"installation_id"`
		OwnerEmail        string `json:"owner_email"`
		TokenUID          *int   `json:"token_uid"`
		TokenGID          *int   `json:"token_gid"`
		AllowLoopbackHTTP bool   `json:"allow_loopback_http"`
		HookSocket        string `json:"hook_socket"`
		HookPeerUID       *int   `json:"hook_peer_uid"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fields); err != nil || decoder.More() {
		return headlessConfig{}, headlessConfigRefused("fields")
	}
	config := headlessConfig{
		allowLoopbackHTTP: fields.AllowLoopbackHTTP,
		token:             credentials.TokenFileSpec{Path: fields.TokenFile, UID: os.Geteuid(), GID: os.Getegid()},
	}
	if config.identity.Origin, err = binding.NormalizeOrigin(fields.Endpoint, fields.AllowLoopbackHTTP); err != nil {
		return headlessConfig{}, fmt.Errorf("%w: endpoint: %w", errHeadlessConfigInvalid, err)
	}
	if config.identity.InstallationID, err = binding.NormalizeInstallationID(fields.InstallationID); err != nil {
		return headlessConfig{}, fmt.Errorf("%w: %w", errHeadlessConfigInvalid, err)
	}
	if config.identity.OwnerEmail, err = binding.NormalizeOwnerEmail(fields.OwnerEmail); err != nil {
		return headlessConfig{}, fmt.Errorf("%w: %w", errHeadlessConfigInvalid, err)
	}
	// The file itself (owner, mode, content) is checked at every read; only a
	// path that can never name it, or a token pasted as one, is the config's.
	tokenFile := fields.TokenFile
	if !filepath.IsAbs(tokenFile) || filepath.Clean(tokenFile) != tokenFile || strings.HasPrefix(filepath.Base(tokenFile), "bpc_") {
		return headlessConfig{}, headlessConfigRefused("token_file")
	}
	if fields.TokenUID != nil {
		config.token.UID = *fields.TokenUID
	}
	if fields.TokenGID != nil {
		config.token.GID = *fields.TokenGID
	}
	// Both hook fields or neither: a socket with no peer would serve no one,
	// a peer with no socket is a misread config.
	if (fields.HookSocket != "") != (fields.HookPeerUID != nil) {
		return headlessConfig{}, headlessConfigRefused("hook_socket")
	}
	if fields.HookSocket != "" {
		if !filepath.IsAbs(fields.HookSocket) || filepath.Clean(fields.HookSocket) != fields.HookSocket {
			return headlessConfig{}, headlessConfigRefused("hook_socket")
		}
		// Root would be admitted by a 0 and the daemon itself by its own uid;
		// the socket serves exactly one other user.
		if *fields.HookPeerUID <= 0 || *fields.HookPeerUID == os.Geteuid() {
			return headlessConfig{}, headlessConfigRefused("hook_peer_uid")
		}
		config.hookSocket, config.hookPeerUID = fields.HookSocket, *fields.HookPeerUID
	}
	return config, nil
}

// operatorManaged: this process runs headless, or a headless daemon bound
// the root. No keyring holds such a root's token, and commands that would
// enroll, pair, sign out or act with the owner's authority refuse.
func (a *app) operatorManaged(layout store.Layout) bool {
	if a.headless != nil {
		return true
	}
	_, err := os.Lstat(layout.Binding())
	return err == nil
}

// refuseOperatorManaged refuses a command that would change an
// operator-managed root: only the operator's config and token file do. A
// root that cannot be named is left to the command to report.
func (a *app) refuseOperatorManaged() error {
	if root, err := a.dataRoot(); err == nil && a.operatorManaged(store.Layout{Root: root}) {
		return errHeadlessOperatorManaged
	}
	return nil
}

func (a *app) runHeadless(ctx context.Context, configPath, manifest, otelcolManifest string) error {
	// The token file is the only credential source: a keyring selection is a
	// conflicting one, refused rather than ignored.
	if a.getenv(credentials.EnvStore) != "" {
		a.logError(errCredentialSourceConflict)
		return errCredentialSourceConflict
	}
	config, err := loadHeadlessConfig(configPath)
	if err == nil {
		err = a.refuseTokenFileInDataRoot(config.token.Path)
	}
	if err == nil && config.hookSocket != "" {
		// Refused at start, not at the first session: an unsafe directory is
		// the operator's to fix before anything captures.
		err = hook.CheckDirectory(config.hookSocket)
	}
	if err != nil {
		a.logError(err)
		return err
	}
	a.headless = &config
	return a.superviseHeadless(ctx, manifest, otelcolManifest)
}

// refuseTokenFileInDataRoot: a switch would carry a token file inside the
// data root into quarantine along with the binding's state.
func (a *app) refuseTokenFileInDataRoot(tokenFile string) error {
	root, err := a.dataRoot()
	if err != nil {
		return err
	}
	roots := []string{filepath.Clean(root)}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		roots = append(roots, resolved)
	}
	for _, dir := range roots {
		relative, err := filepath.Rel(dir, tokenFile)
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return errTokenFileInDataRoot
		}
	}
	return nil
}

// superviseHeadless is superviseDaemon for operator-managed roots: every
// session waits for the gate, and a stop drains what is queued, bounded.
func (a *app) superviseHeadless(ctx context.Context, manifest, otelcolManifest string) error {
	root, err := a.dataRoot()
	if err == nil {
		err = store.EnsurePrivateDir(root)
	}
	if err != nil {
		a.logError(err)
		return err
	}
	layout := store.Layout{Root: root}
	lock, acquired, err := store.TryLock(layout.DaemonLock())
	if err != nil {
		a.logError(err)
		return err
	}
	if !acquired {
		a.logError(daemon.ErrAlreadyRunning)
		return nil
	}
	defer lock.Unlock()
	// Held for the daemon's lifetime: there is no connect or disconnect to
	// yield it to.
	session, err := store.Lock(ctx, layout.SessionLock())
	if err != nil {
		return nil
	}
	defer session.Unlock()
	gate := a.newHeadlessGate(layout)
	// A switch a crash interrupted is rolled forward before anything else
	// writes the root. A failure is held on, and retried, by the gate.
	if _, err := binding.Recover(root); err != nil {
		gate.record(headlessHeld, switchHold(err))
	}
	if layout, err = store.Open(root); err != nil {
		a.logError(err)
		return err
	}
	if err := store.WriteJSON(layout.DaemonPID(), daemonProcess{PID: os.Getpid()}); err != nil {
		a.logError(err)
		return err
	}
	defer os.Remove(layout.DaemonPID())
	a.connectionWake = make(chan struct{}, 1)
	a.uploadFlush = daemon.NewFlushSignal()
	controlAPI := a.startControlAPI(ctx, layout)
	if controlAPI != nil {
		defer controlAPI.Close()
	}
	defer a.daemonPairing.idle()
	a.logArtifacts(manifest, otelcolManifest)
	var runner *beacon.Runner
	for {
		verified, ok := gate.await(ctx)
		if !ok {
			return nil
		}
		if runner == nil {
			if runner, ok = a.awaitBeacon(ctx, manifest, layout); !ok {
				verified.client.Close()
				return nil
			}
		}
		rejected, err := a.runHeadlessSession(ctx, layout, verified, runner, otelcolManifest, sessionPublisher(controlAPI))
		verified.client.Close()
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return err
		}
		if rejected {
			gate.reject(verified.tokenFile)
		}
	}
}

// stopDrainTimeout bounds the upload a stopping headless daemon makes of
// what is already queued; what is not acknowledged by then stays queued.
const stopDrainTimeout = 8 * time.Second

// runHeadlessSession captures until the token file changes, the server
// rejects the token or ctx ends, and reports whether the token was rejected.
func (a *app) runHeadlessSession(ctx context.Context, layout store.Layout, verified verifiedSession, runner *beacon.Runner, otelcolManifest string, sessions func(daemon.SessionEvent)) (rejected bool, err error) {
	// Items stamped before the binding (a slow hook that read the previous
	// binding's policy) must not upload under it.
	if err := purgeInboxBefore(layout, verified.installation.ConnectedAt); err != nil {
		a.logError(err)
	}
	sessionCtx, endSession := context.WithCancel(ctx)
	defer endSession()
	go watchTokenFile(sessionCtx, a.headless.token.Path, verified.tokenFile, endSession)
	// The hook socket exists only while this verified binding captures: it
	// is opened after the purge and closed before the stop drain, so no
	// record is retained for a binding other than the one it was sent to.
	hookSocket, err := a.serveHookSocket(layout)
	if err != nil {
		a.logError(err)
		return false, err
	}
	defer hookSocket.Close()
	agentEnv := a.sessionAgentEnv(layout)
	otel := a.otelConfig(layout, otelcolManifest)
	a.recordDaemonVersion(layout, runner)
	a.logLine("started")
	capture := daemon.New(daemon.Config{InstallationID: verified.installation.ID, VerifyPolicyInstallation: true, Layout: layout, Client: headlessCapture{verified.client}, Normalizer: runner, Registry: a.registry, Home: a.home, TempDirs: a.tempDirs, Now: a.now, AgentEnv: agentEnv, OTel: otel, Sessions: sessions, Flush: a.uploadFlush})
	err = capture.RunLocked(sessionCtx)
	hookSocket.Close()
	if errors.Is(err, daemon.ErrRevoked) {
		return true, nil
	}
	if ctx.Err() == nil {
		return false, err
	}
	// Stopping: the source passes ended with the session; only what is queued
	// is sent, and never with a token the server rejected.
	if admission, _ := state.Load[state.Admission](layout.Admission()); !admission.RevokedFor(verified.installation.ID) {
		draining, cancel := context.WithTimeout(context.Background(), stopDrainTimeout)
		capture.Drain(draining)
		cancel()
	}
	return false, nil
}

// hookSocket is the session's hook listener, or nothing when the config
// names none; Close is safe to call twice.
type hookSocket struct{ server *hook.Server }

func (s hookSocket) Close() {
	if s.server != nil {
		s.server.Close()
	}
}

// serveHookSocket binds the configured hook socket and hands every frame
// to the same shim `hook <agent>` runs, in this process.
func (a *app) serveHookSocket(layout store.Layout) (hookSocket, error) {
	if a.headless.hookSocket == "" {
		return hookSocket{}, nil
	}
	listener, err := hook.Listen(a.headless.hookSocket, hook.Options{PeerUID: a.headless.hookPeerUID, ReadPeerUID: a.hookPeerUID})
	if err != nil {
		return hookSocket{}, err
	}
	sink := hookSink{shim.Shim{Layout: layout, Registry: a.registry, Home: a.home, TempDirs: a.tempDirs, Now: a.now}}
	return hookSocket{hook.Serve(listener, sink)}, nil
}

// hookSink delivers socket frames to the hook shim. Only agents whose
// observations arrive through an in-agent plugin are served: the others
// run the shim themselves as this uid.
type hookSink struct{ shim shim.Shim }

func (s hookSink) Serves(name string) bool {
	adapter, err := s.shim.Registry.Lookup(name)
	return err == nil && adapter.Ingress() == agent.IngressPlugin
}

func (s hookSink) Deliver(name string, payload []byte) {
	s.shim.HandleAndRecord(name, bytes.NewReader(payload))
}

func (s hookSink) Refuse(err error) { s.shim.RecordFailure(err.Error()) }

// watchTokenFile ends the session once the token file is replaced,
// rewritten, touched, chmodded, chowned or removed.
func watchTokenFile(ctx context.Context, path string, read credentials.FileIdentity, end func()) {
	ticker := time.NewTicker(sessionWatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if current, err := credentials.StatTokenFile(path); err != nil || current != read {
				end()
				return
			}
		}
	}
}

// headlessCapture is a headless session's capture client. Auto-match would
// write a mapping, which only the owner does for an operator-managed device:
// the refusal reads as auto-match disabled, so the item is set aside as
// unmatched rather than holding up the inbox.
type headlessCapture struct{ *uplink.Client }

var errAutoMatchRefused = fmt.Errorf("%w: %w", uplink.ErrForbidden, uplink.ErrHeadlessPathRefused)

func (headlessCapture) ResolveMapping(context.Context, string) (policy.Mapping, error) {
	return policy.Mapping{}, errAutoMatchRefused
}

const (
	headlessCapturing = "capturing"
	headlessHeld      = "held"
	// The hold's retry backoff grows from the connection poll interval to
	// this many times it (30 s to 5 min in production).
	holdBackoffCeiling = 10
)

// headlessState is what the daemon last decided, for status in any process.
type headlessState struct {
	State  string `json:"state"`
	Reason string `json:"reason"`
	// BlockedBy names the data-root entry a switch_blocked switch cannot
	// move: only the operator may take it out of the way.
	BlockedBy string    `json:"blocked_by,omitempty"`
	Since     time.Time `json:"since"`
}

// gateRecord is headless.json. The rejected token file (its metadata, never
// its bytes) outlives the process, so no restart sends it again.
type gateRecord struct {
	headlessState
	RejectedTokenFile *credentials.FileIdentity `json:"rejected_token_file,omitempty"`
}

// verifiedSession is what the gate let through: a client restricted to the
// capture routes and the token file it read.
type verifiedSession struct {
	client       *uplink.Client
	tokenFile    credentials.FileIdentity
	installation state.Installation
}

// headlessGate lets a session run only once the token file reads safely,
// /me verifies the configured identity, the root is bound to it and /policy
// agrees. Anything else holds: no source is read and nothing is sent.
type headlessGate struct {
	app    *app
	layout store.Layout
	config headlessConfig
	// decided is what headless.json last said; its reason and entry are the
	// hold last logged ("" while capturing).
	decided headlessState
	// rejectedToken is the token file the server last rejected; it is never
	// sent again unchanged.
	rejectedToken *credentials.FileIdentity
}

func (a *app) newHeadlessGate(layout store.Layout) *headlessGate {
	persisted, err := state.Load[gateRecord](layout.HeadlessState())
	if err != nil {
		a.logError(err)
	}
	// The decision is not carried over, so this process logs its own holds.
	return &headlessGate{app: a, layout: layout, config: *a.headless, rejectedToken: persisted.RejectedTokenFile}
}

func (g *headlessGate) await(ctx context.Context) (verifiedSession, bool) {
	delay := g.app.pollInterval()
	for {
		verified, err := g.verify(ctx)
		if err == nil {
			g.record(headlessCapturing, nil)
			return verified, true
		}
		if ctx.Err() != nil {
			return verifiedSession{}, false
		}
		g.record(headlessHeld, err)
		if !g.waitForRetry(ctx, delay) {
			return verifiedSession{}, false
		}
		delay = min(delay*2, holdBackoffCeiling*g.app.pollInterval())
	}
}

// record logs a hold once per reason (and blocking entry) and persists the
// decision for status.
func (g *headlessGate) record(decided string, cause error) {
	next := headlessState{State: decided}
	if cause != nil {
		next.Reason, next.BlockedBy = errorCode(cause), blockingEntry(cause)
	}
	if decided == headlessHeld && next.Reason == g.decided.Reason && next.BlockedBy == g.decided.BlockedBy {
		return
	}
	if cause != nil {
		g.app.logError(cause)
	}
	next.Since = g.app.now().UTC()
	g.decided = next
	g.persist()
}

func (g *headlessGate) persist() {
	if err := store.WriteJSON(g.layout.HeadlessState(), gateRecord{headlessState: g.decided, RejectedTokenFile: g.rejectedToken}); err != nil {
		g.app.logError(err)
	}
}

func blockingEntry(err error) string {
	var conflict *binding.ConflictError
	if errors.As(err, &conflict) {
		return conflict.Entry
	}
	return ""
}

// switchHold names why a switch did not finish: an entry in its way, which
// only the operator can move, or anything else, retried as it is.
func switchHold(err error) error {
	if errors.Is(err, binding.ErrQuarantineConflict) {
		return fmt.Errorf("%w: %w", errSwitchBlocked, err)
	}
	return fmt.Errorf("%w: %w", binding.ErrSwitchInProgress, err)
}

// waitForRetry waits out delay, or less once the token file changes. A
// rejected token file is waited on until it changes, however long.
func (g *headlessGate) waitForRetry(ctx context.Context, delay time.Duration) bool {
	path := g.config.token.Path
	seen, _ := credentials.StatTokenFile(path)
	if g.rejectedToken != nil {
		seen = *g.rejectedToken
	}
	retryAt := time.Now().Add(delay)
	for {
		wait := sessionWatchInterval
		if g.rejectedToken == nil {
			wait = min(wait, time.Until(retryAt))
		}
		if !sleep(ctx, wait) {
			return false
		}
		if current, _ := credentials.StatTokenFile(path); current != seen {
			return true
		}
		if g.rejectedToken == nil && !time.Now().Before(retryAt) {
			return true
		}
	}
}

func (g *headlessGate) verify(ctx context.Context) (verifiedSession, error) {
	root := g.layout.Root
	// Rolled forward before anything is sent: no request while a journal
	// exists.
	recovered, err := binding.Recover(root)
	if err != nil {
		return verifiedSession{}, switchHold(err)
	}
	if recovered {
		if _, err := store.Open(root); err != nil {
			return verifiedSession{}, err
		}
	}
	token, tokenIdentity, err := credentials.ReadTokenFile(g.config.token)
	if g.rejectedToken != nil && (err != nil || tokenIdentity != *g.rejectedToken) {
		g.rejectedToken = nil
	}
	if err != nil {
		return verifiedSession{}, err
	}
	if g.rejectedToken != nil {
		return verifiedSession{}, errCredentialRejected
	}
	if err := g.holdUnreplacedToken(tokenIdentity); err != nil {
		return verifiedSession{}, err
	}
	client, err := uplink.New(uplink.Options{Endpoint: g.config.identity.Origin, AllowLoopbackHTTP: g.config.allowLoopbackHTTP})
	if err != nil {
		return verifiedSession{}, err
	}
	device, err := client.WithDeviceToken(token)
	if err != nil {
		client.Close()
		return verifiedSession{}, err
	}
	device = device.Headless()
	verified := verifiedSession{client: device, tokenFile: tokenIdentity}
	identity, err := g.askMe(ctx, device)
	if err == nil {
		err = g.settleBinding(identity, tokenIdentity)
	}
	if err == nil {
		verified.installation, err = g.installation()
	}
	if err == nil {
		err = g.checkPolicy(ctx, device)
	}
	if err != nil {
		if errors.Is(err, errCredentialRejected) {
			g.reject(tokenIdentity)
		}
		device.Close()
		return verifiedSession{}, err
	}
	return verified, nil
}

// askMe returns the identity the server knows the token as.
func (g *headlessGate) askMe(ctx context.Context, device *uplink.Client) (binding.Identity, error) {
	asking, cancel := context.WithTimeout(ctx, meTimeout)
	defer cancel()
	me, err := device.Me(asking)
	if err != nil {
		return binding.Identity{}, headlessReason(err)
	}
	verified := binding.Identity{Origin: g.config.identity.Origin}
	// A value that does not normalize can never equal the configured one.
	verified.InstallationID, _ = binding.NormalizeInstallationID(me.Installation.ID)
	verified.OwnerEmail, _ = binding.NormalizeOwnerEmail(me.User.Email)
	return verified, nil
}

// headlessReason names why the server did not verify the token. Uplink
// never follows a redirect, so its target receives nothing.
func headlessReason(err error) error {
	var answered *uplink.StatusError
	switch {
	case errors.Is(err, uplink.ErrDeviceRevoked):
		return fmt.Errorf("%w: %w", errCredentialRejected, err)
	case errors.As(err, &answered) && answered.Status >= 300 && answered.Status < 400:
		return fmt.Errorf("%w: %w", errEndpointRedirected, err)
	case errors.Is(err, uplink.ErrUnauthorized):
		return fmt.Errorf("%w: %w", errUpstreamUnauthorized, err)
	case errors.Is(err, uplink.ErrForbidden):
		return fmt.Errorf("%w: %w", errUpstreamForbidden, err)
	case errors.Is(err, uplink.ErrNotFound):
		return fmt.Errorf("%w: %w", errCompanionUnavailable, err)
	}
	// 429, 5xx, network failures and timeouts stay server_unavailable.
	return err
}

// holdUnreplacedToken: a switch presents the token file to the configured
// origin, and one /me verified under the binding being switched away from
// is that binding's credential. It is not sent until the operator replaces
// it. A switch a journal already records is not re-checked.
func (g *headlessGate) holdUnreplacedToken(tokenFile credentials.FileIdentity) error {
	active, err := binding.Load(g.layout.Root)
	if err != nil {
		return err
	}
	if active == nil || active.BindingID == g.config.identity.ID() {
		return nil
	}
	if active.VerifiedTokenFile == nil {
		// Which token this binding verified is unknown (a switch that recovery
		// completed, or a record older than the field): take the present file
		// to be its, so only a replaced file goes to the new origin.
		active.VerifiedTokenFile = &tokenFile
		if err := binding.Save(g.layout.Root, *active); err != nil {
			return err
		}
	}
	if *active.VerifiedTokenFile == tokenFile {
		return errTokenNotReplacedForSwitch
	}
	return nil
}

// settleBinding binds a fresh root, or carries out the operator's switch,
// so that the root's state belongs to the configured identity before any of
// it is read or sent, and records the token file /me verified for it. Only
// the config switches; a token never does.
func (g *headlessGate) settleBinding(verified binding.Identity, tokenFile credentials.FileIdentity) error {
	root, configured := g.layout.Root, g.config.identity
	decision, err := binding.Decide(root, configured, &verified)
	if err == nil && decision == binding.Switch {
		if err = g.switchBinding(); err == nil {
			decision, err = binding.Decide(root, configured, &verified)
		}
	}
	if err != nil {
		return err
	}
	switch decision {
	case binding.Fresh:
		now := g.app.now().UTC()
		return binding.Save(root, binding.Record{Version: 1, BindingID: configured.ID(), Origin: configured.Origin, InstallationID: configured.InstallationID, OwnerEmail: configured.OwnerEmail, BoundAt: now, LastVerifiedAt: now, VerifiedTokenFile: &tokenFile})
	case binding.Resume:
		record, err := binding.Load(root)
		if err != nil || record == nil || (record.VerifiedTokenFile != nil && *record.VerifiedTokenFile == tokenFile) {
			return err
		}
		record.VerifiedTokenFile = &tokenFile
		return binding.Save(root, *record)
	case binding.HoldIdentityMismatch:
		return errIdentityMismatch
	case binding.HoldUnboundState:
		return errUnboundState
	}
	return binding.ErrSwitchInProgress
}

// switchBinding sets the active binding's state aside under quarantine/ and
// restores the configured identity's, if an earlier switch left it there.
// Nothing is flushed to, or revoked on, the server switched away from.
func (g *headlessGate) switchBinding() error {
	root := g.layout.Root
	active, err := binding.Load(root)
	if err != nil {
		return err
	}
	from := binding.Identity{Origin: active.Origin, InstallationID: active.InstallationID, OwnerEmail: active.OwnerEmail}
	if err := binding.SwitchTo(root, from, g.config.identity, g.app.now().UTC()); err != nil {
		return switchHold(err)
	}
	// The switch moved queue/, inbox/ and work/ aside; hooks and status
	// expect them.
	_, err = store.Open(root)
	return err
}

// installation keeps installation.json the binding's, written when the
// binding starts (or a switch moved the previous one aside), and clears a
// rejection once a token for it verified again.
func (g *headlessGate) installation() (state.Installation, error) {
	record, err := binding.Load(g.layout.Root)
	if err != nil {
		return state.Installation{}, err
	}
	if admission, _ := state.Load[state.Admission](g.layout.Admission()); admission.RevokedFor(record.InstallationID) {
		if err := os.Remove(g.layout.Admission()); err != nil {
			return state.Installation{}, err
		}
	}
	current, _ := state.Load[state.Installation](g.layout.Installation())
	if current.ID == record.InstallationID && current.Endpoint == record.Origin && current.ConnectedAt.Equal(record.BoundAt) {
		return current, nil
	}
	installation := state.Installation{ID: record.InstallationID, Endpoint: record.Origin, AllowLoopbackHTTP: g.config.allowLoopbackHTTP, ConnectedAt: record.BoundAt}
	return installation, store.WriteJSON(g.layout.Installation(), installation)
}

// checkPolicy refuses a server whose policy is for another installation
// than /me verified; nothing of it is cached.
func (g *headlessGate) checkPolicy(ctx context.Context, device *uplink.Client) error {
	fetched, err := device.Policy(ctx)
	if err != nil {
		return headlessReason(err)
	}
	if fetched.Installation.ID != g.config.identity.InstallationID {
		return fmt.Errorf("%w: %w", errIdentityMismatch, daemon.ErrPolicyInstallationMismatch)
	}
	return nil
}

// reject remembers the token file the server rejected and, in the
// configured binding's own state only, records the rejection where capture
// and status look for it. Nothing is deleted.
func (g *headlessGate) reject(tokenFile credentials.FileIdentity) {
	g.rejectedToken = &tokenFile
	g.persist()
	record, _ := binding.Load(g.layout.Root)
	if record == nil || record.BindingID != g.config.identity.ID() {
		return
	}
	installationID := g.config.identity.InstallationID
	state.Update(context.Background(), g.layout, g.layout.Admission(), func(admission *state.Admission) bool {
		if admission.RevokedFor(installationID) {
			return false
		}
		admission.Unauthorized, admission.Since, admission.InstallationID = true, g.app.now().UTC(), installationID
		return true
	})
}

type headlessReport struct {
	Mode      string `json:"mode"`
	BindingID string `json:"binding_id"`
	binding.Identity
	headlessState
	Quarantined []quarantinedBinding `json:"quarantined"`
}

type quarantinedBinding struct {
	BindingID string `json:"binding_id"`
	Pending   int    `json:"pending"`
	Bytes     int64  `json:"bytes"`
}

// headlessStatus reports an operator-managed root: the binding its state
// belongs to (before one exists, the configured identity), what the daemon
// last decided, and what earlier bindings left in quarantine. It never
// carries the token or anything derived from it.
func (a *app) headlessStatus(layout store.Layout) *headlessReport {
	if !a.operatorManaged(layout) {
		return nil
	}
	report := &headlessReport{Mode: "headless", Quarantined: []quarantinedBinding{}}
	if record, _ := binding.Load(layout.Root); record != nil {
		report.Identity = binding.Identity{Origin: record.Origin, InstallationID: record.InstallationID, OwnerEmail: record.OwnerEmail}
	} else if a.headless != nil {
		report.Identity = a.headless.identity
	}
	if report.Identity != (binding.Identity{}) {
		report.BindingID = report.Identity.ID()
	}
	report.headlessState, _ = state.Load[headlessState](layout.HeadlessState())
	entries, _ := os.ReadDir(layout.QuarantineDir())
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		// Quarantined records keep their own ledger and never count against
		// the active queue.
		held, _ := queue.Open(store.Layout{Root: filepath.Join(layout.QuarantineDir(), entry.Name())}).Stats()
		report.Quarantined = append(report.Quarantined, quarantinedBinding{BindingID: entry.Name(), Pending: held.Records, Bytes: held.Bytes})
	}
	return report
}
