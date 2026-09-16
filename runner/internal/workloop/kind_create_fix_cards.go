// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Defaults for the create_fix_cards stamp. An auditor role (ui_validator) files
// follow-up fixes into the active column with routing labels that (a) keep the
// planner off small fixes (`direct-implement`) and (b) flag the UI surface
// (`frontend`, `ui-fix`). `planned` is included so the card reads as ready-to-
// build, consistent with the hand-filed convention. The fix card does NOT carry
// needs-ui-validation — the reviewer re-applies that on approve (its emergent
// behavior), which keeps the audit cycle closed without stranding the card in
// the implementer's needs-ui-validation exclude.
var defaultFixCardLabels = []string{"frontend", "ui-fix", "direct-implement", "planned"}

const (
	defaultFixCardColumnType = "active"
	defaultFixCardPriority   = "urgent"
	defaultFixCardType       = "bug"
)

// lifecycleCreateFixCards reads the prior produces_decision step's structured
// fix_cards[] (carried on the reviewResult) and creates one board card per
// entry, linking each as a blocker of the source card. No-op (and no error) on
// an approve verdict with no fix cards. On a request_changes verdict that filed
// ZERO fix cards it SYNTHESIZES one umbrella card from the verdict body (the C
// backstop) so the source→fix dependency edge always exists to gate
// re-validation — otherwise the auditor money-loops on the same unfixed card.
// Card-creation failures are logged, not fatal: a failed create must not abort
// the audit-verdict label swap that follows, since the validated card's state
// is the load-bearing outcome.
func lifecycleCreateFixCards(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}

	llmRes := llmResultFromWalk(ws)
	if llmRes == nil || llmRes.reviewResult == nil {
		return "", "", nil // no verdict to act on
	}
	rev := llmRes.reviewResult
	specs := rev.FixCards
	// C — synthesis backstop against the re-validation money-loop. A
	// request_changes verdict that files ZERO fix cards is the dead-end that
	// loops: this fail path never strips needs-ui-validation, so re-discovery
	// is gated ONLY by the source→fix dependency edge — and with no fix card
	// there is no edge, so all_dependencies_done trivially passes and the
	// auditor re-validates the same unchanged card every poll. Authors hit this
	// by reasoning "severe defect → return to rework, not a follow-up card" —
	// but this lifecycle has no rework branch, so that choice strands the card.
	// Guarantee at least one fix card (hence one edge) on any fail, regardless
	// of what the LLM emitted, by synthesizing an umbrella card from the
	// verdict body. An approve with no fix cards stays a legitimate no-op.
	if len(specs) == 0 {
		if rev.Decision != "request_changes" {
			return "", "", nil // approve / non-fail → nothing to file
		}
		desc := string(rev.Findings)
		if desc == "" {
			desc = rev.Summary
		}
		if desc == "" {
			desc = "The auditor failed this card (request_changes) but emitted no " +
				"fix details. See the verdict note on this card for the failure."
		}
		specs = []FixCardSpec{{
			Title:       fmt.Sprintf("UI fix: %s", card.Title),
			Description: desc,
		}}
		slog.Warn("create_fix_cards: request_changes verdict filed no fix_cards; "+
			"synthesizing one umbrella card from the verdict to gate re-validation",
			"from_card", card.CardID)
	}

	ws_slug := l.cfg.Valaris.WorkspaceSlug
	columnType := paramString(step, "to_column_type", defaultFixCardColumnType)
	priority := paramString(step, "priority", defaultFixCardPriority)
	cardType := paramString(step, "card_type", defaultFixCardType)
	// link_to_source gates the source→fix dependency edge. Default true is the
	// fail path (Path A): the edge gates re-validation so the auditor can't
	// money-loop on the unfixed card. The approve branch sets it false: the
	// source is already Done, so an edge from it would dangle — the minor
	// follow-up is filed with the same active/urgent/direct-implement stamp but
	// stands alone (column+priority+label, not an edge, is what makes it
	// picked-next). This is the only behavioral difference between the two paths.
	linkToSource := paramBool(step, "link_to_source", true)
	// labels param overrides the default stamp; a parse error or absent key
	// falls back to defaultFixCardLabels (the routing stamp the engine owns).
	labels := defaultFixCardLabels
	if configured, lerr := paramStringList(step, "labels"); lerr == nil && len(configured) > 0 {
		labels = configured
	}

	columnID, err := resolveColumnID(ctx, l, ws_slug, card.BoardID, columnType)
	if err != nil {
		// A missing target column is a config error worth surfacing, but not
		// worth aborting the verdict swap — log and skip the creates.
		slog.Warn("create_fix_cards: could not resolve target column; skipping fix-card creation",
			"to_column_type", columnType, "board_id", card.BoardID, "error", err)
		return "", "", nil
	}

	created := 0
	for _, spec := range specs {
		if spec.Title == "" {
			continue
		}
		// Fix cards inherit the audited card's git_repo_slug verbatim — the
		// fix targets the repo the auditor was driving. Empty slug is omitted
		// from the payload (backend primary-repo default), never invented.
		newID, cerr := l.client.CreateCard(ctx, ws_slug, card.BoardID, columnID,
			spec.Title, spec.Description, cardType, priority, card.GitRepoSlug, labels)
		if cerr != nil {
			slog.Warn("create_fix_cards: failed to create a fix card; continuing",
				"title", spec.Title, "board_id", card.BoardID, "error", cerr)
			continue
		}
		created++
		slog.Info("create_fix_cards: filed follow-up card",
			"new_card_id", newID, "title", spec.Title, "from_card", card.CardID,
			"column", columnType, "labels", labels)

		// Link the fix card as a BLOCKER of the source card: source depends_on
		// fix. The scheduler's all_dependencies_done gate then refuses to
		// re-assign the source card (e.g. re-validate a ui_validator's failed
		// Done card) until every fix lands in done. Without this the validator
		// re-reserves the same unfixed card every poll — the re-validation
		// money-loop. Best-effort: a failed edge must not abort the verdict swap
		// (mirrors the create-failure discipline), but it IS logged loudly since
		// a missing edge silently re-opens the loop. Skip when the source has no
		// id (defensive; requireCard already guarantees it here). Skip entirely
		// on the approve path (linkToSource=false): the source is Done, so an
		// edge from it would dangle — by design the minor follow-up has no edge.
		if linkToSource && newID != "" && card.CardID != "" {
			if derr := l.client.AddCardDependency(ctx, ws_slug, card.BoardID, card.CardID, newID); derr != nil {
				slog.Warn("create_fix_cards: failed to link fix card as blocker of source; "+
					"source may re-validate before the fix lands",
					"source_card", card.CardID, "fix_card", newID, "error", derr)
			}
		}
	}
	slog.Info("create_fix_cards: done", "created", created, "requested", len(specs), "from_card", card.CardID)
	return "", "", nil
}

// resolveColumnID maps a column_type (e.g. "active") to its column id on the
// card's board. Errors when the board has no column of that type.
func resolveColumnID(ctx context.Context, l *Loop, workspaceSlug, boardID, columnType string) (string, error) {
	columns, err := l.client.GetBoard(ctx, workspaceSlug, boardID)
	if err != nil {
		return "", fmt.Errorf("get board: %w", err)
	}
	for _, col := range columns {
		if col.ColumnType == columnType {
			return col.ID, nil
		}
	}
	return "", fmt.Errorf("no column with column_type %q on board %s", columnType, boardID)
}
