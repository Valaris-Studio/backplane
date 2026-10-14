// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// dispatchHold is a negotiated assignment carried from discovery to its
// claim: the hold and the floor the start must bind.
type dispatchHold struct {
	workspaceID   string
	reservationID string
	role          string
	stamp         valaris.ContextDispatchStamp
}

// negotiatedDispatch is the server's current, validated dispatch contract.
type negotiatedDispatch struct {
	workspaceID string
	contract    valaris.ContextDispatchContract
}

// negotiateDispatch fetches and validates the agent's dispatch contract.
// nil without an error means an old server the configuration explicitly lets
// run the legacy path: one without the route, answering its bare 404. Every
// other failure refuses work, a typed 404 (unknown agent or workspace)
// included.
func (l *Loop) negotiateDispatch(ctx context.Context) (*negotiatedDispatch, error) {
	return negotiateDispatch(ctx, l.client, l.cfg, l.client.Agent.ID)
}

func negotiateDispatch(ctx context.Context, client *valaris.Client, cfg *config.Config, agentID string) (*negotiatedDispatch, error) {
	ws, policy := cfg.Valaris.WorkspaceSlug, cfg.ContextDispatch
	contract, err := client.ContextDispatchContract(ctx, ws, agentID)
	var apiErr *valaris.APIError
	if errors.As(err, &apiErr) && apiErr.RouteMissing() && policy.AllowLegacyServer && !policy.Require {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("context dispatch contract: %w", err)
	}
	workspaceID, err := resolveWorkspaceID(ctx, client, ws)
	if err != nil {
		return nil, err
	}
	if err := contract.Validate(agentID, workspaceID); err != nil {
		return nil, err
	}
	if policy.Require && contract.Mode != valaris.ContextDispatchRequired {
		return nil, fmt.Errorf("context dispatch: the server offers %s dispatch and this runner requires it", contract.Mode)
	}
	return &negotiatedDispatch{workspaceID: workspaceID, contract: *contract}, nil
}

func resolveWorkspaceID(ctx context.Context, client *valaris.Client, slug string) (string, error) {
	workspaces, err := client.ListWorkspaces(ctx)
	if err != nil {
		return "", fmt.Errorf("context dispatch: resolving workspace: %w", err)
	}
	for _, workspace := range workspaces {
		if workspace.Slug == slug {
			return workspace.ID, nil
		}
	}
	return "", fmt.Errorf("context dispatch: workspace %q not found", slug)
}

// recheckDispatch negotiates again before a start: the policy the hold was
// assigned under must still be the server's current one.
func (l *Loop) recheckDispatch(ctx context.Context, hold *dispatchHold) error {
	current, err := l.negotiateDispatch(ctx)
	if err != nil {
		return err
	}
	if current == nil || current.contract.Stamp() != hold.stamp || !strings.EqualFold(current.workspaceID, hold.workspaceID) {
		return errors.New("context dispatch: the policy changed since the assignment; its hold is not started")
	}
	return nil
}

// startExecution starts the claimed card's execution, bound to its negotiated
// hold when it has one.
func (l *Loop) startExecution(ctx context.Context, card *discoverResult, start valaris.ExecutionStart) (string, error) {
	agentID := agentIDOf(l)
	if card.Dispatch == nil {
		return l.client.LogExecutionStartWithSkills(ctx, agentID, start.WorkspaceSlug, start.Action, start.BoardID, start.CardID,
			start.InputSummary, start.Role, start.PromptSlug, start.Model, start.Provider, start.Skills)
	}
	return l.client.StartBoundExecution(ctx, agentID, start, l.dispatchBinding(card))
}
