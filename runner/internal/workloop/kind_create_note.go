// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// allowedCreateNoteBodyFrom is the closed set of body-source modes for
// create_note. Unknown values hard-error at config time so operators can't
// silently get an empty note.
var allowedCreateNoteBodyFrom = []string{"findings", "raw", "summary", "decision"}

// lifecycleCreateNote persists a typed note. The body source is controlled by
// the `body_from` param (default "findings"); `kind` is required and chosen
// from the backend's closed-set note kinds. The legacy `from_llm_output`
// boolean alias is rejected outright — operators must migrate to body_from.
//
// Body resolution by body_from:
//   - findings: reviewResult.Findings (falls back through reviewNoteSource for
//     sensor-only paths that populate findings without an LLM step).
//   - raw:      ws.LLMRawOutput (verbatim stdout of the latest llm step).
//   - summary:  reviewResult.Summary (empty when no reviewResult).
//   - decision: reviewResult.Decision (empty when no reviewResult).
//
// An empty resolved body is a hard error rather than a silent skip — that
// behavior masked misconfigured pipelines before the redesign.
func lifecycleCreateNote(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}

	if _, present := step.Params["from_llm_output"]; present {
		return "", "", fmt.Errorf("create_note(%s): from_llm_output param is removed; use body_from: findings instead", step.Name)
	}

	kind := strings.TrimSpace(paramString(step, "kind", ""))
	if kind == "" {
		return "", "", fmt.Errorf("create_note(%s): missing required param kind", step.Name)
	}

	bodyFrom := paramString(step, "body_from", "findings")
	if !containsString(allowedCreateNoteBodyFrom, bodyFrom) {
		return "", "", fmt.Errorf("create_note(%s): unknown body_from %q (allowed: %v)", step.Name, bodyFrom, allowedCreateNoteBodyFrom)
	}

	body := resolveCreateNoteBody(ws, bodyFrom)
	if body == "" {
		return "", "", fmt.Errorf("create_note(%s): resolved body is empty (body_from=%s)", step.Name, bodyFrom)
	}

	title := paramString(step, "title", "")
	if title == "" {
		title = fmt.Sprintf("Note: %s", card.CardID)
	}
	failureClass := paramString(step, "failure_class", "")

	return "", "", l.client.CreateNote(ctx,
		l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID,
		kind, title, body, failureClass, false)
}

// resolveCreateNoteBody pulls the body string for the requested mode. nil
// guards yield "" — the caller hard-errors on empty bodies, so this stays
// total without panicking on missing LLM/review state.
func resolveCreateNoteBody(ws *lifecycle.WalkState, bodyFrom string) string {
	switch bodyFrom {
	case "raw":
		return ws.LLMRawOutput
	case "findings":
		_, findings := reviewNoteSource(llmResultFromWalk(ws), sensorResultFromWalk(ws))
		return findings
	case "summary":
		if r := llmResultFromWalk(ws); r != nil && r.reviewResult != nil {
			return r.reviewResult.Summary
		}
		return ""
	case "decision":
		if r := llmResultFromWalk(ws); r != nil && r.reviewResult != nil {
			return r.reviewResult.Decision
		}
		return ""
	}
	return ""
}

func containsString(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}
