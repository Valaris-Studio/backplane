// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agentaccess

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// keyCheckInterval bounds how often the daemon asks whether the user deleted
// the agents key on the web.
const keyCheckInterval = 10 * time.Minute

// removeAttempts retries a removal the agent raced with its own rewrite.
const removeAttempts = 3

// Agent states and problems, a stable contract with the desktop app.
const (
	stateConfigured  = "configured"
	statePending     = "pending"
	stateConflict    = "conflict"
	stateUnsupported = "unsupported"
	stateError       = "error"

	problemAgentNotInstalled = "agent_not_installed"
	problemConfigInvalid     = "agent_config_invalid"
	problemConfigChanged     = "agent_config_changed"
	problemConfigSymlink     = "agent_config_symlink"
	problemUvxMissing        = "uvx_missing"
	// problemOtherMapping: another bound folder in the same repository
	// already holds the repository's Claude Code entry.
	problemOtherMapping = "folder_bound_to_other_mapping"
	// problemWorktreeLinkUntrusted: the folder's .git claims a linked
	// worktree git does not confirm, so its entry sits under the folder.
	problemWorktreeLinkUntrusted = "worktree_link_untrusted"

	serverActive  = "active"
	serverMissing = "missing"
	serverUnknown = "unknown"
)

// KeyService is the device-token client's agents-key API.
type KeyService interface {
	CreateAgentKey(context.Context) (uplink.AgentKey, error)
	AgentKey(context.Context) (uplink.AgentKeyInfo, error)
	DeleteAgentKey(context.Context) error
}

// Keyring holds the agents key under credentials.AgentKeyAccount; it is
// the only place the key is kept.
type Keyring interface {
	Save(account, secret string) error
	Load(account string) (string, error)
	Delete(account string) error
}

// Connection is the device connection a change is made under.
type Connection struct {
	InstallationID string
	Endpoint       string
	Keys           KeyService
	// MappingIDs are the installation's current mappings; nil means unknown,
	// so nothing is cleaned up for a missing policy.
	MappingIDs []string
	// AgentEnabled is the installation's capture switch per agent; nil
	// allows every agent.
	AgentEnabled func(agentID string) bool
	// RootsFor finds an enabled mapping's folders again, so a clone seen
	// after access was turned on gets its entry; nil keeps the stored ones.
	RootsFor func(mappingID string) []string
}

func (c Connection) agentEnabled(agentID string) bool {
	return c.AgentEnabled == nil || c.AgentEnabled(agentID)
}

// AgentAccess is the control API's view. It holds no key material and no
// value from any agent configuration.
type AgentAccess struct {
	Key           KeyStatus       `json:"key"`
	Prerequisites Prerequisites   `json:"prerequisites"`
	Mappings      []MappingStatus `json:"mappings"`
	Warnings      []Warning       `json:"warnings"`
}

type KeyStatus struct {
	Present     bool    `json:"present"`
	KeyPrefix   *string `json:"key_prefix"`
	ServerState string  `json:"server_state"`
}

type Prerequisites struct {
	Uvx bool `json:"uvx"`
}

type MappingStatus struct {
	MappingID string        `json:"mapping_id"`
	Enabled   bool          `json:"enabled"`
	Agents    []AgentStatus `json:"agents"`
}

type AgentStatus struct {
	AgentID string  `json:"agent_id"`
	Scope   string  `json:"scope"`
	State   string  `json:"state"`
	Problem *string `json:"problem"`
}

type Warning struct {
	AgentID   string `json:"agent_id"`
	EntryName string `json:"entry_name"`
	Reason    string `json:"reason"`
}

type Manager struct {
	Layout  store.Layout
	Keyring Keyring
	// Env locates the agents' configuration; Env.Executable is what entries run.
	Env    agent.Env
	HasUvx func() bool
	Now    func() time.Time
	Logf   func(format string, args ...any)

	mu sync.Mutex
	// outcomes are the last write results, per mapping and agent.
	outcomes     map[string]map[string]AgentStatus
	warnings     []Warning
	keyPrefix    string
	serverState  string
	keyCheckedAt time.Time
}

func (m *Manager) now() time.Time {
	if m.Now == nil {
		return time.Now()
	}
	return m.Now()
}

func (m *Manager) logf(format string, args ...any) {
	if m.Logf != nil {
		m.Logf(format, args...)
	}
}

// Set turns agent access for one mapping on or off. Turning it on mints the
// agents key first when the keyring has none; if that fails nothing is
// written. Turning the last mapping off removes the global entries and
// deletes the key.
func (m *Manager) Set(ctx context.Context, connection Connection, mappingID string, enabled bool, access MappingAccess) (AgentAccess, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	file, err := Load(m.Layout)
	if err != nil {
		return m.snapshotLocked(connection, file), err
	}
	wasEnabled := file.anyEnabled()
	if enabled {
		if err := m.ensureKey(ctx, connection, &file); err != nil {
			return m.snapshotLocked(connection, file), err
		}
		access.Enabled = true
		if len(access.Roots) == 0 && access.Root != "" {
			access.Roots = []string{access.Root}
		}
		file.Mappings[mappingID] = access
	} else if current, known := file.Mappings[mappingID]; known {
		current.Enabled = false
		file.Mappings[mappingID] = current
	}
	file.Endpoint = connection.Endpoint
	// The launcher must know the board before any entry can start it.
	if err := Save(m.Layout, file); err != nil {
		return m.snapshotLocked(connection, file), err
	}
	m.apply(&file, connection)
	if wasEnabled && !file.anyEnabled() {
		m.dropKey(ctx, connection, &file)
	}
	if err := Save(m.Layout, file); err != nil {
		return m.snapshotLocked(connection, file), err
	}
	return m.snapshotLocked(connection, file), nil
}

// Snapshot reports the current state without changing anything.
func (m *Manager) Snapshot(connection Connection) AgentAccess {
	m.mu.Lock()
	defer m.mu.Unlock()
	file, _ := Load(m.Layout)
	return m.snapshotLocked(connection, file)
}

// Reconcile retries entries an agent's own rewrite got in the way of, drops
// mappings the server no longer has, and at most every keyCheckInterval asks
// whether the key still exists. changed reports a different snapshot.
func (m *Manager) Reconcile(ctx context.Context, connection Connection) (AgentAccess, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	file, err := Load(m.Layout)
	if err != nil {
		return m.snapshotLocked(connection, file), false
	}
	before := fingerprint(m.snapshotLocked(connection, file))
	wasEnabled := file.anyEnabled()
	// A mapping the server no longer has is turned off first, so apply knows
	// whose entry it removes, and forgotten once nothing of it is left.
	if connection.RootsFor != nil {
		for id, access := range file.Mappings {
			if roots := connection.RootsFor(id); access.Enabled && len(roots) > 0 {
				access.Roots = roots
				if !slices.Contains(roots, access.Root) {
					access.Root = roots[0]
				}
				file.Mappings[id] = access
			}
		}
	}
	gone := []string{}
	if connection.MappingIDs != nil {
		for id, access := range file.Mappings {
			if !slices.Contains(connection.MappingIDs, id) {
				access.Enabled = false
				file.Mappings[id] = access
				gone = append(gone, id)
			}
		}
	}
	stuck := []string{}
	if wasEnabled || file.Written.any() {
		stuck = m.apply(&file, connection)
	}
	for _, id := range gone {
		if !slices.ContainsFunc(file.Mappings[id].AllRoots(), func(root string) bool { return slices.Contains(stuck, root) }) {
			delete(file.Mappings, id)
		}
	}
	if wasEnabled && !file.anyEnabled() {
		m.dropKey(ctx, connection, &file)
	} else if file.PendingServerDelete && !file.anyEnabled() && connection.Keys != nil {
		m.retryServerDelete(ctx, connection, &file)
	}
	if err := Save(m.Layout, file); err != nil {
		m.logf("agent access: saving state failed: %v", err)
	}
	m.checkKey(ctx, connection)
	after := m.snapshotLocked(connection, file)
	return after, !slices.Equal(before, fingerprint(after))
}

// RemoveAll undoes agent access locally for disconnect and revocation:
// every entry the companion wrote, the keyring item and the state file. The
// server deletes the key itself when the installation is revoked.
func (m *Manager) RemoveAll(installationID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	file, _ := Load(m.Layout)
	roots := slices.Clone(file.Written.ClaudeCode)
	for _, access := range file.Mappings {
		for _, root := range access.AllRoots() {
			roots = appendUnique(roots, root)
		}
	}
	var failures []error
	for _, w := range defaultWriters() {
		targets := []string{""}
		if w.scope == scopeFolder {
			targets = roots
		}
		for _, root := range targets {
			if err := removeWithRetry(w, m.Env, root, nil); err != nil {
				failures = append(failures, err)
			}
		}
	}
	if installationID != "" {
		if err := m.Keyring.Delete(credentials.AgentKeyAccount(installationID)); err != nil {
			failures = append(failures, err)
		}
	}
	if err := os.Remove(Path(m.Layout)); err != nil && !errors.Is(err, os.ErrNotExist) {
		failures = append(failures, err)
	}
	m.outcomes, m.warnings, m.keyPrefix, m.serverState, m.keyCheckedAt = nil, nil, "", "", time.Time{}
	return errors.Join(failures...)
}

// Repair repoints every owned entry at the current executable, e.g. after
// the app moved; it never adds entries.
func (m *Manager) Repair() (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	changed := false
	var failures []error
	for _, w := range defaultWriters() {
		repaired, err := w.repair(m.Env)
		changed = changed || repaired
		if err != nil {
			failures = append(failures, err)
		}
	}
	return changed, errors.Join(failures...)
}

func (m *Manager) ensureKey(ctx context.Context, connection Connection, file *File) error {
	account := credentials.AgentKeyAccount(connection.InstallationID)
	_, err := m.Keyring.Load(account)
	if err == nil {
		return nil
	}
	if !errors.Is(err, credentials.ErrNotFound) {
		return err
	}
	key, err := connection.Keys.CreateAgentKey(ctx)
	if errors.Is(err, uplink.ErrAgentKeyRotationConflict) {
		// Another mint for this installation ran at once. If another
		// companion process made it, its key is in the keyring by now;
		// otherwise one more mint replaces it.
		info, getErr := connection.Keys.AgentKey(ctx)
		if getErr != nil && !errors.Is(getErr, uplink.ErrAgentKeyMissing) {
			return getErr
		}
		if _, loadErr := m.Keyring.Load(account); loadErr == nil {
			m.keyPrefix, m.serverState, m.keyCheckedAt = info.KeyPrefix, serverActive, m.now()
			return nil
		}
		key, err = connection.Keys.CreateAgentKey(ctx)
	}
	if err != nil {
		return err
	}
	if err := m.Keyring.Save(account, key.Key); err != nil {
		// A key nobody can use must not stay valid on the server.
		if deleteErr := connection.Keys.DeleteAgentKey(ctx); deleteErr != nil {
			m.logf("agent access: deleting an unstored agents key failed: %v", deleteErr)
		}
		return err
	}
	// A mint replaces every earlier key on the server, including one whose
	// delete is still pending, which must now never be retried.
	file.PendingServerDelete = false
	m.keyPrefix, m.serverState, m.keyCheckedAt = key.KeyPrefix, serverActive, m.now()
	return nil
}

// dropKey deletes the key on the server and in the keyring. The keyring item
// goes even when the server is unreachable; the server delete is then kept
// pending (no secret, only the fact) and retried by Reconcile.
func (m *Manager) dropKey(ctx context.Context, connection Connection, file *File) {
	if err := connection.Keys.DeleteAgentKey(ctx); err != nil {
		m.logf("agent access: deleting the agents key on the server failed: %v", err)
		file.PendingServerDelete = true
	}
	if err := m.Keyring.Delete(credentials.AgentKeyAccount(connection.InstallationID)); err != nil {
		m.logf("agent access: deleting the agents key from the keyring failed: %v", err)
	}
	m.keyPrefix, m.serverState = "", ""
}

func (m *Manager) retryServerDelete(ctx context.Context, connection Connection, file *File) {
	if err := connection.Keys.DeleteAgentKey(ctx); err != nil {
		m.logf("agent access: retrying the agents key delete failed: %v", err)
		return
	}
	file.PendingServerDelete = false
}

func (m *Manager) keyPresent(connection Connection) bool {
	if connection.InstallationID == "" || m.Keyring == nil {
		return false
	}
	_, err := m.Keyring.Load(credentials.AgentKeyAccount(connection.InstallationID))
	return err == nil
}

func (m *Manager) checkKey(ctx context.Context, connection Connection) {
	if connection.Keys == nil || !m.keyPresent(connection) || m.now().Sub(m.keyCheckedAt) < keyCheckInterval {
		return
	}
	m.keyCheckedAt = m.now()
	info, err := connection.Keys.AgentKey(ctx)
	switch {
	case err == nil:
		m.keyPrefix, m.serverState = info.KeyPrefix, serverActive
	case errors.Is(err, uplink.ErrAgentKeyMissing):
		// Deleted on the web: forget ours so turning access back on mints one.
		if err := m.Keyring.Delete(credentials.AgentKeyAccount(connection.InstallationID)); err != nil {
			m.logf("agent access: clearing a deleted agents key failed: %v", err)
		}
		m.keyPrefix, m.serverState = "", serverMissing
	default:
		m.serverState = serverUnknown
	}
}

// apply brings every agent's entries in line with the enabled mappings and
// records the outcomes, the entries written and the warnings. stuck are the
// folders whose entry of a mapping that is off could not be removed.
func (m *Manager) apply(file *File, connection Connection) (stuck []string) {
	enabled := file.enabledIDs()
	uvx := m.HasUvx == nil || m.HasUvx()
	m.outcomes = map[string]map[string]AgentStatus{}
	for _, id := range enabled {
		m.outcomes[id] = map[string]AgentStatus{}
	}
	warnings := []Warning{}
	written := Written{ClaudeCode: []string{}}
	for _, w := range defaultWriters() {
		present := w.present(m.Env)
		eligible, problem := true, ""
		switch {
		case !present:
			eligible, problem = false, problemAgentNotInstalled
		case !connection.agentEnabled(w.agentID):
			eligible = false
		default:
			problem = w.unsupported(m.Env)
			eligible = problem == ""
		}
		record := func(mappingID string, state, problem string) {
			m.outcomes[mappingID][w.agentID] = status(w, state, problem)
		}
		if !eligible {
			for _, id := range enabled {
				record(id, stateUnsupported, problem)
			}
		}
		switch w.scope {
		case scopeFolder:
			// Removals first, so a folder one mapping let go of can be taken
			// by another in the same pass. Only the entries of mappings that
			// no longer want the folder may go; a root no mapping names is
			// forgotten.
			for _, root := range file.Written.ClaudeCode {
				owners := file.idsNotWanting(root, eligible)
				if len(owners) == 0 {
					continue
				}
				if err := removeWithRetry(w, m.Env, root, owners); err != nil {
					written.ClaudeCode = appendUnique(written.ClaudeCode, root)
					stuck = append(stuck, root)
				}
			}
			if eligible {
				for _, id := range enabled {
					// A mapping reports its first folder that is not
					// configured, else the first advisory.
					var reported *AgentStatus
					for _, root := range file.Mappings[id].AllRoots() {
						_, err := w.write(m.Env, root, id)
						state, problem := outcome(err, func(env agent.Env) string { return w.advisory(env, root) }, m.Env, uvx)
						current := status(w, state, problem)
						if reported == nil || reported.State == stateConfigured && (state != stateConfigured || reported.Problem == nil && current.Problem != nil) {
							reported = &current
						}
						if err == nil || slices.Contains(file.Written.ClaudeCode, root) && !errors.Is(err, claudecode.ErrOtherMapping) {
							written.ClaudeCode = appendUnique(written.ClaudeCode, root)
						}
					}
					if reported != nil {
						m.outcomes[id][w.agentID] = *reported
					}
				}
			}
		case scopeGlobal:
			wasWritten := file.Written.global(w.agentID)
			isWritten := false
			if eligible && len(enabled) > 0 {
				_, err := w.write(m.Env, "", "")
				state, problem := outcome(err, func(env agent.Env) string { return w.advisory(env, "") }, m.Env, uvx)
				for _, id := range enabled {
					record(id, state, problem)
				}
				isWritten = err == nil || wasWritten
			} else if wasWritten {
				isWritten = removeWithRetry(w, m.Env, "", nil) != nil
			}
			written.setGlobal(w.agentID, isWritten)
		}
		if present && len(enabled) > 0 {
			warnings = append(warnings, m.findings(w, file, enabled, connection.Endpoint)...)
		}
	}
	file.Written = written
	m.warnings = uniqueWarnings(warnings)
	return stuck
}

func (m *Manager) findings(w writer, file *File, enabled []string, endpoint string) []Warning {
	roots := []string{""}
	if w.scope == scopeFolder {
		roots = nil
		for _, id := range enabled {
			roots = append(roots, file.Mappings[id].AllRoots()...)
		}
	}
	warnings := []Warning{}
	for _, root := range roots {
		found, err := w.findings(m.Env, root, endpoint)
		if err != nil {
			continue
		}
		for _, finding := range found {
			warnings = append(warnings, Warning{AgentID: w.agentID, EntryName: finding.EntryName, Reason: finding.Reason})
		}
	}
	return warnings
}

func outcome(err error, advisory func(agent.Env) string, env agent.Env, uvx bool) (state, problem string) {
	switch {
	case err == nil:
		if next := advisory(env); next != "" {
			return stateConfigured, next
		}
		if !uvx {
			return stateConfigured, problemUvxMissing
		}
		return stateConfigured, ""
	case errors.Is(err, mcpentry.ErrNameTaken):
		return stateConflict, ""
	case errors.Is(err, claudecode.ErrOtherMapping):
		return stateConflict, problemOtherMapping
	case errors.Is(err, agent.ErrConfigChanged):
		return statePending, problemConfigChanged
	case errors.Is(err, agent.ErrConfigSymlink):
		return stateError, problemConfigSymlink
	case errors.Is(err, agent.ErrConfigInvalid):
		return stateError, problemConfigInvalid
	case errors.Is(err, pi.ErrMCPAdapterMissing):
		return stateUnsupported, pi.ErrMCPAdapterMissing.Error()
	default:
		return stateError, ""
	}
}

func status(w writer, state, problem string) AgentStatus {
	result := AgentStatus{AgentID: w.agentID, Scope: w.scope, State: state}
	if problem != "" {
		result.Problem = &problem
	}
	return result
}

func removeWithRetry(w writer, env agent.Env, root string, mappingIDs []string) error {
	var err error
	for attempt := 0; attempt < removeAttempts; attempt++ {
		if _, err = w.remove(env, root, mappingIDs); !errors.Is(err, agent.ErrConfigChanged) {
			return err
		}
	}
	return err
}

func (m *Manager) snapshotLocked(connection Connection, file File) AgentAccess {
	result := AgentAccess{
		Key:           KeyStatus{Present: m.keyPresent(connection), ServerState: serverUnknown},
		Prerequisites: Prerequisites{Uvx: m.HasUvx == nil || m.HasUvx()},
		Mappings:      []MappingStatus{},
		Warnings:      []Warning{},
	}
	if m.serverState != "" {
		result.Key.ServerState = m.serverState
	}
	if result.Key.Present && m.keyPrefix != "" {
		prefix := m.keyPrefix
		result.Key.KeyPrefix = &prefix
	}
	writers := defaultWriters()
	for _, id := range connection.MappingIDs {
		mapping := MappingStatus{MappingID: id, Enabled: file.Mappings[id].Enabled, Agents: []AgentStatus{}}
		if mapping.Enabled {
			for _, w := range writers {
				agentStatus, known := m.outcomes[id][w.agentID]
				if !known {
					agentStatus = status(w, statePending, "")
				}
				mapping.Agents = append(mapping.Agents, agentStatus)
			}
		}
		result.Mappings = append(result.Mappings, mapping)
	}
	if file.anyEnabled() {
		result.Warnings = append(result.Warnings, m.warnings...)
	}
	return result
}

func fingerprint(access AgentAccess) []byte {
	encoded, _ := json.Marshal(access)
	return encoded
}

func uniqueWarnings(warnings []Warning) []Warning {
	unique := []Warning{}
	for _, warning := range warnings {
		if !slices.Contains(unique, warning) {
			unique = append(unique, warning)
		}
	}
	sort.SliceStable(unique, func(i, j int) bool {
		if unique[i].AgentID != unique[j].AgentID {
			return unique[i].AgentID < unique[j].AgentID
		}
		return unique[i].EntryName < unique[j].EntryName
	})
	return unique
}

func appendUnique(values []string, value string) []string {
	if slices.Contains(values, value) {
		return values
	}
	return append(values, value)
}

func (f File) anyEnabled() bool { return len(f.enabledIDs()) > 0 }

// idsNotWanting names the mappings whose entry at root may be removed:
// every mapping except the enabled ones that want root. When the agent is not
// eligible at all, no mapping wants any folder.
func (f File) idsNotWanting(root string, eligible bool) []string {
	ids := []string{}
	for id, access := range f.Mappings {
		if eligible && access.Enabled && slices.Contains(access.AllRoots(), root) {
			continue
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (f File) enabledIDs() []string {
	ids := []string{}
	for id, access := range f.Mappings {
		if access.Enabled && len(access.AllRoots()) > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (w Written) any() bool { return len(w.ClaudeCode) > 0 || w.CodexCLI || w.PiCLI }

func (w Written) global(agentID string) bool {
	switch agentID {
	case "codex_cli":
		return w.CodexCLI
	case "pi_cli":
		return w.PiCLI
	}
	return false
}

func (w *Written) setGlobal(agentID string, written bool) {
	switch agentID {
	case "codex_cli":
		w.CodexCLI = written
	case "pi_cli":
		w.PiCLI = written
	}
}
