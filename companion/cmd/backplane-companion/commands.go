// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/buildinfo"
	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/pairing"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/process"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	envAPIKey          = "BACKPLANE_API_KEY"
	envBeaconArtifact  = "BACKPLANE_BEACON_ARTIFACT"
	envOtelcolArtifact = "BACKPLANE_OTELCOL_ARTIFACT"
)

var errOTelCollectorUnavailable = errors.New("otel_collector_unavailable")

func (a *app) connect(ctx context.Context, args []string) error {
	flags := newFlags("connect")
	endpoint := flags.String("endpoint", "", "Backplane URL")
	name := flags.String("name", "", "device name (default: OS, architecture and installation id)")
	loopback := flags.Bool("allow-insecure-loopback", false, "allow plain HTTP to a loopback IP (development)")
	browser := flags.Bool("browser", false, "pair by approving a code in Backplane instead of an API key")
	replace := flags.Bool("replace", false, "switch servers: retire the current connection once the new one is made")
	if err := flags.Parse(args); err != nil || *endpoint == "" || flags.NArg() != 0 {
		return fmt.Errorf("%w: connect --endpoint URL [--name NAME] [--browser] [--replace]", errUsage)
	}
	layout, err := a.layout()
	if err != nil {
		return err
	}
	if *browser {
		return a.connectByBrowser(ctx, layout, *endpoint, *name, *loopback, *replace)
	}
	revokedTokenID, err := a.connectPreflight(ctx, layout, *replace)
	if err != nil {
		return err
	}
	client, err := uplink.New(uplink.Options{Endpoint: *endpoint, AllowLoopbackHTTP: *loopback})
	if err != nil {
		return err
	}
	defer client.Close()
	apiKey := strings.TrimSpace(a.getenv(envAPIKey))
	if apiKey == "" {
		if apiKey, err = a.readSecret(message("api_key_prompt", locale(a.getenv))); err != nil {
			return err
		}
	}
	// Holding the session keeps a running daemon from uploading or writing
	// captured state while the connection changes underneath it.
	session, err := a.endDaemonSession(ctx, layout)
	if err != nil {
		return err
	}
	defer os.Remove(layout.DisconnectRequest())
	defer session.Unlock()
	if err := a.finishRetirement(ctx, layout); err != nil {
		a.logError(err)
	}
	installation := state.Installation{ID: newUUID(), Endpoint: client.Endpoint(), AllowLoopbackHTTP: *loopback, Name: *name, Platform: a.goos + "/" + a.goarch, ConnectedAt: a.now().UTC()}
	previous, _ := state.Load[state.Installation](layout.Installation())
	if previous.ID != "" && previous.Endpoint == installation.Endpoint {
		// Reconnecting after the keyring lost the token keeps this device's
		// installation instead of orphaning it on the server.
		installation.ID = previous.ID
		if installation.Name == "" {
			// The server keeps an existing installation's name; so does this.
			installation.Name = previous.Name
		}
	}
	if installation.Name == "" {
		installation.Name = a.neutralDeviceName(installation.ID)
	}
	registered, err := a.register(ctx, client, strings.TrimSpace(apiKey), &installation)
	if err != nil {
		return err
	}
	var policyCached bool
	adopt := func() (err error) {
		policyCached, err = a.adoptInstallation(ctx, layout, client, installation, previous, registered.DeviceToken, revokedTokenID)
		return err
	}
	var outcome *switchOutcome
	if *replace {
		outcome = &switchOutcome{}
		err = a.adoptReplacing(ctx, layout, outcome, &installation, adopt)
	} else {
		err = adopt()
	}
	if err != nil {
		return err
	}
	return a.printConnected(layout, installation, policyCached, outcome.oldServerRevoked())
}

// printConnected reports old_server_revoked only when connect retired a
// connection (--replace).
func (a *app) printConnected(layout store.Layout, installation state.Installation, policyCached bool, oldServerRevoked *bool) error {
	report := map[string]any{"connected": true, "installation_id": installation.ID, "endpoint": installation.Endpoint, "policy_cached": policyCached, "data_dir": layout.Root}
	if oldServerRevoked != nil {
		report["old_server_revoked"] = *oldServerRevoked
	}
	return a.printJSON(report)
}

// connectPreflight refuses while a working connection exists, unless
// replace will retire it, and returns the id whose token the server
// revoked, if any, for adoptInstallation to drop.
func (a *app) connectPreflight(ctx context.Context, layout store.Layout, replace bool) (revokedTokenID string, err error) {
	if previous, device, err := a.connectedClient(layout); err == nil {
		revoked := a.revokedOnServer(ctx, layout, device)
		device.Close()
		switch {
		case revoked:
			revokedTokenID = previous.ID
		case !replace:
			return "", errAlreadyConnected
		}
	}
	// Checked before registering, so a store that refuses writes (typical of
	// SSH sessions) never leaves an enrolled installation nobody holds.
	if err := probeCredentialStore(a.keyring); err != nil {
		return "", err
	}
	return revokedTokenID, nil
}

// adoptInstallation makes a freshly issued device token this device's
// connection. The caller holds the daemon session. On failure nothing is
// left behind: the token leaves the keyring and the server installation is
// revoked, since nobody could use it. Returns whether the policy was cached.
func (a *app) adoptInstallation(ctx context.Context, layout store.Layout, client *uplink.Client, installation, previous state.Installation, token, revokedTokenID string) (bool, error) {
	// The keyring holds the only copy of the device token; no API key is
	// ever written anywhere.
	device, err := client.WithDeviceToken(token)
	if err != nil {
		return false, err
	}
	if err := a.keyring.Save(installation.ID, token); err != nil {
		// Best effort: an installation whose token is lost must not stay active.
		device.RevokeInstallation(ctx)
		return false, err
	}
	rollback := func(cause error) (bool, error) {
		if err := a.keyring.Delete(installation.ID); err != nil && !errors.Is(err, credentials.ErrNotFound) {
			cause = errors.Join(cause, err)
		}
		device.RevokeInstallation(ctx)
		return false, cause
	}
	if revokedTokenID != "" && revokedTokenID != installation.ID {
		// Best effort: failing here would orphan the registration just made,
		// and a revoked token authenticates nothing.
		if err := a.keyring.Delete(revokedTokenID); err != nil {
			fmt.Fprintln(a.stderr, "backplane-companion:", localizedError(err, locale(a.getenv)))
		}
	}
	if installation.ID != previous.ID {
		// What another installation captured, possibly for another server or
		// organization, must never upload under this one.
		if err := purgeCapturedState(layout); err != nil {
			return rollback(err)
		}
	}
	if err := store.WriteJSON(layout.Installation(), installation); err != nil {
		return rollback(err)
	}
	// A revocation recorded under the previous credential no longer applies.
	if err := os.Remove(layout.Admission()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return rollback(err)
	}
	if err := purgeInboxBefore(layout, installation.ConnectedAt); err != nil {
		return rollback(err)
	}
	return a.cachePolicy(ctx, layout, device) == nil, nil
}

func (a *app) pairingIntervalOrDefault() time.Duration {
	if a.pairingIntervalUnit == 0 {
		return time.Second
	}
	return a.pairingIntervalUnit
}

// connectByBrowser pairs by browser code: it prints the code and the page to
// approve it on, then waits for the approval. No API key is involved.
func (a *app) connectByBrowser(ctx context.Context, layout store.Layout, endpoint, name string, loopback, replace bool) error {
	revokedTokenID, err := a.connectPreflight(ctx, layout, replace)
	if err != nil {
		return err
	}
	persist := a.persistPairing(layout, revokedTokenID, a.now().UTC())
	var outcome *switchOutcome
	if replace {
		outcome = &switchOutcome{}
		persist = a.persistSwitch(layout, revokedTokenID, a.now().UTC(), outcome)
	}
	manager := pairing.New(ctx, pairing.Config{
		Persist:           persist,
		Platform:          a.goos,
		Arch:              a.goarch,
		CompanionVersion:  buildinfo.Current(a.goos, a.goarch).Version,
		AllowLoopbackHTTP: loopback,
		IntervalUnit:      a.pairingIntervalOrDefault(),
	})
	defer manager.Close()
	started, err := manager.Start(ctx, endpoint, name)
	if err != nil {
		return err
	}
	if err := a.printJSON(map[string]any{"user_code": started.UserCode, "verification_uri": started.VerificationURI, "verification_uri_complete": started.VerificationURIComplete, "expires_at": started.ExpiresAt.UTC().Format(time.RFC3339), "interval": started.Interval}); err != nil {
		return err
	}
	result, err := manager.Wait(ctx, started.ID)
	if err != nil {
		return err
	}
	switch result.State {
	case pairing.StateConnected:
		installation, err := state.Load[state.Installation](layout.Installation())
		if err != nil {
			return err
		}
		cached, _ := policy.Load(layout.Policy())
		return a.printConnected(layout, installation, !cached.RefreshedAt.IsZero(), outcome.oldServerRevoked())
	case pairing.StateDenied:
		return errPairingDenied
	case pairing.StateExpired:
		return errPairingExpired
	}
	return errors.Join(errPairingFailed, result.Err)
}

// persistPairing stores a paired installation the way connect stores an
// enrolled one, holding the daemon session while it does. A connection made
// after pairingStartedAt wins over this grant, which is then revoked.
func (a *app) persistPairing(layout store.Layout, revokedTokenID string, pairingStartedAt time.Time) pairing.Persist {
	return a.persistGrant(layout, revokedTokenID, pairingStartedAt, nil)
}

// persistSwitch persists a grant that replaces the current connection: the
// old server first gets what is queued for it (bounded), then the grant is
// adopted, and only then is the old installation revoked and its token
// dropped, so a failed adoption leaves the old connection working. outcome
// receives whether the old server confirmed the revoke.
func (a *app) persistSwitch(layout store.Layout, revokedTokenID string, pairingStartedAt time.Time, outcome *switchOutcome) pairing.Persist {
	return a.persistGrant(layout, revokedTokenID, pairingStartedAt, outcome)
}

func (a *app) persistGrant(layout store.Layout, revokedTokenID string, pairingStartedAt time.Time, switching *switchOutcome) pairing.Persist {
	return func(ctx context.Context, grant pairing.Grant) error {
		client, err := uplink.New(uplink.Options{Endpoint: grant.Endpoint, AllowLoopbackHTTP: grant.AllowLoopbackHTTP})
		if err != nil {
			return err
		}
		defer client.Close()
		session, err := a.endDaemonSession(ctx, layout)
		if err != nil {
			if device, deviceErr := client.WithDeviceToken(grant.DeviceToken); deviceErr == nil {
				// Best effort: nobody else can ever collect this token.
				device.RevokeInstallation(ctx)
			}
			return err
		}
		defer os.Remove(layout.DisconnectRequest())
		defer session.Unlock()
		if err := a.finishRetirement(ctx, layout); err != nil {
			a.logError(err)
		}
		previous, _ := state.Load[state.Installation](layout.Installation())
		if previous.ID != "" && previous.ID != grant.InstallationID && previous.ConnectedAt.After(pairingStartedAt) {
			// Another approved code (or connect) became this device's connection
			// while this pairing waited: keep it, and leave no second
			// installation active on the server with a token nobody holds.
			if device, err := client.WithDeviceToken(grant.DeviceToken); err == nil {
				device.RevokeInstallation(ctx)
			}
			if err := a.keyring.Delete(grant.InstallationID); err != nil && !errors.Is(err, credentials.ErrNotFound) {
				return errors.Join(errPairingSuperseded, err)
			}
			return errPairingSuperseded
		}
		installation := state.Installation{ID: grant.InstallationID, Endpoint: client.Endpoint(), AllowLoopbackHTTP: grant.AllowLoopbackHTTP, Name: grant.Name, Platform: a.goos + "/" + a.goarch, ConnectedAt: a.now().UTC()}
		if installation.Name == "" {
			installation.Name = a.neutralDeviceName(installation.ID)
		}
		adopt := func() error {
			_, err := a.adoptInstallation(ctx, layout, client, installation, previous, grant.DeviceToken, revokedTokenID)
			return err
		}
		if switching != nil {
			return a.adoptReplacing(ctx, layout, switching, &installation, adopt)
		}
		return adopt()
	}
}

// cachePolicy fetches the device's policy and caches it for capture.
func (a *app) cachePolicy(ctx context.Context, layout store.Layout, device *uplink.Client) error {
	fetched, err := device.Policy(ctx)
	if err != nil {
		return err
	}
	// A re-pair may have landed while the request was in flight; another
	// installation's policy (and API base) must never become this one's.
	current, err := state.Load[state.Installation](layout.Installation())
	if err != nil {
		return err
	}
	if fetched.Installation.ID != current.ID {
		return fmt.Errorf("%w: policy for installation %q, connected as %q", uplink.ErrInvalidResponse, fetched.Installation.ID, current.ID)
	}
	return policy.Save(layout.Policy(), policy.Cached{Policy: fetched, RefreshedAt: a.now().UTC()})
}

// refreshPolicyCache re-reads the policy after a change made from this
// device, so capture follows it without waiting for the daemon's refresh,
// and stops offering projects the change mapped.
func (a *app) refreshPolicyCache(ctx context.Context, layout store.Layout) error {
	_, device, err := a.connectedClient(layout)
	if err != nil {
		return err
	}
	defer device.Close()
	if err := a.cachePolicy(ctx, layout, device); err != nil {
		return err
	}
	cached, err := policy.Load(layout.Policy())
	if err != nil {
		return err
	}
	return state.Update(ctx, layout, layout.Discovered(), func(discovered *state.Discovered) bool {
		kept := discovered.Projects[:0]
		for _, project := range discovered.Projects {
			if !mappedByAny(cached.Policy.Mappings, project) {
				kept = append(kept, project)
			}
		}
		changed := len(kept) != len(discovered.Projects)
		discovered.Projects = kept
		return changed
	})
}

// mappedByAny reports whether a mapping covers the project: one for its
// root, or a repository mapping for its remote.
func mappedByAny(mappings []policy.Mapping, project state.DiscoveredProject) bool {
	for _, mapping := range mappings {
		mapsRoot := mapping.RootPath != "" && filepath.Clean(mapping.RootPath) == project.Root
		mapsRepo := mapping.RootPath == "" && project.RepoURL != "" && mapping.RepoURLNormalized == project.RepoURL
		if mapsRoot || mapsRepo {
			return true
		}
	}
	return false
}

func (a *app) rename(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("%w: rename NAME", errUsage)
	}
	name, ok := control.ValidDeviceName(args[0])
	if !ok {
		return fmt.Errorf("%w: rename NAME (1 to 80 printable characters)", errUsage)
	}
	renamed, err := a.renameDevice(ctx, name)
	if err != nil {
		return err
	}
	return a.printJSON(map[string]string{"name": renamed})
}

// renameDevice renames the installation on the server, then locally.
func (a *app) renameDevice(ctx context.Context, name string) (string, error) {
	layout, err := a.layout()
	if err != nil {
		return "", err
	}
	installation, device, err := a.connectedClient(layout)
	if err != nil {
		return "", err
	}
	defer device.Close()
	if err := device.RenameInstallation(ctx, name); err != nil {
		return "", err
	}
	err = state.Update(ctx, layout, layout.Installation(), func(current *state.Installation) bool {
		if current.ID != installation.ID {
			return false
		}
		current.Name = name
		return true
	})
	return name, err
}

// revokedOnServer reports whether the server refuses the stored credential,
// as recorded by the daemon or, when no daemon noticed yet, as it answers now.
// An unreachable server proves nothing, so the device counts as connected.
func (a *app) revokedOnServer(ctx context.Context, layout store.Layout, device *uplink.Client) bool {
	installation, _ := state.Load[state.Installation](layout.Installation())
	if admission, err := state.Load[state.Admission](layout.Admission()); err == nil && admission.RevokedFor(installation.ID) {
		return true
	}
	_, err := device.Policy(ctx)
	return errors.Is(err, uplink.ErrDeviceRevoked)
}

// probeCredentialStore writes, reads and deletes a throwaway entry, so no
// secret is involved.
func probeCredentialStore(keyring credentialStore) error {
	key := "connect-probe-" + newUUID()
	if err := keyring.Save(key, "probe"); err != nil {
		return err
	}
	if _, err := keyring.Load(key); err != nil {
		keyring.Delete(key)
		return err
	}
	return keyring.Delete(key)
}

// neutralDeviceName identifies the device on the server without the
// hostname, which is often the user's real name (e.g. "Janes-MacBook.local").
func (a *app) neutralDeviceName(installationID string) string {
	return a.goos + "-" + a.goarch + "-" + installationID[:8]
}

// register obtains a device token for installation. A repeat registration
// returns no token, so the token is rotated; a revoked installation is
// replaced by a new one.
func (a *app) register(ctx context.Context, client *uplink.Client, apiKey string, installation *state.Installation) (uplink.Installation, error) {
	request := func() uplink.InstallationRequest {
		return uplink.InstallationRequest{InstallationID: installation.ID, Name: installation.Name, Platform: installation.Platform}
	}
	registered, err := client.RegisterInstallation(ctx, apiKey, request())
	if err != nil || registered.DeviceToken != "" {
		return registered, err
	}
	rotated, err := client.RotateInstallation(ctx, apiKey, installation.ID)
	if !errors.Is(err, uplink.ErrConflict) {
		return rotated, err
	}
	replaced := installation.ID
	installation.ID = newUUID()
	if installation.Name == a.neutralDeviceName(replaced) {
		installation.Name = a.neutralDeviceName(installation.ID)
	}
	registered, err = client.RegisterInstallation(ctx, apiKey, request())
	if err == nil && registered.DeviceToken == "" {
		err = fmt.Errorf("%w: new installation returned no token", uplink.ErrInvalidResponse)
	}
	return registered, err
}

// connectedClient returns the device client for this installation.
func (a *app) connectedClient(layout store.Layout) (state.Installation, *uplink.Client, error) {
	installation, err := state.Load[state.Installation](layout.Installation())
	if err != nil {
		return installation, nil, err
	}
	if installation.ID == "" {
		return installation, nil, errNotConnected
	}
	token, err := a.keyring.Load(installation.ID)
	if errors.Is(err, credentials.ErrNotFound) {
		return installation, nil, errNotConnected
	}
	if err != nil {
		return installation, nil, err
	}
	client, err := uplink.New(uplink.Options{Endpoint: installation.Endpoint, AllowLoopbackHTTP: installation.AllowLoopbackHTTP})
	if err != nil {
		return installation, nil, err
	}
	device, err := client.WithDeviceToken(token)
	return installation, device, err
}

// sessionReleaseTimeout bounds the wait for a running daemon to end its
// session; it stops within a poll plus the collector's graceful stop.
const sessionReleaseTimeout = 30 * time.Second

func (a *app) disconnect(ctx context.Context, args []string) error {
	flags := newFlags("disconnect")
	server := flags.String("server", "", "the Backplane URL to sign out of; must be the current one")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return fmt.Errorf("%w: disconnect [--server URL]", errUsage)
	}
	layout, err := a.layout()
	if err != nil {
		return err
	}
	// A switch code still waiting in a running daemon would connect again
	// after this sign-out; one already approved finishes first.
	if err := a.cancelDaemonPairing(ctx, layout); err != nil {
		return err
	}
	result, err := a.disconnectDevice(ctx, *server)
	if err != nil {
		return err
	}
	return a.printJSON(result)
}

type disconnectResult struct {
	Connected     bool `json:"connected"`
	ServerRevoked bool `json:"server_revoked"`
}

// disconnectDevice signs this device out. expectedServer, when set, must be
// the current connection's server; with several connections (later) it
// picks one, today it guards a script from signing out of a server it did
// not mean. It is checked under the session, so a switch finishing
// meanwhile cannot redirect the sign-out.
func (a *app) disconnectDevice(ctx context.Context, expectedServer string) (disconnectResult, error) {
	layout, err := a.layout()
	if err != nil {
		return disconnectResult{}, err
	}
	session, err := a.endDaemonSession(ctx, layout)
	if err != nil {
		return disconnectResult{}, err
	}
	defer os.Remove(layout.DisconnectRequest())
	defer session.Unlock()
	if expectedServer != "" {
		current, _ := state.Load[state.Installation](layout.Installation())
		if current.ID != "" && !sameServer(current.Endpoint, expectedServer) {
			return disconnectResult{}, fmt.Errorf("%w: disconnect --server %s: this device is connected to %s", errUsage, expectedServer, current.Endpoint)
		}
	}
	// A switch interrupted mid-way still holds the old connection's keys;
	// the purge below would forget the marker that names them.
	if err := a.finishRetirement(ctx, layout); err != nil {
		a.logError(err)
	}
	admission, _ := state.Load[state.Admission](layout.Admission())
	installation, client, connectErr := a.connectedClient(layout)
	serverRevoked := admission.RevokedFor(installation.ID)
	if connectErr == nil {
		// Best effort: an unreachable server must not keep the device capturing.
		// The revoked-token 401 means the server already revoked it.
		err := client.RevokeInstallation(ctx)
		serverRevoked = err == nil || errors.Is(err, uplink.ErrDeviceRevoked)
		client.Close()
	}
	// Agents' entries point at this connection; they and the agents key go
	// before purge removes the record of what was written.
	a.removeAgentAccess(layout, installation.ID)
	if installation.ID != "" {
		if err := a.keyring.Delete(installation.ID); err != nil {
			return disconnectResult{}, err
		}
	}
	if err := purgeDataDir(layout, daemonRunning(layout)); err != nil {
		return disconnectResult{}, err
	}
	return disconnectResult{Connected: false, ServerRevoked: serverRevoked}, nil
}

// endDaemonSession asks a running daemon to end its capture session and
// waits until it has, so nothing is uploaded or written with the state
// disconnect removes. A daemon keeps running afterwards, waiting for the next
// connection, so disconnect works whether or not the service is installed.
func (a *app) endDaemonSession(ctx context.Context, layout store.Layout) (store.Unlocker, error) {
	if err := store.WriteFileAtomic(layout.DisconnectRequest(), nil); err != nil {
		return nil, err
	}
	waiting, cancel := context.WithTimeout(ctx, sessionReleaseTimeout)
	defer cancel()
	session, err := store.Lock(waiting, layout.SessionLock())
	if err != nil {
		os.Remove(layout.DisconnectRequest())
		if ctx.Err() == nil {
			return nil, errDaemonRunning
		}
		return nil, err
	}
	return session, nil
}

// purgeDataDir removes everything captured, derived or logged, since any
// of it can hold local paths or content. Only what holds neither survives:
// lock files, the pid, control socket and discovery file of a daemon that
// may be running, the OTLP gate port agents' exporters point at (until
// agents uninstall), the Windows service definition (removed by service
// uninstall) and the pause choice, kept because it can only reduce capture
// after a reconnect. Ignored paths are paths, so they go. Unknown files,
// e.g. from a newer version, go too.
func purgeDataDir(layout store.Layout, daemonRunning bool) error {
	preferences, _ := state.Load[state.Preferences](layout.Preferences())
	survivors := map[string]bool{}
	for _, path := range []string{layout.StateLock(), layout.DaemonLock(), layout.SessionLock(), layout.DaemonPID(), layout.DisconnectRequest(), layout.OTelSettings(), layout.ServiceDir(), control.SocketPath(layout.Root), control.DiscoveryPath(layout.Root)} {
		survivors[filepath.Base(path)] = true
	}
	emptied := map[string]bool{}
	for _, dir := range []string{layout.InboxDir(), layout.QueueDir(), layout.WorkDir()} {
		emptied[filepath.Base(dir)] = true
	}
	entries, err := os.ReadDir(layout.Root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(layout.Root, entry.Name())
		switch {
		case survivors[entry.Name()]:
		case emptied[entry.Name()]:
			err = purge(path)
		case path == layout.LogsDir() && daemonRunning && entry.IsDir():
			err = truncateLogs(path)
		default:
			err = os.RemoveAll(path)
		}
		if err != nil {
			return err
		}
	}
	if preferences.Paused {
		return store.WriteJSON(layout.Preferences(), state.Preferences{Paused: true})
	}
	return nil
}

// purgeCapturedState drops everything captured or derived for an
// installation, leaving the preferences and logs.
func purgeCapturedState(layout store.Layout) error {
	for _, file := range []string{layout.Policy(), layout.Ledger(), layout.Threads(), layout.CaptureWindows(), layout.MappedRoots()} {
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	// The OTel runtime files hold lines the collector already normalized;
	// the collector is stopped while the session lock is held.
	for _, dir := range []string{layout.InboxDir(), layout.QueueDir(), layout.WorkDir(), layout.OTelDir(), layout.UsageDir()} {
		if err := purge(dir); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	// Spooled bodies, read positions and the offer count belong to the
	// connection; a switch never sends them to the new server.
	return os.RemoveAll(layout.RichDir())
}

// truncateLogs empties the logs a running daemon (and, under launchd, the
// service manager) holds open: removing them would fail on Windows and on
// Unix leave the daemon writing to an unlinked file.
func truncateLogs(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if entry.Type().IsRegular() && filepath.Ext(entry.Name()) == ".log" {
			err = os.Truncate(path, 0)
		} else {
			err = os.RemoveAll(path)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// purgeInboxBefore drops items captured under an earlier connection: a hook
// that read the old policy just before disconnect can still land an item
// after disconnect purged the inbox. Doing this at connect needs no daemon
// state, and treating not_connected as a drop reason would not help, since a
// new policy already exists when the daemon next drains.
func purgeInboxBefore(layout store.Layout, connectedAt time.Time) error {
	names, err := inbox.List(layout.InboxDir())
	if err != nil {
		return err
	}
	for _, name := range names {
		item, err := inbox.Read(layout.InboxDir(), name)
		if err == nil && !item.ReceivedAt.Before(connectedAt) {
			continue
		}
		if err := inbox.Remove(layout.InboxDir(), name); err != nil {
			return err
		}
	}
	return nil
}

func purge(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return err
		}
	}
	return store.SyncDir(dir)
}

func (a *app) runDaemon(ctx context.Context, args []string) error {
	flags := newFlags("run")
	manifest := flags.String("beacon-artifact", a.defaultBeaconManifest(), "pinned beacon-hooks artifact.json")
	otelcolManifest := flags.String("otelcol-artifact", a.defaultOtelcolManifest(), "pinned beacon-otelcol otelcol.json")
	dataDir := flags.String("data-dir", "", "data directory (instead of BACKPLANE_COMPANION_HOME)")
	logPath := flags.String("log", "", "append diagnostics to this file")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return fmt.Errorf("%w: run [--beacon-artifact PATH] [--data-dir DIR] [--log FILE]", errUsage)
	}
	if *dataDir != "" {
		if !filepath.IsAbs(*dataDir) {
			return fmt.Errorf("%w: --data-dir must be absolute", errUsage)
		}
		a.dataDirOverride = *dataDir
	}
	if *logPath != "" {
		log, err := openRotatingLog(*logPath, maxLogBytes)
		if err != nil {
			return err
		}
		defer log.Close()
		a.stderr = log
	}
	return a.superviseDaemon(ctx, *manifest, *otelcolManifest)
}

const (
	defaultConnectPoll  = 30 * time.Second
	defaultArtifactBase = 5 * time.Second
	defaultArtifactMax  = 5 * time.Minute
)

// superviseDaemon waits out conditions that a restart cannot fix (no
// connection yet, a Beacon artifact mid-upgrade) instead of exiting, so the
// service manager never crash-loops, and logs each condition once. After a
// disconnect or a server-side revoke it waits for the next connection.
func (a *app) superviseDaemon(ctx context.Context, manifest, otelcolManifest string) error {
	layout, err := a.layout()
	if err != nil {
		a.logError(err)
		return err
	}
	lock, acquired, err := store.TryLock(layout.DaemonLock())
	if err != nil {
		a.logError(err)
		return err
	}
	if !acquired {
		// A manual run while the service is up is not a failure.
		a.logError(daemon.ErrAlreadyRunning)
		return nil
	}
	defer lock.Unlock()
	if err := store.WriteJSON(layout.DaemonPID(), daemonProcess{PID: os.Getpid()}); err != nil {
		a.logError(err)
		return err
	}
	defer os.Remove(layout.DaemonPID())
	// Started before anything is awaited: pairing and status must work
	// while the daemon waits for a connection or an artifact.
	a.connectionWake = make(chan struct{}, 1)
	a.uploadFlush = daemon.NewFlushSignal()
	controlAPI := a.startControlAPI(ctx, layout)
	if controlAPI != nil {
		defer controlAPI.Close()
	}
	// Runs before the control API closes: an approved switch still storing
	// its grant finishes rather than outliving the daemon.
	defer a.daemonPairing.idle()
	a.logArtifacts(manifest, otelcolManifest)
	var runner *beacon.Runner
	for {
		installation, client, ok := a.awaitConnection(ctx, layout)
		if !ok {
			return nil
		}
		if runner == nil {
			if runner, ok = a.awaitBeacon(ctx, manifest, layout); !ok {
				client.Close()
				return nil
			}
		}
		revoked, err := a.runSession(ctx, layout, installation, client, runner, otelcolManifest, sessionPublisher(controlAPI))
		client.Close()
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return err
		}
		// Should neither the revocation nor the token deletion have been
		// recorded, the next attempt must not hammer the server.
		if revoked && !a.sleepUntilConnection(ctx, a.pollInterval()) {
			return nil
		}
	}
}

// sessionWatchInterval is how often a capture session checks that its
// connection still stands, which bounds how long disconnect waits.
const sessionWatchInterval = 200 * time.Millisecond

// runSession captures for one connection while holding the session lock. It
// ends when disconnect asks it to, when connect replaced the connection, or
// when the server revoked the credential; a revoked token is deleted from
// the keyring and the queue is kept.
func (a *app) runSession(ctx context.Context, layout store.Layout, installation state.Installation, client *uplink.Client, runner *beacon.Runner, otelcolManifest string, sessions func(daemon.SessionEvent)) (revoked bool, err error) {
	session, err := store.Lock(ctx, layout.SessionLock())
	if err != nil {
		return false, nil
	}
	defer session.Unlock()
	// A switch a crash interrupted after adoption still holds the old
	// connection's keys and server installation.
	if err := a.finishRetirement(ctx, layout); err != nil {
		a.logError(err)
	}
	// Items stamped before this connection (a slow hook of the previous one)
	// must not upload under it.
	if err := purgeInboxBefore(layout, installation.ConnectedAt); err != nil {
		a.logError(err)
	}
	// Disconnect may have run while this session waited for the lock.
	if !connectionStands(layout, installation) {
		return false, nil
	}
	sessionCtx, endSession := context.WithCancel(ctx)
	defer endSession()
	go func() {
		ticker := time.NewTicker(sessionWatchInterval)
		defer ticker.Stop()
		for {
			select {
			case <-sessionCtx.Done():
				return
			case <-ticker.C:
				if !connectionStands(layout, installation) {
					endSession()
					return
				}
			}
		}
	}()
	agentEnv := a.sessionAgentEnv(layout)
	otel := a.otelConfig(layout, otelcolManifest)
	a.recordDaemonVersion(layout, runner)
	a.logLine("started")
	stopAgentAccess := a.startAgentAccess(sessionCtx, layout, installation, client)
	defer stopAgentAccess()
	err = daemon.New(daemon.Config{InstallationID: installation.ID, Layout: layout, Client: client, Normalizer: runner, Registry: a.registry, Home: a.home, TempDirs: a.tempDirs, Now: a.now, AgentEnv: agentEnv, OTel: otel, Sessions: sessions, Flush: a.uploadFlush}).RunLocked(sessionCtx)
	switch {
	case errors.Is(err, daemon.ErrRevoked):
		a.logError(err)
		// The server deleted the agents key with the installation.
		stopAgentAccess()
		a.removeAgentAccess(layout, installation.ID)
		// Connect may already have stored a new token under the same id.
		if connectionStands(layout, installation) {
			if err := a.keyring.Delete(installation.ID); err != nil {
				a.logError(err)
			}
		}
		return true, nil
	case err == nil && ctx.Err() == nil:
		a.logLine("disconnected")
	}
	return false, err
}

// disconnectPending reports a disconnect (or connect) waiting for the
// session. A request older than any such wait was left by one that was
// killed, and must not idle the daemon forever.
func disconnectPending(layout store.Layout) bool {
	info, err := os.Lstat(layout.DisconnectRequest())
	return err == nil && time.Since(info.ModTime()) < 2*sessionReleaseTimeout
}

// connectionStands reports whether installation is still the current
// connection: no disconnect is pending and connect has not replaced it.
func connectionStands(layout store.Layout, installation state.Installation) bool {
	if disconnectPending(layout) {
		return false
	}
	current, err := state.Load[state.Installation](layout.Installation())
	return err == nil && current.ID == installation.ID && current.ConnectedAt.Equal(installation.ConnectedAt)
}

// otelConfig enables the OTLP gate when an agent was set up to export to it
// and the pinned collector verifies. Without the collector the daemon still
// captures every other agent.
func (a *app) otelConfig(layout store.Layout, manifest string) *daemon.OTelConfig {
	settings, err := state.Load[state.OTelSettings](layout.OTelSettings())
	if err != nil || settings.GatePort == 0 {
		return nil
	}
	executable, err := beacon.VerifyExecutable(manifest)
	if err != nil {
		a.logError(errors.Join(errOTelCollectorUnavailable, err))
		return nil
	}
	return &daemon.OTelConfig{GatePort: settings.GatePort, Collector: executable, Harness: codex.HarnessForService}
}

func (a *app) defaultOtelcolManifest() string {
	if manifest := a.getenv(envOtelcolArtifact); manifest != "" {
		return manifest
	}
	return filepath.Join(a.beaconDir(), "otelcol.json")
}

// recordDaemonVersion lets status tell the running daemon's build from the
// CLI's, e.g. after an upgrade that has not restarted the daemon yet.
func (a *app) recordDaemonVersion(layout store.Layout, runner *beacon.Runner) {
	build := buildinfo.Current(a.goos, a.goarch)
	running := &state.DaemonVersion{Version: build.Version, Commit: build.Commit, BeaconCommit: build.BeaconCommit, BeaconHooksSHA256: runner.SHA256(), StartedAt: a.now().UTC()}
	state.Update(context.Background(), layout, layout.Health(), func(health *state.Health) bool {
		health.Daemon = running
		return true
	})
}

func (a *app) pollInterval() time.Duration {
	if a.connectPollInterval == 0 {
		return defaultConnectPoll
	}
	return a.connectPollInterval
}

func (a *app) awaitConnection(ctx context.Context, layout store.Layout) (state.Installation, *uplink.Client, bool) {
	interval := a.pollInterval()
	lastCode := ""
	for {
		installation, client, err := a.readyConnection(layout)
		if err == nil {
			return installation, client, true
		}
		if code := errorCode(err); code != lastCode {
			a.logError(err)
			lastCode = code
		}
		if !a.sleepUntilConnection(ctx, interval) {
			return state.Installation{}, nil, false
		}
	}
}

// readyConnection is the connection a session may capture for: a revoked
// credential waits for connect even if its keyring entry could not be
// deleted, and a pending disconnect waits for it to finish.
func (a *app) readyConnection(layout store.Layout) (state.Installation, *uplink.Client, error) {
	if disconnectPending(layout) {
		return state.Installation{}, nil, errNotConnected
	}
	installation, client, err := a.connectedClient(layout)
	if admission, loadErr := state.Load[state.Admission](layout.Admission()); err == nil && loadErr == nil && admission.RevokedFor(installation.ID) {
		client.Close()
		return state.Installation{}, nil, daemon.ErrRevoked
	}
	return installation, client, err
}

func (a *app) awaitBeacon(ctx context.Context, manifest string, layout store.Layout) (*beacon.Runner, bool) {
	delay, ceiling := a.artifactRetryBase, a.artifactRetryMax
	if delay == 0 {
		delay, ceiling = defaultArtifactBase, defaultArtifactMax
	}
	logged := false
	for {
		// Verified once, at start; re-verifying later, against checksums fixed
		// at link time, belongs with release signing (CR-9 native).
		runner, err := beacon.Load(manifest, layout.WorkDir())
		if err == nil {
			return runner, true
		}
		if !logged {
			a.logError(err)
			logged = true
		}
		if !sleep(ctx, delay) {
			return nil, false
		}
		delay = min(delay*2, ceiling)
	}
}

// wakeForConnection ends a sleepUntilConnection early; it never blocks.
func (a *app) wakeForConnection() {
	select {
	case a.connectionWake <- struct{}{}:
	default:
	}
}

// sleepUntilConnection is sleep, cut short by wakeForConnection.
func (a *app) sleepUntilConnection(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
	case <-a.connectionWake:
	}
	return true
}

func sleep(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (a *app) logLine(text string) {
	fmt.Fprintln(a.stderr, a.now().UTC().Format(time.RFC3339), text)
}

func (a *app) logError(err error) {
	a.logLine(localizedError(err, locale(a.getenv)))
}

func (a *app) defaultBeaconManifest() string {
	if manifest := a.getenv(envBeaconArtifact); manifest != "" {
		return manifest
	}
	return filepath.Join(a.beaconDir(), "artifact.json")
}

// beaconDir is where the bundled Beacon artifacts live. Inside a macOS app it
// is only Contents/Resources/beacon, sealed by the app's signature: an app in
// a user-writable place (e.g. ~/Downloads) must not trust a beacon directory
// someone planted beside the executable, and a missing one fails closed.
// Release archives keep the directory beside the executable.
func (a *app) beaconDir() string {
	executable := a.executable
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	executableDir := filepath.Dir(executable)
	contents := filepath.Dir(executableDir)
	if filepath.Base(executableDir) == "MacOS" && filepath.Base(contents) == "Contents" && strings.HasSuffix(filepath.Dir(contents), ".app") {
		return filepath.Join(contents, "Resources", "beacon")
	}
	return filepath.Join(executableDir, "beacon")
}

func (a *app) agents(_ context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: agents list|install|uninstall|status [agent...]", errUsage)
	}
	reports, err := a.agentReports(args[0], args[1:], false)
	if err != nil {
		return err
	}
	return a.printJSON(reports)
}

type agentActionReport struct {
	ID          string                   `json:"id"`
	Presence    *agent.Presence          `json:"presence,omitempty"`
	Integration *agent.IntegrationStatus `json:"integration,omitempty"`
	Action      string                   `json:"action,omitempty"`
	// Telemetry says when exporter setup was skipped (another exporter).
	Telemetry string `json:"telemetry,omitempty"`
}

// agentReports runs action (list, install, uninstall or status) for the
// named agents, or all of them. withPresence adds each agent's presence to
// the integration status, as the control API reports agents.
func (a *app) agentReports(action string, names []string, withPresence bool) ([]agentActionReport, error) {
	selected, err := a.selectAgents(names)
	if err != nil {
		return nil, err
	}
	env := a.agentEnv()
	if action == "install" && len(names) == 0 {
		// Without names, only agents present on this machine are set up.
		selected = presentAgents(selected, env)
	}
	if action == "install" && exportsTelemetry(selected) {
		if env, err = a.envWithGate(); err != nil {
			return nil, err
		}
	}
	reports := []agentActionReport{}
	for _, adapter := range selected {
		switch action {
		case "list":
			presence := adapter.Discover(env)
			reports = append(reports, agentActionReport{ID: adapter.ID(), Presence: &presence})
			continue
		case "install":
			err = adapter.Install(env)
		case "uninstall":
			err = adapter.Uninstall(env)
		case "status":
		default:
			return nil, fmt.Errorf("%w: agents list|install|uninstall|status", errUsage)
		}
		if err != nil {
			return nil, err
		}
		status := adapter.Status(env)
		entry := agentActionReport{ID: adapter.ID(), Integration: &status, Action: a.requiredAction(status)}
		if withPresence {
			presence := adapter.Discover(env)
			entry.Presence = &presence
		}
		if containsString(status.Problems, agent.ProblemConflictExistingOTel) {
			entry.Telemetry = "skipped_conflict_existing_otel"
		}
		reports = append(reports, entry)
	}
	return reports, nil
}

func exportsTelemetry(agents []agent.Agent) bool {
	for _, adapter := range agents {
		if adapter.Ingress() == agent.IngressOTLP {
			return true
		}
	}
	return false
}

// sessionAgentEnv is the environment the daemon repairs agents with. When
// an agent that exports telemetry already has an integration, e.g. one an
// older companion left on a fresh data directory, the gate is allocated
// first, as the manual Repair (agents install) does: without it the repair
// has nowhere to point the telemetry and fails. No integration, no gate, so
// no collector runs for users without such an agent.
func (a *app) sessionAgentEnv(layout store.Layout) agent.Env {
	env := a.agentEnv()
	if env.Telemetry.Endpoint != "" || !a.hasTelemetryIntegration(env) {
		return env
	}
	if _, err := a.gatePort(layout); err != nil {
		a.logError(err)
		return env
	}
	return a.agentEnv()
}

func (a *app) hasTelemetryIntegration(env agent.Env) bool {
	for _, adapter := range a.registry.All() {
		if adapter.Ingress() == agent.IngressOTLP && adapter.Status(env).State != agent.NotInstalled {
			return true
		}
	}
	return false
}

// envWithGate allocates the OTLP gate port (once) and returns the agent
// environment that points at it.
func (a *app) envWithGate() (agent.Env, error) {
	layout, err := a.layout()
	if err != nil {
		return agent.Env{}, err
	}
	if _, err := a.gatePort(layout); err != nil {
		return agent.Env{}, err
	}
	return a.agentEnv(), nil
}

// requiredAction explains, in the user's language, what only the user can
// do to make an integration capture.
func (a *app) requiredAction(status agent.IntegrationStatus) string {
	language := locale(a.getenv)
	switch {
	case status.State == agent.NeedsTrust:
		// A Codex app already running also needs a restart once the hooks
		// are trusted; saying both now spares a second round.
		return strings.TrimSpace(message("codex_trust_instructions", language) + " " + restartAction(status, language))
	case status.State == agent.InvalidConfig:
		return fmt.Sprintf(message("invalid_config", language), status.ConfigPath)
	case containsString(status.Problems, agent.ProblemConflictExistingOTel):
		return message(agent.ProblemConflictExistingOTel, language)
	}
	return restartAction(status, language)
}

func restartAction(status agent.IntegrationStatus, language string) string {
	switch {
	case containsString(status.Problems, agent.ProblemRestartRequired):
		return message(agent.ProblemRestartRequired, language)
	case containsString(status.Problems, agent.ProblemDaemonRestartRequired):
		return message(agent.ProblemDaemonRestartRequired, language)
	}
	return ""
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func presentAgents(agents []agent.Agent, env agent.Env) []agent.Agent {
	present := []agent.Agent{}
	for _, adapter := range agents {
		if adapter.Discover(env).Installed {
			present = append(present, adapter)
		}
	}
	return present
}

func (a *app) selectAgents(names []string) ([]agent.Agent, error) {
	if len(names) == 0 {
		return a.registry.All(), nil
	}
	selected := make([]agent.Agent, 0, len(names))
	for _, name := range names {
		adapter, err := a.registry.Lookup(name)
		if err != nil {
			return nil, err
		}
		selected = append(selected, adapter)
	}
	return selected, nil
}

func (a *app) projects(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: projects list|map PATH|ignore PATH|unignore PATH", errUsage)
	}
	layout, err := a.layout()
	if err != nil {
		return err
	}
	switch {
	case args[0] == "list" && len(args) == 1:
		report, err := a.listProjects(layout, false)
		if err != nil {
			return err
		}
		return a.printJSON(report)
	case args[0] == "map" && len(args) == 2:
		return a.mapProject(ctx, layout, args[1])
	case args[0] == "ignore" && len(args) == 2:
		ignored, err := a.ignorePath(ctx, layout, args[1])
		if err != nil {
			return err
		}
		return a.printJSON(map[string]any{"ignored": ignored})
	case args[0] == "unignore" && len(args) == 2:
		unignored, err := a.unignorePath(ctx, layout, args[1])
		if err != nil {
			return err
		}
		return a.printJSON(map[string]any{"unignored": unignored})
	}
	return fmt.Errorf("%w: projects list|map PATH|ignore PATH|unignore PATH", errUsage)
}

type projectsReport struct {
	Discovered []discoveredProject `json:"discovered"`
	Ignored    []string            `json:"ignored"`
	Mappings   []policy.Mapping    `json:"mappings"`
}

type discoveredProject struct {
	state.DiscoveredProject
	// Reason says why the project is not captured, and Candidates the
	// boards it could be mapped to; the control API sets both.
	Reason     string            `json:"reason,omitempty"`
	Candidates *[]boardCandidate `json:"candidates,omitempty"`
}

// boardCandidate is a board bound to a discovered project's repository.
// WorkspaceName is null when the policy came from a server that predates it.
type boardCandidate struct {
	WorkspaceID   string  `json:"workspace_id"`
	WorkspaceName *string `json:"workspace_name"`
	WorkspaceSlug string  `json:"workspace_slug"`
	BoardID       string  `json:"board_id"`
	BoardName     string  `json:"board_name"`
}

// listProjects reports the mappings, the discovered projects and the
// ignored paths; withReasons explains each discovered project.
func (a *app) listProjects(layout store.Layout, withReasons bool) (projectsReport, error) {
	mappings := []policy.Mapping{}
	var cachedPolicy *policy.Cached
	if cached, err := policy.Load(layout.Policy()); err == nil {
		mappings = cached.Policy.Mappings
		cachedPolicy = &cached
	}
	discovered, err := state.Load[state.Discovered](layout.Discovered())
	if err != nil {
		return projectsReport{}, err
	}
	preferences, err := state.Load[state.Preferences](layout.Preferences())
	if err != nil {
		return projectsReport{}, err
	}
	report := projectsReport{Discovered: []discoveredProject{}, Ignored: nonNil(preferences.IgnoredPaths), Mappings: mappings}
	for _, project := range discovered.Projects {
		entry := discoveredProject{DiscoveredProject: project}
		if withReasons {
			entry.Reason = a.discoveredReason(project, cachedPolicy)
			candidates := []boardCandidate{}
			if entry.Reason == "auto_match_off" || entry.Reason == "ambiguous" {
				candidates = boardCandidates(cachedPolicy.Policy.RepoCatalog, project.RepoURL)
			}
			entry.Candidates = &candidates
		}
		report.Discovered = append(report.Discovered, entry)
	}
	return report, nil
}

func boardCandidates(catalog []policy.CatalogRepo, repoURL string) []boardCandidate {
	candidates := []boardCandidate{}
	seen := map[string]bool{}
	for _, repo := range catalog {
		if repo.RepoURLNormalized != repoURL || seen[repo.BoardID] {
			continue
		}
		seen[repo.BoardID] = true
		candidates = append(candidates, boardCandidate{WorkspaceID: repo.WorkspaceID, WorkspaceName: repo.WorkspaceName, WorkspaceSlug: repo.WorkspaceSlug, BoardID: repo.BoardID, BoardName: repo.BoardName})
	}
	return candidates
}

// discoveredReason is why a discovered project is not captured: no_origin
// (no hosted remote), excluded (by the server's globs), auto_match_off,
// ambiguous (bound in several workspaces) or not_bound (no board uses it).
func (a *app) discoveredReason(project state.DiscoveredProject, cached *policy.Cached) string {
	if project.RepoURL == "" {
		return "no_origin"
	}
	if cached == nil {
		return "not_bound"
	}
	// Scope decides exclusion exactly as capture does, against a policy
	// that differs from the cached one only in being fresh.
	decision := scope.Decide(scope.Input{
		AgentID: "control", Cwd: project.Root, Home: a.home, TempDirs: a.tempDirs, Now: a.now(),
		Policy: &policy.Cached{RefreshedAt: a.now(), Policy: policy.Policy{Installation: policy.Installation{ID: "control", ExcludeGlobs: cached.Policy.Installation.ExcludeGlobs}}},
	})
	if decision.Reason == scope.ReasonExcluded {
		return "excluded"
	}
	if !cached.Policy.Installation.AutoMatchRepos {
		return "auto_match_off"
	}
	workspaces := map[string]bool{}
	for _, repo := range cached.Policy.RepoCatalog {
		if repo.RepoURLNormalized == project.RepoURL {
			workspaces[repo.WorkspaceID] = true
		}
	}
	if len(workspaces) > 1 {
		return "ambiguous"
	}
	return "not_bound"
}

// mapProject asks the server to map the repository at path; explicit
// non-repository mappings arrive with the CR-4 mapping UX.
func (a *app) mapProject(ctx context.Context, layout store.Layout, path string) error {
	_, client, err := a.connectedClient(layout)
	if err != nil {
		return err
	}
	defer client.Close()
	root, err := canonicalPath(path)
	if err != nil {
		return err
	}
	repo, found := scope.FindRepo(root)
	if !found || repo.RemoteURL == "" {
		return errNotARepository
	}
	mapping, err := client.ResolveMapping(ctx, repo.RemoteURL)
	switch {
	case errors.Is(err, uplink.ErrConflict):
		return errAmbiguousRepo
	case errors.Is(err, uplink.ErrForbidden):
		return errAutoMatchDisabled
	case errors.Is(err, uplink.ErrNotFound), errors.Is(err, uplink.ErrUnprocessable):
		return errNoMatchingBoard
	}
	if err != nil {
		return err
	}
	if cached, err := policy.Load(layout.Policy()); err == nil {
		if err := policy.Save(layout.Policy(), cached.WithMapping(mapping)); err != nil {
			return err
		}
	}
	if err := state.ForgetDiscovered(ctx, layout, repo.Root); err != nil {
		return err
	}
	return a.printJSON(mapping)
}

func (a *app) ignorePath(ctx context.Context, layout store.Layout, path string) (string, error) {
	root, err := canonicalPath(path)
	if err != nil {
		return "", err
	}
	err = state.Update(ctx, layout, layout.Preferences(), func(preferences *state.Preferences) bool {
		for _, ignored := range preferences.IgnoredPaths {
			if scope.CanonicalOrClean(ignored) == root {
				return false
			}
		}
		preferences.IgnoredPaths = append(preferences.IgnoredPaths, root)
		return true
	})
	if err != nil {
		return "", err
	}
	if err := state.ForgetDiscovered(ctx, layout, root); err != nil {
		return "", err
	}
	return root, nil
}

// discoverPath records a folder the user picked as a found project, as a
// hook in it would: the enclosing repository's root and normalized remote,
// or the folder itself outside a repository. Scope refuses it exactly where
// capture would, and a folder a mapping already covers is refused too.
func (a *app) discoverPath(ctx context.Context, layout store.Layout, path string) (discoveredProject, error) {
	folder, err := canonicalPath(path)
	if err != nil {
		return discoveredProject{}, err
	}
	preferences, err := state.Load[state.Preferences](layout.Preferences())
	if err != nil {
		return discoveredProject{}, err
	}
	// Only the exclusions and mappings of the cached policy apply; a fresh
	// policy of its own keeps a stale, paused or missing one from hiding them.
	installation := policy.Installation{ID: "control"}
	var mappings []policy.Mapping
	if cached, err := policy.Load(layout.Policy()); err == nil {
		installation.ExcludeGlobs, mappings = cached.Policy.Installation.ExcludeGlobs, cached.Policy.Mappings
	}
	decision := scope.Decide(scope.Input{
		AgentID: "control", Cwd: folder, Home: a.home, TempDirs: a.tempDirs, Now: a.now(), IgnoredPaths: preferences.IgnoredPaths,
		Policy: &policy.Cached{RefreshedAt: a.now(), Policy: policy.Policy{Installation: installation, Mappings: mappings}},
	})
	switch decision.Reason {
	case scope.ReasonHomeOrRoot:
		return discoveredProject{}, errHomeOrRoot
	case scope.ReasonTempDir:
		return discoveredProject{}, errTempDir
	case scope.ReasonExcluded:
		return discoveredProject{}, errExcludedPath
	case scope.ReasonIgnored:
		return discoveredProject{}, errIgnoredPath
	case scope.ReasonMapped, scope.ReasonMappingDisabled:
		return discoveredProject{}, errAlreadyMapped
	}
	project := scope.Project{Root: folder}
	if decision.Discovered != nil {
		project = *decision.Discovered
	}
	// A repository rooted at HOME (dotfiles) would make all of HOME a project.
	if isHomeOrRoot(project.Root, a.home) {
		return discoveredProject{}, errHomeOrRoot
	}
	if err := state.RecordDiscovered(ctx, layout, project, a.now()); err != nil {
		return discoveredProject{}, err
	}
	report, err := a.listProjects(layout, true)
	if err != nil {
		return discoveredProject{}, err
	}
	for _, entry := range report.Discovered {
		if entry.Root == project.Root {
			return entry, nil
		}
	}
	return discoveredProject{}, errTooManyProjects
}

func isHomeOrRoot(root, home string) bool {
	if root == filepath.VolumeName(root)+string(filepath.Separator) {
		return true
	}
	if home == "" {
		return false
	}
	resolvedHome, err := canonicalPath(home)
	return err == nil && root == resolvedHome
}

// unignorePath lets a path be captured and discovered again. A directory
// deleted since it was ignored is matched by its absolute spelling.
func (a *app) unignorePath(ctx context.Context, layout store.Layout, path string) (string, error) {
	root, err := canonicalPath(path)
	if errors.Is(err, errNotADirectory) {
		if root, err = filepath.Abs(path); err == nil {
			root = filepath.Clean(root)
		}
	}
	if err != nil {
		return "", err
	}
	err = state.Update(ctx, layout, layout.Preferences(), func(preferences *state.Preferences) bool {
		kept := preferences.IgnoredPaths[:0]
		for _, ignored := range preferences.IgnoredPaths {
			if scope.CanonicalOrClean(ignored) != root {
				kept = append(kept, ignored)
			}
		}
		changed := len(kept) != len(preferences.IgnoredPaths)
		preferences.IgnoredPaths = kept
		return changed
	})
	return root, err
}

func canonicalPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	canonical, ok := scope.CanonicalDir(absolute)
	if !ok {
		return "", errNotADirectory
	}
	return canonical, nil
}

func (a *app) setPaused(ctx context.Context, paused bool) error {
	if err := a.writePaused(ctx, paused); err != nil {
		return err
	}
	return a.printJSON(map[string]bool{"paused": paused})
}

func (a *app) writePaused(ctx context.Context, paused bool) error {
	layout, err := a.layout()
	if err != nil {
		return err
	}
	return state.Update(ctx, layout, layout.Preferences(), func(preferences *state.Preferences) bool {
		changed := preferences.Paused != paused
		preferences.Paused = paused
		return changed
	})
}

type daemonProcess struct {
	PID int `json:"pid"`
}

// daemonRunning is true while a live daemon holds the daemon lock. Without a
// pid file (a daemon predating it) the lock alone decides.
func daemonRunning(layout store.Layout) bool {
	lock, acquired, err := store.TryLock(layout.DaemonLock())
	if err != nil {
		return false
	}
	if acquired {
		lock.Unlock()
		return false
	}
	var recorded daemonProcess
	if err := store.ReadJSON(layout.DaemonPID(), 4096, &recorded); err != nil {
		return true
	}
	return process.Alive(recorded.PID)
}

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}

func newUUID() string {
	value := make([]byte, 16)
	rand.Read(value)
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:])
}
