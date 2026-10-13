// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"golang.org/x/term"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/agentaccess"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/process"
	"github.com/Valaris-Studio/backplane/companion/internal/process/pstable"
	"github.com/Valaris-Studio/backplane/companion/internal/service"
	"github.com/Valaris-Studio/backplane/companion/internal/shim"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

type credentialStore interface {
	Save(installationID, token string) error
	Load(installationID string) (string, error)
	Delete(installationID string) error
}

// app carries every process dependency so tests can run commands in-process
// against a temporary HOME, a fake server and a mocked keyring.
type app struct {
	getenv     func(string) string
	stdin      io.Reader
	stdout     io.Writer
	stderr     io.Writer
	home       string
	executable string
	goos       string
	goarch     string
	now        func() time.Time
	tempDirs   []string
	keyring    credentialStore
	readSecret func(prompt string) (string, error)
	registry   *agent.Registry
	// computerName is the computer's own name as a valid device name, or "".
	computerName func() string
	// uid selects the launchd domain; serviceRunner runs launchctl, systemctl
	// or schtasks.
	uid           int
	serviceRunner service.Runner
	// dataDirOverride comes from `run --data-dir`, used where the service
	// manager cannot set BACKPLANE_COMPANION_HOME (Windows Task Scheduler).
	dataDirOverride string
	// How `run` waits out a missing connection or Beacon artifact instead of
	// exiting into a service-manager restart loop.
	connectPollInterval time.Duration
	artifactRetryBase   time.Duration
	artifactRetryMax    time.Duration
	// pairingIntervalUnit scales the server's pairing interval and expiry,
	// which are in seconds; zero means a second.
	pairingIntervalUnit time.Duration
	// switchFlushTimeout and switchRevokeTimeout bound what a switch waits
	// for the old server; zero means the defaults in switch.go.
	switchFlushTimeout  time.Duration
	switchRevokeTimeout time.Duration
	// connectionWake cuts the daemon's wait for a connection short once
	// pairing through its control API stored one.
	connectionWake chan struct{}
	// uploadFlush lets the control API skip the running daemon's upload
	// backoff once; nil while no daemon runs in this process.
	uploadFlush *daemon.FlushSignal
	// processes finds agent apps that must restart to load an integration;
	// nil (tests, platforms without such apps) skips that check.
	processes process.Finder
	// agentAccess is shared by the control API and the capture session;
	// publishAgentAccess sends its changes to control API subscribers.
	agentAccessMu      sync.Mutex
	agentAccess        *agentaccess.Manager
	publishAgentAccess func(any)
	// daemonPairing is the running daemon's pairer, waited on at shutdown.
	daemonPairing *daemonPairer
}

func newApp() *app {
	home, _ := os.UserHomeDir()
	executable, _ := os.Executable()
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	a := &app{
		getenv:        os.Getenv,
		stdin:         os.Stdin,
		stdout:        os.Stdout,
		stderr:        os.Stderr,
		home:          home,
		executable:    executable,
		goos:          runtime.GOOS,
		goarch:        runtime.GOARCH,
		now:           time.Now,
		tempDirs:      defaultTempDirs(),
		keyring:       selectKeyring(home),
		readSecret:    readSecretFromTerminal,
		registry:      agent.NewRegistry(claudecode.New(), pi.New(), codex.New()),
		computerName:  func() string { return systemComputerNameSources().read(runtime.GOOS) },
		uid:           os.Getuid(),
		serviceRunner: service.ExecRunner{},
	}
	if table := pstable.SystemTable(); table != nil {
		a.processes = process.NewCachedFinder(table, processCacheTTL, time.Now, a.logLine)
	}
	return a
}

// processCacheTTL spares the agent status probe a ps run on every call; a
// restarted app is still noticed within one 15 s probe.
const processCacheTTL = 5 * time.Second

// selectKeyring returns the OS keyring, or the dev file store when a
// devkeyring build is asked for it; a refused selection fails every
// credential operation with the reason.
func selectKeyring(home string) credentialStore {
	root, err := store.DefaultRoot(os.Getenv, runtime.GOOS, home)
	if err != nil {
		return unavailableStore{err}
	}
	selected, err := credentials.Select(os.Getenv, root)
	if err != nil {
		return unavailableStore{err}
	}
	return selected
}

type unavailableStore struct{ err error }

func (u unavailableStore) Save(string, string) error   { return u.err }
func (u unavailableStore) Load(string) (string, error) { return "", u.err }
func (u unavailableStore) Delete(string) error         { return u.err }

func defaultTempDirs() []string {
	dirs := []string{os.TempDir()}
	if runtime.GOOS != "windows" {
		dirs = append(dirs, "/tmp", "/var/tmp")
	}
	return dirs
}

func readSecretFromTerminal(prompt string) (string, error) {
	descriptor := int(os.Stdin.Fd())
	if !term.IsTerminal(descriptor) {
		return "", errAPIKeyMissing
	}
	fmt.Fprint(os.Stderr, prompt)
	secret, err := term.ReadPassword(descriptor)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", errAPIKeyMissing
	}
	return string(secret), nil
}

func (a *app) dataRoot() (string, error) {
	if a.dataDirOverride != "" {
		return a.dataDirOverride, nil
	}
	return store.DefaultRoot(a.getenv, a.goos, a.home)
}

func (a *app) layout() (store.Layout, error) {
	root, err := a.dataRoot()
	if err != nil {
		return store.Layout{}, err
	}
	return store.Open(root)
}

func (a *app) agentEnv() agent.Env {
	env := agent.Env{Home: a.home, Getenv: a.getenv, Executable: a.hookExecutable(), Processes: a.processes}
	root, err := a.dataRoot()
	if err != nil {
		return env
	}
	env.StateDir = root
	layout := store.Layout{Root: root}
	if settings, err := state.Load[state.OTelSettings](layout.OTelSettings()); err == nil && settings.GatePort != 0 {
		env.Telemetry.Endpoint = fmt.Sprintf("http://127.0.0.1:%d", settings.GatePort)
	}
	cached, err := policy.Load(layout.Policy())
	env.Telemetry.LogUserPrompt = err == nil && promptContentWanted(cached.Policy)
	return env
}

// promptContentWanted is false only when every capture would be reduced to
// metadata anyway, so agents need not export prompt text at all.
func promptContentWanted(current policy.Policy) bool {
	if current.Installation.AutoMatchRepos {
		return true
	}
	for _, mapping := range current.Mappings {
		if mapping.Enabled && mapping.ContentLevel != string(privacy.Metadata) {
			return true
		}
	}
	return false
}

// defaultGatePort is tried first so the gate address is predictable; any
// free loopback port is used when it is taken.
const defaultGatePort = 14327

func (a *app) gatePort(layout store.Layout) (int, error) {
	settings, err := state.Load[state.OTelSettings](layout.OTelSettings())
	if err != nil {
		return 0, err
	}
	if settings.GatePort != 0 {
		return settings.GatePort, nil
	}
	port := defaultGatePort
	if listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
		listener.Close()
	} else if listener, err := net.Listen("tcp", "127.0.0.1:0"); err == nil {
		port = listener.Addr().(*net.TCPAddr).Port
		listener.Close()
	} else {
		return 0, err
	}
	return port, store.WriteJSON(layout.OTelSettings(), state.OTelSettings{GatePort: port})
}

func (a *app) printJSON(value any) error {
	encoder := json.NewEncoder(a.stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func newFlags(name string) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	return flags
}

const usage = "usage: backplane-companion connect|disconnect|rename|run|hook|agents|projects|pause|resume|status|service|uninstall|version|mcp"

func (a *app) run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: %s", errUsage, usage)
	}
	commands := map[string]func(context.Context, []string) error{
		"connect":    a.connect,
		"disconnect": a.disconnect,
		"rename":     a.rename,
		"run":        a.runDaemon,
		"agents":     a.agents,
		"projects":   a.projects,
		"pause":      func(ctx context.Context, _ []string) error { return a.setPaused(ctx, true) },
		"resume":     func(ctx context.Context, _ []string) error { return a.setPaused(ctx, false) },
		"status":     a.status,
		"service":    a.service,
		"uninstall":  a.uninstall,
		"version":    a.version,
		"mcp":        a.mcp,
	}
	command, ok := commands[args[0]]
	if !ok {
		return fmt.Errorf("%w: %s", errUsage, usage)
	}
	return command(ctx, args[1:])
}

// runHook always answers "{}" and returns normally; failures are counted in
// the health file instead of being reported to the agent.
func (a *app) runHook(args []string) {
	defer fmt.Fprintln(a.stdout, "{}")
	if len(args) != 1 {
		return
	}
	root, err := a.dataRoot()
	if err != nil {
		return
	}
	hook := shim.Shim{Layout: store.Layout{Root: root}, Registry: a.registry, Home: a.home, TempDirs: a.tempDirs, Now: a.now}
	hook.HandleAndRecord(args[0], a.stdin)
}
