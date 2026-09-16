// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"fmt"
	"strings"
	"unicode"
)

func (s *CompletionWorkStatus) ResumeSummary() string {
	lines := []string{fmt.Sprintf("Completion: %d pending, %d actionable, %d failed.", s.PendingCount, s.ActionableCount, s.FailedCount)}
	for _, item := range s.Workflows {
		line := fmt.Sprintf("Card %s; candidate %s; %s; source %s; next: %s.", item.CardID, item.CandidateID, item.Phase, item.SourceSHA, item.NextAction)
		if item.MergeSHA != nil {
			line += " Merge: " + *item.MergeSHA + "."
		}
		if a := item.Attempt; a != nil {
			line += fmt.Sprintf(" Attempt %s; %s / %s / %s; lease %s (%s).", a.ID, a.Role, a.Provider, a.Model, a.LeaseState, a.ExpiresAt)
		}
		if item.Failure != nil {
			line += " Reason: " + item.Failure.Code + "."
		}
		if item.Summary != "" {
			line += " " + item.Summary
		}
		lines = append(lines, strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, line))
	}
	if s.NextCursor != nil {
		lines = append(lines, "More workflows are available; next cursor: "+*s.NextCursor+".")
	}
	return strings.Join(lines, "\n")
}
