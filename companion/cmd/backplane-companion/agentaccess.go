// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agentaccess"
	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/mcplaunch"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// agentAccessInterval is how often a capture session retries entries an
// agent's own rewrite got in the way of, repoints entries after the app
// moved, and asks (at most every ten minutes) whether the key still exists.
const agentAccessInterval = time.Minute

// agentAccessFor is the one manager of this process, shared by the control
// API and the capture session so both see the same outcomes.
func (a *app) agentAccessFor(layout store.Layout) *agentaccess.Manager {
	a.agentAccessMu.Lock()
	defer a.agentAccessMu.Unlock()
	if a.agentAccess == nil || a.agentAccess.Layout != layout {
		a.agentAccess = &agentaccess.Manager{
			Layout:  layout,
			Keyring: appKeyring{a},
			Env:     a.agentEnv(),
			HasUvx:  a.hasUvx,
			Now:     a.now,
			Logf:    func(format string, args ...any) { a.logLine(fmt.Sprintf(format, args...)) },
		}
	}
	return a.agentAccess
}

// appKeyring follows a.keyring, which tests swap after the manager exists.
type appKeyring struct{ app *app }

func (k appKeyring) Save(account, secret string) error   { return k.app.keyring.Save(account, secret) }
func (k appKeyring) Load(account string) (string, error) { return k.app.keyring.Load(account) }
func (k appKeyring) Delete(account string) error         { return k.app.keyring.Delete(account) }

func (a *app) hasUvx() bool {
	_, found := mcplaunch.FindUvx(a.getenv, a.home, a.goos)
	return found
}

// removeAgentAccess undoes agent access locally; it never blocks the
// disconnect or revocation that calls it.
func (a *app) removeAgentAccess(layout store.Layout, installationID string) {
	if err := a.agentAccessFor(layout).RemoveAll(installationID); err != nil {
		a.logError(err)
	}
}

func accessConnection(installation state.Installation, keys agentaccess.KeyService, cached policy.Cached) agentaccess.Connection {
	ids := []string{}
	for _, mapping := range cached.Policy.Mappings {
		ids = append(ids, mapping.ID)
	}
	return agentaccess.Connection{InstallationID: installation.ID, Endpoint: installation.Endpoint, Keys: keys, MappingIDs: ids, AgentEnabled: cached.Policy.AgentEnabled}
}

// startAgentAccess keeps agent access in line for one capture session; the
// returned stop ends it and waits.
func (a *app) startAgentAccess(ctx context.Context, layout store.Layout, installation state.Installation, client *uplink.Client) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		manager := a.agentAccessFor(layout)
		ticker := time.NewTicker(agentAccessInterval)
		defer ticker.Stop()
		for {
			if _, err := manager.Repair(); err != nil {
				a.logError(err)
			}
			if cached, err := policy.Load(layout.Policy()); err == nil {
				connection := accessConnection(installation, client, cached)
				connection.RootsFor = func(id string) []string {
					for _, mapping := range cached.Policy.Mappings {
						if mapping.ID == id {
							return a.mappingRoots(layout, cached, mapping)
						}
					}
					return nil
				}
				result, changed := manager.Reconcile(ctx, connection)
				if changed && a.publishAgentAccess != nil {
					a.publishAgentAccess(result)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

// agentAccessService is the control API's agent access, over the same
// manager the capture session keeps in line.
type agentAccessService struct {
	app    *app
	layout store.Layout
}

func (s agentAccessService) AgentAccess(context.Context) (any, error) {
	manager := s.app.agentAccessFor(s.layout)
	installation, client, err := s.app.connectedClient(s.layout)
	if err != nil {
		return manager.Snapshot(agentaccess.Connection{}), nil
	}
	defer client.Close()
	cached, _ := policy.Load(s.layout.Policy())
	return manager.Snapshot(accessConnection(installation, client, cached)), nil
}

func (s agentAccessService) SetAgentAccess(ctx context.Context, mappingID string, enabled bool) (any, error) {
	installation, client, err := s.app.connectedClient(s.layout)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	cached, mapping, found := s.cachedMapping(mappingID)
	if !found {
		// The mapping may be newer than the daemon's last policy refresh.
		if err := s.app.refreshPolicyCache(ctx, s.layout); err != nil {
			return nil, err
		}
		cached, mapping, found = s.cachedMapping(mappingID)
	}
	if !found {
		return nil, &control.Error{Status: http.StatusNotFound, Code: control.CodeNotFound, Message: "No such mapping on this device."}
	}
	access := agentaccess.MappingAccess{}
	if enabled {
		if access, err = s.boardAccess(ctx, client, mapping); err != nil {
			return nil, err
		}
	}
	return s.app.agentAccessFor(s.layout).Set(ctx, accessConnection(installation, client, cached), mappingID, enabled, access)
}

func (s agentAccessService) cachedMapping(id string) (policy.Cached, policy.Mapping, bool) {
	cached, err := policy.Load(s.layout.Policy())
	if err != nil {
		return cached, policy.Mapping{}, false
	}
	for _, mapping := range cached.Policy.Mappings {
		if mapping.ID == id {
			return cached, mapping, true
		}
	}
	return cached, policy.Mapping{}, false
}

// boardAccess is what the launcher needs for mapping: its local folder and
// the board's names as the owner can reach them now.
func (s agentAccessService) boardAccess(ctx context.Context, client *uplink.Client, mapping policy.Mapping) (agentaccess.MappingAccess, error) {
	cached, _ := policy.Load(s.layout.Policy())
	roots := s.app.mappingRoots(s.layout, cached, mapping)
	if len(roots) == 0 {
		return agentaccess.MappingAccess{}, &control.Error{Status: http.StatusConflict, Code: control.CodeMappingRootUnknown, Message: "This device has not seen the folder of that repository yet."}
	}
	document, err := client.Boards(ctx)
	if err != nil {
		return agentaccess.MappingAccess{}, err
	}
	var catalog struct {
		Workspaces []struct {
			ID     string `json:"id"`
			Slug   string `json:"slug"`
			Name   string `json:"name"`
			Boards []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"boards"`
		} `json:"workspaces"`
	}
	if err := json.Unmarshal(document, &catalog); err != nil {
		return agentaccess.MappingAccess{}, fmt.Errorf("%w: boards", uplink.ErrInvalidResponse)
	}
	for _, workspace := range catalog.Workspaces {
		if workspace.ID != mapping.WorkspaceID {
			continue
		}
		for _, board := range workspace.Boards {
			if board.ID == mapping.BoardID && mapping.BoardID != "" {
				return agentaccess.MappingAccess{Root: roots[0], Roots: roots, WorkspaceSlug: workspace.Slug, WorkspaceName: workspace.Name, BoardID: board.ID, BoardName: board.Name}, nil
			}
		}
	}
	return agentaccess.MappingAccess{}, &control.Error{Status: http.StatusNotFound, Code: control.CodeNotFound, Message: "You can no longer reach that board."}
}
