// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package agent defines what the companion needs from each coding agent it
// observes, so capture stays agent-agnostic.
package agent

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/process"
)

var (
	ErrUnknownAgent     = errors.New("unknown_agent")
	ErrInvalidHook      = errors.New("invalid_hook_payload")
	ErrUnsupportedEvent = errors.New("unsupported_hook_event")
	ErrMissingIdentity  = errors.New("missing_native_identity")
	ErrConfigInvalid    = errors.New("agent_config_invalid")
	ErrConfigSymlink    = errors.New("agent_config_symlink")
	// ErrConfigChanged means the agent rewrote its configuration while we
	// were editing it; nothing was written and the edit can be retried.
	ErrConfigChanged = errors.New("agent_config_changed")
	// ErrConfigForeign means a file at the companion's path was not written
	// by the companion; it is never overwritten or removed.
	ErrConfigForeign = errors.New("agent_config_not_owned")
	// ErrIgnoredEvent marks a valid event the agent's normalizer maps to
	// nothing, so it is not retained at all.
	ErrIgnoredEvent = errors.New("ignored_hook_event")
)

// Env locates an agent's user-level configuration. Tests point Home at a
// temporary directory so the operator's real configuration is never touched.
type Env struct {
	Home   string
	Getenv func(string) string
	// Executable is the absolute companion path written into owned hooks.
	Executable string
	// Telemetry is where agents that export OpenTelemetry send it.
	Telemetry Telemetry
	// StateDir is the companion's data directory, where adapters record when
	// they last changed an integration; "" records nothing.
	StateDir string
	// Processes finds agent apps that load their configuration only when
	// they start; nil skips those checks.
	Processes process.Finder
}

type Telemetry struct {
	// Endpoint is the companion's loopback OTLP/HTTP gate, e.g.
	// "http://127.0.0.1:14327".
	Endpoint string
	// LogUserPrompt is false when every mapping retains metadata only.
	LogUserPrompt bool
}

func (env Env) Lookup(key string) string {
	if env.Getenv == nil {
		return ""
	}
	return env.Getenv(key)
}

// LookPath finds an executable on the Env's PATH (not the process's), so
// discovery in tests depends only on the test environment.
func (env Env) LookPath(name string) (string, bool) { return env.LookPathFor(runtime.GOOS, name) }

// defaultPathext is Windows' default when PATHEXT is unset; npm installs
// agents as .cmd shims (claude.cmd, pi.cmd).
const defaultPathext = ".COM;.EXE;.BAT;.CMD"

// LookPathFor is LookPath for a given OS, so the Windows rules are testable
// anywhere.
func (env Env) LookPathFor(goos, name string) (string, bool) {
	candidates := []string{name}
	if goos == "windows" {
		pathext := env.Lookup("PATHEXT")
		if pathext == "" {
			pathext = defaultPathext
		}
		for _, extension := range strings.Split(pathext, ";") {
			if extension = strings.TrimSpace(extension); extension != "" {
				candidates = append(candidates, name+strings.ToLower(extension), name+strings.ToUpper(extension))
			}
		}
	}
	for _, dir := range filepath.SplitList(env.Lookup("PATH")) {
		for _, candidate := range candidates {
			path := filepath.Join(dir, candidate)
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			if goos == "windows" && candidate != name || goos != "windows" && info.Mode().Perm()&0o111 != 0 {
				return path, true
			}
		}
	}
	return "", false
}

type Presence struct {
	Installed  bool   `json:"installed"`
	Version    string `json:"version,omitempty"`
	ConfigPath string `json:"config_path"`
}

type IntegrationState string

const (
	Installed    IntegrationState = "installed"
	NotInstalled IntegrationState = "not_installed"
	Broken       IntegrationState = "broken"
	// NeedsTrust: installed, but the agent will not run the integration
	// until the user approves it in the agent.
	NeedsTrust IntegrationState = "needs_trust"
	// InvalidConfig: the agent's own configuration file is one the agent
	// rejects; the companion leaves it untouched until the user fixes it.
	InvalidConfig IntegrationState = "invalid_config"
)

type IntegrationStatus struct {
	State      IntegrationState `json:"state"`
	ConfigPath string           `json:"config_path"`
	Problems   []string         `json:"problems,omitempty"`
	// ProblemConfigPaths names, per problem, the file it concerns when an
	// agent spreads its setup over several (Codex: hooks.json and
	// config.toml). Problems about no file are absent.
	ProblemConfigPaths map[string]string `json:"problem_config_paths,omitempty"`
	// Notes are informational, e.g. another tool's extension coexisting.
	Notes []string `json:"notes,omitempty"`
	// Trust is the agent's own approval state for the integration, when the
	// agent has one (trusted, needs_trust, modified, trust_unknown).
	Trust string `json:"trust,omitempty"`
}

// Ingress is how an agent's observations reach the companion. It is also the
// collection_method recorded upstream.
type Ingress string

const (
	// IngressHook: the agent runs the companion shim, which writes the inbox.
	IngressHook Ingress = "hook"
	// IngressOTLP: the agent exports OpenTelemetry to a local collector.
	IngressOTLP Ingress = "otlp"
	// IngressPlugin: an in-agent extension reports observations.
	IngressPlugin Ingress = "plugin"
	// IngressPoll: the companion reads the agent's local session files.
	IngressPoll Ingress = "poll"
)

type Observation struct {
	NativeSessionID  string `json:"native_session_id"`
	NativeToolCallID string `json:"native_tool_call_id,omitempty"`
	Cwd              string `json:"cwd"`
	Event            string `json:"event"`
	// ThreadID identifies the agent thread the event belongs to when it
	// differs from the session (e.g. a Codex subagent).
	ThreadID       string `json:"thread_id,omitempty"`
	HarnessVersion string `json:"harness_version,omitempty"`
}

type Agent interface {
	// ID is the stable harness identifier, e.g. "claude_code".
	ID() string
	Discover(Env) Presence
	// Install, Uninstall and Status manage only companion-owned entries and
	// preserve foreign entries and unknown fields.
	Install(Env) error
	Uninstall(Env) error
	Status(Env) IntegrationStatus
	// Repair repoints existing owned entries that are stale (another
	// executable or an outdated command). It never re-adds owned entries the
	// user removed; Install is the explicit way to restore those.
	Repair(Env) (changed bool, err error)
	Ingress() Ingress
	ParseHook(raw []byte) (Observation, map[string]any, error)
	// RewriteCwd records the canonical working directory in the payload.
	RewriteCwd(payload map[string]any, cwd string)
	// IdentityPreserved reports whether the native session and tool-call ids
	// survived sanitization unchanged; if not, the observation is unusable.
	IdentityPreserved(observation Observation, sanitized map[string]any) bool
	BeaconPlatform() string
	BeaconCommand(event string) (string, bool)
	// PrepareBeaconInput returns the payload handed to beacon-hooks for event,
	// without mutating payload.
	PrepareBeaconInput(event string, payload map[string]any) map[string]any
	// ToolOutput names the top-level payload members of event that carry
	// tool output, which only the full content level retains.
	ToolOutput(event string) []string
}

// UsageRead asks for the token usage an agent's local transcript recorded
// since the previous read, after the hook event Event.
type UsageRead struct {
	Transcript string
	SessionID  string
	Event      string
	Now        time.Time
	// Until is when the boundary's hook fired. Unless the session ended, a
	// request that began later may still be streaming and waits.
	Until time.Time
	// Allowed reports whether capture was allowed for the session at a
	// time; usage from any other time is passed over, never uploaded.
	Allowed func(time.Time) bool
	// Env locates the agent's own directories, which confine where a
	// transcript may be read from.
	Env Env
	// Harness is the harness the session's telemetry named, when one adapter
	// serves several and the transcript alone may not tell them apart.
	Harness string
}

// UsageSource is an agent whose hooks carry no token usage, so the daemon
// reads it from the agent's local transcript at response boundaries. Only
// usage metadata is decoded; message content is never read into an event.
type UsageSource interface {
	// UsageTranscript names the transcript to read after event, from the
	// raw hook payload. It must stay cheap: the hook shim calls it.
	UsageTranscript(event string, payload map[string]any) (string, bool)
	// ReadUsage returns normalized usage events and the next cursor, an
	// opaque state the daemon keeps per session.
	ReadUsage(read UsageRead, cursor json.RawMessage) (UsageResult, error)
}

type UsageResult struct {
	Events []json.RawMessage
	Cursor json.RawMessage
	// DeferredFiles counts changed transcripts left for a later read to
	// bound this one; never their paths.
	DeferredFiles int
	// CapacityLimitedFiles counts transcripts a read left as they were
	// because they hold back more than a cursor keeps; their usage waits,
	// and they are never named.
	CapacityLimitedFiles int
	// Harness names the harness the events were attributed to, when it is
	// not the adapter's own id.
	Harness string
}

// CommandName is the CLI spelling of an agent id: "claude_code" → "claude-code".
func CommandName(id string) string { return strings.ReplaceAll(id, "_", "-") }

// Aliased agents accept extra CLI names, e.g. "pi" for "pi_cli".
type Aliased interface{ Aliases() []string }

type Registry struct {
	agents  map[string]Agent
	aliases map[string]string
}

func NewRegistry(agents ...Agent) *Registry {
	registry := &Registry{agents: map[string]Agent{}, aliases: map[string]string{}}
	for _, agent := range agents {
		registry.agents[agent.ID()] = agent
		if aliased, ok := agent.(Aliased); ok {
			for _, alias := range aliased.Aliases() {
				registry.aliases[alias] = agent.ID()
			}
		}
	}
	return registry
}

// Lookup accepts the id, its hyphenated spelling or an alias.
func (r *Registry) Lookup(name string) (Agent, error) {
	id := strings.ReplaceAll(name, "-", "_")
	if aliased, ok := r.aliases[name]; ok {
		id = aliased
	}
	agent, ok := r.agents[id]
	if !ok {
		return nil, ErrUnknownAgent
	}
	return agent, nil
}

func (r *Registry) All() []Agent {
	agents := make([]Agent, 0, len(r.agents))
	for _, agent := range r.agents {
		agents = append(agents, agent)
	}
	sort.Slice(agents, func(i, j int) bool { return agents[i].ID() < agents[j].ID() })
	return agents
}
