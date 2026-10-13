// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package shim is the hook hot path. It decides scope from the cached local
// policy and, only for in-scope sessions, retains one sanitized inbox item.
// It never runs Beacon, hashes binaries or uses the network.
package shim

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	maxHookBytes      = 1 << 20
	discoveryLockWait = 250 * time.Millisecond
)

var (
	ErrHookTooLarge     = errors.New("hook_payload_too_large")
	ErrIdentityRedacted = errors.New("native_identity_matches_privacy_filter")
)

type Shim struct {
	Layout   store.Layout
	Registry *agent.Registry
	Home     string
	TempDirs []string
	Now      func() time.Time
}

// HandleAndRecord runs Handle and counts any failure in the health file. The
// caller always answers the agent with "{}": observation never becomes a
// decision.
func (s Shim) HandleAndRecord(agentName string, input io.Reader) {
	if err := s.Handle(agentName, input); err != nil {
		if _, statErr := os.Stat(s.Layout.Root); statErr == nil {
			state.RecordHookError(s.Layout, errorCode(err), s.Now())
		}
	}
}

func (s Shim) Handle(agentName string, input io.Reader) error {
	adapter, err := s.Registry.Lookup(agentName)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(input, maxHookBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxHookBytes {
		return ErrHookTooLarge
	}
	observation, payload, err := adapter.ParseHook(raw)
	if errors.Is(err, agent.ErrIgnoredEvent) {
		return nil
	}
	if err != nil {
		return err
	}
	decision, err := s.decide(adapter.ID(), observation.Cwd)
	if err != nil {
		return err
	}
	if adapter.Ingress() == agent.IngressOTLP {
		return s.recordThread(adapter, observation, payload, decision)
	}
	if !decision.InScope {
		return s.recordDiscovered(decision)
	}
	return s.retain(adapter, observation, payload, decision)
}

func (s Shim) decide(agentID, cwd string) (scope.Decision, error) {
	input := scope.Input{AgentID: agentID, Cwd: cwd, Home: s.Home, TempDirs: s.TempDirs, Now: s.Now()}
	cached, err := policy.Load(s.Layout.Policy())
	if errors.Is(err, os.ErrNotExist) {
		return scope.Decide(input), nil
	}
	if err != nil {
		return scope.Decision{}, err
	}
	input.Policy = &cached
	preferences, err := state.Load[state.Preferences](s.Layout.Preferences())
	if err != nil {
		return scope.Decision{}, err
	}
	admission, err := state.Load[state.Admission](s.Layout.Admission())
	if err != nil {
		return scope.Decision{}, err
	}
	discovered, err := state.Load[state.Discovered](s.Layout.Discovered())
	if err != nil {
		return scope.Decision{}, err
	}
	input.LocalPaused, input.IgnoredPaths = preferences.Paused, preferences.IgnoredPaths
	installation, err := state.Load[state.Installation](s.Layout.Installation())
	if err != nil {
		return scope.Decision{}, err
	}
	input.Unauthorized = admission.RevokedFor(installation.ID)
	input.UnmatchedRoots = discovered.UnmatchedRoots()
	return scope.Decide(input), nil
}

func (s Shim) recordDiscovered(decision scope.Decision) error {
	if decision.Discovered == nil {
		return nil
	}
	known, err := state.Load[state.Discovered](s.Layout.Discovered())
	if err == nil && known.Knows(*decision.Discovered) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), discoveryLockWait)
	defer cancel()
	return state.RecordDiscovered(ctx, s.Layout, *decision.Discovered, s.Now())
}

// recordThread notes where an OTLP agent's thread runs, and its transcript.
// Its telemetry is scoped against this when it reaches the gate; the hook
// payload itself, including any prompt, is not retained.
func (s Shim) recordThread(adapter agent.Agent, observation agent.Observation, payload map[string]any, decision scope.Decision) error {
	if err := s.recordDiscovered(decision); err != nil {
		return err
	}
	if _, err := os.Stat(s.Layout.Root); err != nil {
		// Never connected: nothing is captured, so nothing is recorded.
		return nil
	}
	cwd := decision.Cwd
	if cwd == "" {
		cwd = observation.Cwd
	}
	threadID := observation.ThreadID
	if threadID == "" {
		threadID = observation.NativeSessionID
	}
	var transcript string
	if source, ok := adapter.(agent.UsageSource); ok {
		transcript, _ = source.UsageTranscript(observation.Event, payload)
	}
	return state.RecordThread(s.Layout, threadID, state.Thread{Agent: adapter.ID(), Cwd: cwd, SessionID: observation.NativeSessionID, Transcript: transcript}, s.Now())
}

func (s Shim) retain(adapter agent.Agent, observation agent.Observation, payload map[string]any, decision scope.Decision) error {
	// Only the path is taken; the daemon reads the transcript, off the hot path.
	var usageTranscript, contentFile string
	if source, ok := adapter.(agent.UsageSource); ok {
		usageTranscript, _ = source.UsageTranscript(observation.Event, payload)
	}
	if source, ok := adapter.(agent.ContentSource); ok {
		if path, named := source.ContentFile(observation.Event, payload); named && filepath.IsAbs(path) && !strings.ContainsRune(path, 0) {
			contentFile = filepath.Clean(path)
		}
	}
	adapter.RewriteCwd(payload, decision.Cwd)
	// Tool output is reduced before sanitizing, so a standard-level digest
	// describes the output the agent actually produced.
	toolOutput := adapter.ToolOutput(observation.Event)
	payload = privacy.ReduceToolOutput(privacy.ReduceEditContent(payload, adapter.ID(), decision.ContentLevel), toolOutput, decision.ContentLevel)
	clean, coverage := privacy.SanitizeFor(payload, toolOutput, decision.ContentLevel)
	if !adapter.IdentityPreserved(observation, clean) {
		return ErrIdentityRedacted
	}
	observation.Cwd = decision.Cwd
	return inbox.Write(s.Layout.InboxDir(), inbox.Item{
		Agent:            adapter.ID(),
		Observation:      observation,
		MappingID:        decision.MappingID,
		PendingAutoMatch: decision.PendingAutoMatch,
		ContentLevel:     decision.ContentLevel,
		ReceivedAt:       s.Now().UTC(),
		Coverage:         coverage,
		Payload:          privacy.ApplyContentLevel(clean, decision.ContentLevel),
		UsageTranscript:  usageTranscript,
		ContentFile:      contentFile,
	})
}

// knownErrors map failures to stable, content-free health codes.
var knownErrors = []error{
	ErrHookTooLarge, ErrIdentityRedacted, agent.ErrUnknownAgent, agent.ErrInvalidHook,
	agent.ErrUnsupportedEvent, agent.ErrMissingIdentity, inbox.ErrFull, inbox.ErrItemTooBig,
	store.ErrUnsafePath, policy.ErrInvalid,
}

func errorCode(err error) string {
	for _, known := range knownErrors {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	return "internal_error"
}
