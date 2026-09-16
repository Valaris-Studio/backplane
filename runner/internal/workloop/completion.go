// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	runnergit "github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

const completionReviewSchema = `{"type":"object","additionalProperties":false,"properties":{"outcome":{"type":"string","enum":["passed","failed"]},"summary":{"type":"string"}},"required":["outcome","summary"]}`
const completionOutputLimit = 16384

func (m *LoopMode) completionCapabilities() valaris.CompletionCapabilities {
	names := map[string]bool{}
	for name, provider := range m.providers {
		if provider != nil && provider.Name() == name {
			names[name] = true
		}
	}
	if m.defaultProvider != nil {
		names[m.defaultProvider.Name()] = true
	}
	providers := make([]string, 0, len(names))
	for name := range names {
		providers = append(providers, name)
	}
	sort.Strings(providers)
	return valaris.CompletionCapabilities{Providers: providers, ExactCheckout: true, ArgvChecks: true}
}

// Completion work precedes ordinary iterations and every terminal/parking
// decision. A failed or unavailable control plane never means "no work".
func (m *LoopMode) runCompletionWork(ctx context.Context, cfg *valaris.BoardLoopConfig, remaining float64) (held, executed bool, cost float64, err error) {
	if cfg.CompletionPolicy == nil {
		return false, false, 0, nil
	}
	status, err := m.client.GetCompletionWork(ctx, m.workspaceSlug, m.boardID)
	if err != nil {
		return false, false, 0, err
	}
	m.reportCompletionProgress(status)
	if !status.Outstanding() {
		return false, false, 0, nil
	}
	if status.ActionableCount == 0 || time.Now().Before(m.completionRetryAfter) {
		return true, false, 0, nil
	}
	if remaining <= 0 {
		return true, false, 0, fmt.Errorf("completion work is pending but the loop budget is exhausted; increase the budget to resume")
	}
	if err := m.preflightCompletionWorkflow(ctx, cfg); err != nil {
		return true, false, 0, err
	}
	work, err := m.client.ClaimCompletionWork(ctx, m.workspaceSlug, m.boardID, m.completionCapabilities())
	if err != nil {
		return true, false, 0, err
	}
	if work == nil {
		return true, false, 0, nil
	}
	cap := remaining
	if m.cfg.LLM.MaxBudgetUSD > 0 && m.cfg.LLM.MaxBudgetUSD < cap {
		cap = m.cfg.LLM.MaxBudgetUSD
	}
	stopHeartbeat := m.startCompletionHeartbeat(ctx)
	result, cost := m.executeCompletionWork(ctx, cfg, work, cap)
	stopHeartbeat()
	if ctx.Err() != nil {
		return true, true, cost, ctx.Err()
	}
	// Result publication is control plane only. The exact same payload is safe
	// to retry; a process restart recovers through the expiring server lease.
	if err := m.publishCompletionResult(ctx, work.AttemptID, result); err != nil {
		return true, true, cost, fmt.Errorf("publishing completion result: %s", m.completionOutput(err.Error(), work.LeaseToken))
	}
	if result.Outcome == "failed" {
		m.completionRetryAfter = time.Now().Add(30 * time.Second)
	}
	return true, true, cost, nil
}

func (m *LoopMode) executeCompletionWork(ctx context.Context, cfg *valaris.BoardLoopConfig, work *valaris.CompletionWork, sessionCap float64) (receipt valaris.CompletionResult, cost float64) {
	started := time.Now()
	defer func() { receipt.CostUSD = cost; receipt.DurationSeconds = time.Since(started).Seconds() }()
	receipt = valaris.CompletionResult{LeaseToken: work.LeaseToken, CandidateID: work.CandidateID, PolicyHash: work.PolicyHash, ContractHash: work.ContractHash, SourceSHA: work.SourceSHA, Outcome: "failed", Checks: []valaris.CompletionCheckResult{}, Artifacts: work.Artifacts}
	fail := func(reason string) (valaris.CompletionResult, float64) {
		receipt.Summary = m.completionOutput(reason, work.LeaseToken)
		return receipt, cost
	}
	if work.AttemptID == "" || work.LeaseToken == "" || work.CandidateID == "" || work.CardID == "" || work.Role == "" || work.Context == "" || work.PolicyHash == "" || work.ContractHash == "" {
		return fail("completion claim is missing required identity or mandatory context")
	}
	if work.PolicyHash != cfg.CompletionPolicyHash {
		return fail("completion claim policy changed; request a current candidate")
	}
	if work.ExpiresAt.IsZero() || !work.ExpiresAt.After(time.Now()) {
		return fail("completion claim lease has expired")
	}
	workCtx, cancel := context.WithDeadline(ctx, work.ExpiresAt)
	defer cancel()
	manager := &runnergit.Manager{RoleToken: m.cfg.Git.Tokens[work.Role]}
	dir, cleanup, err := manager.CloneExact(workCtx, work.RepoURL, work.SourceSHA)
	if err != nil {
		return fail(err.Error())
	}
	defer cleanup()
	manager.BaseDir = filepath.Dir(dir)

	switch work.Kind {
	case "validation":
		m.reportBudget(cfg, m.budgetSpent, nil, work.Kind)
		if len(work.Checks) == 0 {
			return fail("completion validation has no configured checks")
		}
		seen := map[string]bool{}
		for _, check := range work.Checks {
			if check.ID == "" || seen[check.ID] || len(check.Argv) == 0 || check.Argv[0] == "" || check.TimeoutSeconds <= 0 || check.TimeoutSeconds > 86400 {
				return fail("completion validation contains an invalid or duplicate check contract")
			}
			seen[check.ID] = true
			if err = manager.VerifyExactSource(workCtx, dir, work.SourceSHA); err != nil {
				return fail(err.Error())
			}
			result := m.runCompletionCheck(workCtx, dir, check, work.LeaseToken)
			result.SourceSHA = work.SourceSHA
			receipt.Checks = append(receipt.Checks, result)
			if err = manager.VerifyExactSource(workCtx, dir, work.SourceSHA); err != nil {
				return fail(err.Error())
			}
			if result.ExitCode != 0 {
				return fail("completion check " + check.ID + " failed; retry the accepted revision after resolving the failure")
			}
		}
		receipt.Outcome = "passed"
		receipt.Summary = "All configured checks passed against the exact accepted source revision."
	case "review", "evidence_review":
		provider := m.providers[work.Provider]
		if provider == nil && m.defaultProvider != nil && m.defaultProvider.Name() == work.Provider {
			provider = m.defaultProvider
		}
		if provider == nil || provider.Name() != work.Provider {
			return fail(fmt.Sprintf("completion provider %q is unavailable; install/configure that provider before retrying", work.Provider))
		}
		if cp, ok := provider.(llm.CapabilityProvider); !ok || !cp.Capabilities().StructuredOutput {
			return fail(fmt.Sprintf("completion provider %q does not support the required structured review result", work.Provider))
		}
		if strings.TrimSpace(work.Model) == "" || isTierAlias(work.Model) {
			return fail("completion review requires an exact configured provider model, not a tier alias")
		}
		if reporter, ok := provider.(llm.ShellDenyReporter); ok {
			if unsupported := reporter.UnenforceableDeny(work.ToolPolicy.Deny); len(unsupported) > 0 {
				return fail(fmt.Sprintf("completion provider %q cannot enforce configured tool restrictions (%s); configure a compatible provider before retrying", work.Provider, strings.Join(unsupported, ", ")))
			}
		}
		prompt := fmt.Sprintf("## Mandatory completion assignment\nRole: %s\nKind: %s\nCard: %s\nCandidate: %s\nExact source revision: %s\nPolicy hash: %s\nCheck contract hash: %s\n\n%s\n\n## Mandatory board completion policy\n%s", work.Role, work.Kind, work.CardID, work.CandidateID, work.SourceSHA, work.PolicyHash, work.ContractHash, work.Context, cfg.CompletionContext)
		// Fresh invocation: no source-session ID, no claim/result MCP tools, and no
		// control-plane lease in any model-visible field.
		denied := append([]string{"Edit", "Write", "NotebookEdit"}, work.ToolPolicy.Deny...)
		opts := llm.Options{SystemPrompt: "Independently inspect the immutable candidate. Do not modify source. Return passed or failed with concrete evidence.", Model: work.Model, WorkingDir: dir, OutputSchema: completionReviewSchema, MaxBudgetUSD: sessionCap, PermissionMode: m.cfg.LLM.PermissionMode, DangerouslySkipPermissions: m.cfg.LLM.DangerouslySkipPermissions, AnthropicAPIKey: m.cfg.LLM.AnthropicAPIKey, AllowedTools: []string{"Read", "Glob", "Grep", "Bash"}, DisallowedTools: denied}
		if err := m.preflightCompletionWorkflow(workCtx, cfg, work); err != nil {
			return fail(err.Error())
		}
		m.reportBudget(cfg, m.budgetSpent, provider, work.Kind)
		result, execErr := provider.Execute(workCtx, prompt, opts)
		cost = resultCost(result, provider, work.Model)
		if result != nil {
			receipt.TokensUsed = result.InputTokens + result.OutputTokens
			for _, configured := range work.ToolPolicy.Deny {
				for _, unenforced := range result.UnenforcedDeny {
					if configured == unenforced {
						return fail(fmt.Sprintf("completion provider %q did not enforce configured tool restriction %q; configure a compatible provider before retrying", work.Provider, configured))
					}
				}
			}
		}
		if iterationFailed(result, execErr, workCtx) {
			return fail("completion review provider execution failed; verify provider availability and retry")
		}
		if err = manager.VerifyExactSource(workCtx, dir, work.SourceSHA); err != nil {
			return fail(err.Error())
		}
		var verdict struct {
			Outcome string `json:"outcome"`
			Summary string `json:"summary"`
		}
		if result == nil || json.Unmarshal(result.StructuredOutput, &verdict) != nil || (verdict.Outcome != "passed" && verdict.Outcome != "failed") || strings.TrimSpace(verdict.Summary) == "" {
			return fail("completion review returned no valid structured verdict")
		}
		receipt.Outcome = verdict.Outcome
		receipt.Summary = m.completionOutput(verdict.Summary, work.LeaseToken)
	default:
		return fail(fmt.Sprintf("unsupported completion work kind %q; upgrade the runner", work.Kind))
	}
	return receipt, cost
}

// boundedCheckOutput drains all child output while retaining a bounded prefix.
// stdout and stderr may write concurrently; truncation never blocks the child.
type boundedCheckOutput struct {
	mu   sync.Mutex
	data []byte
}

func (b *boundedCheckOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if remaining := completionOutputLimit - len(b.data); remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		b.data = append(b.data, p...)
	}
	return n, nil
}

var _ io.Writer = (*boundedCheckOutput)(nil)

func (m *LoopMode) runCompletionCheck(ctx context.Context, dir string, check valaris.CompletionCheck, lease string) valaris.CompletionCheckResult {
	checkCtx, cancel := context.WithTimeout(ctx, time.Duration(check.TimeoutSeconds)*time.Second)
	defer cancel()
	command := exec.CommandContext(checkCtx, check.Argv[0], check.Argv[1:]...)
	command.Dir = dir
	command.Env = completionCheckEnvironment(filepath.Dir(dir))
	command.WaitDelay = time.Second
	cleanupProcess := configureCompletionProcess(command)
	defer cleanupProcess()
	output := &boundedCheckOutput{}
	command.Stdout, command.Stderr = output, output
	err := command.Run()
	exitCode := 0
	if err != nil {
		exitCode = -1
		if command.ProcessState != nil && command.ProcessState.ExitCode() != 0 {
			exitCode = command.ProcessState.ExitCode()
		}
	}
	if checkCtx.Err() != nil {
		exitCode = -1
	}
	text := string(output.data)
	if err != nil {
		text += "\nCheck execution failed: " + err.Error()
	}
	return valaris.CompletionCheckResult{ID: check.ID, ExitCode: exitCode, Output: m.completionOutput(text, lease)}
}

func completionCheckEnvironment(root string) []string {
	env := []string{}
	for _, entry := range runnergit.SubprocessEnv(root) {
		key, _, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		if upper == llm.SourceExecutionEnvKey || strings.Contains(upper, "TOKEN") || strings.Contains(upper, "SECRET") || strings.Contains(upper, "PASSWORD") || strings.Contains(upper, "API_KEY") || upper == "VALARIS_API_KEY" {
			continue
		}
		env = append(env, entry)
	}
	return env
}

func (m *LoopMode) completionOutput(value, lease string) string {
	secrets := []string{lease, m.cfg.Valaris.APIKey, m.cfg.LLM.AnthropicAPIKey, m.cfg.Git.ForgeToken}
	for _, value := range m.cfg.Git.Tokens {
		secrets = append(secrets, value)
	}
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		if strings.Contains(upper, "TOKEN") || strings.Contains(upper, "SECRET") || strings.Contains(upper, "PASSWORD") || strings.Contains(upper, "API_KEY") {
			secrets = append(secrets, value)
		}
	}
	for _, secret := range secrets {
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	if len(value) > completionOutputLimit {
		value = value[:completionOutputLimit]
	}
	return strings.ToValidUTF8(value, "")
}

func (m *LoopMode) completionWake(cfg *valaris.BoardLoopConfig) <-chan struct{} {
	if cfg.CompletionPolicy == nil {
		return nil
	}
	return m.wake
}
func (m *LoopMode) iterationWait(cfg *valaris.BoardLoopConfig, delay time.Duration) <-chan time.Time {
	if cfg.CompletionPolicy == nil {
		return time.After(delay)
	}
	if delay > idleWaitMax {
		delay = idleWaitMax
	}
	return m.sleep(delay)
}
func (m *LoopMode) publishCompletionResult(ctx context.Context, attempt string, result valaris.CompletionResult) error {
	for retry := 0; ; retry++ {
		err := m.client.CompleteCompletionWork(ctx, m.workspaceSlug, m.boardID, attempt, result)
		if err == nil {
			return nil
		}
		var rejection *valaris.CompletionResultRejection
		if errors.As(err, &rejection) {
			return err
		}
		var apiErr *valaris.APIError
		if retry >= 2 || (errors.As(err, &apiErr) && apiErr.StatusCode != 429 && apiErr.StatusCode < 500) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(retry+1) * 250 * time.Millisecond):
		}
	}
}

// A long provider/check invocation must not make a live runner appear offline.
// This heartbeat never renews the claim: expires_at remains the hard deadline.
// Stop and join before the caller makes its next control-plane mutation.
func (m *LoopMode) startCompletionHeartbeat(ctx context.Context) func() {
	heartbeatCtx, cancel := context.WithCancel(ctx)
	beat := func() {
		report := valaris.NewHealthReport()
		report.LoopBoardID = m.boardID
		report.LoopState = valaris.LoopStateTicking
		if err := m.client.Heartbeat(heartbeatCtx, report); err != nil && heartbeatCtx.Err() == nil {
			slog.Warn("completion runner heartbeat failed", "board_id", m.boardID, "error", err)
		}
	}
	beat()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case <-ticker.C:
				beat()
			}
		}
	}()
	return func() { cancel(); <-done }
}

// A named source provider is operator intent under an explicit policy, not a
// tier preference. The unconfigured-provider path retains local tier routing.
func (m *LoopMode) completionSourceProvider(cfg *valaris.BoardLoopConfig) (llm.Provider, error) {
	if isTierAlias(cfg.Model) {
		return nil, fmt.Errorf("completion policy source provider %q requires a concrete model; configure a concrete model for the selected provider", cfg.Provider)
	}
	provider := m.providers[cfg.Provider]
	if provider == nil && m.defaultProvider != nil && m.defaultProvider.Name() == cfg.Provider {
		provider = m.defaultProvider
	}
	if provider == nil || provider.Name() != cfg.Provider {
		return nil, fmt.Errorf("completion policy source provider %q is unavailable; install/configure that provider before resuming", cfg.Provider)
	}
	return provider, nil
}
