// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"encoding/json"
	"log/slog"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Suppress repeated presentation, never the prerequisite checks themselves.
func (m *LoopMode) completionNoticeChanged(key string, value any) bool {
	encoded, _ := json.Marshal(value)
	if m.completionNotices == nil {
		m.completionNotices = map[string]string{}
	}
	if previous, ok := m.completionNotices[key]; ok && previous == string(encoded) {
		return false
	}
	m.completionNotices[key] = string(encoded)
	return true
}

func (m *LoopMode) reportCompletionProgress(status *valaris.CompletionWorkStatus) {
	if !m.completionNoticeChanged("workflow", status) {
		return
	}
	slog.Info("completion workflow status", "board_id", m.boardID,
		"pending", status.PendingCount, "actionable", status.ActionableCount, "failed", status.FailedCount)
	for _, item := range status.Workflows {
		mergeSHA, failure := "", ""
		if item.MergeSHA != nil {
			mergeSHA = *item.MergeSHA
		}
		if item.Failure != nil {
			failure = item.Failure.Code
		}
		slog.Info("completion workflow", "board_id", m.boardID,
			"card_id", m.completionOutput(item.CardID, ""), "candidate_id", m.completionOutput(item.CandidateID, ""),
			"phase", m.completionOutput(item.Phase, ""), "source_sha", m.completionOutput(item.SourceSHA, ""),
			"merge_sha", m.completionOutput(mergeSHA, ""), "failure", m.completionOutput(failure, ""),
			"next_action", m.completionOutput(item.NextAction, ""), "summary", m.completionOutput(item.Summary, ""))
		if attempt := item.Attempt; attempt != nil {
			slog.Info("completion attempt", "attempt_id", m.completionOutput(attempt.ID, ""),
				"role", m.completionOutput(attempt.Role, ""), "provider", m.completionOutput(attempt.Provider, ""),
				"model", m.completionOutput(attempt.Model, ""), "lease", m.completionOutput(attempt.LeaseState, ""),
				"expires_at", m.completionOutput(attempt.ExpiresAt, ""))
		}
	}
	if status.NextCursor != nil {
		slog.Info("additional completion workflows available", "next_cursor", m.completionOutput(*status.NextCursor, ""))
	}
}
