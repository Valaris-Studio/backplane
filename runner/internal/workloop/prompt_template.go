// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"text/template"
)

// contextSourceIndexRef matches the Go index form a prompt uses to consume a
// context_sources entry, tolerating whitespace variants. Mirrors the backend
// lint regex (backend/app/services/agents/context_source_lint.py).
var contextSourceIndexRef = regexp.MustCompile(
	`\{\{\s*index\s+\.ContextSources\s+"([^"]+)"\s*\}\}`,
)

// legacyBridgeAlias holds the two kinds that reach prompts through legacy
// struct fields (board_definition -> ProjectDirectives, review_history ->
// ReviewHistory) rather than the index form. A declared source aliased to one
// of these is still consumed via the legacy field, so it is not "unconsumed".
var legacyBridgeAlias = map[string]struct{}{
	"board_definition": {},
	"review_history":   {},
}

// unreferencedContextSources returns the ContextSources aliases the runner
// holds that the template never references via the index form. These are
// declared-but-unconsumed at runtime: their rendered context is silently
// dropped. The two legacy-bridge aliases are excluded — they're consumed via
// {{.ProjectDirectives}}/{{.ReviewHistory}}. Result is sorted for stable logs.
func unreferencedContextSources(tmpl string, sources map[string]string) []string {
	if len(sources) == 0 {
		return nil
	}
	referenced := make(map[string]struct{})
	for _, m := range contextSourceIndexRef.FindAllStringSubmatch(tmpl, -1) {
		referenced[m[1]] = struct{}{}
	}
	var unref []string
	for alias := range sources {
		if _, ok := referenced[alias]; ok {
			continue
		}
		if _, ok := legacyBridgeAlias[alias]; ok {
			continue
		}
		unref = append(unref, alias)
	}
	sort.Strings(unref)
	return unref
}

// PromptContext holds all variables available for Go template interpolation
// in platform-managed prompt configs. Field names map to {{.FieldName}} in templates.
type PromptContext struct {
	Workspace         string
	AgentID           string
	BoardID           string
	BoardIDs          string // comma-separated list of board IDs
	CardID            string
	ExecutionID       string
	ApprovalSummary   string
	Branch            string
	PRURL             string
	ErrorMsg          string
	UserID            string
	GitRepoURL        string
	GitRepoName       string
	BlockedCardIDs    string // comma-separated IDs of circuit-breaker-blocked cards
	ReviewHistory     string // chronological review notes, pre-fetched via REST and injected
	ActionPlan        string // structured action plan from the execution mediator
	ReworkAttempt     int    // which rework attempt this is (1-based)
	MaxReworkAttempts int    // threshold for escalation warnings
	ProjectDirectives string // definition coding standards + pinned notes, injected into implement prompt
	Decision          string // review decision: "approve" or "request_changes"
	ResumeBrief       string // Cluster I: continue-from-checkpoint instructions for a budget-suspended card being resumed; empty on a fresh pickup
	Iteration         int    // loop mode: 1-based iteration number within this runner process
	// ContextSources carries every backend-rendered context_sources entry from
	// the assignment bundle, keyed by the operator-chosen `as` alias. Templates
	// access individual entries via {{ index .ContextSources "<alias>" }}.
	ContextSources map[string]string
}

// applyBoardDefinitionAlias mirrors the legacy {{.ProjectDirectives}} contract
// onto the new context_sources surface. The "board_definition" kind replaces
// the runner-side fetchDirectives path; aliasing it keeps existing prompt
// templates rendering unchanged. Pre-set ProjectDirectives wins — a stage that
// still threads directives through the legacy path must not be overwritten.
func applyBoardDefinitionAlias(pc *PromptContext) {
	if pc.ProjectDirectives != "" {
		return
	}
	if v, ok := pc.ContextSources["board_definition"]; ok && v != "" {
		pc.ProjectDirectives = v
	}
}

// applyReviewHistoryAlias mirrors the legacy {{.ReviewHistory}} contract onto
// the context_sources surface. The "review_history" kind replaces the
// runner-side fetchReviewHistory path; aliasing it keeps existing prompt
// templates rendering unchanged. Pre-set ReviewHistory wins.
func applyReviewHistoryAlias(pc *PromptContext) {
	if pc.ReviewHistory != "" {
		return
	}
	if v, ok := pc.ContextSources["review_history"]; ok && v != "" {
		pc.ReviewHistory = v
	}
}

// applyContextSourceAliases bridges every legacy {{.Field}} contract to its
// context_sources kind so call sites stay one-liners and new aliases land in
// one place instead of fanning out across stage builders.
func applyContextSourceAliases(pc *PromptContext) {
	applyBoardDefinitionAlias(pc)
	applyReviewHistoryAlias(pc)
}

// renderPrompt parses and executes a Go text/template with the given context.
// Returns the rendered string or an error if the template is malformed.
func renderPrompt(tmpl string, ctx PromptContext) (string, error) {
	t, err := template.New("prompt").Parse(tmpl)
	if err != nil {
		return "", err
	}
	var buf strings.Builder
	if err := t.Execute(&buf, ctx); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// mustRender renders a template or panics. Used by hardcoded prompt functions
// where template syntax is compile-time correct and errors are programming bugs.
func mustRender(tmpl string, ctx PromptContext) string {
	result, err := renderPrompt(tmpl, ctx)
	if err != nil {
		panic(fmt.Sprintf("prompt template bug: %v", err))
	}
	return result
}

// mustRenderExt renders a template with an arbitrary data struct (for prompts
// that need derived fields beyond PromptContext). Panics on template errors.
func mustRenderExt(tmpl string, data any) string {
	t, err := template.New("prompt").Parse(tmpl)
	if err != nil {
		panic(fmt.Sprintf("prompt template bug: %v", err))
	}
	var buf strings.Builder
	if err := t.Execute(&buf, data); err != nil {
		panic(fmt.Sprintf("prompt template bug: %v", err))
	}
	return buf.String()
}
