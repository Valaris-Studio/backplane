// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// A card held under a required context dispatch floor is never invoked from
// cached templates or the assignment's provider: each call waits for its rate
// permit, refreshes the execution's current dispatch-context, renders it once,
// has the exact final call prepared and acknowledged, and only then invokes
// that call unchanged. The acknowledgement records the call as prepared, not
// as used by a model.

const (
	// A transient or unknown preparation outcome is retried this many times,
	// with the same request key and payload, within preparationRetryWindow.
	maxPreparationRetries  = 2
	preparationRetryWindow = 15 * time.Second
	preparationBackoff     = 200 * time.Millisecond
)

type dispatchInvocationKey struct{}

// withDispatchInvocation names the invocation required dispatches under ctx
// are for; it travels with the call, not with the Loop.
func withDispatchInvocation(ctx context.Context, invocation valaris.DispatchInvocation) context.Context {
	return context.WithValue(ctx, dispatchInvocationKey{}, invocation)
}

// dispatchInvocationOf is the invocation named for ctx, by default the
// stage's main call.
func dispatchInvocationOf(ctx context.Context) valaris.DispatchInvocation {
	if invocation, ok := ctx.Value(dispatchInvocationKey{}).(valaris.DispatchInvocation); ok {
		return invocation
	}
	return valaris.DispatchInvocation{Kind: "stage", PromptSlot: "main"}
}

// requiresPreparedDispatch reports whether card's calls must be prepared:
// its hold was bound under a required floor, which a later policy change
// never lowers. A runner required to negotiate refuses an unbound card.
func (l *Loop) requiresPreparedDispatch(card *discoverResult) (bool, error) {
	if card.Dispatch != nil {
		return card.Dispatch.stamp.Mode == valaris.ContextDispatchRequired, nil
	}
	if l.cfg != nil && l.cfg.ContextDispatch.Require {
		return false, errors.New("context dispatch: required, and this card has no bound execution")
	}
	return false, nil
}

// dispatchBinding is what card's execution was bound to at its start.
func (l *Loop) dispatchBinding(card *discoverResult) valaris.ContextBinding {
	hold := card.Dispatch
	return valaris.ContextBinding{
		ReservationID: hold.reservationID, AgentID: agentIDOf(l), WorkspaceID: hold.workspaceID,
		BoardID: card.BoardID, CardID: card.CardID, Role: hold.role, ContextDispatch: hold.stamp,
	}
}

// preparedCall is one required call's local inputs: what its caller fetched
// or selected itself, and adds to the rendered input before preparation.
type preparedCall struct {
	card        *discoverResult
	executionID string
	repoDir     string
	// local carries the caller's own prompt fields (action plan, approval
	// summary, separately fetched directives…); the snapshot supplies the
	// card, its context and the identities, and a context source it maps to
	// a bridge alias replaces the fetched text.
	local           PromptContext
	resumeSessionID string
	// finish adds the caller's local additions to the rendered input.
	finish func(string) string
	// defaultSchema is the output schema when the snapshot names none.
	defaultSchema string
}

// invokePrepared runs one required call and returns its result and the input
// it was invoked with.
func (l *Loop) invokePrepared(ctx context.Context, call preparedCall) (*llm.Result, string, error) {
	if call.executionID == "" {
		return nil, "", errors.New("context dispatch: required, and the call has no execution")
	}
	if l.limiter != nil {
		if err := l.limiter.wait(ctx); err != nil {
			return nil, "", fmt.Errorf("rate limit wait: %w", err)
		}
	}
	invocation := dispatchInvocationOf(ctx)
	binding := l.dispatchBinding(call.card)
	for refreshed := false; ; refreshed = true {
		prepared, err := l.prepareCurrent(ctx, call, invocation, binding)
		var apiErr *valaris.APIError
		if errors.As(err, &apiErr) && revisionConflict(apiErr) && !refreshed {
			slog.Info("dispatch preparation met a newer revision — refreshing once", "execution_id", call.executionID, "error_code", apiErr.ErrorCode())
			continue
		}
		if err != nil {
			return nil, prepared.input(), err
		}
		if err := ctx.Err(); err != nil {
			return nil, prepared.input(), fmt.Errorf("context dispatch: canceled after preparation: %w", err)
		}
		result, err := l.invoke(ctx, prepared.provider, prepared.preparation.InputPrompt, prepared.options)
		return result, prepared.input(), err
	}
}

// preparedInvocation is a call prepared and acknowledged, to be invoked as is.
type preparedInvocation struct {
	provider    llm.Provider
	options     llm.Options
	preparation valaris.DispatchPreparation
}

func (p *preparedInvocation) input() string {
	if p == nil {
		return ""
	}
	return p.preparation.InputPrompt
}

// prepareCurrent refreshes the snapshot, renders and prepares one call.
func (l *Loop) prepareCurrent(ctx context.Context, call preparedCall, invocation valaris.DispatchInvocation, binding valaris.ContextBinding) (*preparedInvocation, error) {
	ws := l.cfg.Valaris.WorkspaceSlug
	snapshot, err := l.client.DispatchContext(ctx, ws, call.executionID, invocation)
	if err != nil {
		return nil, fmt.Errorf("context dispatch: refreshing: %w", err)
	}
	if err := snapshot.Validate(call.executionID, binding, invocation); err != nil {
		return nil, err
	}
	policy := snapshot.Dispatch
	// A call refused for its configuration is refused before anything is
	// selected, rendered or prepared.
	if semantics := callSemanticsOf(ctx); semantics != nil {
		if err := semantics.check(policy.Flags, invocation); err != nil {
			return nil, err
		}
	}
	provider, model, resolution, err := l.dispatchProvider(policy)
	if err != nil {
		return nil, err
	}
	pctx := call.local
	pctx.Workspace, pctx.AgentID, pctx.BoardID, pctx.CardID = ws, agentIDOf(l), call.card.BoardID, call.card.CardID
	pctx.ExecutionID, pctx.ContextSources, pctx.Card = call.executionID, snapshot.Context, snapshot.Card
	applyCurrentContextAliases(&pctx)
	input, err := renderPrompt(policy.InputTemplate, pctx)
	if err != nil {
		return nil, fmt.Errorf("context dispatch: rendering the input: %w", err)
	}
	if call.finish != nil {
		input = call.finish(input)
	}
	system := ""
	if policy.SystemTemplate != "" {
		if system, err = renderPrompt(policy.SystemTemplate, pctx); err != nil {
			return nil, fmt.Errorf("context dispatch: rendering the system prompt: %w", err)
		}
	}
	options := l.dispatchOptions(policy, model, call)
	options.SystemPrompt = system
	if err := checkDispatchChannels(provider, options); err != nil {
		return nil, err
	}
	key, err := valaris.NewRequestID()
	if err != nil {
		return nil, err
	}
	preparation := valaris.DispatchPreparation{
		ProtocolVersion: valaris.ContextDispatchVersion, ClientRequestID: key,
		ContextRevision: snapshot.ContextRevision, DispatchRevision: snapshot.DispatchRevision,
		Invocation: snapshot.Invocation, InputPrompt: input, SystemPrompt: system,
		Provider: policy.Provider, Adapter: provider.Name(), Model: model, ResolutionKind: resolution,
		ChannelContract: valaris.ChannelContract{Version: valaris.ContextDispatchVersion, Input: "verbatim", System: "empty"},
	}
	if system != "" {
		preparation.ChannelContract.System = "verbatim"
	}
	if call.resumeSessionID != "" {
		resume := call.resumeSessionID
		preparation.ResumeSessionID, preparation.ChannelContract.Resume = &resume, true
	}
	prepared := &preparedInvocation{provider: provider, options: options, preparation: preparation}
	ack, err := l.prepareWithRetry(ctx, call.executionID, preparation)
	if err != nil {
		return prepared, err
	}
	if err := ack.Validate(preparation, call.executionID, len(policy.RequiredSourceIndices) > 0); err != nil {
		return prepared, err
	}
	return prepared, nil
}

// applyCurrentContextAliases is applyContextSourceAliases for a current
// snapshot: a bridge alias the snapshot maps replaces separately fetched text.
func applyCurrentContextAliases(pc *PromptContext) {
	if v, ok := pc.ContextSources["board_definition"]; ok {
		pc.ProjectDirectives = v
	}
	if v, ok := pc.ContextSources["review_history"]; ok {
		pc.ReviewHistory = v
	}
}

// dispatchProvider is the provider the snapshot names, and the model and
// resolution kind the preparation declares. A tier is served by the runner's
// own preference for it; a named provider must be one the runner built.
func (l *Loop) dispatchProvider(policy valaris.DispatchPolicy) (llm.Provider, string, string, error) {
	resolution := "pinned"
	if policy.Tier != "" {
		resolution = "tier"
		if provider := l.providerForTier(policy.Tier); provider != nil {
			intent := valaris.AssignmentLLM{Provider: policy.Provider, Model: policy.Model, Tier: policy.Tier}
			return provider, l.modelForProvider(provider, intent, policy.Model), resolution, nil
		}
	}
	if provider, ok := l.providers[policy.Provider]; ok {
		return provider, policy.Model, resolution, nil
	}
	if l.providers == nil && l.provider != nil && l.provider.Name() == policy.Provider {
		return l.provider, policy.Model, resolution, nil
	}
	return nil, "", "", fmt.Errorf("context dispatch: this runner has no provider %q", policy.Provider)
}

// dispatchOptions are the call's options from the snapshot's current policy.
func (l *Loop) dispatchOptions(policy valaris.DispatchPolicy, model string, call preparedCall) llm.Options {
	deny, _ := resolveToolDeny(policy.ToolPolicy.Deny)
	tools := policy.Tools
	if tools == nil {
		tools = l.strategy.AllowedTools()
	}
	schema := policy.OutputSchema
	if schema == "" {
		schema = call.defaultSchema
	}
	return llm.Options{
		Model:                      model,
		MCPConfigPath:              l.cfg.LLM.MCPConfigPath,
		MaxBudgetUSD:               l.effectiveBudgetUSD(),
		PermissionMode:             l.cfg.LLM.PermissionMode,
		DangerouslySkipPermissions: l.cfg.LLM.DangerouslySkipPermissions,
		DisallowedTools:            deny,
		AllowedTools:               tools,
		ContextDirs:                l.cfg.LLM.ContextDirs,
		AnthropicAPIKey:            l.cfg.LLM.AnthropicAPIKey,
		OutputSchema:               schema,
		WorkingDir:                 call.repoDir,
		ResumeSessionID:            call.resumeSessionID,
		ContextDispatchVersion:     valaris.ContextDispatchVersion,
	}
}

// checkDispatchChannels refuses, before preparation, a call the provider's
// declared channels cannot carry exactly.
func checkDispatchChannels(provider llm.Provider, options llm.Options) error {
	var channels llm.PromptChannels
	if declaring, ok := provider.(llm.CapabilityProvider); ok {
		channels = declaring.Capabilities().PromptChannels
	}
	return llm.CheckPromptChannels(channels, options.ResumeSessionID != "", options)
}

// prepareWithRetry submits p, retrying a transient or unknown outcome with
// the same key and payload.
func (l *Loop) prepareWithRetry(ctx context.Context, executionID string, p valaris.DispatchPreparation) (*valaris.PreparationAck, error) {
	ctx, cancel := context.WithTimeout(ctx, preparationRetryWindow)
	defer cancel()
	deadline, _ := ctx.Deadline()
	for retry := 0; ; retry++ {
		ack, err := l.client.PrepareDispatch(ctx, l.cfg.Valaris.WorkspaceSlug, executionID, p)
		if err == nil || ctx.Err() != nil || retry == maxPreparationRetries || !transientPreparation(err) {
			return ack, err
		}
		backoff := preparationBackoff << retry
		if time.Now().Add(backoff).After(deadline) {
			return nil, err
		}
		slog.Warn("dispatch preparation failed transiently — retrying the same request", "execution_id", executionID, "error", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(backoff):
		}
	}
}

func transientPreparation(err error) bool {
	if errors.Is(err, valaris.ErrAmbiguousPreparation) {
		return true
	}
	var apiErr *valaris.APIError
	return errors.As(err, &apiErr) && (apiErr.StatusCode >= http.StatusInternalServerError || apiErr.StatusCode == http.StatusTooManyRequests)
}

// revisionConflict reports the server rejecting a preparation because the
// execution's context or dispatch moved on since its snapshot.
func revisionConflict(err *valaris.APIError) bool {
	code := err.ErrorCode()
	return err.StatusCode == http.StatusConflict && (code == "execution_context_changed" || code == "execution_dispatch_changed")
}
